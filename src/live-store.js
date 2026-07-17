// src/live-store.js – persistiert offene LIVE-Positionen auf Platte.
// Ohne das gehen bei jedem Railway-Neustart die offenen Positionen verloren
// (Coins bleiben in der Wallet liegen und werden nie verkauft).
const fs = require("fs");
const path = require("path");
const FILE = path.join(process.cwd(), "data", "live-positions.json");

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch { return {}; }
}
function save(obj) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(obj));
  } catch (e) { console.error("live-store save:", e.message); }
}
module.exports = { load, save };
