// src/wallets.js – lädt Solana- + BSC-Wallet aus den Private Keys (nur wenn vorhanden),
// stellt Verbindungen bereit und liest Guthaben. Ohne Keys bleibt alles null (Paper-Betrieb).
const cfg = require("./config");

let sol = null;  // { keypair, connection, pubkey }
let bsc = null;  // { wallet, provider, address }

async function initSolana() {
  if (!cfg.SOLANA_PRIVATE_KEY) return null;
  const { Connection, Keypair } = require("@solana/web3.js");
  const bs58 = require("bs58");
  let secret;
  const k = cfg.SOLANA_PRIVATE_KEY.trim();
  try {
    secret = k.startsWith("[") ? Uint8Array.from(JSON.parse(k)) : bs58.default.decode(k);
  } catch (e) { console.error("SOLANA_PRIVATE_KEY ungültig:", e.message); return null; }
  const keypair = Keypair.fromSecretKey(secret);
  const rpc = cfg.SOLANA_PRIVATE_KEY && process.env.HELIUS_RPC_URL ? process.env.HELIUS_RPC_URL : "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpc, "confirmed");
  sol = { keypair, connection, pubkey: keypair.publicKey };
  console.log("Solana-Wallet geladen:", keypair.publicKey.toBase58());
  return sol;
}

async function initBsc() {
  if (!cfg.BSC_PRIVATE_KEY) return null;
  const { ethers } = require("ethers");
  try {
    const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org");
    const wallet = new ethers.Wallet(cfg.BSC_PRIVATE_KEY.trim(), provider);
    bsc = { wallet, provider, address: wallet.address };
    console.log("BSC-Wallet geladen:", wallet.address);
    return bsc;
  } catch (e) { console.error("BSC_PRIVATE_KEY ungültig:", e.message); return null; }
}

async function solBalanceUsd(solUsd) {
  if (!sol) return null;
  try { const lamports = await sol.connection.getBalance(sol.pubkey); return (lamports / 1e9) * solUsd; }
  catch { return null; }
}
async function bnbBalanceUsd(bnbUsd) {
  if (!bsc) return null;
  try { const wei = await bsc.provider.getBalance(bsc.address); const { ethers } = require("ethers"); return parseFloat(ethers.formatEther(wei)) * bnbUsd; }
  catch { return null; }
}

function getSol() { return sol; }
function getBsc() { return bsc; }

module.exports = { initSolana, initBsc, getSol, getBsc, solBalanceUsd, bnbBalanceUsd };
