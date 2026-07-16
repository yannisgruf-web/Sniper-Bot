// src/sol-price.js – SOL/USD, minütlich aktualisiert (Binance)
let price = 0, last = 0;
async function solUsd() {
  if (Date.now() - last < 60e3 && price > 0) return price;
  try {
    const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT");
    const d = await r.json();
    if (d && d.price) { price = +d.price; last = Date.now(); return price; }
  } catch (e) { console.error("solUsd fetch fehlgeschlagen:", e.message); }
  // Fallback: letzter bekannter Wert, sonst grober Näherungswert (NIE 0 -> sonst zeigt Guthaben fälschlich $0)
  return price || 150;
}
module.exports = { solUsd };
