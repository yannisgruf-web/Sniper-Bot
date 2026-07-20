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

// Datenquelle umschaltbar: Binance sperrt viele Cloud-/US-IPs. data.api.binance.vision
// ist ein sperrfreier Read-Only-Spiegel; Bybit und OKX sind vollwertige Alternativen.
const QUELLE = (process.env.INDI_SOURCE || "binance-vision").toLowerCase();
const HOSTS = {
  "binance":        "https://api.binance.com",
  "binance-vision": "https://data-api.binance.vision",
  "bybit":          "https://api.bybit.com",
  "okx":            "https://www.okx.com",
};
const BASE = HOSTS[QUELLE] || HOSTS["binance-vision"];

// Statische Fallback-Liste (falls die Volumen-Abfrage scheitert)
const DEFAULT_SYMBOLS = ("BTC,ETH,BNB,SOL,XRP,ADA,DOGE,AVAX,DOT,LINK,TON,MATIC,ICP,SHIB,LTC,BCH,UNI,ATOM,ETC,XLM," +
  "NEAR,APT,FIL,ARB,OP,VET,INJ,GRT,ALGO,FTM,THETA,RUNE,SEI,SUI,TIA,IMX,LDO,STX,EGLD,FLOW," +
  "SAND,MANA,AXS,AAVE,MKR,SNX,CRV,KAVA,ROSE,CHZ").split(",").map(s => s.trim() + "USDT");

// Stablecoins & gewrappte Token, die nie gehandelt werden sollen (kein echtes Momentum).
const AUSSCHLUSS = /^(USDC|FDUSD|TUSD|USDP|DAI|BUSD|EUR|WBTC|WBETH|BETH|USDT)USDT$/;

let symbolCache = { list: null, ts: 0 };
// Top-N liquideste USDT-Paare nach 24h-Quote-Volumen, 1h gecacht. Quellenabhängig.
async function topSymbols() {
  if (process.env.INDI_SYMBOLS)
    return process.env.INDI_SYMBOLS.split(",").map(s => { const u = s.trim().toUpperCase(); return u.endsWith("USDT") ? u : u + "USDT"; });
  if (symbolCache.list && Date.now() - symbolCache.ts < 3600e3) return symbolCache.list;
  try {
    let paare = [];
    if (QUELLE === "bybit") {
      const j = await fetchJson(`${BASE}/v5/market/tickers?category=spot`);
      paare = (j.result?.list || []).filter(t => t.symbol.endsWith("USDT"))
        .map(t => ({ symbol: t.symbol, vol: +t.turnover24h }));
    } else if (QUELLE === "okx") {
      const j = await fetchJson(`${BASE}/api/v5/market/tickers?instType=SPOT`);
      paare = (j.data || []).filter(t => t.instId.endsWith("-USDT"))
        .map(t => ({ symbol: t.instId.replace("-", ""), vol: +t.volCcy24h }));
    } else {
      const all = await fetchJson(`${BASE}/api/v3/ticker/24hr`);
      paare = all.filter(t => t.symbol.endsWith("USDT")).map(t => ({ symbol: t.symbol, vol: +t.quoteVolume }));
    }
    const ranked = paare.filter(t => !AUSSCHLUSS.test(t.symbol))
      .sort((a, b) => b.vol - a.vol).slice(0, cfg.INDI_TOP_N).map(t => t.symbol);
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
  if (QUELLE === "bybit") {
    const j = await fetchJson(`${BASE}/v5/market/kline?category=spot&symbol=${sym}&interval=15&limit=250`);
    const list = (j.result?.list || []).slice().reverse();   // Bybit liefert neueste zuerst
    return list.slice(0, -1).map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  }
  if (QUELLE === "okx") {
    const inst = sym.replace("USDT", "-USDT");
    const j = await fetchJson(`${BASE}/api/v5/market/candles?instId=${inst}&bar=15m&limit=250`);
    const list = (j.data || []).slice().reverse();           // OKX liefert neueste zuerst
    return list.slice(0, -1).map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  }
  const raw = await fetchJson(`${BASE}/api/v3/klines?symbol=${sym}&interval=15m&limit=250`);
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

// ── Trend-Gate: erlaubt/verbietet eine Richtung anhand von EMA-Trend, VWAP und ADX.
// Kein Signal, sondern ein Filter ÜBER den Oszillator-Stimmen. Gibt zurück, ob
// die gewünschte Richtung ("long"/"short") gehandelt werden darf, plus Begründung.
function trendGate(candles, side) {
  if (!cfg.INDI_TREND_FILTER) return { ok: true, grund: "Filter aus" };
  const closes = candles.map(k => k.c);
  const richtung = side === "short" ? -1 : 1;
  const gruende = [];

  // 1. EMA-Trend muss zur Richtung passen (oder neutral sein, je nach Strenge).
  const et = ind.emaTrend(closes);
  if (cfg.INDI_TREND_STRICT ? et !== richtung : et === -richtung)
    return { ok: false, grund: `EMA-Trend ${et > 0 ? "aufwärts" : et < 0 ? "abwärts" : "neutral"} gegen ${side}` };
  gruende.push(`EMA ${et === richtung ? "pro" : "neutral"}`);

  // 2. VWAP-Seite darf der Richtung nicht widersprechen.
  const vw = ind.vwapSide(candles);
  if (vw === -richtung)
    return { ok: false, grund: `Preis ${vw > 0 ? "über" : "unter"} VWAP gegen ${side}` };
  gruende.push("VWAP ok");

  // 3. ADX: bei starkem Trend NICHT dagegen handeln. Gegen-Trend-Trades nur in
  // ruhigen Phasen (ADX niedrig), wo Mean-Reversion funktioniert.
  const ax = ind.adx(candles);
  if (ax != null) {
    const gegenTrend = (et !== 0 && et !== richtung);
    if (gegenTrend && ax >= cfg.INDI_ADX_MAX)
      return { ok: false, grund: `ADX ${ax.toFixed(0)} zu stark für Gegen-Trend-${side}` };
    gruende.push(`ADX ${ax.toFixed(0)}`);
  }
  return { ok: true, grund: gruende.join(", ") };
}

// ── Positionsverwaltung (long ODER short, mit optionalem Hebel) ──
function openPos(sym, price, v, side) {
  // Positionsgröße: entweder fester $-Betrag ODER prozentual vom GESAMTKAPITAL
  // (frei + in offenen Positionen gebundene Margin). Prozentual erzeugt den
  // Zinseszins-Effekt: wächst das Konto, wachsen die Positionen mit.
  const gesamtKapital = state.balance + offeneSumme();
  let einsatz = cfg.INDI_POS_PCT > 0 ? gesamtKapital * (cfg.INDI_POS_PCT / 100) : cfg.INDI_POS_USD;
  const usd = Math.min(einsatz, state.balance);   // nie mehr als frei verfügbar
  if (usd < 5) return;                             // Mindestgröße, sonst kein Trade
  state.balance -= usd;                            // nur der EINSATZ (Margin) wird gebunden
  const hebel = Math.max(1, cfg.INDI_LEVERAGE);
  const posWert = usd * hebel;                     // effektive Positionsgröße
  // Liquidationspreis: bei ~ (100/hebel)% Bewegung gegen die Position ist die Margin weg.
  const liqDistPct = (100 / hebel) * 0.9;
  const liqPrice = side === "short"
    ? price * (1 + liqDistPct / 100)
    : price * (1 - liqDistPct / 100);
  const sig = side === "short" ? v.bear : v.bull;
  state.positions[sym] = { side, entry: price, usd, hebel, posWert, liqPrice,
                           qty: posWert / price, openedAt: Date.now(), peakPnl: 0, votes: sig };
  persist();
  const pfeil = side === "short" ? "🔴📉" : "🟢";
  const wort = side === "short" ? "Short" : "Kauf";
  const max = side === "short" ? 6 : 7;
  const hebelInfo = hebel > 1 ? ` · ${hebel}x (Position ${posWert.toFixed(0)}$)` : "";
  const groessenInfo = cfg.INDI_POS_PCT > 0 ? ` (${cfg.INDI_POS_PCT}% v. ${gesamtKapital.toFixed(0)}$)` : "";
  notify(`${pfeil} <b>INDI ${wort} ${sym.replace("USDT", "")}</b> (Paper)\n${usd.toFixed(2)}$${groessenInfo}${hebelInfo} @ ${price}\nSignale (${sig.length}/${max}): ${sig.join(", ")}\nRest-Guthaben: ${state.balance.toFixed(2)}$`).catch(() => {});
}

function closePos(sym, price, grund) {
  const pos = state.positions[sym];
  if (!pos) return;
  const side = pos.side || "long";
  const hebel = pos.hebel || 1;
  const posWert = pos.posWert || pos.usd;    // Fallback für Alt-Positionen ohne Hebel-Feld
  // Kursbewegung in %, richtungsabhängig.
  const moveBruttoPct = side === "short"
    ? ((pos.entry - price) / pos.entry) * 100
    : ((price - pos.entry) / pos.entry) * 100;
  // Brutto-Gewinn/Verlust in $ = Bewegung × POSITIONSWERT (nicht Einsatz) -> Hebel wirkt.
  const bruttoUsd = posWert * (moveBruttoPct / 100);
  // Gebühren auf das Positionsvolumen (beide Seiten), Funding bei Shorts.
  const fee = cfg.INDI_FEE_PCT / 100;
  const gebuehrUsd = cfg.INDI_FEES ? posWert * fee * 2 : 0;
  const haltStd = (Date.now() - pos.openedAt) / 3600e3;
  const fundingUsd = (cfg.INDI_FEES && side === "short") ? posWert * (cfg.INDI_FUNDING_PCT / 100) * Math.max(1, Math.ceil(haltStd / 8)) : 0;
  let nettoUsd = bruttoUsd - gebuehrUsd - fundingUsd;
  // Verlust kann die Margin (den Einsatz) nicht übersteigen -> Liquidation kappt bei -Einsatz.
  if (nettoUsd < -pos.usd) nettoUsd = -pos.usd;
  const nettoPct = (nettoUsd / pos.usd) * 100;   // Rendite bezogen auf den EINSATZ
  state.balance += pos.usd + nettoUsd;
  delete state.positions[sym];
  persist();
  logTrade({ symbol: sym.replace("USDT", ""), side, hebel, entry: pos.entry, exit: price, sizeUsd: pos.usd,
             bruttoPct: +moveBruttoPct.toFixed(2), gebuehrUsd: +(gebuehrUsd + fundingUsd).toFixed(3),
             pnlUsd: +nettoUsd.toFixed(2), pnlPct: +nettoPct.toFixed(2), grund,
             haltedauerMin: +((Date.now() - pos.openedAt) / 60e3).toFixed(0), votes: pos.votes });
  const wort = side === "short" ? "Short-Exit" : "Verkauf";
  const kostenHinweis = cfg.INDI_FEES ? ` · Kosten ${(gebuehrUsd + fundingUsd).toFixed(2)}$` : "";
  const hebelHinweis = hebel > 1 ? ` · ${hebel}x` : "";
  notify(`${nettoUsd >= 0 ? "✅" : "❌"} <b>INDI ${wort} ${sym.replace("USDT", "")}</b> (Paper)\nNetto ${nettoUsd >= 0 ? "+" : ""}${nettoUsd.toFixed(2)}$ (${nettoPct >= 0 ? "+" : ""}${nettoPct.toFixed(1)}%)${hebelHinweis}${kostenHinweis} · ${grund}\nGuthaben: ${(state.balance + offeneSumme()).toFixed(2)}$ (davon ${state.balance.toFixed(2)}$ frei)`).catch(() => {});
}
function offeneSumme() { return Object.values(state.positions).reduce((s, p) => s + p.usd, 0); }

// ── Signal-Scan: läuft einmal pro abgeschlossener 15m-Kerze ──
let scanBusy = false;
let lastScan = { ts: null, geprueft: 0, kandidaten: [], fehler: 0 };
async function scan() {
  if (scanBusy) return; scanBusy = true;
  const naehe = [];   // Kandidaten kurz vor einem Kaufsignal
  let geprueft = 0, fehler = 0, letzterFehler = null;
  try {
    for (const sym of await topSymbols()) {
      try {
        const candles = await fetchCandles(sym);
        if (candles.length < 60) continue;
        const v = votes(candles);
        geprueft++;
        const price = candles[candles.length - 1].c;
        const pos = state.positions[sym];
        const slotsFrei = Object.keys(state.positions).length < cfg.INDI_MAX_POS;
        if (!pos) {
          // Kandidaten fürs Heartbeat sammeln (stärkere Seite zählt)
          if (v.bull.length > 0 || v.bear.length > 0) {
            const long = v.bull.length >= v.bear.length;
            naehe.push({ sym: sym.replace("USDT", ""), n: long ? v.bull.length : v.bear.length,
                         sig: long ? v.bull : v.bear, dir: long ? "L" : "S" });
          }
          // Einstieg: Long bei bullischer, Short bei bärischer Konfluenz (falls aktiviert).
          // Das Trend-Gate kann eine Richtung trotz Konfluenz verbieten.
          if (v.bull.length >= cfg.INDI_MIN_VOTES && slotsFrei) {
            const gate = trendGate(candles, "long");
            if (gate.ok) openPos(sym, price, v, "long");
            else console.log(`[INDI] Long ${sym} blockiert: ${gate.grund}`);
          }
          else if (cfg.INDI_SHORTS && v.bear.length >= cfg.INDI_MIN_VOTES && slotsFrei) {
            const gate = trendGate(candles, "short");
            if (gate.ok) openPos(sym, price, v, "short");
            else console.log(`[INDI] Short ${sym} blockiert: ${gate.grund}`);
          }
        } else {
          // Bestehende Position: schließen bei Gegen-Konfluenz.
          if (pos.side === "short" && v.bull.length >= cfg.INDI_MIN_VOTES)
            closePos(sym, price, `bullische Konfluenz (${v.bull.join(", ")})`);
          else if ((pos.side || "long") === "long" && v.bear.length >= cfg.INDI_MIN_VOTES)
            closePos(sym, price, `bärische Konfluenz (${v.bear.join(", ")})`);
        }
        await new Promise(r => setTimeout(r, 120));   // Binance-Limits schonen
      } catch (e) { fehler++; letzterFehler = e.message; console.error(`[INDI] ${sym}:`, e.message); }
    }
    naehe.sort((a, b) => b.n - a.n);
    lastScan = { ts: Date.now(), geprueft, kandidaten: naehe.slice(0, 3), fehler, letzterFehler };
  } finally { scanBusy = false; }
}

// ── Exit-Überwachung: jede Minute TP / SL / Trailing auf aktuellen Preisen ──
async function exitTick() {
  const syms = Object.keys(state.positions);
  if (!syms.length) return;
  // Aktuellen Preis je offener Position holen (letzte abgeschlossene Kerze).
  // Quellenunabhängig – nutzt denselben fetchCandles-Pfad wie der Scan.
  const priceMap = {};
  for (const sym of syms) {
    try { const c = await fetchCandles(sym); if (c.length) priceMap[sym] = c[c.length - 1].c; }
    catch (e) { console.error(`[INDI] exit-preis ${sym}:`, e.message); }
    await new Promise(r => setTimeout(r, 120));
  }
  for (const sym of syms) {
    const pos = state.positions[sym];
    const price = priceMap[sym];
    if (!price) continue;
    const hebel = pos.hebel || 1;
    // Liquidation zuerst prüfen: Preis jenseits der Schwelle -> Position ist wertlos.
    if (pos.liqPrice && ((pos.side === "short" && price >= pos.liqPrice) ||
                         ((pos.side || "long") === "long" && price <= pos.liqPrice))) {
      closePos(sym, pos.liqPrice, `💥 LIQUIDATION (${hebel}x)`);
      continue;
    }
    // Kursbewegung, dann mit Hebel auf Einsatz-Rendite skalieren.
    const movePct = (pos.side === "short")
      ? ((pos.entry - price) / pos.entry) * 100
      : ((price - pos.entry) / pos.entry) * 100;
    const pnl = movePct * hebel;                    // Rendite bezogen auf Einsatz
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
// Aktuellen PnL aller offenen Positionen live berechnen (holt Live-Preise).
async function statusLive() {
  const syms = Object.keys(state.positions);
  const zeilen = [];
  let offenerPnl = 0;
  for (const sym of syms) {
    const pos = state.positions[sym];
    const hebel = pos.hebel || 1;
    let price = pos.entry;
    try { const c = await fetchCandles(sym); if (c.length) price = c[c.length - 1].c; } catch {}
    const movePct = (pos.side === "short")
      ? ((pos.entry - price) / pos.entry) * 100
      : ((price - pos.entry) / pos.entry) * 100;
    const pnlPct = movePct * hebel;                 // gehebelte Rendite auf Einsatz
    const pnlUsd = pos.usd * (pnlPct / 100);
    offenerPnl += pnlUsd;
    const pfeil = pnlPct >= 0 ? "🟢" : "🔴";
    const dir = pos.side === "short" ? "S" : "L";
    const hb = hebel > 1 ? ` ${hebel}x` : "";
    zeilen.push(`${pfeil} ${sym.replace("USDT", "")} [${dir}${hb}]: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% (${pnlUsd >= 0 ? "+" : ""}${pnlUsd.toFixed(2)}$) · Peak +${pos.peakPnl}%`);
    await new Promise(r => setTimeout(r, 120));
  }
  return { balance: state.balance, offen: zeilen, gesamt: state.balance + offeneSumme() + offenerPnl, offenerPnl };
}
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
    ? lastScan.kandidaten.map(k => `${k.sym} [${k.dir}] ${k.n}/${k.dir === "S" ? 6 : 7} (${k.sig.join(",")})`).join("\n")
    : "keiner mit aktivem Signal";
  const fehlerZeile = lastScan.fehler ? `\n⚠️ ${lastScan.fehler} Fehler` + (lastScan.letzterFehler ? ` – ${String(lastScan.letzterFehler).slice(0, 120)}` : "") : "";
  return `💓 <b>Indi-Heartbeat</b> (Quelle: ${QUELLE})\nLetzter Scan: vor ${minAgo} Min · ${lastScan.geprueft} Coins geprüft${fehlerZeile}\n` +
    `Offene Positionen: ${Object.keys(state.positions).length} · frei ${state.balance.toFixed(2)}$\n` +
    `Nächste Kandidaten (Schwelle ${cfg.INDI_MIN_VOTES}/7):\n${kand}`;
}
function bilanz() {
  const arr = load(TRADES, []);
  if (!arr.length) return { n: 0 };
  const auswert = (trades) => {
    if (!trades.length) return null;
    const pnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
    const kosten = trades.reduce((s, t) => s + (t.gebuehrUsd || 0), 0);
    const wins = trades.filter(t => t.pnlUsd > 0);
    const sorted = [...trades].sort((a, b) => b.pnlUsd - a.pnlUsd);
    return { n: trades.length, pnlUsd: +pnl.toFixed(2), kostenUsd: +kosten.toFixed(2),
             winRate: +(wins.length / trades.length * 100).toFixed(0),
             best: sorted[0], worst: sorted[sorted.length - 1],
             avgHaltMin: +(trades.reduce((s, t) => s + (t.haltedauerMin || 0), 0) / trades.length).toFixed(0) };
  };
  const longs = arr.filter(t => (t.side || "long") === "long");
  const shorts = arr.filter(t => t.side === "short");
  return { n: arr.length, gesamt: auswert(arr), long: auswert(longs), short: auswert(shorts) };
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
  console.log(`[INDI] Engine aktiv (Quelle ${QUELLE}): Top-${cfg.INDI_TOP_N} Symbole, 15m, ${cfg.INDI_MIN_VOTES}er-Konfluenz, Shorts=${cfg.INDI_SHORTS ? "AN" : "aus"}, Hebel ${cfg.INDI_LEVERAGE}x, Größe ${cfg.INDI_POS_PCT > 0 ? cfg.INDI_POS_PCT + "%" : cfg.INDI_POS_USD + "$"}, virtuell ${cfg.INDI_START_USD}$`);
}

module.exports = { start, scan, exitTick, votes, status, statusLive, heartbeatText, bilanz, state };
