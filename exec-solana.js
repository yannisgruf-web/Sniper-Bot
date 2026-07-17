// src/exec-solana.js – echte Swaps auf Solana über Jupiter.
// Kauf: SOL -> Token. Verkauf: Token -> SOL. Signierung nur wenn !DRY_RUN.
const { Connection, Keypair, VersionedTransaction, PublicKey } = require("@solana/web3.js");
const bs58mod = require("bs58");
const bs58 = bs58mod.default || bs58mod;   // funktioniert bei beiden Modul-Formen
const cfg = require("./config");

const SOL_MINT = "So11111111111111111111111111111111111111112";
let conn = null, wallet = null;

function init() {
  if (wallet) return true;
  const pk = process.env.SOLANA_PRIVATE_KEY;
  if (!pk) return false;
  try {
    const k = pk.trim();
    let secret = k.startsWith("[") ? Uint8Array.from(JSON.parse(k)) : bs58.decode(k);
    if (secret.length !== 64)
      throw new Error(`SOLANA_PRIVATE_KEY hat ${secret.length} Byte, erwartet 64. ` +
        (secret.length === 32 ? "Das sieht nach einer ADRESSE aus, nicht nach einem Private Key! " : "") +
        "Phantom: Einstellungen -> Sicherheit & Datenschutz -> Private Key exportieren.");
    wallet = Keypair.fromSecretKey(secret);
    if (cfg.SOLANA_ADDRESS && cfg.SOLANA_ADDRESS.trim() !== wallet.publicKey.toBase58()) {
      console.error(`SOLANA ADRESS-MISMATCH: Key ergibt ${wallet.publicKey.toBase58()}, erwartet ${cfg.SOLANA_ADDRESS.trim()}`);
      wallet = null; return false;
    }
    conn = new Connection((process.env.HELIUS_RPC_URL || "https://api.mainnet-beta.solana.com"), "confirmed");
    return true;
  } catch (e) { console.error("Solana-Key ungültig:", e.message); return false; }
}
function address() { return wallet ? wallet.publicKey.toBase58() : null; }

async function solBalanceUsd(solUsd) {
  if (!init()) return 0;
  const lamports = await conn.getBalance(wallet.publicKey);
  return (lamports / 1e9) * solUsd;
}

// quote-api.jup.ag/v6 wurde am 1.10.2025 abgeschaltet. Aktueller kostenloser Endpunkt: lite-api.jup.ag.
// Optional: JUP_API_KEY setzen -> dann api.jup.ag mit Key (höhere Limits, empfohlen für Dauerbetrieb).
const JUP_BASE = process.env.JUP_API_KEY ? "https://api.jup.ag" : "https://lite-api.jup.ag";
const JUP_HEADERS = process.env.JUP_API_KEY ? { "x-api-key": process.env.JUP_API_KEY } : {};

async function jupQuote(inputMint, outputMint, amount, slippageBps) {
  const url = `${JUP_BASE}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;
  const r = await fetch(url, { headers: JUP_HEADERS });
  if (!r.ok) throw new Error(`Jupiter quote ${r.status} (${JUP_BASE})`);
  const q = await r.json();
  if (!q || q.error) throw new Error("Jupiter quote: " + (q.error || "leer"));
  return q;
}

async function jupSwapTx(quote) {
  const r = await fetch(`${JUP_BASE}/swap/v1/swap`, {
    method: "POST", headers: { "Content-Type": "application/json", ...JUP_HEADERS },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto"
    })
  });
  if (!r.ok) throw new Error(`Jupiter swap ${r.status} (${JUP_BASE})`);
  const d = await r.json();
  if (!d.swapTransaction) throw new Error("Jupiter swap: keine Transaktion");
  return d.swapTransaction;
}

async function sendSigned(swapTxB64) {
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTxB64, "base64"));
  tx.sign([wallet]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3, skipPreflight: false });
  const conf = await conn.confirmTransaction(sig, "confirmed");
  if (conf.value?.err) throw new Error("Tx fehlgeschlagen: " + JSON.stringify(conf.value.err));
  return sig;
}

// Nachkommastellen eines Token-Mints von der Chain lesen (für korrekte Preisberechnung)
async function mintDecimals(mint) {
  try {
    const info = await conn.getParsedAccountInfo(new PublicKey(mint));
    const d = info?.value?.data?.parsed?.info?.decimals;
    return Number.isInteger(d) ? d : null;
  } catch { return null; }
}

// Kauf: usdAmount in SOL umrechnen, dann SOL->Token
async function buy(tokenMint, usdAmount, solUsd) {
  if (!init()) return { ok: false, error: "keine Wallet" };
  const solAmount = usdAmount / solUsd;
  const lamports = Math.floor(solAmount * 1e9);
  try {
    const quote = await jupQuote(SOL_MINT, tokenMint, lamports, cfg.BUY_SLIPPAGE_BPS);
    const rawOut = +quote.outAmount;                 // ROHE Einheiten!
    const dec = await mintDecimals(tokenMint);
    // Preis pro ganzem Token = USD / (rohe Menge / 10^decimals). Ohne decimals kein Preis melden.
    const humanOut = dec != null ? rawOut / Math.pow(10, dec) : null;
    const priceUsd = humanOut > 0 ? usdAmount / humanOut : null;
    if ((!cfg.LIVE_TRADING)) return { ok: true, dryRun: true, tokens: rawOut, priceUsd, decimals: dec, route: quote.routePlan?.length || 0 };
    const swapTx = await jupSwapTx(quote);
    const sig = await sendSigned(swapTx);
    return { ok: true, sig, tokens: rawOut, priceUsd, decimals: dec };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Verkauf: gesamte Token-Menge -> SOL
async function sell(tokenMint, tokenAmount, solUsd) {
  if (!init()) return { ok: false, error: "keine Wallet" };
  try {
    const quote = await jupQuote(tokenMint, SOL_MINT, Math.floor(tokenAmount), cfg.SELL_SLIPPAGE_BPS);
    const outLamports = +quote.outAmount;
    const usdOut = (outLamports / 1e9) * solUsd;
    if ((!cfg.LIVE_TRADING)) return { ok: true, dryRun: true, usdOut };
    const swapTx = await jupSwapTx(quote);
    const sig = await sendSigned(swapTx);
    return { ok: true, sig, usdOut };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { init, address, solBalanceUsd, buy, sell };
