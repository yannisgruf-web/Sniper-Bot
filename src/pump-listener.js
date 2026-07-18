// src/pump-listener.js – Echtzeit-Feed neuer Pump.fun-Launches (Solana).
// Auto-Reconnect mit Backoff; Trade-Abos je Token für die Preisverfolgung.
const WebSocket = require("ws");

function startPumpListener({ onNewToken, onTokenTrade, onStatus }) {
  let ws = null, backoff = 1000;
  const tradeSubs = new Set();

  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function connect() {
    ws = new WebSocket("wss://pumpportal.fun/api/data");
    ws.on("open", () => {
      backoff = 1000;
      onStatus?.("verbunden");
      send({ method: "subscribeNewToken" });
      if (tradeSubs.size) send({ method: "subscribeTokenTrade", keys: [...tradeSubs] });
    });
    ws.on("message", raw => {
      let d; try { d = JSON.parse(raw); } catch { return; }
      if (d.txType === "create" && d.mint) onNewToken(d);
      else if (d.mint && (d.txType === "buy" || d.txType === "sell")) onTokenTrade(d);
    });
    ws.on("close", () => { onStatus?.("getrennt – reconnect"); retry(); });
    ws.on("error", () => { try { ws.close(); } catch {} });
  }
  function retry() { setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30000); }

  connect();
  return {
    subscribeTrades(mint)   { tradeSubs.add(mint);    send({ method: "subscribeTokenTrade",   keys: [mint] }); },
    unsubscribeTrades(mint) { tradeSubs.delete(mint); send({ method: "unsubscribeTokenTrade", keys: [mint] }); }
  };
}
module.exports = { startPumpListener };
