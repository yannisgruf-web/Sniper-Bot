// src/exec-bsc.js – echte Swaps auf BSC über PancakeSwap V2 Router.
// buy(): BNB -> Token für festen USD-Betrag. sell(): gesamten Token-Bestand -> BNB.
const cfg = require("./config");
const wallets = require("./wallets");
const { ethers } = require("ethers");

const ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E"; // PancakeSwap V2
const WBNB   = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const ROUTER_ABI = [
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin,address[] path,address to,uint deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn,uint amountOutMin,address[] path,address to,uint deadline)",
  "function getAmountsOut(uint amountIn,address[] path) view returns (uint[])"
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint)",
  "function approve(address,uint) returns (bool)",
  "function allowance(address,address) view returns (uint)",
  "function decimals() view returns (uint8)"
];

function router() { return new ethers.Contract(ROUTER, ROUTER_ABI, wallets.getBsc().wallet); }
function deadline() { return Math.floor(Date.now() / 1000) + 120; }

async function buy(token, usdAmount, bnbUsd) {
  const bsc = wallets.getBsc();
  const value = ethers.parseEther((usdAmount / bnbUsd).toFixed(9));
  const path = [WBNB, token];
  const r = router();
  let minOut = 0n;
  try { const amounts = await r.getAmountsOut(value, path); minOut = amounts[1] * BigInt(10000 - cfg.BUY_SLIPPAGE_BPS) / 10000n; } catch {}
  const tx = await r.swapExactETHForTokensSupportingFeeOnTransferTokens(minOut, path, bsc.address, deadline(), { value });
  const rec = await tx.wait(1);
  return { ok: true, txid: rec.hash };
}

async function sell(token) {
  const bsc = wallets.getBsc();
  const erc = new ethers.Contract(token, ERC20_ABI, bsc.wallet);
  const bal = await erc.balanceOf(bsc.address);
  if (bal === 0n) return { ok: false, error: "kein Bestand" };
  const allowance = await erc.allowance(bsc.address, ROUTER);
  if (allowance < bal) { const a = await erc.approve(ROUTER, ethers.MaxUint256); await a.wait(1); }
  const path = [token, WBNB];
  const r = router();
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      let minOut = 0n;
      try { const amounts = await r.getAmountsOut(bal, path); const slip = Math.min(cfg.SELL_SLIPPAGE_BPS * attempt, 5000); minOut = amounts[1] * BigInt(10000 - slip) / 10000n; } catch {}
      const tx = await r.swapExactTokensForETHSupportingFeeOnTransferTokens(bal, minOut, path, bsc.address, deadline());
      const rec = await tx.wait(1);
      return { ok: true, txid: rec.hash };
    } catch (e) { lastErr = e.message?.slice(0, 100); await new Promise(r => setTimeout(r, 800)); }
  }
  return { ok: false, error: lastErr };
}

module.exports = { buy, sell };
