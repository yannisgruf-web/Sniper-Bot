// src/executor.js – Brücke zwischen Signal-Logik und echten Swaps.
// Sicherheitsschalter LIVE_TRADING: false -> tut GAR NICHTS (reiner Paper-Betrieb).
// Preisquelle für Positionsgröße: SOL/BNB in USD. Realisierte PnL -> Risk-Manager.
const cfg = require("./config");
const risk = require("./risk");
const wallets = require("./wallets");
const execSol = require("./exec-solana");
const execBsc = require("./exec-bsc");

const live = new Map(); // posId -> { chain, token, buyTxid, tokenAmount, entryUsd, sizeUsd }
const liveStats = { buys: 0, sells: 0, buyFails: 0, sellFails: 0, realizedUsd: 0 };

function enabled(chain) {
  if (!cfg.LIVE_TRADING) return false;
  if (!cfg.LIVE_CHAINS.includes(chain)) return false;
  if (chain === "solana" && !wallets.getSol()) return false;
  if (chain === "bsc" && !wallets.getBsc()) return false;
  return true;
}

// Kauf beim Paper-Entry mitauslösen (nur wenn live & erlaubt & Risk ok)
async function onEntry(posId, chain, token, prices) {
  if (!enabled(chain)) return;
  if (!risk.canBuy()) { console.log("LIVE-Kauf blockiert (Kill-Switch):", risk.status().killReason); return; }
  const sizeUsd = chain === "solana" ? cfg.POSITION_USD_SOLANA : cfg.POSITION_USD_BSC;
  try {
    let res;
    if (chain === "solana") res = await execSol.buy(token, sizeUsd, prices.sol);
    else res = await execBsc.buy(token, sizeUsd, prices.bnb);
    if (!res.ok) { liveStats.buyFails++; console.error("LIVE-Kauf fehlgeschlagen", token, res.error); return; }
    liveStats.buys++;
    const tokenAmount = chain === "solana" ? res.outAmount : null; // BSC liest Bestand beim Verkauf frisch
    live.set(posId, { chain, token, buyTxid: res.txid, tokenAmount, entryUsd: sizeUsd, sizeUsd });
    console.log(`✅ LIVE-KAUF ${chain} ${token.slice(0,8)} $${sizeUsd} tx=${res.txid.slice(0,12)}`);
  } catch (e) { liveStats.buyFails++; console.error("LIVE-Kauf Ausnahme", e.message); }
}

// Verkauf beim Paper-Exit mitauslösen. pnlPct aus dem Paper-Trade dient nur der PnL-Schätzung.
async function onExit(posId, pnlPct) {
  const p = live.get(posId);
  if (!p) return;
  live.delete(posId);
  try {
    let res;
    if (p.chain === "solana") {
      const bal = await execSol.tokenBalance(p.token).catch(() => p.tokenAmount);
      res = await execSol.sell(p.token, bal || p.tokenAmount);
    } else {
      res = await execBsc.sell(p.token);
    }
    if (!res.ok) { liveStats.sellFails++; console.error(`❌ LIVE-VERKAUF FEHLGESCHLAGEN ${p.chain} ${p.token.slice(0,8)}: ${res.error}`); return; }
    liveStats.sells++;
    // realisierte PnL grob aus Paper-Prozentsatz (exakter Wert erst nach on-chain-Abgleich)
    const realized = p.sizeUsd * (pnlPct / 100);
    liveStats.realizedUsd += realized;
    risk.recordRealized(realized);
    console.log(`✅ LIVE-VERKAUF ${p.chain} ${p.token.slice(0,8)} ~${realized>=0?"+":""}$${realized.toFixed(2)} tx=${res.txid.slice(0,12)}`);
  } catch (e) { liveStats.sellFails++; console.error("LIVE-Verkauf Ausnahme", e.message); }
}

function summary() {
  return { aktiv: cfg.LIVE_TRADING, chains: cfg.LIVE_CHAINS, offeneLivePositionen: live.size,
           ...liveStats, realizedUsd: +liveStats.realizedUsd.toFixed(2), risk: risk.status() };
}

module.exports = { onEntry, onExit, summary, enabled };
