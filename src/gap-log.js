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

// Vollständige Bilanz: ALLE Abschlüsse (normale Verkäufe + Rugs), für /bilanz.
function bilanz() {
  const all = load();
  if (!all.length) return { n: 0 };
  const rugs = all.filter(e => e.rug);
  const normal = all.filter(e => !e.rug);
  const gaps = normal.filter(e => e.gapPp != null);
  const pnlUsd = e => (e.erloesUsd || 0) - (e.sizeUsd || 0);
  const totalPnl = all.reduce((s, e) => s + pnlUsd(e), 0);
  const sortedByPnl = [...normal].sort((a, b) => pnlUsd(b) - pnlUsd(a));
  const best = sortedByPnl[0], worst = sortedByPnl[sortedByPnl.length - 1];
  const avgGap = gaps.length ? gaps.reduce((s, e) => s + e.gapPp, 0) / gaps.length : null;
  return {
    n: all.length,
    rugs: rugs.length,
    rugRatePct: +(rugs.length / all.length * 100).toFixed(0),
    totalPnlUsd: +totalPnl.toFixed(2),
    avgGapPp: avgGap != null ? +avgGap.toFixed(1) : null,
    best: best ? { symbol: best.symbol, pnl: +pnlUsd(best).toFixed(2) } : null,
    worst: worst ? { symbol: worst.symbol, pnl: +pnlUsd(worst).toFixed(2) } : null,
    totalSizeUsd: +all.reduce((s, e) => s + (e.sizeUsd || 0), 0).toFixed(2),
  };
}

module.exports = { add, stats, bilanz, load };
