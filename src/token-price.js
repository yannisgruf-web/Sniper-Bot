// src/token-price.js – aktueller USD-Preis eines Tokens (für die Live-Überwachung).
const CHAIN = { solana: "solana", bsc: "bsc", base: "base", eth: "ethereum", arbitrum: "arbitrum" };
async function tokenPriceUsd(chain, tokenAddr) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddr}`,
      { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const d = await r.json();
    const want = CHAIN[chain] || chain;
    // liquideste Paar auf der richtigen Chain nehmen
    const pairs = (d.pairs || []).filter(p => p.chainId === want && p.priceUsd);
    if (!pairs.length) return null;
    pairs.sort((a, b) => (+b.liquidity?.usd || 0) - (+a.liquidity?.usd || 0));
    return +pairs[0].priceUsd || null;
  } catch { return null; }
}
module.exports = { tokenPriceUsd };
