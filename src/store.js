// src/store.js – Zugriff auf denselben Netlify-Blob-Store wie die Cockpit-PWA
const { getStore } = require("@netlify/blobs");

function store() {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_BLOBS_TOKEN;
  if (!siteID || !token) throw new Error("NETLIFY_SITE_ID / NETLIFY_BLOBS_TOKEN fehlen");
  return getStore({ name: "btc-cockpit", siteID, token });
}
async function getJSON(key, fallback) {
  try { const v = await store().get(key, { type: "json" }); return v ?? fallback; }
  catch (e) { console.error("blob get", key, e.message); return fallback; }
}
async function setJSON(key, val) {
  try { await store().setJSON(key, val); }
  catch (e) { console.error("blob set", key, e.message); }
}
module.exports = { getJSON, setJSON };
