// src/blacklist.js – lernt Serien-Rugger: Ersteller-Wallets, deren Coins
// wiederholt illiquide sterben oder >60% verlieren, werden gesperrt.
const fs = require("fs");
const path = require("path");
const FILE = path.join(process.cwd(), "data", "blacklist.json");

let db = { creators: {} };  // addr -> { launches: [ts...], rugs: n }
try { db = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}

let dirty = false;
function save() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(db));
  } catch (e) { console.error("blacklist save", e.message); }
}
setInterval(save, 60e3);

function entry(addr) {
  if (!db.creators[addr]) db.creators[addr] = { launches: [], rugs: 0 };
  return db.creators[addr];
}

function recordLaunch(addr) {
  if (!addr) return;
  const e = entry(addr);
  const cut = Date.now() - 24 * 3600e3;
  e.launches = e.launches.filter(t => t > cut);
  e.launches.push(Date.now());
  dirty = true;
}

function recordRug(addr) {
  if (!addr) return;
  entry(addr).rugs++;
  dirty = true;
}

// Gesperrt: >=2 geruggte Coins ODER >=4 Launches in 24h (Serien-Spammer)
function isBlocked(addr) {
  const e = addr && db.creators[addr];
  if (!e) return null;
  if (e.rugs >= 2) return `Serien-Rugger (${e.rugs} Rugs)`;
  if (e.launches.length >= 4) return `Serien-Launcher (${e.launches.length} Launches/24h)`;
  return null;
}

module.exports = { recordLaunch, recordRug, isBlocked };
