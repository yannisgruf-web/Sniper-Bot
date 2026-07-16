// src/wallets.js – lädt Solana- + BSC-Wallet aus den Private Keys (nur wenn vorhanden),
// stellt Verbindungen bereit und liest Guthaben. Ohne Keys bleibt alles null (Paper-Betrieb).
const cfg = require("./config");

let sol = null;  // { keypair, connection, pubkey }
let bsc = null;  // { wallet, provider, address }

async function initSolana() {
  if (!cfg.SOLANA_PRIVATE_KEY) return null;
  const { Connection, Keypair } = require("@solana/web3.js");
  const bs58mod = require("bs58");
  const bs58 = bs58mod.default || bs58mod;   // funktioniert bei beiden Modul-Formen
  let secret;
  const k = cfg.SOLANA_PRIVATE_KEY.trim();
  try {
    if (k.startsWith("[")) {
      secret = Uint8Array.from(JSON.parse(k));           // JSON-Array-Format
    } else {
      secret = bs58.decode(k);                           // Phantom Base58-Format
    }
  } catch (e) { console.error("SOLANA_PRIVATE_KEY ungültig:", e.message); return null; }

  // Solana-Secretkeys sind 64 Byte. 32 Byte = nur Seed -> auch akzeptieren.
  if (secret.length !== 64 && secret.length !== 32) {
    console.error(`SOLANA_PRIVATE_KEY hat ${secret.length} Byte (erwartet 64). Falsches Format? ` +
                  `Phantom: Einstellungen -> Sicherheit -> Private Key exportieren (Base58-String).`);
    return null;
  }
  let keypair;
  try {
    keypair = secret.length === 64 ? Keypair.fromSecretKey(secret) : Keypair.fromSeed(secret);
  } catch (e) { console.error("Solana-Keypair-Fehler:", e.message); return null; }

  const derived = keypair.publicKey.toBase58();
  // Optionale Sicherheitsprüfung: erwartete Adresse als Env setzen -> Start bricht bei Nichtübereinstimmung ab
  if (cfg.SOLANA_ADDRESS && cfg.SOLANA_ADDRESS.trim() !== derived) {
    console.error(`ADRESS-MISMATCH! Key ergibt ${derived}, erwartet ${cfg.SOLANA_ADDRESS.trim()}. ` +
                  `Live-Trading für Solana wird blockiert.`);
    return null;
  }
  const rpc = process.env.HELIUS_RPC_URL || "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpc, "confirmed");
  sol = { keypair, connection, pubkey: keypair.publicKey };
  console.log("Solana-Wallet geladen:", derived);
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
