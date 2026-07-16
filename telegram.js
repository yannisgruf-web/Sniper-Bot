// src/telegram.js – Alerts via Telegram-Bot (kostenlos, kein Netlify nötig)
const cfg = require("./config");

let sentThisHour = 0, hourStart = Date.now();
function rateOk() {
  if (Date.now() - hourStart > 3600e3) { hourStart = Date.now(); sentThisHour = 0; }
  return sentThisHour < cfg.MAX_PUSH_PER_HOUR;
}

// notifyLive: für echtes Geld – umgeht das Stundenlimit IMMER.
async function notifyLive(text) { return send(text, true); }
// notify: normale Signale – unterliegt dem Stundenlimit.
async function notify(text) { return send(text, false); }

async function send(text, bypassLimit) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat  = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) { console.log("Telegram nicht konfiguriert – Alert nur im Log:", text.split("\n")[0]); return false; }
  if (!bypassLimit && !rateOk()) { console.log("Telegram-Limit/h erreicht – übersprungen (nur Signale, Live-Meldungen gehen immer raus)"); return false; }
  // Telegram-Hardlimit ist 4096 Zeichen. Rohe Fehlermeldungen (z.B. Blockchain-Reverts mit
  // Hex-Daten) können das sprengen -> hart kürzen, damit eine Live-Meldung NIE verloren geht.
  if (text.length > 3900) text = text.slice(0, 3900) + "\n… (gekürzt)";
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: false })
    });
    if (!r.ok) { console.error("Telegram", r.status, (await r.text()).slice(0, 120)); return false; }
    sentThisHour++;
    return true;
  } catch (e) { console.error("Telegram", e.message); return false; }
}
module.exports = { notify, notifyLive };
