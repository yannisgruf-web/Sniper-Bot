// src/executor.js – koordiniert echte Trades. Sicherheitsschichten:
// LIVE_TRADING (Hauptschalter), DRY_RUN (kein Signieren), ONE_TRADE_TEST (Stopp nach 1),
// Tagesverlust-Limit (Selbstabschaltung), chain-abhängige Positionsgröße.
const cfg = require("./config");
const solX = require("./exec-solana");
const bscX = require("./exec-bsc");
const { notify } = require("./telegram");

const state = {
  enabled: cfg.LIVE_TRADING,
  realTradesToday: 0,
  pnlUsdToday: 0,
  dayStamp: new Date().toISOString().slice(0, 10),
  positions: new Map(),   // id -> { chain, tokenAddr, tokens, entryUsd, sizeUsd, symbol }
  haltReason: null
};

function rollDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== state.dayStamp) { state.dayStamp = today; state.pnlUsdToday = 0; state.realTradesToday = 0; state.haltReason = null; }
}
function canTrade(chain) {
  rollDay();
  if (!state.enabled) return "live aus";
  if (state.haltReason) return state.haltReason;
  if (!cfg.LIVE_CHAINS.includes(chain)) return "chain nicht live";
  if (cfg.ONE_TRADE_TEST && state.realTradesToday >= 1) { state.haltReason = "Ein-Trade-Test beendet"; return state.haltReason; }
  if (state.pnlUsdToday <= -cfg.DAILY_LOSS_LIMIT_USD) { state.haltReason = `Tagesverlust-Limit (${state.pnlUsdToday.toFixed(2)}$)`; halt(state.haltReason); return state.haltReason; }
  if (state.positions.has(chain)) {} // Mehrfachpositionen erlaubt, Slot-Logik liegt im Index
  return null;
}
function halt(reason) {
  state.enabled = false; state.haltReason = reason;
  notify(`🛑 <b>Executor gestoppt</b>\n${reason}\nEs werden keine neuen Käufe mehr getätigt.`).catch(() => {});
}

async function openReal({ id, chain, tokenAddr, symbol, priceUnitUsd }) {
  const block = canTrade(chain);
  if (block) return { skipped: block };
  const sizeUsd = chain === "solana" ? cfg.POS_USD_SOLANA : cfg.POS_USD_BSC;
  const res = chain === "solana"
    ? await solX.buy(tokenAddr, sizeUsd, priceUnitUsd)
    : await bscX.buy(tokenAddr, sizeUsd, priceUnitUsd);
  if (!res.ok) { notify(`⚠️ Kauf fehlgeschlagen ${symbol}: ${res.error}`).catch(() => {}); return { error: res.error }; }
  if (res.dryRun) { notify(`🧪 <b>DRY-RUN Kauf ${symbol}</b> (${chain})\nWürde ${sizeUsd}$ tauschen · Route ok · Preis ${res.priceUsd}`).catch(() => {}); return { dryRun: true }; }
  state.realTradesToday++;
  state.positions.set(id, { chain, tokenAddr, tokens: res.tokens, entryUsd: sizeUsd, sizeUsd, symbol });
  notify(`✅ <b>LIVE Kauf ${symbol}</b> (${chain})\n${sizeUsd}$ · <code>${res.sig}</code>`).catch(() => {});
  return { ok: true, sig: res.sig, tokens: res.tokens };
}

async function closeReal(id, priceUnitUsd, reason) {
  const p = state.positions.get(id);
  if (!p) return { skipped: "keine Live-Position" };
  const res = p.chain === "solana"
    ? await solX.sell(p.tokenAddr, p.tokens, priceUnitUsd)
    : await bscX.sell(p.tokenAddr, priceUnitUsd);
  if (!res.ok) { notify(`⚠️ VERKAUF fehlgeschlagen ${p.symbol}: ${res.error}`).catch(() => {}); return { error: res.error }; }
  if (res.dryRun) { notify(`🧪 DRY-RUN Verkauf ${p.symbol}: würde ~${res.usdOut?.toFixed(2)}$ erlösen`).catch(() => {}); return { dryRun: true }; }
  const pnl = res.usdOut - p.entryUsd;
  state.pnlUsdToday += pnl;
  state.positions.delete(id);
  notify(`${pnl >= 0 ? "✅" : "❌"} <b>LIVE Verkauf ${p.symbol}</b>\nErlös ${res.usdOut.toFixed(2)}$ · PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}$ · ${reason}\nTag: ${state.pnlUsdToday >= 0 ? "+" : ""}${state.pnlUsdToday.toFixed(2)}$`).catch(() => {});
  return { ok: true, pnl };
}

function summary() {
  return {
    live: state.enabled, dryRun: (!cfg.LIVE_TRADING), oneTradeTest: cfg.ONE_TRADE_TEST,
    chains: cfg.LIVE_CHAINS, realTradesToday: state.realTradesToday,
    pnlUsdToday: +state.pnlUsdToday.toFixed(2), dailyLossStop: cfg.DAILY_LOSS_LIMIT_USD,
    haltReason: state.haltReason, openLive: state.positions.size,
    solAddress: solX.address(), bscAddress: bscX.address()
  };
}
function stopCommand() { halt("/stop per Telegram"); }
function hasLivePosition(id) { return state.positions.has(id); }

module.exports = { openReal, closeReal, summary, stopCommand, hasLivePosition, state };
