// backtest/run.js – rechnet alle Parameter-Kombinationen über die drei Zeiträume.
//
// Suchzeitraum   2024      -> hier darf man Parameter aussuchen
// Prüfzeitraum   2025      -> unangetastet, prüft ob der Fund kein Zufall war
// Testzeitraum   2026 H1   -> letzter Beweis, wird nur einmal angeschaut
//
// Eine Konfiguration zählt nur, wenn sie in ALLEN DREI positiv ist.
const fs = require("fs");
const path = require("path");
const eng = require("./engine");
const ind = require("../src/indicators");

const CACHE = path.join(__dirname, "data");
const ERGEBNIS = path.join(__dirname, "ergebnisse");

const ZEITRAEUME = [
  { name: "Suche 2024",  von: Date.parse("2024-01-01"), bis: Date.parse("2025-01-01") },
  { name: "Prüf 2025",   von: Date.parse("2025-01-01"), bis: Date.parse("2026-01-01") },
  { name: "Test 2026H1", von: Date.parse("2026-01-01"), bis: Date.parse("2026-07-01") },
];

const TF = { "15m": 1, "1h": 4, "4h": 16 };

// ── Parameterraum ──
function kombinationen() {
  const out = [];
  for (const tf of (process.env.BT_TFS || "15m,1h,4h").split(","))
  for (const minVotes of [2, 3, 4])
  for (const momentum of [false, true])
  for (const atrStop of [false, true])
  for (const trendFilter of [false, true]) {
    out.push({
      id: `${tf}|v${minVotes}|${momentum ? "mom" : "---"}|${atrStop ? "atr" : "pct"}|${trendFilter ? "tf" : "--"}`,
      tf, minVotes, momentum, atrStop, trendFilter,
      // Feste Werte (entsprechen den Live-Defaults)
      shorts: true, hebel: 2, feePct: 0.1,
      tpPct: 5, slPct: -3, trailArm: 2, trailStep: 1,
      momentumAdx: 30, momBodyPct: 2, momVolMult: 2,
      atrScope: "momentum", atrMult: 2, atrTpMult: 3, atrTrailMult: 2,
      trendStrict: false, adxMax: 30,
    });
  }
  return out;
}

// ── Selbsttest: stimmen die Serien-Varianten mit den Live-Funktionen überein? ──
function selbsttest() {
  const c = [];
  let p = 100;
  for (let i = 0; i < 400; i++) {
    p *= 1 + (Math.sin(i / 7) * 0.01 + (Math.random() - 0.5) * 0.008);
    c.push({ t: i * 9e5, o: p * 0.999, h: p * 1.004, l: p * 0.996, c: p, v: 1000 + Math.random() * 500 });
  }
  const adxS = eng.adxSerie(c), atrS = eng.atrSerie(c);
  const closes = c.map(k => k.c);
  const emaS = eng.emaTrendSerie(closes), vwapS = eng.vwapSideSerie(c);
  let fehler = 0;
  for (const i of [250, 300, 350, 399]) {
    const teil = c.slice(0, i + 1);
    const a1 = adxS[i], a2 = ind.adx(teil);
    const t1 = atrS[i], t2 = ind.atr(teil);
    const e1 = emaS[i], e2 = ind.emaTrend(teil.map(k => k.c));
    const v1 = vwapS[i], v2 = ind.vwapSide(teil);
    const nah = (x, y) => x != null && y != null && Math.abs(x - y) / (Math.abs(y) || 1) < 1e-6;
    if (!nah(a1, a2)) { console.log(`  ADX  i=${i}: Serie ${a1?.toFixed(4)} vs Live ${a2?.toFixed(4)}`); fehler++; }
    if (!nah(t1, t2)) { console.log(`  ATR  i=${i}: Serie ${t1?.toFixed(6)} vs Live ${t2?.toFixed(6)}`); fehler++; }
    if (e1 !== e2)    { console.log(`  EMA  i=${i}: Serie ${e1} vs Live ${e2}`); fehler++; }
    if (v1 !== v2)    { console.log(`  VWAP i=${i}: Serie ${v1} vs Live ${v2}`); fehler++; }
  }
  return fehler;
}

function auswerten(trades) {
  if (!trades.length) return { n: 0, netto: 0, brutto: 0, treffer: 0, dauer: 0 };
  const netto = trades.reduce((s, t) => s + t.nettoPct, 0);
  const brutto = trades.reduce((s, t) => s + t.bruttoPct, 0);
  const wins = trades.filter(t => t.nettoPct > 0).length;
  return {
    n: trades.length,
    netto: +netto.toFixed(1),                       // Summe der Renditen je Einsatz, in %
    brutto: +brutto.toFixed(1),
    treffer: +(wins / trades.length * 100).toFixed(0),
    dauer: +(trades.reduce((s, t) => s + t.dauerKerzen, 0) / trades.length).toFixed(1),
  };
}

async function main() {
  console.log("Selbsttest der Indikator-Serien...");
  const f = selbsttest();
  if (f) { console.error(`ABBRUCH: ${f} Abweichungen zur Live-Logik.`); process.exit(1); }
  console.log("  Serien stimmen mit der Live-Logik überein.\n");

  const symDatei = path.join(CACHE, "symbols.json");
  if (!fs.existsSync(symDatei)) { console.error("Keine Daten. Erst 'node backtest/download.js' ausführen."); process.exit(1); }
  const symbole = JSON.parse(fs.readFileSync(symDatei, "utf8"))
    .filter(s => fs.existsSync(path.join(CACHE, `${s}-15m.json`)));
  const kombis = kombinationen();
  console.log(`${symbole.length} Coins · ${kombis.length} Kombinationen · 3 Zeiträume`);

  // Ergebnis-Sammler: [kombiId][zeitraum] -> Trades
  const sammler = new Map();
  for (const k of kombis) sammler.set(k.id, ZEITRAEUME.map(() => []));

  const t0 = Date.now();
  for (let si = 0; si < symbole.length; si++) {
    const sym = symbole[si];
    let roh;
    try { roh = JSON.parse(fs.readFileSync(path.join(CACHE, `${sym}-15m.json`), "utf8")); }
    catch { continue; }
    const c15 = roh.map(r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
    if (c15.length < 3000) continue;

    // Signale je Zeitrahmen EINMAL berechnen
    const sigCache = {};
    for (const [tfName, faktor] of Object.entries(TF)) {
      if (!kombis.some(k => k.tf === tfName)) continue;
      const cc = eng.aggregiere(c15, faktor);
      if (cc.length < 400) continue;
      sigCache[tfName] = eng.berechneSignale(cc);
    }

    // Alle Kombis über die vorberechneten Signale
    for (const k of kombis) {
      const sig = sigCache[k.tf];
      if (!sig) continue;
      const trades = eng.simuliere(sig, k);
      const ziel = sammler.get(k.id);
      for (const t of trades) {
        for (let z = 0; z < ZEITRAEUME.length; z++)
          if (t.t >= ZEITRAEUME[z].von && t.t < ZEITRAEUME[z].bis) { ziel[z].push(t); break; }
      }
    }

    const proSek = (si + 1) / ((Date.now() - t0) / 1000);
    const rest = Math.round((symbole.length - si - 1) / proSek);
    if (si % 5 === 0 || si === symbole.length - 1)
      console.log(`[${si + 1}/${symbole.length}] ${sym} · noch ca. ${Math.floor(rest / 60)}:${String(rest % 60).padStart(2, "0")} Min`);
  }

  // ── Auswertung ──
  const zeilen = [];
  for (const k of kombis) {
    const perioden = sammler.get(k.id).map(auswerten);
    zeilen.push({ id: k.id, perioden,
      robust: perioden.every(p => p.n >= 30 && p.netto > 0),
      summeNetto: +perioden.reduce((s, p) => s + p.netto, 0).toFixed(1) });
  }
  zeilen.sort((a, b) => b.summeNetto - a.summeNetto);

  fs.mkdirSync(ERGEBNIS, { recursive: true });
  fs.writeFileSync(path.join(ERGEBNIS, "ergebnisse.json"), JSON.stringify(zeilen, null, 1));

  const kopf = "Konfiguration".padEnd(30) + ZEITRAEUME.map(z => z.name.padStart(22)).join("") + "   robust";
  const linien = [kopf, "-".repeat(kopf.length)];
  for (const z of zeilen.slice(0, 30)) {
    const teile = z.perioden.map(p => (p.n ? `${p.netto > 0 ? "+" : ""}${p.netto}% (${p.n}T,${p.treffer}%)` : "keine Trades").padStart(22));
    linien.push(z.id.padEnd(30) + teile.join("") + (z.robust ? "   JA ***" : ""));
  }
  const robusteZahl = zeilen.filter(z => z.robust).length;
  linien.push("", `Robuste Konfigurationen (alle 3 Zeiträume positiv, je >=30 Trades): ${robusteZahl} von ${zeilen.length}`);
  if (!robusteZahl) linien.push("=> Keine Konfiguration hat den Test bestanden.");
  const text = linien.join("\n");
  fs.writeFileSync(path.join(ERGEBNIS, "ergebnisse.txt"), text);
  console.log("\n" + text);
  console.log(`\nGesamtlaufzeit: ${Math.round((Date.now() - t0) / 60000)} Minuten`);
  console.log(`Details: backtest/ergebnisse/ergebnisse.json`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { kombinationen, auswerten, selbsttest };
