// src/cleanup.js – holt gebundene Miete zurück:
//  1. LEERE Token-Konten -> schließen (je ~0.002 SOL Miete zurück)
//  2. Konten mit WERTLOSEN Tokens (keine Route oder < Staubgrenze) -> verbrennen + schließen
//  3. Konten mit echtem Restwert -> NICHT anfassen, nur melden
// Zweistufig: erst Plan anzeigen, Ausführung nur nach Bestätigung.
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } = require("@solana/web3.js");
const bs58m = require("bs58"); const bs58 = bs58m.default || bs58m;

const TOKEN_PROGRAM   = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN22_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const RENT_PER_ATA_SOL = 0.00203928;
const DUST_LAMPORTS = 500000;              // ~0.0005 SOL: darunter gilt ein Restbestand als Staub
const JUP_BASE = process.env.JUP_API_KEY ? "https://api.jup.ag" : "https://lite-api.jup.ag";
const JUP_HEADERS = process.env.JUP_API_KEY ? { "x-api-key": process.env.JUP_API_KEY } : {};

let conn = null, wallet = null;
function init() {
  if (wallet) return true;
  const key = process.env.SOLANA_PRIVATE_KEY;
  if (!key) return false;
  wallet = Keypair.fromSecretKey(bs58.decode(key.trim()));
  conn = new Connection(process.env.HELIUS_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  return true;
}

async function quoteLamports(mint, amountRaw) {
  try {
    const url = `${JUP_BASE}/swap/v1/quote?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${amountRaw}&slippageBps=5000&onlyDirectRoutes=false&maxAccounts=40`;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(url, { headers: JUP_HEADERS, signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;                // 400 = keine Route -> wertlos
    const q = await r.json();
    return q?.outAmount ? +q.outAmount : null;
  } catch { return null; }
}

// Alle Token-Konten der Wallet einsammeln (klassisch + Token-2022) und klassifizieren.
async function plan(solUsd) {
  if (!init()) return { error: "keine Wallet (SOLANA_PRIVATE_KEY fehlt)" };
  const accs = [];
  for (const pid of [TOKEN_PROGRAM, TOKEN22_PROGRAM]) {
    try {
      const res = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: pid });
      for (const a of res.value) accs.push({ programId: pid, pubkey: a.pubkey, info: a.account.data.parsed.info });
    } catch (e) { console.error("[CLEANUP] Kontenliste:", e.message); }
  }
  const leer = [], verbrennen = [], behalten = [];
  for (const a of accs) {
    const raw = a.info.tokenAmount?.amount || "0";
    const mint = a.info.mint;
    if (mint === SOL_MINT) { behalten.push({ mint, grund: "wSOL" }); continue; }
    if (raw === "0") { leer.push({ pubkey: a.pubkey, programId: a.programId, mint }); continue; }
    const out = await quoteLamports(mint, raw);
    await new Promise(r => setTimeout(r, 350));   // API nicht fluten
    if (out == null || out < DUST_LAMPORTS)
      verbrennen.push({ pubkey: a.pubkey, programId: a.programId, mint, raw, wertLamports: out || 0 });
    else
      behalten.push({ mint, wertUsd: +((out / 1e9) * solUsd).toFixed(2) });
  }
  const rentSol = (leer.length + verbrennen.length) * RENT_PER_ATA_SOL;
  return { leer, verbrennen, behalten,
           rentSol: +rentSol.toFixed(4), rentUsd: +(rentSol * solUsd).toFixed(2) };
}

function burnIx(programId, account, mint, ownerPk, amountRaw) {
  const data = Buffer.alloc(9);
  data.writeUInt8(8, 0);                                  // Burn
  data.writeBigUInt64LE(BigInt(amountRaw), 1);
  return new TransactionInstruction({ programId, data, keys: [
    { pubkey: account, isSigner: false, isWritable: true },
    { pubkey: new PublicKey(mint), isSigner: false, isWritable: true },
    { pubkey: ownerPk, isSigner: true, isWritable: false },
  ]});
}
function closeIx(programId, account, ownerPk) {
  return new TransactionInstruction({ programId, data: Buffer.from([9]), keys: [   // CloseAccount
    { pubkey: account, isSigner: false, isWritable: true },
    { pubkey: ownerPk, isSigner: false, isWritable: true },   // Miete geht an den Owner
    { pubkey: ownerPk, isSigner: true, isWritable: false },
  ]});
}

// Plan ausführen: Bündel à max. 5 Konten pro Transaktion.
async function execute(p) {
  if (!init()) return { error: "keine Wallet" };
  const pre = await conn.getBalance(wallet.publicKey, "confirmed");
  const jobs = [
    ...p.verbrennen.map(v => ({ ixs: [burnIx(v.programId, v.pubkey, v.mint, wallet.publicKey, v.raw),
                                      closeIx(v.programId, v.pubkey, wallet.publicKey)] })),
    ...p.leer.map(l => ({ ixs: [closeIx(l.programId, l.pubkey, wallet.publicKey)] })),
  ];
  let ok = 0, fehler = [];
  for (let i = 0; i < jobs.length; i += 5) {
    const batch = jobs.slice(i, i + 5);
    try {
      const tx = new Transaction();
      for (const j of batch) tx.add(...j.ixs);
      const bh = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = bh.blockhash;
      tx.feePayer = wallet.publicKey;
      tx.sign(wallet);
      const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
      const conf = await conn.confirmTransaction(
        { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
      if (conf.value?.err) throw new Error(JSON.stringify(conf.value.err));
      ok += batch.length;
    } catch (e) {
      fehler.push(`Bündel ${Math.floor(i / 5) + 1}: ${e.message}`);
      console.error("[CLEANUP]", e.stack || e.message);
    }
  }
  let post = pre;
  try { post = await conn.getBalance(wallet.publicKey, "confirmed"); } catch {}
  return { ok, gesamt: jobs.length, fehler, zurueckSol: +((post - pre) / 1e9).toFixed(4) };
}

module.exports = { plan, execute };
