// src/risk.js – Tagesverlust-Wächter + globaler Kill-Switch.
// Schaltet Live-Käufe ab, sobald der realisierte Tagesverlust das Limit reißt.
// Verkäufe bleiben IMMER erlaubt (man muss aus offenen Positionen rauskommen).
const cfg = require("./config");

let dayKey = new Date().toISOString().slice(0, 10);
let realizedUsdToday = 0;
let killed = false;
let killReason = null;

function rollDay() {
  const k = new Date().toISOString().slice(0, 10);
  if (k !== dayKey) { dayKey = k; realizedUsdToday = 0; if (killReason === "tageslimit") { killed = false; killReason = null; } }
}
function recordRealized(usd) { rollDay(); realizedUsdToday += usd; if (realizedUsdToday <= -Math.abs(cfg.DAILY_LOSS_LIMIT_USD)) { killed = true; killReason = "tageslimit"; } }
function kill(reason) { killed = true; killReason = reason || "manuell"; }
function reset() { killed = false; killReason = null; }
function canBuy() { rollDay(); return !killed; }
function status() { rollDay(); return { killed, killReason, realizedUsdToday: +realizedUsdToday.toFixed(2), limit: -Math.abs(cfg.DAILY_LOSS_LIMIT_USD) }; }

module.exports = { recordRealized, kill, reset, canBuy, status };
