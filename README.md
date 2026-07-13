# KAS-Sniper-Bot (Paper-Trading)

Erkennt brandneue Coin-Launches in Echtzeit, prüft sie in Sekunden auf Red Flags,
schickt Push-Alerts an die Cockpit-PWA und simuliert Trades mit fiktivem Geld.
**Bewegt KEIN echtes Kapital.**

## Architektur
- `src/pump-listener.js` – WebSocket auf PumpPortal: neue Pump.fun-Launches (Solana) in Sekunden
- `src/gecko-listener.js` – GeckoTerminal-Polling: neue Pools auf ETH/Base/BSC/Arbitrum/Solana (< 30 Min alt)
- `src/safety.js` – Turbo-Checks: Dev-Buy-Heuristik, GoPlus (Honeypot, Mint/Freeze, LP-Lock, Creator-Anteil, Sell-Tax)
- `src/paper.js` – Paper-Trading: Entry beim Signal, Exit bei TP/SL/Zeitlimit, Ergebnisse in Netlify Blobs (`sniper-trades`)
- `src/push.js` – Web-Push an die PWA (gleiche VAPID-Keys/Subscriptions wie das Cockpit)
- `src/index.js` – Orchestrator + Stats-JSON über HTTP (`?t=STATS_TOKEN`)

## Env-Variablen (Railway → Variables)
| Variable | Wert |
|---|---|
| `VAPID_PUBLIC_KEY` | identisch zu Netlify |
| `VAPID_PRIVATE_KEY` | identisch zu Netlify |
| `VAPID_SUBJECT` | z. B. `mailto:du@example.com` |
| `NETLIFY_SITE_ID` | identisch zu Netlify |
| `NETLIFY_BLOBS_TOKEN` | identisch zu Netlify |
| `STATS_TOKEN` | frei gewählter langer Zufallsstring |

Optionale Filter: siehe `.env.example` (Positionsgröße, TP/SL, Zeitlimit, Dev-Buy-Grenzen, Liquiditätsminimum …).

## Start
`npm install && npm start` – Railway macht beides automatisch (`start`-Script).

## Ehrliche Einordnung
Minuten-alte Coins haben eine sehr hohe Totalausfallquote. Dieses System ist ein
Erkennungs- und Übungswerkzeug: Erst wenn die Paper-Statistik über Wochen netto
positiv ist, lohnt die Diskussion über echtes Kapital (dann: Semi-Auto mit Bestätigungs-Tap).
