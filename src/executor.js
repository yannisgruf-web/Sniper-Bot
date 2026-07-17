// src/executor.js – koordiniert echte Trades. Sicherheitsschichten:
// LIVE_TRADING (Hauptschalter), DRY_RUN (kein Signieren), ONE_TRADE_TEST (Stopp nach 1),
// Tagesverlust-Limit (Selbstabschaltung), chain-abhängige Positionsgröße.
const cfg = require("./config");
const solX = require("./exec-solana");
const bscX = require("./exec-bsc");
const { notifyLive } = require("./telegram");
const liveStore = require("./live-store");
const tp = require("./token-price");
const gapLog = require("./gap-log");
const { solUsd, bnbUsd } = require("./prices");

// Gespeicherten Zustand laden. WICHTIG: Tageszähler und Halt-Status überleben
// Neustarts – sonst hebelt jeder Absturz den Ein-Trade-Test aus (ist heute passiert).
// Unterscheidung: ändert sich die Railway-Deployment-ID, war es ein BEWUSSTES
// Deploy (neuer Code) -> Zähler zurücksetzen. Gleiche ID = Absturz -> Zustand behalten.
const _stored = liveStore.load();
const _meta = _stored.__meta || {};
delete _stored.__meta;
const _today = new Date().toISOString().slice(0, 10);
const _deployId = process.env.RAILWAY_DEPLOYMENT_ID || "lokal";
const _sameRun = _meta.dayStamp === _today && _meta.deployId === _deployId;
const state = {
  enabled: cfg.LIVE_TRADING && !(_sameRun && _meta.haltReason),
  realTradesToday: _sameRun ? (_meta.realTradesToday || 0) : 0,
  pnlUsdToday: _meta.dayStamp === _today ? (_meta.pnlUsdToday || 0) : 0, // PnL zählt IMMER für den Tag, auch über Deploys
  dayStamp: _today,
  positions: new Map(Object.entries(_stored)),  // überlebt Neustarts
  haltReason: _sameRun ? (_meta.haltReason || null) : null
};
// Sperre gegen gleichzeitige Verkäufe derselben Position (Watchdog + Paper-Spiegel
// haben heute bei CARDCAT zeitgleich verkauft -> Doppel-Meldungen, Phantom-Erlös).
const closing = new Set();

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
    if (res.blocked) {
      // Kein Fehler, sondern ein Treffer des Verkäuflichkeits-Gates: Token wäre gefährlich gewesen.
      notifyLive(`🛡️ <b>Kauf blockiert: ${symbol}</b> (${chain})\nGrund: ${res.error}\nKein Geld bewegt – genau dafür ist das Gate da.`).catch(() => {});
      return { blocked: res.error };
    }
    notifyLive(`⚠️ Kauf fehlgeschlagen ${symbol}: ${(res.error||"").slice(0,300)}`).catch(() => {});
    return { error: res.error };
  }
  if (res.dryRun) { state.realTradesToday--; notifyLive(`🧪 <b>DRY-RUN Kauf ${symbol}</b> (${chain})\nWürde ${sizeUsd}$ tauschen · Route ok · Preis ${res.priceUsd}`).catch(() => {}); return { dryRun: true }; }
  // Einstiegspreis aus derselben Quelle wie der Watchdog holen -> beide vergleichen dieselbe Einheit.
  // (Der Preis aus der Swap-Quote kann in rohen Token-Einheiten vorliegen und ist als Referenz untauglich.)
  let entryPriceUsd = await tp.tokenPriceUsd(chain, tokenAddr).catch(() => null);
  if (!entryPriceUsd && res.priceUsd) entryPriceUsd = res.priceUsd;
  state.positions.set(id, { chain, tokenAddr, tokens: res.tokens, entryUsd: sizeUsd, sizeUsd, symbol,
                            entryPriceUsd: entryPriceUsd || null, openedAt: Date.now() });
  persist();
  const gateInfo = res.roundtripLossPct != null ? ` · Gate ok (Roundtrip ${res.roundtripLossPct}%)` : "";
  notifyLive(`✅ <b>LIVE Kauf ${symbol}</b> (${chain})\n${sizeUsd}$${gateInfo} · <code>${res.sig}</code>`).catch(() => {});
  return { ok: true, sig: res.sig, tokens: res.tokens };
}

// Nach Verlusten sofort prüfen, nicht erst beim nächsten Kaufversuch.
function checkDailyLimit() {
  if (state.enabled && state.pnlUsdToday <= -cfg.DAILY_LOSS_LIMIT_USD)
    halt(`Tagesverlust-Limit (${state.pnlUsdToday.toFixed(2)}$)`);
}

async function closeReal(id, priceUnitUsd, reason, anzeigePnlPct = null) {
  const p = state.positions.get(id);
  if (!p) return { skipped: "keine Live-Position" };
  if (closing.has(id)) return { skipped: "Verkauf läuft bereits" };
  closing.add(id);
  try {
  // Verkauf läuft auch ohne Kurs (Menge ist bekannt) – Kurs nur für die PnL-Anzeige.
  const res = p.chain === "solana"
    ? await solX.sell(p.tokenAddr, p.tokens, priceUnitUsd)
    : await bscX.sell(p.tokenAddr, priceUnitUsd);
  if (!res.ok) {
    // Kein Bestand auf der Chain: Position existiert real nicht (mehr) -> ohne Verkauf ausbuchen.
    if (res.noBalance) {
      state.positions.delete(id); persist();
      notifyLive(`ℹ️ <b>${p.symbol}</b>: kein Bestand in der Wallet – Position wird ohne Verkauf geschlossen (vermutlich bereits manuell verkauft).`).catch(() => {});
      return { closed: "noBalance" };
    }
    // Fehlschlag zählen (überlebt Neustarts, da mitpersistiert).
    p.sellFails = (p.sellFails || 0) + 1;
    persist();
    const maxFails = cfg.SELL_FAIL_LIMIT;
    if (p.sellFails >= maxFails) {
      // Unverkäuflich (Rug/Honeypot/Liquidität weg): als Totalverlust abschließen,
      // damit der Watchdog nicht endlos weiter hämmert und Telegram zuspammt.
      const pnl = -p.entryUsd;
      state.pnlUsdToday += pnl;
      state.positions.delete(id);
      persist();
      gapLog.add({ symbol: p.symbol, chain: p.chain, reason: "rug", rug: true,
                   anzeigePnlPct: null, realPnlPct: -100, gapPp: null,
                   sizeUsd: p.entryUsd, erloesUsd: 0,
                   haltedauerMin: p.openedAt ? +((Date.now() - p.openedAt) / 60e3).toFixed(1) : null });
      notifyLive(`💀 <b>${p.symbol}: unverkäuflich (Rug/Honeypot)</b>\n${p.sellFails}× Verkauf gescheitert (je ${cfg.SELL_RETRIES} interne Versuche) – Position wird als Totalverlust (−${p.entryUsd.toFixed(2)}$) geschlossen.\nLetzter Fehler: ${String(res.error || "").slice(0, 500)}\nTag: ${state.pnlUsdToday >= 0 ? "+" : ""}${state.pnlUsdToday.toFixed(2)}$`).catch(() => {});
      checkDailyLimit();
      return { closed: "rug", pnl };
    }
    // Nur der ERSTE Fehlschlag geht laut nach Telegram, die weiteren still ins Log (kein Spam).
    if (p.sellFails === 1)
      notifyLive(`⚠️ <b>VERKAUF fehlgeschlagen ${p.symbol}</b> (Runde ${p.sellFails}/${maxFails})\n${String(res.error || "").slice(0, 900)}\nWeitere Verkaufsrunden laufen automatisch – Meldung erst wieder bei Erfolg oder endgültigem Abschluss.`).catch(() => {});
    else
      console.error(`VERKAUF fehlgeschlagen ${p.symbol} (Runde ${p.sellFails}/${maxFails}): ${res.error}`);
    return { error: res.error };
  }
  if (res.dryRun) { notifyLive(`🧪 DRY-RUN Verkauf ${p.symbol}: würde ~${res.usdOut?.toFixed(2)}$ erlösen`).catch(() => {}); return { dryRun: true }; }
  const pnl = res.usdOut - p.entryUsd;
  state.pnlUsdToday += pnl;
  state.positions.delete(id);
  persist();
  checkDailyLimit();
  // ── Lücken-Messung: Anzeige-PnL (DexScreener/Paper-Sicht) vs. realisierter PnL.
  const realPnlPct = p.entryUsd > 0 ? (pnl / p.entryUsd) * 100 : null;
  let grundText = reason, gapText = "";
  if (anzeigePnlPct != null && realPnlPct != null) {
    const gap = anzeigePnlPct - realPnlPct;
    gapLog.add({ symbol: p.symbol, chain: p.chain, reason,
                 anzeigePnlPct: +anzeigePnlPct.toFixed(1), realPnlPct: +realPnlPct.toFixed(1),
                 gapPp: +gap.toFixed(1), sizeUsd: p.entryUsd, erloesUsd: +res.usdOut.toFixed(2),
                 haltedauerMin: p.openedAt ? +((Date.now() - p.openedAt) / 60e3).toFixed(1) : null });
    const s = gapLog.stats();
    grundText = `${reason} ausgelöst bei ${anzeigePnlPct >= 0 ? "+" : ""}${anzeigePnlPct.toFixed(0)}% (Anzeige)`;
    gapText = `\nRealisiert ${realPnlPct >= 0 ? "+" : ""}${realPnlPct.toFixed(0)}% · Lücke ${(anzeigePnlPct - realPnlPct).toFixed(0)}pp` +
              (s.n > 1 ? ` · Ø Lücke bisher ${s.avgGapPp}pp (${s.n} Trades)` : "");
  }
  const versuchInfo = res.attempt > 1 ? `\n(brauchte ${res.attempt} Versuche, Slippage ${res.slippageBps / 100}%)` : "";
  notifyLive(`${pnl >= 0 ? "✅" : "❌"} <b>LIVE Verkauf ${p.symbol}</b>\nErlös ${res.usdOut.toFixed(2)}$ · PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}$ · ${grundText}${gapText}${versuchInfo}\nTag: ${state.pnlUsdToday >= 0 ? "+" : ""}${state.pnlUsdToday.toFixed(2)}$`).catch(() => {});
  return { ok: true, pnl };
  } finally { closing.delete(id); }
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
function persist() {
  liveStore.save({ ...Object.fromEntries(state.positions),
    __meta: { dayStamp: state.dayStamp, deployId: _deployId, realTradesToday: state.realTradesToday,
              pnlUsdToday: state.pnlUsdToday, haltReason: state.haltReason } });
}

// ── Live-Watchdog: überwacht offene ECHTE Positionen unabhängig von der Paper-Engine.
// Nötig, weil nach einem Neustart die Paper-Engine leer ist und sonst niemand verkaufen würde.
async function watchdogTick() {
  if (!state.positions.size) return;
  for (const [id, p] of [...state.positions]) {
    try {
      const now = await tp.tokenPriceUsd(p.chain, p.tokenAddr);
      const ageMin = p.openedAt ? (Date.now() - p.openedAt) / 60e3 : 999;
      let grund = null, anzeigePnl = null;
      if (now && p.entryPriceUsd) {
        const pnl = (now - p.entryPriceUsd) / p.entryPriceUsd * 100;
        // Plausibilitätsprüfung: >2000% ist kein echter Kursgewinn, sondern ein Einheiten-/Datenfehler.
        // Dann NICHT verkaufen, sondern Einstiegspreis einmalig korrigieren und weiter beobachten.
        if (pnl > 2000) {
          if (!p.priceFixed) {
            console.error(`${p.symbol}: unplausibler PnL ${pnl.toFixed(0)}% -> Einstiegspreis wird korrigiert`);
            p.priceFixed = true; p.entryPriceUsd = now; persist();
            notifyLive(`⚠️ ${p.symbol}: Einstiegspreis war fehlerhaft, wurde korrigiert. Position bleibt offen.`).catch(()=>{});
          }
        }
        else if (pnl >= cfg.TAKE_PROFIT_PCT) { grund = "take-profit"; anzeigePnl = pnl; }
        else if (pnl <= cfg.STOP_LOSS_PCT)   { grund = "stop-loss";   anzeigePnl = pnl; }
        // ── Trailing-Stop: Hochwasserstand merken; ab +TRAIL_ARM_PCT ist der Stop
        // auf Einstand (0%) gesichert und zieht je TRAIL_STEP_PCT eine Stufe nach.
        // Beispiel (5/5): Peak +7% -> Stop 0% · Peak +12% -> Stop +5% · Peak +23% -> Stop +15%.
        if (!grund && cfg.TRAILING) {
          if (p.peakPnl == null || pnl > p.peakPnl) { p.peakPnl = +pnl.toFixed(1); persist(); }
          if (p.peakPnl >= cfg.TRAIL_ARM_PCT) {
            const stufe = Math.floor(p.peakPnl / cfg.TRAIL_STEP_PCT) * cfg.TRAIL_STEP_PCT - cfg.TRAIL_STEP_PCT;
            if (pnl <= stufe) { grund = `trailing-stop (Stop ${stufe >= 0 ? "+" : ""}${stufe}%, Peak +${p.peakPnl}%)`; anzeigePnl = pnl; }
          }
        }
      }
      if (!grund && ageMin >= cfg.TIME_LIMIT_MIN) {
        grund = "zeitlimit";
        if (now && p.entryPriceUsd) anzeigePnl = (now - p.entryPriceUsd) / p.entryPriceUsd * 100;
      }
      if (grund) {
        const unit = p.chain === "solana" ? await solUsd() : await bnbUsd();
        await closeReal(id, unit, grund, anzeigePnl);
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

// Ein-Trade-Test per Telegram neu scharfmachen – ersetzt den Redeploy-Workflow.
function resume() {
  rollDay();
  state.realTradesToday = 0;
  state.haltReason = null;
  state.enabled = cfg.LIVE_TRADING;
  persist();
  return { enabled: state.enabled, pnlUsdToday: +state.pnlUsdToday.toFixed(2) };
}

module.exports = { openReal, closeReal, summary, stopCommand, hasLivePosition, state, watchdogTick, resume };
