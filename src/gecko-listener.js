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

async function poolPriceUsd(network, poolAddr) {
  try {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddr}`,
      { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const d = await r.json();
    return +d?.data?.attributes?.base_token_price_usd || null;
  } catch { return null; }
}
module.exports = { startGeckoListener, poolPriceUsd };
