// src/gecko-listener.js – pollt new_pools aller Chains; meldet nur Pools
// jünger als MAX_AGE_MIN mit Mindestliquidität. Ergänzung zum Pump-Feed.
const cfg = require("./config");

const seen = new Map(); // poolKey -> ts (TTL-Dedupe)
function prune() { const cut = Date.now() - 6 * 3600e3; for (const [k, t] of seen) if (t < cut) seen.delete(k); }

async function poll(onCandidate) {
  prune();
  for (const net of cfg.GT_NETWORKS) {
    try {
      const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${net}/new_pools?page=1`,
        { headers: { accept: "application/json" } });
      if (!r.ok) continue;
      const d = await r.json();
      for (const p of (d.data || [])) {
        const a = p.attributes || {};
        const created = Date.parse(a.pool_created_at || "");
        if (!created) continue;
        const ageMin = (Date.now() - created) / 60e3;
        if (ageMin > cfg.MAX_AGE_MIN) continue;
        const liq = +a.reserve_in_usd || 0;
        if (liq < cfg.MIN_LIQ_USD) continue;
        const baseId = p.relationships?.base_token?.data?.id || "";
        const address = baseId.includes("_") ? baseId.slice(baseId.indexOf("_") + 1) : null;
        if (!address) continue;
        const key = net + ":" + (a.address || address);
        if (seen.has(key)) continue;
        seen.set(key, Date.now());
        onCandidate({
          source: "gecko", network: net,
          symbol: (a.name || "").split("/")[0].trim() || "?",
          address, poolAddr: a.address || null,
          ageMin, liq,
          priceUsd: +a.base_token_price_usd || null
        });
      }
    } catch (e) { console.error("gecko", net, e.message); }
  }
}

function startGeckoListener(onCandidate) {
  poll(onCandidate);
  const iv = setInterval(() => poll(onCandidate), cfg.GT_POLL_SEC * 1000);
  return { stop: () => clearInterval(iv) };
}

// ---- DexScreener: Preis-Updates (kostenlos, 300 req/min, bis 30 Pools/Anfrage) ----
const DS_CHAIN = { eth: "ethereum", solana: "solana", base: "base", bsc: "bsc", arbitrum: "arbitrum" };
async function dexPrices(network, poolAddrs) {
  const chain = DS_CHAIN[network] || network;
  const out = {};
  if (!poolAddrs.length) return out;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${chain}/${poolAddrs.slice(0, 30).join(",")}`,
      { headers: { accept: "application/json" } });
    if (!r.ok) { console.error("dexscreener", chain, r.status); return out; }
    const d = await r.json();
    const pairs = d.pairs || (d.pair ? [d.pair] : []);
    for (const p of pairs) {
      const price = +p.priceUsd || null;
      if (price && p.pairAddress) out[p.pairAddress.toLowerCase()] = price;
    }
  } catch (e) { console.error("dexscreener", network, e.message); }
  return out;
}

async function poolPriceUsd(network, poolAddr) {
  try {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddr}`,
      { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const d = await r.json();
    return +d?.data?.attributes?.base_token_price_usd || null;
  } catch { return null; }
}
module.exports = { startGeckoListener, poolPriceUsd, dexPrices };
