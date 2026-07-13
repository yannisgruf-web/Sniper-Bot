// src/push.js – Web-Push an die Cockpit-PWA (gleiche VAPID-Keys, gleiche Subscriptions)
const webpush = require("web-push");
const { getJSON, setJSON } = require("./store");
const cfg = require("./config");

const SUB_KEY = "subscriptions";
let sentThisHour = 0, hourStart = Date.now();

function rateOk() {
  if (Date.now() - hourStart > 3600e3) { hourStart = Date.now(); sentThisHour = 0; }
  return sentThisHour < cfg.MAX_PUSH_PER_HOUR;
}

async function sendPush(title, body, url) {
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) { console.error("VAPID-Keys fehlen – Push übersprungen"); return false; }
  if (!rateOk()) { console.log("Push-Limit/h erreicht – übersprungen:", title); return false; }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:me@example.com", pub, priv);
  const subs = await getJSON(SUB_KEY, []);
  if (!subs.length) { console.log("Keine Push-Subscriptions vorhanden"); return false; }
  const payload = JSON.stringify({ title, body, url: url || "/" });
  const alive = [];
  for (const s of subs) {
    try { await webpush.sendNotification(s, payload); alive.push(s); }
    catch (e) { if (![404, 410].includes(e.statusCode)) alive.push(s); }
  }
  if (alive.length !== subs.length) await setJSON(SUB_KEY, alive);
  sentThisHour++;
  return true;
}
module.exports = { sendPush };
