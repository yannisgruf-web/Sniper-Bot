// src/prices.js – SOL/BNB in USD. Mehrere Quellen, weil Binance US-IPs blockt (Railway US-West!).
// WICHTIG: Bei Totalausfall wird 0 zurückgegeben -> Aufrufer MUSS den Trade ablehnen.
// Niemals geschätzte Konstanten für Positionsgrößen verwenden.
const cache = { solana: { p: 0, t: 0 }, binancecoin: { p: 0, t: 0 } };
const TTL = 60e3;

async function fromCoinGecko(id) {
  const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
    { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error("coingecko " + r.status);
  const d = await r.json();
  const p = d?.[id]?.usd;
  if (!p) throw new Error("coingecko: kein Preis");
  return +p;
}
async function fromBinance(symbol) {
  const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
  if (!r.ok) throw new Error("binance " + r.status);
  const d = await r.json();
  if (!d?.price) throw new Error("binance: kein Preis");
  return +d.price;
}
async function fromDexScreener(pairChain, pairAddr) {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${pairChain}/${pairAddr}`);
  if (!r.ok) throw new Error("dexscreener " + r.status);
  const d = await r.json();
  const p = d?.pairs?.[0]?.priceUsd || d?.pair?.priceUsd;
  if (!p) throw new Error("dexscreener: kein Preis");
  return +p;
}

async function get(id, binanceSymbol, dsChain, dsPair) {
  const c = cache[id];
  if (Date.now() - c.t < TTL && c.p > 0) return c.p;
  const quellen = [
    () => fromCoinGecko(id),
    () => fromBinance(binanceSymbol),
    () => fromDexScreener(dsChain, dsPair)
  ];
  for (const q of quellen) {
    try {
      const p = await q();
      if (p > 0) { cache[id] = { p, t: Date.now() }; return p; }
    } catch (e) { /* nächste Quelle */ }
  }
  console.error(`PREIS-AUSFALL für ${id}: keine Quelle erreichbar. Trades werden blockiert.`);
  return c.p > 0 ? c.p : 0;   // letzter bekannter Wert, sonst 0 = "unbekannt"
}

// SOL/USDC-Pool (Raydium) bzw. WBNB/BUSD-Pool als letzte Rückfallebene
const solUsd = () => get("solana", "SOLUSDT", "solana", "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2");
const bnbUsd = () => get("binancecoin", "BNBUSDT", "bsc", "0x58F876857a02D6762E0101bb5C46A8c1ED44Dc16");

module.exports = { solUsd, bnbUsd };
