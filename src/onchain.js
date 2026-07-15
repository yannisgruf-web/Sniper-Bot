// src/onchain.js – Solana-RPC-Checks (public mainnet RPC, optional HELIUS_RPC_URL)
const RPC = process.env.HELIUS_RPC_URL || "https://api.mainnet-beta.solana.com";

async function rpc(method, params) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctl.signal
    });
    const d = await r.json();
    return d.result || null;
  } catch { return null; }
  finally { clearTimeout(t); }
}

// Holder-Konzentration: Anteil der Top-10-Wallets am zirkulierenden Supply
// (Bonding-Curve-Konto wird herausgerechnet, da es den unverkauften Rest hält).
async function holderConcentration(mint, curveKey) {
  const [largest, supply] = await Promise.all([
    rpc("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]),
    rpc("getTokenSupply", [mint, { commitment: "confirmed" }])
  ]);
  if (!largest?.value?.length || !supply?.value) return null;
  const total = +supply.value.amount;
  if (!total) return null;

  // Curve-Konto identifizieren: größtes Konto ist praktisch immer die Curve;
  // zusätzlich per Adresse ausschließen, falls bekannt.
  const accounts = largest.value.map(a => ({ addr: a.address, amt: +a.amount }));
  accounts.sort((x, y) => y.amt - x.amt);
  let curveAmt = 0;
  const rest = [];
  for (const a of accounts) {
    if ((curveKey && a.addr === curveKey) || (!curveAmt && a === accounts[0] && a.amt > total * 0.3)) curveAmt += a.amt;
    else rest.push(a);
  }
  const circulating = total - curveAmt;
  if (circulating <= 0) return null;
  const top10 = rest.slice(0, 10).reduce((s, a) => s + a.amt, 0);
  return top10 / circulating * 100; // Prozent
}

module.exports = { holderConcentration };
