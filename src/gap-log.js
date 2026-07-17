// src/gap-log.js – misst pro Live-Trade die Ausführungslücke:
// "Anzeige-PnL" (DexScreener-Preis, das was Paper glauben würde) vs.
// "realisierter PnL" (was der Verkauf wirklich erlöst hat).
// Das ist DIE Messung für die Kernfrage des Projekts: Wie viel vom
// Paper-Edge überlebt die echte Ausführung?
const fs = require("fs");
const path = require("path");
const FILE = path.join(process.cwd(), "data", "gap-log.json");

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch { return []; }
}
function save(arr) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(arr, null, 1));
  } catch (e) { console.error("gap-log save:", e.message); }
}

// Einen abgeschlossenen Live-Trade protokollieren.
function add(entry) {
  const arr = load();
  arr.push({ ts: new Date().toISOString(), ...entry });
  save(arr);
  return arr;
}

// Laufende Statistik über alle bisher gemessenen Trades (nur die mit beiden Werten).
function stats() {
  const arr = load().filter(e => e.anzeigePnlPct != null && e.realPnlPct != null);
  if (!arr.length) return { n: 0 };
  const gaps = arr.map(e => e.anzeigePnlPct - e.realPnlPct);
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { n: arr.length, avgGapPp: +avg.toFixed(1), medianGapPp: +median.toFixed(1) };
}

module.exports = { add, stats, load };
