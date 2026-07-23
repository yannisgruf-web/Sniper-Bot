// backtest/download.js – lädt historische 15m-Kerzen von Binance und legt sie
// als Cache auf die Festplatte. Einmal geladen, danach beliebig oft nutzbar.
// 1h und 4h werden NICHT separat geladen, sondern aus den 15m-Kerzen aggregiert.
const fs = require("fs");
const path = require("path");

const BASE = process.env.BT_SOURCE_URL || "https://data-api.binance.vision";
const CACHE = path.join(__dirname, "data");
const START = Date.parse(process.env.BT_START || "2024-01-01T00:00:00Z");
const ENDE = Date.parse(process.env.BT_END || "2026-07-01T00:00:00Z");
const TOP_N = +(process.env.BT_TOP_N || 100);

const AUSSCHLUSS = /^(USDC|FDUSD|TUSD|USDP|DAI|BUSD|EUR|TRY|BRL|ARS|WBTC|WBETH|BETH|USDT)USDT$/;

async function fetchJson(url, versuche = 4) {
  for (let i = 0; i < versuche; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(url, { signal: ctl.signal });
      clearTimeout(t);
      if (r.status === 429 || r.status === 418) { await sleep(5000 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === versuche - 1) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Die TOP_N liquidesten USDT-Paare (24h-Volumen) – dasselbe Kriterium wie live.
async function topSymbols() {
  if (process.env.BT_SYMBOLS)
    return process.env.BT_SYMBOLS.split(",").map(s => {
      const u = s.trim().toUpperCase(); return u.endsWith("USDT") ? u : u + "USDT";
    });
  const all = await fetchJson(`${BASE}/api/v3/ticker/24hr`);
  return all.filter(t => t.symbol.endsWith("USDT") && !AUSSCHLUSS.test(t.symbol))
    .map(t => ({ symbol: t.symbol, vol: +t.quoteVolume }))
    .sort((a, b) => b.vol - a.vol).slice(0, TOP_N).map(t => t.symbol);
}

// Kerzen eines Symbols über den ganzen Zeitraum, seitenweise à 1000 Stück.
async function ladeSymbol(sym) {
  const datei = path.join(CACHE, `${sym}-15m.json`);
  if (fs.existsSync(datei)) {
    const alt = JSON.parse(fs.readFileSync(datei, "utf8"));
    if (alt.length && alt[0][0] <= START + 864e5 && alt[alt.length - 1][0] >= ENDE - 864e5) return alt.length;
  }
  const out = [];
  let cursor = START;
  while (cursor < ENDE) {
    const url = `${BASE}/api/v3/klines?symbol=${sym}&interval=15m&startTime=${cursor}&limit=1000`;
    let raw;
    try { raw = await fetchJson(url); }
    catch (e) { console.error(`  ${sym}: ${e.message} – überspringe Rest`); break; }
    if (!raw || !raw.length) break;
    // Kompakt speichern: [openTime, o, h, l, c, v]
    for (const k of raw) {
      if (k[0] >= ENDE) break;
      out.push([k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]);
    }
    const letzte = raw[raw.length - 1][0];
    if (letzte <= cursor) break;
    cursor = letzte + 1;
    await sleep(120);                       // Binance-Limits schonen
  }
  if (out.length) {
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(datei, JSON.stringify(out));
  }
  return out.length;
}

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  console.log(`Zeitraum: ${new Date(START).toISOString().slice(0, 10)} bis ${new Date(ENDE).toISOString().slice(0, 10)}`);
  const syms = await topSymbols();
  console.log(`${syms.length} Symbole werden geladen.\n`);
  const t0 = Date.now();
  let gesamt = 0;
  for (let i = 0; i < syms.length; i++) {
    const n = await ladeSymbol(syms[i]);
    gesamt += n;
    const proSek = (i + 1) / ((Date.now() - t0) / 1000);
    const restSek = (syms.length - i - 1) / proSek;
    console.log(`[${i + 1}/${syms.length}] ${syms[i]}: ${n} Kerzen · noch ca. ${Math.round(restSek / 60)} Min`);
  }
  fs.writeFileSync(path.join(CACHE, "symbols.json"), JSON.stringify(syms));
  console.log(`\nFertig: ${gesamt.toLocaleString("de")} Kerzen in ${Math.round((Date.now() - t0) / 60000)} Minuten.`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { topSymbols, ladeSymbol, CACHE };
