// src/indi-engine.js – Paper-Trading auf Top-Coins nach Indikator-Konfluenz.
// Virtuelles USDC-Guthaben. Nur Long (Spot-Logik): bullische Konfluenz = Kauf,
// bärische Konfluenz ODER TP/SL/Trailing = Verkauf. Signale werden ausschließlich
// auf ABGESCHLOSSENEN 15-Minuten-Kerzen berechnet (kein Repainting).
const fs = require("fs");
const path = require("path");
const cfg = require("./config");
const { notify } = require("./telegram");
const ind = require("./indicators");

const FILE = path.join(process.cwd(), "data", "indi-portfolio.json");
const TRADES = path.join(process.cwd(), "data", "indi-trades.json");
const BINANCE = "https://api.binance.com";

// Statische Fallback-Liste (falls die Volumen-Abfrage scheitert)
const DEFAULT_SYMBOLS = ("BTC,ETH,BNB,SOL,XRP,ADA,DOGE,AVAX,DOT,LINK,TON,MATIC,ICP,SHIB,LTC,BCH,UNI,ATOM,ETC,XLM," +
  "NEAR,APT,FIL,ARB,OP,VET,INJ,GRT,ALGO,FTM,THETA,RUNE,SEI,SUI,TIA,IMX,LDO,STX,EGLD,FLOW," +
  "SAND,MANA,AXS,AAVE,MKR,SNX,CRV,KAVA,ROSE,CHZ").split(",").map(s => s.trim() + "USDT");

// Stablecoins & gewrappte Token, die nie gehandelt werden sollen (kein echtes Momentum).
const AUSSCHLUSS = /^(USDC|FDUSD|TUSD|USDP|DAI|BUSD|EUR|WBTC|WBETH|BETH|USDT)USDT$/;

let symbolCache = { list: null, ts: 0 };
// Top-N liquideste USDT-Paare nach 24h-Quote-Volumen, 1h gecacht.
async function topSymbols() {
  if (process.env.INDI_SYMBOLS)
    return process.env.INDI_SYMBOLS.split(",").map(s => { const u = s.trim().toUpperCase(); return u.endsWith("USDT") ? u : u + "USDT"; });
  if (symbolCache.list && Date.now() - symbolCache.ts < 3600e3) return symbolCache.list;
  try {
    const all = await fetchJson(`${BINANCE}/api/v3/ticker/24hr`);
    const ranked = all
      .filter(t => t.symbol.endsWith("USDT") && !AUSSCHLUSS.test(t.symbol))
      .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
      .slice(0, cfg.INDI_TOP_N)
      .map(t => t.symbol);
    if (ranked.length >= 20) { symbolCache = { list: ranked, ts: Date.now() }; return ranked; }
  } catch (e) { console.error("[INDI] Symbolliste (nutze Fallback):", e.message); }
  return DEFAULT_SYMBOLS.slice(0, cfg.INDI_TOP_N);
}

function load(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function save(file, obj) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 1)); } catch (e) { console.error("[INDI] save:", e.message); } }

const state = load(FILE, { balance: cfg.INDI_START_USD, positions: {} });
function persist() { save(FILE, state); }
function logTrade(t) { const arr = load(TRADES, []); arr.push({ ts: new Date().toISOString(), ...t }); save(TRADES, arr); }

async function fetchJson(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); }
  finally { clearTimeout(t); }
}

async function fetchCandles(sym) {
  const raw = await fetchJson(`${BINANCE}/api/v3/klines?symbol=${sym}&interval=15m&limit=120`);
  // Letzte Kerze ist die LAUFENDE -> weglassen, nur abgeschlossene bewerten.
  return raw.slice(0, -1).map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
}

// ── Stimmen auszählen: pro Indikator bullisch (+), bärisch (−) oder neutral ──
function votes(candles) {
  const closes = candles.map(k => k.c);
  const i = candles.length - 1, p = i - 1;
  const bull = [], bear = [];

  const r = ind.rsi(closes, 14);
  const div = ind.rsiDivergence(candles, r);
  if (div === 1) bull.push("RSI-Div"); else if (div === -1) bear.push("RSI-Div");

  const m = ind.mfi(candles, 14);
  if (m[i] != null) { if (m[i] < 20) bull.push("MFI"); else if (m[i] > 80) bear.push("MFI"); }

  const { k, d } = ind.stochRsi(closes);
  if (k[i] != null && d[i] != null && k[p] != null && d[p] != null) {
    if (k[p] <= d[p] && k[i] > d[i] && k[i] < 30) bull.push("StochRSI");
    else if (k[p] >= d[p] && k[i] < d[i] && k[i] > 70) bear.push("StochRSI");
  }

  const pso = ind.premierStoch(candles);
  if (pso[i] != null && pso[p] != null) {
    if (pso[p] < -0.9 && pso[i] >= -0.9) bull.push("PSO");
    else if (pso[p] > 0.9 && pso[i] <= 0.9) bear.push("PSO");
  }

  const mc = ind.macd(closes);
  if (mc.hist[i] != null && mc.hist[p] != null) {
    if (mc.hist[p] <= 0 && mc.hist[i] > 0) bull.push("MACD");
    else if (mc.hist[p] >= 0 && mc.hist[i] < 0) bear.push("MACD");
  }

  const sq = ind.ttmSqueeze(candles);
  if (sq.on[i] != null && sq.on[p] != null) {
    if (sq.on[p] === true && sq.on[i] === false) {           // Squeeze löst sich
      if (sq.momo[i] > 0) bull.push("TTM"); else if (sq.momo[i] < 0) bear.push("TTM");
    }
  }

  // Fibonacci Golden Pocket: NUR bullisch (Pullback ins 0.618-0.65-Band eines
  // Aufwärts-Swings). Es gibt kein symmetrisches bärisches Gegenstück, daher
  // zählt es ausschließlich bei den Kauf-Stimmen.
  const fib = ind.fibGoldenPocket(candles);
  if (fib.inPocket === 1) bull.push("Fib-GP");

  return { bull, bear };
}

// ── Positionsverwaltung ──
function openPos(sym, price, v) {
  const usd = Math.min(cfg.INDI_POS_USD, state.balance);
  if (usd < 10) return;
  state.balance -= usd;
  state.positions[sym] = { entry: price, usd, qty: usd / price, openedAt: Date.now(), peakPnl: 0, votes: v.bull };
  persist();
  notify(`🟢 <b>INDI Kauf ${sym.replace("USDT", "")}</b> (Paper)\n${usd.toFixed(0)}$ @ ${price}\nSignale (${v.bull.length}/7): ${v.bull.join(", ")}\nRest-Guthaben: ${state.balance.toFixed(2)}$`).catch(() => {});
}

function closePos(sym, price, grund) {
  const pos = state.positions[sym];
  if (!pos) return;
  const out = pos.qty * price;
  const pnl = out - pos.usd;
  const pnlPct = (pnl / pos.usd) * 100;
  state.balance += out;
  delete state.positions[sym];
  persist();
  logTrade({ symbol: sym.replace("USDT", ""), entry: pos.entry, exit: price, sizeUsd: pos.usd,
             pnlUsd: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(2), grund,
             haltedauerMin: +((Date.now() - pos.openedAt) / 60e3).toFixed(0), votes: pos.votes });
  notify(`${pnl >= 0 ? "✅" : "❌"} <b>INDI Verkauf ${sym.replace("USDT", "")}</b> (Paper)\nPnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}$ (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%) · ${grund}\nGuthaben: ${(state.balance + offeneSumme()).toFixed(2)}$ (davon ${state.balance.toFixed(2)}$ frei)`).catch(() => {});
}
function offeneSumme() { return Object.values(state.positions).reduce((s, p) => s + p.usd, 0); }

// ── Signal-Scan: läuft einmal pro abgeschlossener 15m-Kerze ──
let scanBusy = false;
let lastScan = { ts: null, geprueft: 0, kandidaten: [], fehler: 0 };
async function scan() {
  if (scanBusy) return; scanBusy = true;
  const naehe = [];   // Kandidaten kurz vor einem Kaufsignal
  let geprueft = 0, fehler = 0;
  try {
    for (const sym of await topSymbols()) {
      try {
        const candles = await fetchCandles(sym);
        if (candles.length < 60) continue;
        const v = votes(candles);
        geprueft++;
        const price = candles[candles.length - 1].c;
        const offen = !!state.positions[sym];
        if (v.bull.length > 0 && !offen)
          naehe.push({ sym: sym.replace("USDT", ""), n: v.bull.length, sig: v.bull });
        if (!offen && v.bull.length >= cfg.INDI_MIN_VOTES && Object.keys(state.positions).length < cfg.INDI_MAX_POS)
          openPos(sym, price, v);
        else if (offen && v.bear.length >= cfg.INDI_MIN_VOTES)
          closePos(sym, price, `bärische Konfluenz (${v.bear.join(", ")})`);
        await new Promise(r => setTimeout(r, 120));   // Binance-Limits schonen
      } catch (e) { fehler++; console.error(`[INDI] ${sym}:`, e.message); }
    }
    naehe.sort((a, b) => b.n - a.n);
    lastScan = { ts: Date.now(), geprueft, kandidaten: naehe.slice(0, 3), fehler };
  } finally { scanBusy = false; }
}

// ── Exit-Überwachung: jede Minute TP / SL / Trailing auf aktuellen Preisen ──
async function exitTick() {
  const syms = Object.keys(state.positions);
  if (!syms.length) return;
  let tickers;
  try { tickers = await fetchJson(`${BINANCE}/api/v3/ticker/price`); } catch { return; }
  const priceMap = Object.fromEntries(tickers.map(t => [t.symbol, +t.price]));
  for (const sym of syms) {
    const pos = state.positions[sym];
    const price = priceMap[sym];
    if (!price) continue;
    const pnl = ((price - pos.entry) / pos.entry) * 100;
    if (pnl > pos.peakPnl) { pos.peakPnl = +pnl.toFixed(2); persist(); }
    if (pnl >= cfg.INDI_TP_PCT) { closePos(sym, price, `take-profit (+${pnl.toFixed(1)}%)`); continue; }
    if (pnl <= cfg.INDI_SL_PCT) { closePos(sym, price, `stop-loss (${pnl.toFixed(1)}%)`); continue; }
    if (pos.peakPnl >= cfg.INDI_TRAIL_ARM) {
      const stufe = Math.floor(pos.peakPnl / cfg.INDI_TRAIL_STEP) * cfg.INDI_TRAIL_STEP - cfg.INDI_TRAIL_STEP;
      if (pnl <= stufe) closePos(sym, price, `trailing-stop (Stop ${stufe >= 0 ? "+" : ""}${stufe}%, Peak +${pos.peakPnl}%)`);
    }
  }
}

// ── Status & Bilanz für Telegram ──
function status() {
  const offen = Object.entries(state.positions).map(([s, p]) =>
    `${s.replace("USDT", "")}: ${p.usd.toFixed(0)}$ @ ${p.entry} (Peak +${p.peakPnl}%)`);
  return { balance: state.balance, offen, gesamt: state.balance + offeneSumme(), lastScan };
}
// Menschenlesbares Lebenszeichen: wann zuletzt gescannt, wie viele Coins, wer ist nah dran.
function heartbeatText() {
  if (!lastScan.ts) return "⏳ Noch kein Scan gelaufen (erster kommt nach dem nächsten 15-Min-Kerzenschluss).";
  const minAgo = Math.round((Date.now() - lastScan.ts) / 60e3);
  const kand = lastScan.kandidaten.length
    ? lastScan.kandidaten.map(k => `${k.sym} ${k.n}/7 (${k.sig.join(",")})`).join("\n")
    : "keiner mit aktivem Signal";
  return `💓 <b>Indi-Heartbeat</b>\nLetzter Scan: vor ${minAgo} Min · ${lastScan.geprueft} Coins geprüft${lastScan.fehler ? ` · ${lastScan.fehler} Fehler` : ""}\n` +
    `Offene Positionen: ${Object.keys(state.positions).length} · frei ${state.balance.toFixed(2)}$\n` +
    `Nächste Kandidaten (Schwelle ${cfg.INDI_MIN_VOTES}/7):\n${kand}`;
}
function bilanz() {
  const arr = load(TRADES, []);
  if (!arr.length) return { n: 0 };
  const pnl = arr.reduce((s, t) => s + t.pnlUsd, 0);
  const wins = arr.filter(t => t.pnlUsd > 0);
  const sorted = [...arr].sort((a, b) => b.pnlUsd - a.pnlUsd);
  return { n: arr.length, pnlUsd: +pnl.toFixed(2), winRate: +(wins.length / arr.length * 100).toFixed(0),
           best: sorted[0], worst: sorted[sorted.length - 1],
           avgHaltMin: +(arr.reduce((s, t) => s + (t.haltedauerMin || 0), 0) / arr.length).toFixed(0) };
}

// ── Scheduler: Scan kurz nach jedem 15m-Kerzenschluss, Exits im Minutentakt ──
let lastSlot = null;
let lastHeartbeat = 0;
function start() {
  if (!cfg.INDI_ENABLED) return;
  setInterval(() => {
    const slot = Math.floor(Date.now() / (15 * 60e3));
    if (slot !== lastSlot && Date.now() % (15 * 60e3) > 20e3) {   // 20s Puffer nach Kerzenschluss
      lastSlot = slot;
      scan().catch(e => console.error("[INDI] scan:", e.message));
    }
    // Stündliches Lebenszeichen (nur wenn eingeschaltet), unabhängig vom Handel.
    if (cfg.INDI_HEARTBEAT && Date.now() - lastHeartbeat >= cfg.INDI_HEARTBEAT_MIN * 60e3) {
      lastHeartbeat = Date.now();
      notify(heartbeatText()).catch(() => {});
    }
  }, 30e3);
  setInterval(() => { exitTick().catch(() => {}); }, 60e3);
  console.log(`[INDI] Engine aktiv: Top-${cfg.INDI_TOP_N} Symbole, 15m, ${cfg.INDI_MIN_VOTES}/7 bull, /6 bear, virtuell ${cfg.INDI_START_USD}$`);
}

module.exports = { start, scan, exitTick, votes, status, heartbeatText, bilanz, state };
