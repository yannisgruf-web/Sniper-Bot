// src/exec-solana.js – echte Swaps auf Solana über Jupiter v6.
// buy(): SOL -> Token für festen USD-Betrag. sell(): gesamten Token-Bestand -> SOL.
// Gibt bei Erfolg { ok, txid, ... } zurück, sonst { ok:false, error }.
const cfg = require("./config");
const wallets = require("./wallets");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP = "https://quote-api.jup.ag/v6";

async function jupQuote(inMint, outMint, amount, slippageBps) {
  const u = `${JUP}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;
  const r = await fetch(u);
  if (!r.ok) throw new Error("jup quote " + r.status);
  const q = await r.json();
  if (!q || q.error) throw new Error("jup quote: " + (q?.error || "leer"));
  return q;
}

async function jupSwap(quote) {
  const sol = wallets.getSol();
  const { VersionedTransaction } = require("@solana/web3.js");
  const r = await fetch(`${JUP}/swap`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: sol.pubkey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto"
    })
  });
  if (!r.ok) throw new Error("jup swap " + r.status);
  const { swapTransaction } = await r.json();
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([sol.keypair]);
  const sig = await sol.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  const conf = await sol.connection.confirmTransaction(sig, "confirmed");
  if (conf.value?.err) throw new Error("tx err: " + JSON.stringify(conf.value.err));
  return sig;
}

// Kauf: fester USD-Betrag SOL -> Token
async function buy(tokenMint, usdAmount, solUsd) {
  const lamports = Math.floor((usdAmount / solUsd) * 1e9);
  const quote = await jupQuote(SOL_MINT, tokenMint, lamports, cfg.BUY_SLIPPAGE_BPS);
  const txid = await jupSwap(quote);
  const outTokens = +quote.outAmount;
  return { ok: true, txid, outAmount: outTokens, inLamports: lamports };
}

// Verkauf: gesamten Token-Bestand -> SOL (mit Wiederholung bei Rug-Situationen)
async function sell(tokenMint, tokenAmount) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const slip = cfg.SELL_SLIPPAGE_BPS * attempt; // Slippage bei jedem Versuch lockern
      const quote = await jupQuote(tokenMint, SOL_MINT, Math.floor(tokenAmount), Math.min(slip, 5000));
      const txid = await jupSwap(quote);
      return { ok: true, txid, outLamports: +quote.outAmount };
    } catch (e) { lastErr = e.message; await new Promise(r => setTimeout(r, 800)); }
  }
  return { ok: false, error: lastErr };
}

// Token-Bestand einer Mint im Wallet lesen (für sell)
async function tokenBalance(tokenMint) {
  const sol = wallets.getSol();
  const { PublicKey } = require("@solana/web3.js");
  const res = await sol.connection.getParsedTokenAccountsByOwner(sol.pubkey, { mint: new PublicKey(tokenMint) });
  let amt = 0;
  for (const a of res.value) amt += +a.account.data.parsed.info.tokenAmount.amount;
  return amt;
}

module.exports = { buy, sell, tokenBalance };
