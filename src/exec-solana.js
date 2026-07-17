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
  if (!r.ok) {
    // Begründung aus dem Body mitnehmen (z.B. "could not find any route" = Liquidität weg)
    let grund = "";
    try { const b = await r.json(); grund = b?.error || b?.message || JSON.stringify(b).slice(0, 150); }
    catch { try { grund = (await r.text()).slice(0, 150); } catch {} }
    throw new Error(`Jupiter quote ${r.status}${grund ? ` – ${grund}` : ""} (${JUP_BASE})`);
  }
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
  const bh = await conn.getLatestBlockhash("confirmed");
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3, skipPreflight: false });
  // Moderne Strategie: wartet bis zur Bestätigung ODER bis der Blockhash abläuft
  // (dann ist die Tx sicher NICHT gelandet und der Fehler ist ehrlich).
  const conf = await conn.confirmTransaction(
    { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
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

// ── Verkäuflichkeits-Gate: läuft VOR jedem echten Kauf. Prüft die zwei Fragen,
// die W26 zum 5$-Verlust gemacht haben: (a) KANN dieser Token überhaupt wieder
// verkauft werden? (b) Gibt es eine echte Verkaufsroute mit echter Liquidität?
const TOKEN22_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

async function sellGate(tokenMint, buyQuote, lamportsIn) {
  // 1) Mint-Konto von der Chain lesen: Honeypot-Mechanismen auf Token-Ebene
  const info = await conn.getParsedAccountInfo(new PublicKey(tokenMint));
  const v = info?.value;
  if (!v) return { ok: false, reason: "Mint-Konto nicht lesbar" };
  const parsed = v.data?.parsed?.info || {};
  if (parsed.freezeAuthority)
    return { ok: false, reason: "Freeze-Authority aktiv (Konto einfrierbar = klassischer Honeypot)" };
  if (cfg.BLOCK_MINT_AUTHORITY && parsed.mintAuthority)
    return { ok: false, reason: "Mint-Authority aktiv (unbegrenzt nachprägbar)" };
  const owner = v.owner?.toBase58 ? v.owner.toBase58() : String(v.owner);
  if (owner === TOKEN22_PROGRAM) {
    const exts = Array.isArray(parsed.extensions) ? parsed.extensions : [];
    const names = exts.map(e => e.extension);
    for (const gefahr of ["transferHook", "permanentDelegate", "nonTransferable", "pausableConfig", "pausable"])
      if (names.includes(gefahr)) return { ok: false, reason: `Token-2022 mit ${gefahr}` };
    const das = exts.find(e => e.extension === "defaultAccountState");
    if (das?.state?.accountState === "frozen")
      return { ok: false, reason: "Token-2022: neue Konten standardmäßig eingefroren" };
    const fee = exts.find(e => e.extension === "transferFeeConfig");
    const feeBps = +fee?.state?.newerTransferFee?.transferFeeBasisPoints || 0;
    if (feeBps / 100 > cfg.MAX_SELL_TAX_PCT)
      return { ok: false, reason: `Token-2022 Transfersteuer ${(feeBps / 100).toFixed(1)}%` };
  }
  // 2) Rückweg prüfen: Sell-Route MUSS existieren, und der sofortige Roundtrip
  // (kaufen + direkt wieder verkaufen) darf nicht absurd teuer sein – sonst ist
  // die Liquidität einseitig, gefälscht oder zu dünn zum Rauskommen.
  let back;
  try { back = await jupQuote(tokenMint, SOL_MINT, String(buyQuote.outAmount), cfg.SELL_SLIPPAGE_BPS); }
  catch (e) { return { ok: false, reason: `keine Verkaufsroute (${e.message})` }; }
  const outLamports = +back.outAmount;
  if (!(outLamports > 0)) return { ok: false, reason: "Verkaufsroute liefert 0 zurück" };
  const lossPct = (1 - outLamports / lamportsIn) * 100;
  if (lossPct > cfg.MAX_ROUNDTRIP_LOSS_PCT)
    return { ok: false, reason: `Roundtrip-Verlust ${lossPct.toFixed(0)}% (Liquidität zu dünn/einseitig, Limit ${cfg.MAX_ROUNDTRIP_LOSS_PCT}%)` };
  return { ok: true, roundtripLossPct: +lossPct.toFixed(1) };
}

// Kauf: usdAmount in SOL umrechnen, dann SOL->Token
async function buy(tokenMint, usdAmount, solUsd) {
  if (!init()) return { ok: false, error: "keine Wallet" };
  const solAmount = usdAmount / solUsd;
  const lamports = Math.floor(solAmount * 1e9);
  let schritt = "start";
  try {
    schritt = "quote";
    const quote = await jupQuote(SOL_MINT, tokenMint, lamports, cfg.BUY_SLIPPAGE_BPS);
    const rawOut = +quote.outAmount;                 // ROHE Einheiten!
    schritt = "sell-gate";
    if (cfg.SELL_GATE) {
      const gate = await sellGate(tokenMint, quote, lamports);
      if (!gate.ok) return { ok: false, blocked: true, error: gate.reason };
      var roundtrip = gate.roundtripLossPct;
    }
    schritt = "decimals";
    const dec = await mintDecimals(tokenMint);
    const humanOut = dec != null ? rawOut / Math.pow(10, dec) : null;
    const priceUsd = humanOut > 0 ? usdAmount / humanOut : null;
    if ((!cfg.LIVE_TRADING)) return { ok: true, dryRun: true, tokens: rawOut, priceUsd, decimals: dec, route: quote.routePlan?.length || 0, roundtripLossPct: roundtrip };
    schritt = "swap-tx bauen";
    const swapTx = await jupSwapTx(quote);
    schritt = "signieren+senden";
    const sig = await sendSigned(swapTx);
    return { ok: true, sig, tokens: rawOut, priceUsd, decimals: dec, roundtripLossPct: roundtrip };
  } catch (e) {
    console.error(`[SOLANA BUY FEHLER] Schritt "${schritt}" | Token ${tokenMint} |`, e.stack || e.message);
    return { ok: false, error: `[${schritt}] ${e.message}` };
  }
}

// Tatsächlichen Token-Bestand der Wallet lesen (rohe Einheiten, als BigInt).
// Grund: Die beim Kauf gespeicherte Menge ist nur die QUOTE-Erwartung – real kommt
// durch Slippage immer etwas anderes an. Verkauft wird, was WIRKLICH da ist.
async function tokenBalanceRaw(mint) {
  const res = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) });
  let raw = 0n;
  for (const a of res.value) raw += BigInt(a.account?.data?.parsed?.info?.tokenAmount?.amount || "0");
  return raw;
}

// Vollständige On-Chain-Logs aus einem Sende-/Simulationsfehler ziehen (SendTransactionError).
async function txLogs(e) {
  try {
    if (Array.isArray(e.logs) && e.logs.length) return e.logs;
    if (typeof e.getLogs === "function") {
      const l = await e.getLogs(conn);
      if (Array.isArray(l) && l.length) return l;
    }
  } catch {}
  return null;
}

// Verkauf: gesamten ECHTEN Bestand -> SOL. Mit Retries: jeder Versuch holt eine
// FRISCHE Quote (Pool-Zustand ändert sich bei frischen Coins sekündlich) und
// erhöht die Slippage-Toleranz (+10% je Versuch, Deckel 50%) – Priorität: raus kommen.
async function sell(tokenMint, tokenAmount, solUsd) {
  if (!init()) return { ok: false, error: "keine Wallet" };
  let schritt = "bestand";
  // 1) Echten Wallet-Bestand lesen – nie die gespeicherte Kaufmenge blind verkaufen.
  let amount;
  try {
    const raw = await tokenBalanceRaw(tokenMint);
    if (raw === 0n) return { ok: false, noBalance: true,
      error: "kein Token-Bestand in der Wallet (bereits verkauft oder nie erhalten)" };
    amount = raw.toString();
  } catch (e) {
    console.error(`[SOLANA SELL] Bestand nicht lesbar (${e.message}) – nutze gespeicherte Menge als Fallback`);
    amount = String(Math.floor(tokenAmount));
  }
  const tries = Math.max(1, cfg.SELL_RETRIES || 3);
  const errors = [];
  // Saldo VOR dem Verkauf merken: der gemeldete Erlös ist ab jetzt der ECHTE
  // Zuwachs im Wallet (inkl. Gebühren), nicht die Quote-Schätzung. Quote-Werte
  // haben heute Gewinne gemeldet, die nie angekommen sind.
  let preLamports = null;
  try { preLamports = await conn.getBalance(wallet.publicKey, "confirmed"); } catch {}
  for (let i = 0; i < tries; i++) {
    const slip = Math.min(cfg.SELL_SLIPPAGE_BPS + i * 1000, 5000);
    try {
      schritt = "quote";
      const quote = await jupQuote(tokenMint, SOL_MINT, amount, slip);
      const outLamports = +quote.outAmount;
      const usdQuote = (outLamports / 1e9) * solUsd;
      if ((!cfg.LIVE_TRADING)) return { ok: true, dryRun: true, usdOut: usdQuote };
      schritt = "swap-tx bauen";
      const swapTx = await jupSwapTx(quote);
      schritt = "signieren+senden";
      const sig = await sendSigned(swapTx);
      // Echten Erlös messen: Saldo nach bestätigter Tx minus Saldo davor.
      let usdOut = usdQuote, gemessen = false;
      try {
        if (preLamports != null) {
          const post = await conn.getBalance(wallet.publicKey, "confirmed");
          const diff = post - preLamports;
          if (diff > 0) { usdOut = (diff / 1e9) * solUsd; gemessen = true; }
        }
      } catch {}
      return { ok: true, sig, usdOut, usdQuote, gemessen, attempt: i + 1, slippageBps: slip };
    } catch (e) {
      const logs = await txLogs(e);
      const tail = logs ? " | " + logs.slice(-3).join(" · ").slice(0, 300) : "";
      errors.push(`V${i + 1}/${tries} [${schritt}, ${slip}bps]: ${e.message}${tail}`);
      console.error(`[SOLANA SELL FEHLER] Versuch ${i + 1}/${tries} Schritt "${schritt}" slip=${slip}bps | Token ${tokenMint} |`, e.stack || e.message);
      if (logs) console.error(`[SOLANA SELL ONCHAIN-LOGS]\n` + logs.join("\n"));
      if (i < tries - 1) await new Promise(r => setTimeout(r, 1500));
    }
  }
  return { ok: false, error: errors.join("\n"), attempts: tries };
}

module.exports = { init, address, solBalanceUsd, buy, sell, tokenBalanceRaw, sellGate };
