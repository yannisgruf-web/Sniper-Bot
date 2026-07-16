// src/entry-gate.js – Beobachtungsfenster vor dem Einstieg (Profi-Sniper-Checks):
//  1. Bundle-Erkennung: viele Käufe in den ersten Sekunden = koordinierte Wallets
//  2. Unique-Buyer-Ratio: wenige Wallets kaufen wiederholt = Wash-Trading
//  3. Top-Wallet-Dominanz: eine Wallet kauft den Großteil = Insider-Akkumulation
//  4. Holder-Konzentration on-chain (Solana RPC, exkl. Bonding Curve)
const cfg = require("./config");

function newObservation(createMsg) {
  return {
    symbol: createMsg.symbol || "?",
    creator: createMsg.traderPublicKey || null,
    curveKey: (createMsg.associatedBondingCurve || createMsg.bondingCurveKey || "").toString(),
    mint: createMsg.mint,
    startTs: Date.now(),
    buys: []   // { wallet, sol, ts }
  };
}

function recordTrade(obs, msg) {
  if ((msg.txType || "").toLowerCase() !== "buy") return;
  obs.buys.push({ wallet: msg.traderPublicKey || "?", sol: +msg.solAmount || 0, ts: Date.now() });
}

function ready(obs) {
  const age = (Date.now() - obs.startTs) / 1000;
  return obs.buys.length >= cfg.OBS_MAX_TRADES || (age >= cfg.OBS_MAX_SEC && obs.buys.length >= cfg.OBS_MIN_TRADES);
}

// Solana RPC: Top-Holder-Anteil (ohne Bonding-Curve-Konto)
async function holderConcentration(mint, curveKey) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3500);
    const r = await fetch(process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenLargestAccounts", params: [mint] })
    });
    clearTimeout(t);
    const d = await r.json();
    const accs = d?.result?.value || [];
    if (!accs.length) return null;
    const ex = accs.filter(a => a.address !== curveKey);
    const total = ex.reduce((s, a) => s + (+a.uiAmount || 0), 0);
    if (total <= 0) return null;
    const top5 = ex.slice(0, 5).reduce((s, a) => s + (+a.uiAmount || 0), 0);
    return top5 / total * 100;   // % des zirkulierenden Supplys bei den Top 5
  } catch { return null; }
}

async function evaluate(obs) {
  const flags = [];
  const buys = obs.buys;
  if (buys.length < cfg.OBS_MIN_TRADES)
    return { ok: false, reason: `zu wenig Aktivität (${buys.length} Käufe)` };

  // 1. Bundle: Käufe in den ersten 3 Sekunden nach dem ERSTEN Kauf
  const t0 = buys[0].ts;
  const burst = buys.filter(b => b.ts - t0 <= 3000).length;
  if (burst >= cfg.MAX_BURST_3S)
    return { ok: false, reason: `Bundle-Verdacht: ${burst} Käufe in 3s` };

  // 2. Unique-Buyer-Ratio
  const uniq = new Set(buys.map(b => b.wallet)).size;
  const ratio = uniq / buys.length;
  if (ratio < cfg.MIN_UNIQUE_RATIO)
    return { ok: false, reason: `Wash-Verdacht: nur ${(ratio * 100).toFixed(0)}% einzigartige Käufer` };

  // 3. Top-Wallet-Dominanz (nach gekauftem SOL-Volumen)
  const bySol = {};
  let solSum = 0;
  for (const b of buys) { bySol[b.wallet] = (bySol[b.wallet] || 0) + b.sol; solSum += b.sol; }
  const topShare = solSum > 0 ? Math.max(...Object.values(bySol)) / solSum : 0;
  if (topShare > cfg.MAX_TOP_WALLET_SHARE)
    return { ok: false, reason: `eine Wallet kauft ${(topShare * 100).toFixed(0)}% des Volumens` };

  // 4. On-Chain-Holder-Konzentration (weich: bei RPC-Ausfall nur Flag)
  const conc = await holderConcentration(obs.mint, obs.curveKey);
  if (conc != null && conc > cfg.MAX_TOP_HOLDERS_PCT)
    return { ok: false, reason: `Top-5-Holder halten ${conc.toFixed(0)}% des Umlaufs` };
  if (conc == null) flags.push("Holder-Check n/a");

  return { ok: true, flags, metrics: {
    buys: buys.length, uniquePct: +(ratio * 100).toFixed(0),
    topWalletPct: +(topShare * 100).toFixed(0),
    top5HolderPct: conc != null ? +conc.toFixed(0) : null, burst3s: burst
  }};
}

module.exports = { newObservation, recordTrade, ready, evaluate };
