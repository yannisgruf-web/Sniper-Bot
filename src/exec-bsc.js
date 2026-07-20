// src/exec-bsc.js – echte BSC-Swaps über den OpenOcean-Aggregator.
// OpenOcean findet den besten Pfad über ALLE BSC-DEXen (PancakeV2/V3, Biswap, ...) selbst
// -> kein "execution reverted" mehr, weil kein fester Router erzwungen wird.
const { ethers } = require("ethers");
const cfg = require("./config");

const OO = "https://open-api.openocean.finance/v3/bsc";
const BNB = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"; // OpenOcean-Native-Token-Platzhalter
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint)",
  "function approve(address spender, uint amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint)",
  "function decimals() view returns (uint8)"
];

let provider = null, wallet = null;

function init() {
  if (wallet) return true;
  const pk = process.env.BSC_PRIVATE_KEY;
  if (!pk) return false;
  try {
    provider = new ethers.JsonRpcProvider(process.env.BSC_RPC || "https://bsc-dataseed.binance.org");
    wallet = new ethers.Wallet(pk.trim().startsWith("0x") ? pk.trim() : "0x" + pk.trim(), provider);
    console.log("BSC-Wallet geladen:", wallet.address);
    return true;
  } catch (e) { console.error("BSC-Key ungültig:", e.message); return false; }
}
function address() { return wallet ? wallet.address : null; }

async function bnbBalanceUsd(bnbUsd) {
  if (!init()) return 0;
  const wei = await provider.getBalance(wallet.address);
  return +ethers.formatEther(wei) * bnbUsd;
}

async function ooFetch(path, params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${OO}${path}?${qs}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error("OpenOcean " + r.status);
  const d = await r.json();
  if (d.code && d.code !== 200) throw new Error("OpenOcean code " + d.code + " " + (d.message || ""));
  return d.data;
}

// Kauf: BNB -> Token. usdAmount in USD, live nur wenn LIVE_TRADING.
async function buy(tokenAddr, usdAmount, bnbUsd) {
  if (!init()) return { ok: false, error: "keine Wallet" };
  try {
    const bnbAmount = usdAmount / bnbUsd;
    const slippagePct = (cfg.BUY_SLIPPAGE_BPS / 100).toString(); // OpenOcean will Prozent
    const q = await ooFetch("/swap_quote", {
      inTokenAddress: BNB, outTokenAddress: tokenAddr,
      amount: bnbAmount.toFixed(8), gasPrice: "3", slippage: slippagePct,
      account: wallet.address
    });
    const outRaw = BigInt(q.outAmount || "0");
    const dec = +q.outToken?.decimals || 18;
    const tokens = +ethers.formatUnits(outRaw, dec);
    const priceUsd = tokens > 0 ? usdAmount / tokens : null;
    if (!cfg.LIVE_TRADING) return { ok: true, dryRun: true, priceUsd, tokens: outRaw.toString() };

    const tx = await wallet.sendTransaction({
      to: q.to, data: q.data, value: BigInt(q.value || "0"),
      gasLimit: q.estimatedGas ? BigInt(Math.floor(+q.estimatedGas * 1.3)) : undefined
    });
    const rc = await tx.wait(1);
    return { ok: true, sig: rc.hash, priceUsd, tokens: outRaw.toString() };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Verkauf: gesamten Token-Bestand -> BNB. Mit Approve (einmalig) und Retry außen im Executor.
async function sell(tokenAddr, bnbUsd) {
  if (!init()) return { ok: false, error: "keine Wallet" };
  try {
    const token = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
    const bal = await token.balanceOf(wallet.address);
    if (bal === 0n) return { ok: false, error: "kein Token-Bestand" };
    const dec = await token.decimals().catch(() => 18);
    const amountHuman = ethers.formatUnits(bal, dec);
    const slippagePct = (cfg.SELL_SLIPPAGE_BPS / 100).toString();

    const q = await ooFetch("/swap_quote", {
      inTokenAddress: tokenAddr, outTokenAddress: BNB,
      amount: amountHuman, gasPrice: "3", slippage: slippagePct, account: wallet.address
    });
    const usdOut = +ethers.formatEther(BigInt(q.outAmount || "0")) * bnbUsd;
    if (!cfg.LIVE_TRADING) return { ok: true, dryRun: true, usdOut };

    // Approve für den OpenOcean-Spender (aus Quote), falls nötig
    const spender = q.to;
    const allow = await token.allowance(wallet.address, spender);
    if (allow < bal) { const a = await token.approve(spender, ethers.MaxUint256); await a.wait(1); }

    const tx = await wallet.sendTransaction({
      to: q.to, data: q.data, value: BigInt(q.value || "0"),
      gasLimit: q.estimatedGas ? BigInt(Math.floor(+q.estimatedGas * 1.3)) : undefined
    });
    const rc = await tx.wait(1);
    return { ok: true, sig: rc.hash, usdOut };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { init, address, bnbBalanceUsd, buy, sell };
