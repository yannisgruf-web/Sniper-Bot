// src/sol-price.js – SOL/USD, minütlich aktualisiert (Binance)
let price = 0, last = 0;
async function solUsd() {
  if (Date.now() - last < 60e3 && price > 0) return price;
  try {
    const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT");
    const d = await r.json();
    if (d && d.price) { price = +d.price; last = Date.now(); }
  } catch (e) { /* alter Wert bleibt */ }
  return price || 0;
}
module.exports = { solUsd };
