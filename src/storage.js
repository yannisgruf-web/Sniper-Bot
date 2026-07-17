// src/storage.js – Trade-Log als lokale JSON-Datei (./data/trades.json).
// Hinweis: Railway-Dateisystem ist fluechtig bei Re-Deploys; fuer dauerhafte
// Historie ein Railway Volume auf /app/data mounten (optional, 1 Klick).
const fs = require("fs");
const path = require("path");
const DIR = path.join(process.cwd(), "data");
const FILE = path.join(DIR, "trades.json");

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch { return { trades: [], updated: null }; }
}
function save(obj) {
  try {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.error("storage save", e.message); }
}
module.exports = { load, save };
