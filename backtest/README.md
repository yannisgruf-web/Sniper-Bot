# Backtester

Rechnet die Live-Strategie über historische Kerzen. Zwei Schritte:

## 1. Daten laden (einmalig, ~30-60 Min)
```
node backtest/download.js
```
Lädt 15m-Kerzen der Top-100-Coins von 2024-01-01 bis 2026-07-01 nach
`backtest/data/`. Bricht der Lauf ab, einfach neu starten – bereits
geladene Coins werden übersprungen. Etwa 1-2 GB Speicherbedarf.

Optional per Umgebungsvariable:
- `BT_TOP_N=50` – weniger Coins
- `BT_SYMBOLS=BTC,ETH,SOL` – feste Liste statt Volumen-Ranking
- `BT_START` / `BT_END` – anderer Zeitraum

## 2. Backtest rechnen (~3-5 Min)
```
node backtest/run.js
```
Prüft 72 Kombinationen (3 Zeitrahmen × 3 Konfluenz-Schwellen ×
Momentum an/aus × ATR/Prozent-Stops × Trendfilter an/aus) über drei
getrennte Zeiträume.

Ergebnis: `backtest/ergebnisse/ergebnisse.txt` (Tabelle) und
`ergebnisse.json` (Details).

## Wie das Ergebnis zu lesen ist
- **Suche 2024**: hier darf man Parameter aussuchen
- **Prüf 2025**: unangetastet – zeigt, ob der Fund kein Zufall war
- **Test 2026H1**: letzter Beweis, nur einmal anschauen
- **robust = JA**: in allen drei Zeiträumen positiv, je mindestens 30 Trades

Nur "robust"-Konfigurationen sind es wert, weiterverfolgt zu werden.
Sind es null, hat die Strategie in dieser Form keinen belegbaren Vorteil.

## Grenzen
- **Survivorship Bias**: Die Coin-Liste von heute enthält nur Überlebende.
  Auf 2024 angewendet ist das systematisch zu optimistisch.
- **Ausführung idealisiert**: Gebühren sind drin, Slippage nicht.
- Die Prozentzahl ist die **Summe** der Renditen je Einsatz, nicht
  aufgezinst – gut zum Vergleichen, nicht als Kontostand lesbar.
- Vergangenheit sagt nichts über die Zukunft.

## Geprüft
Der Backtester wurde gegen die Live-Logik verifiziert:
Indikator-Serien identisch, Trade-Rechnung von Hand nachgerechnet
(Long und Short), echte Trends werden erkannt – und auf trendlosen
Zufallsdaten findet er null robuste Konfigurationen (kein Blick in
die Zukunft).
