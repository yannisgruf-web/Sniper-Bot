// src/executor.js – koordiniert echte Trades. Sicherheitsschichten:
// LIVE_TRADING (Hauptschalter), DRY_RUN (kein Signieren), ONE_TRADE_TEST (Stopp nach 1),
// Tagesverlust-Limit (Selbstabschaltung), chain-abhängige Positionsgröße.
const cfg = require("./config");
const solX = require("./exec-solana");
const bscX = require("./exec-bsc");
const { notifyLive } = require("./telegram");
const liveStore = require("./live-store");
const { tokenPriceUsd } = require("./token-price");
const { solUsd, bnbUsd } = require("./prices");

const state = {
  enabled: cfg.LIVE_TRADING,
  realTradesToday: 0,
  pnlUsdToday: 0,
  dayStamp: new Date().toISOString().slice(0, 10),
  positions: new Map(Object.entries(liveStore.load())),  // überlebt Neustarts
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
  notifyLive(`🛑 <b>Executor gestoppt</b>\n${reason}\nEs werden keine neuen Käufe mehr getätigt.`).catch(() => {});
}

async function openReal({ id, chain, tokenAddr, symbol, priceUnitUsd }) {
  const block = canTrade(chain);
  if (block) return { skipped: block };
  // Slot SOFORT reservieren (synchron, vor jedem await) – verhindert, dass zwei
  // gleichzeitige Signale (z.B. Solana + BSC) beide den ONE_TRADE_TEST-Check passieren.
  state.realTradesToday++;
  const myTradeSlot = state.realTradesToday;
  // Ohne verlässlichen SOL/BNB-Kurs KEIN Trade – sonst wird die Positionsgröße falsch berechnet.
  if (!priceUnitUsd || !isFinite(priceUnitUsd) || priceUnitUsd <= 0) {
    state.realTradesToday--; // Reservierung zurückgeben, war kein echter Versuch
    console.error(`Kauf ${symbol} abgelehnt: ${chain}-Kurs unbekannt (Preisquellen ausgefallen)`);
    notifyLive(`⛔ Kauf ${symbol} abgelehnt: ${chain.toUpperCase()}-Kurs unbekannt – Positionsgröße nicht berechenbar.`).catch(()=>{});
    return { error: "kurs unbekannt" };
  }
  const sizeUsd = chain === "solana" ? cfg.POS_USD_SOLANA : cfg.POS_USD_BSC;
  const res = chain === "solana"
    ? await solX.buy(tokenAddr, sizeUsd, priceUnitUsd)
    : await bscX.buy(tokenAddr, sizeUsd, priceUnitUsd);
  if (!res.ok) {
    state.realTradesToday--; // Kauf ist wirklich fehlgeschlagen -> zählt nicht als "der eine Trade"
    notifyLive(`⚠️ Kauf fehlgeschlagen ${symbol}: ${(res.error||"").slice(0,300)}`).catch(() => {});
    return { error: res.error };
  }
  if (res.dryRun) { state.realTradesToday--; notifyLive(`🧪 <b>DRY-RUN Kauf ${symbol}</b> (${chain})\nWürde ${sizeUsd}$ tauschen · Route ok · Preis ${res.priceUsd}`).catch(() => {}); return { dryRun: true }; }
  state.positions.set(id, { chain, tokenAddr, tokens: res.tokens, entryUsd: sizeUsd, sizeUsd, symbol,
                            entryPriceUsd: res.priceUsd || null, openedAt: Date.now() });
  persist();
  notifyLive(`✅ <b>LIVE Kauf ${symbol}</b> (${chain})\n${sizeUsd}$ · <code>${res.sig}</code>`).catch(() => {});
  return { ok: true, sig: res.sig, tokens: res.tokens };
}

async function closeReal(id, priceUnitUsd, reason) {
  const p = state.positions.get(id);
  if (!p) return { skipped: "keine Live-Position" };
  // Verkauf läuft auch ohne Kurs (Menge ist bekannt) – Kurs nur für die PnL-Anzeige.
  const res = p.chain === "solana"
    ? await solX.sell(p.tokenAddr, p.tokens, priceUnitUsd)
    : await bscX.sell(p.tokenAddr, priceUnitUsd);
  if (!res.ok) { notifyLive(`⚠️ VERKAUF fehlgeschlagen ${p.symbol}: ${res.error}`).catch(() => {}); return { error: res.error }; }
  if (res.dryRun) { notifyLive(`🧪 DRY-RUN Verkauf ${p.symbol}: würde ~${res.usdOut?.toFixed(2)}$ erlösen`).catch(() => {}); return { dryRun: true }; }
  const pnl = res.usdOut - p.entryUsd;
  state.pnlUsdToday += pnl;
  state.positions.delete(id);
  persist();
  notifyLive(`${pnl >= 0 ? "✅" : "❌"} <b>LIVE Verkauf ${p.symbol}</b>\nErlös ${res.usdOut.toFixed(2)}$ · PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}$ · ${reason}\nTag: ${state.pnlUsdToday >= 0 ? "+" : ""}${state.pnlUsdToday.toFixed(2)}$`).catch(() => {});
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
function persist() { liveStore.save(Object.fromEntries(state.positions)); }

// ── Live-Watchdog: überwacht offene ECHTE Positionen unabhängig von der Paper-Engine.
// Nötig, weil nach einem Neustart die Paper-Engine leer ist und sonst niemand verkaufen würde.
async function watchdogTick() {
  if (!state.positions.size) return;
  for (const [id, p] of [...state.positions]) {
    try {
      const now = await tokenPriceUsd(p.chain, p.tokenAddr);
      const ageMin = p.openedAt ? (Date.now() - p.openedAt) / 60e3 : 999;
      let grund = null;
      if (now && p.entryPriceUsd) {
        const pnl = (now - p.entryPriceUsd) / p.entryPriceUsd * 100;
        if (pnl >= cfg.TAKE_PROFIT_PCT) grund = `take-profit (${pnl.toFixed(0)}%)`;
        else if (pnl <= cfg.STOP_LOSS_PCT) grund = `stop-loss (${pnl.toFixed(0)}%)`;
      }
      if (!grund && ageMin >= cfg.TIME_LIMIT_MIN) grund = "zeitlimit";
      if (grund) {
        const unit = p.chain === "solana" ? await solUsd() : await bnbUsd();
        await closeReal(id, unit, grund);
      }
    } catch (e) { console.error("watchdog", p.symbol, e.message); }
  }
}
setInterval(() => { watchdogTick().catch(()=>{}); }, Math.max(cfg.PRICE_POLL_SEC, 10) * 1000);

// Beim Start: wiederhergestellte Positionen melden
if (state.positions.size) {
  const liste = [...state.positions.values()].map(p => `${p.symbol} (${p.chain})`).join(", ");
  console.log("Live-Positionen aus Datei wiederhergestellt:", liste);
  notifyLive(`♻️ <b>${state.positions.size} offene Live-Position(en) nach Neustart wiederhergestellt</b>\n${liste}\nDie Überwachung läuft weiter.`).catch(()=>{});
}

function stopCommand() { halt("/stop per Telegram"); }
function hasLivePosition(id) { return state.positions.has(id); }

module.exports = { openReal, closeReal, summary, stopCommand, hasLivePosition, state, watchdogTick };
