# Stock Tracker — Plan d'Implementation Complet
## Consensus Stochastique (7 agents, Volet 2)
> Date: 2026-04-24 | Processus: Stochastic Consensus | 7 perspectives independantes

---

# PARTIE 1 — CONSENSUS, DIVERGENCES, OUTLIERS

## CONSENSUS (5+/7 agents convergent)

### 1. Architecture multi-sources avec polling echelonne
**7/7 convergent.** Tous les agents s'accordent sur une approche multi-sources avec priorite:
1. EDGAR EFTS API (Form 4, 13F) — toutes les 5 min
2. Unusual Whales API (Congress) — toutes les 5 min (payant ~$15/mois)
3. Quiver Quantitative (Congress) — toutes les 15 min (free tier)
4. Senate eFD scraping — toutes les 30 min
5. House Clerk XML — toutes les 60 min
6. Capitol Trades — toutes les 60 min (backup)

### 2. SQLite comme base de donnees
**6/7 convergent.** SQLite via `better-sqlite3` — zero config, backup = copier un fichier, performances largement suffisantes pour ce volume (<100K trades). Mode WAL pour lectures concurrentes.

### 3. Node.js + TypeScript comme stack backend
**7/7 convergent.** Ecosysteme riche (parsers XML, scraping, cron), async I/O ideal pour polling multiple, TypeScript pour la surete des types.

### 4. PM2 pour le process management 24/7
**5/7 convergent.** Auto-restart, log rotation, monitoring integre, `pm2 startup` pour demarrage automatique au boot Mac via launchd.

### 5. Tracker BOTH chambers (Senate + House)
**6/7 convergent.** Les meilleurs traders sont souvent des representants (Pelosi, Crenshaw, McCaul). Les sources couvrent les deux de toute facon.

### 6. Deduplication par cle composite multi-champ
**7/7 convergent.** Cle: `{politician_normalized}|{ticker}|{trade_date}|{direction}|{amount_range}` + fuzzy matching pour tolerance de 1 jour + priorite de source pour resolution de conflits (EDGAR > Senate eFD > Unusual Whales > Quiver > Capitol Trades).

### 7. React + Vite + Tailwind pour le frontend
**6/7 convergent.** Dashboard dark theme, TradingView Lightweight Charts pour les graphiques financiers, TanStack Table pour les tableaux triables, SSE pour les updates temps reel.

### 8. Ranking algorithm: Alpha risk-adjusted + metrics composites
**6/7 convergent.** Score composite ponderant: alpha vs SPY (30%), win rate (20%), Sharpe-like ratio (20%), profit factor (15%), frequence (10%), recence (5%). Minimum 5 trades pour etre classe.

### 9. Fund managers Tier 1: Buffett, Ackman, Druckenmiller, Tepper
**7/7 convergent.** Tous unanimes sur ces 4 comme les plus signifiants via 13F (portfolios concentres, chaque mouvement = conviction).

### 10. Broker integration: Alpaca d'abord (paper trading), puis live
**5/7 convergent.** API gratuite, paper trading, zero commission, SDK Node.js simple. Phase 1 = alertes only, Phase 2 = paper, Phase 3 = live.

---

## DIVERGENCES (3-4/7 en desaccord)

### 1. Unusual Whales: payant vs gratuit seulement?
- **POUR (4/7):** $15/mois, source la plus rapide pour les trades Congress, ROI evident.
- **CONTRE (3/7):** Commencer 100% gratuit (EDGAR + Quiver + scraping), ajouter Unusual Whales si les sources gratuites sont trop lentes.
- **Decision recommandee:** Commencer SANS Unusual Whales, mesurer la latence reelle des sources gratuites pendant 2 semaines, puis decider.

### 2. Fastify vs Express pour l'API
- **Fastify (4/7):** Plus rapide, meilleure gestion TypeScript, schema validation integree.
- **Express (3/7):** Plus connu, plus de middleware disponibles, documentation abondante.
- **Decision recommandee:** Fastify — les avantages de performance et TS justifient la courbe d'apprentissage minime.

### 3. Pino vs Winston pour le logging
- **Pino (4/7):** Plus rapide, structured logging natif, JSON output.
- **Winston (3/7):** Plus flexible, transports multiples, plus connu.
- **Decision recommandee:** Pino — performance et integration Fastify native.

### 4. Zustand vs React Context pour le state management frontend
- **Zustand (4/7):** Minimal, pas de boilerplate, bon pour un projet simple.
- **Aucun state manager (3/7):** React Query/TanStack Query suffit si les donnees viennent toutes du backend.
- **Decision recommandee:** TanStack Query pour les donnees serveur + Zustand si besoin de state local complexe.

### 5. Yahoo Finance vs Polygon.io pour les prix
- **Yahoo Finance (4/7):** Gratuit, historique complet, pas d'API key.
- **Polygon.io (3/7):** Plus fiable, API officielle, meilleur pour le temps reel.
- **Decision recommandee:** Yahoo Finance (`yahoo-finance2` npm) pour le MVP, migrer vers Polygon si Yahoo devient instable.

---

## OUTLIERS (1-2 agents seulement)

### 1. Correlation trades/legislation calendar (Agent 3 uniquement)
**Idee:** Croiser automatiquement les dates de trades des senateurs avec le calendrier legislatif (votes, hearings, briefings classifies) via l'API Congress.gov.
- **Potentiel:** ELEVE — c'est litteralement la these d'insider trading politique
- **Faisabilite:** MOYENNE — necesssite mapping automatique secteur/legislation
- **Verdict:** A integrer en Phase 3 comme enrichissement des alertes

### 2. Herfindahl-Hirschman Index pour ponderer les alertes 13F (Agent 7 uniquement)
**Idee:** Calculer le HHI (concentration) de chaque portfolio de fund manager et l'utiliser comme multiplicateur d'importance des alertes.
- **Potentiel:** ELEVE — un mouvement de Ackman (HHI ~0.15, 6 positions) vaut infiniment plus qu'un mouvement de Bridgewater (HHI ~0.005, 500 positions)
- **Faisabilite:** HAUTE — simple calcul mathematique
- **Verdict:** INTEGRER immediatement — c'est un insight quant brillant

### 3. Michael Burry comme signal media plutot que trading (Agent 7 uniquement)
**Idee:** Tracker Burry non pour copier ses trades (petit AUM, turnover eleve) mais parce que ses 13F generent des mouvements de marche via la couverture media.
- **Potentiel:** MOYEN — meta-signal interessant
- **Verdict:** Tracker passivement, pas d'alertes haute priorite

### 4. BullMQ comme queue in-memory (Agent 5 uniquement)
**Idee:** Utiliser une vraie job queue (BullMQ + Redis) au lieu d'un simple async.
- **Potentiel:** BAS pour le MVP — overengineering pour le volume actuel
- **Verdict:** Simple async queue suffit, BullMQ si scaling necessaire

---

# PARTIE 2 — PLAN D'IMPLEMENTATION FINAL

## Architecture Globale

```
┌─────────────────────────────────────────────────────────────────┐
│                        STOCK TRACKER                             │
│                                                                  │
│  ┌──────────────────────────────────────────────────┐           │
│  │              INGESTION LAYER                      │           │
│  │                                                    │           │
│  │  EDGAR  Quiver  Senate  House  Capitol  Unusual   │           │
│  │  (5min) (15min) (30min) (60min) (60min)  (5min)   │           │
│  └──────────────────┬───────────────────────────────┘           │
│                     │                                            │
│  ┌──────────────────▼───────────────────────────────┐           │
│  │           PROCESSING PIPELINE                      │           │
│  │  Parse → Normalize → Dedup → Enrich → Store       │           │
│  └──────────┬──────────────────┬────────────────────┘           │
│             │                  │                                  │
│  ┌──────────▼──────┐  ┌───────▼────────┐  ┌────────────────┐   │
│  │  RANKING ENGINE │  │  ALERT ENGINE  │  │  PRICE SERVICE │   │
│  │  (weekly full,  │  │  (real-time,   │  │  (Yahoo Fin.,  │   │
│  │   incremental)  │  │   Discord bot) │  │   daily + OD)  │   │
│  └────────┬────────┘  └───────┬────────┘  └────────────────┘   │
│           │                   │                                   │
│  ┌────────▼───────────────────▼────────────────────────────┐    │
│  │                   SQLite DATABASE                        │    │
│  │  politicians | trades | fund_holdings | rankings |       │    │
│  │  alerts | prices                                         │    │
│  └─────────────────────────┬───────────────────────────────┘    │
│                            │                                     │
│  ┌─────────────────────────▼───────────────────────────────┐    │
│  │                   FASTIFY API                            │    │
│  │  /api/dashboard | /api/rankings | /api/trades |          │    │
│  │  /api/portfolio | /api/funds | /api/alerts | /api/events │    │
│  └─────────────────────────┬───────────────────────────────┘    │
│                            │                                     │
│  ┌─────────────────────────▼───────────────────────────────┐    │
│  │              REACT FRONTEND (Vite)                       │    │
│  │  Dashboard | Rankings | Trades | Buffett | Funds | Alerts│    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

## Structure du Projet

```
stock-tracker/
├── package.json
├── tsconfig.json
├── .env
├── .env.example
│
├── src/
│   ├── index.ts                    # Orchestrateur principal
│   ├── config.ts                   # Validation env (Zod)
│   │
│   ├── ingestion/                  # Sources de donnees
│   │   ├── base-source.ts          # Classe abstraite commune
│   │   ├── edgar.ts                # SEC EDGAR (Form 4 + 13F)
│   │   ├── senate-efd.ts           # Senate eFD scraping
│   │   ├── house-clerk.ts          # House disclosures XML
│   │   ├── quiver.ts               # Quiver Quantitative API
│   │   ├── capitol-trades.ts       # Capitol Trades
│   │   └── unusual-whales.ts       # Unusual Whales API
│   │
│   ├── parsing/                    # Parsers par type de filing
│   │   ├── form4-parser.ts         # XML Form 4
│   │   ├── 13f-parser.ts           # XML 13F-HR
│   │   ├── ptr-parser.ts           # Senate PTR (HTML)
│   │   └── normalizer.ts           # Format unifie NormalizedTrade
│   │
│   ├── ranking/                    # Moteur de ranking
│   │   ├── metrics.ts              # Calcul des metriques individuelles
│   │   ├── composite-score.ts      # Formule composite ponderee
│   │   ├── backtester.ts           # Backtesting historique
│   │   └── cluster-detector.ts     # Detection clusters multi-politiciens
│   │
│   ├── tracking/                   # Suivi portfolios
│   │   ├── buffett-tracker.ts      # Berkshire specifique
│   │   ├── fund-manager-tracker.ts # Autres milliardaires
│   │   └── portfolio-diff.ts       # Diff quarter-over-quarter
│   │
│   ├── alerting/                   # Systeme d'alertes
│   │   ├── discord.ts              # Discord webhook/bot
│   │   ├── alert-engine.ts         # Regles + deduplication
│   │   └── formatters.ts           # Formatage des messages
│   │
│   ├── api/                        # API REST (Fastify)
│   │   ├── server.ts               # Serveur Fastify + SSE
│   │   └── routes/
│   │       ├── dashboard.ts
│   │       ├── senators.ts
│   │       ├── trades.ts
│   │       ├── portfolio.ts
│   │       ├── rankings.ts
│   │       └── alerts.ts
│   │
│   ├── db/
│   │   ├── schema.ts               # Schema SQL complet
│   │   ├── migrations/
│   │   └── queries.ts
│   │
│   ├── prices/
│   │   ├── yahoo-finance.ts
│   │   └── price-cache.ts
│   │
│   └── utils/
│       ├── logger.ts               # Pino
│       ├── rate-limiter.ts         # Par source
│       ├── retry.ts                # Exponential backoff
│       └── scheduler.ts            # Wrapper node-cron
│
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   ├── index.html
│   └── src/
│       ├── App.tsx
│       ├── pages/
│       │   ├── Dashboard.tsx       # Vue d'ensemble
│       │   ├── Rankings.tsx        # Leaderboard politiciens
│       │   ├── SenatorDetail.tsx   # Detail par politicien
│       │   ├── TradeHistory.tsx    # Historique des trades
│       │   ├── BuffettPortfolio.tsx # Portfolio Berkshire
│       │   ├── FundManagers.tsx    # Autres fund managers
│       │   └── AlertHistory.tsx    # Historique alertes
│       ├── components/
│       │   ├── TradeTable.tsx
│       │   ├── RankingChart.tsx
│       │   ├── PortfolioTreemap.tsx
│       │   ├── AlertFeed.tsx
│       │   └── ClusterIndicator.tsx
│       └── hooks/
│           ├── useApi.ts
│           └── useRealTime.ts      # SSE hook
│
├── scripts/
│   ├── seed-historical.ts          # Backfill donnees historiques
│   ├── backtest.ts                 # Run backtesting
│   └── health-check.ts            # Health check systeme
│
└── tests/
    ├── parsing/
    ├── ranking/
    └── fixtures/                   # XML/HTML exemples
```

## Stack Technique Exacte

### Backend
| Package | Version | Role |
|---------|---------|------|
| `typescript` | ^5.4 | Langage |
| `tsx` | ^4.7 | Runtime TS (dev) |
| `fastify` | ^4.26 | Serveur API |
| `better-sqlite3` | ^9.4 | Base de donnees |
| `fast-xml-parser` | ^4.3 | Parser XML (Form 4, 13F) |
| `cheerio` | ^1.0 | Scraper HTML (Senate eFD) |
| `node-cron` | ^3.0 | Scheduler |
| `yahoo-finance2` | ^2.9 | Prix des actions |
| `zod` | ^3.22 | Validation schemas |
| `pino` | ^8.19 | Logger structure |
| `discord.js` | ^14.14 | Bot Discord |
| `undici` | built-in | HTTP client (Node 18+) |
| `pm2` | ^5.3 | Process manager (global) |
| `dotenv` | ^16.4 | Variables d'environnement |

### Frontend
| Package | Version | Role |
|---------|---------|------|
| `react` | ^18.3 | Framework UI |
| `react-dom` | ^18.3 | DOM rendering |
| `react-router-dom` | ^6.22 | Routing |
| `vite` | ^5.1 | Build tool |
| `@vitejs/plugin-react` | ^4.2 | Vite React plugin |
| `tailwindcss` | ^3.4 | CSS utility-first |
| `@tanstack/react-table` | ^8.15 | Tableaux avances |
| `lightweight-charts` | ^4.1 | Charts TradingView |
| `recharts` | ^2.12 | Charts simples |
| `zustand` | ^4.5 | State management |
| `@tanstack/react-query` | ^5.20 | Server state |
| `lucide-react` | ^0.350 | Icones |
| `date-fns` | ^3.3 | Dates |

## Schema Base de Donnees

```sql
-- Politiciens (senateurs + representants)
CREATE TABLE politicians (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  chamber TEXT NOT NULL CHECK (chamber IN ('senate', 'house')),
  state TEXT,
  party TEXT,
  committees TEXT,           -- JSON array
  active INTEGER DEFAULT 1,
  cik TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Trades individuels
CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  politician_id INTEGER NOT NULL REFERENCES politicians(id),
  ticker TEXT,
  asset_name TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  filing_date TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('buy', 'sell', 'exchange')),
  amount_range TEXT,
  amount_midpoint REAL,
  asset_type TEXT DEFAULT 'stock',
  source TEXT NOT NULL,
  source_id TEXT,
  raw_data TEXT,
  UNIQUE(politician_id, ticker, trade_date, direction, amount_range)
);

-- Holdings 13F (snapshots trimestriels)
CREATE TABLE fund_holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fund_name TEXT NOT NULL,
  fund_cik TEXT NOT NULL,
  report_date TEXT NOT NULL,
  filing_date TEXT NOT NULL,
  ticker TEXT,
  cusip TEXT NOT NULL,
  security_name TEXT NOT NULL,
  shares REAL NOT NULL,
  value_thousands REAL NOT NULL,
  change_type TEXT,
  change_shares REAL,
  change_pct REAL,
  UNIQUE(fund_cik, report_date, cusip)
);

-- Rankings
CREATE TABLE rankings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  politician_id INTEGER NOT NULL REFERENCES politicians(id),
  computed_at TEXT NOT NULL,
  score REAL NOT NULL,
  alpha REAL,
  win_rate REAL,
  sharpe REAL,
  profit_factor REAL,
  trade_count INTEGER,
  rank_position INTEGER
);

-- Alertes
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data TEXT,
  discord_sent INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Cache prix
CREATE TABLE prices (
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,
  close REAL NOT NULL,
  PRIMARY KEY (ticker, date)
);

-- Index
CREATE INDEX idx_trades_politician ON trades(politician_id);
CREATE INDEX idx_trades_ticker ON trades(ticker);
CREATE INDEX idx_trades_date ON trades(trade_date);
CREATE INDEX idx_trades_filing ON trades(filing_date);
CREATE INDEX idx_fund_cik ON fund_holdings(fund_cik);
CREATE INDEX idx_fund_date ON fund_holdings(report_date);
CREATE INDEX idx_rankings_politician ON rankings(politician_id);
CREATE INDEX idx_alerts_type ON alerts(type);
```

## Algorithme de Ranking — Formule Composite

```
SCORE = (0.30 * z_alpha)          # Alpha annualisee vs S&P 500
      + (0.20 * z_win_rate)       # % trades battant le S&P
      + (0.20 * z_sharpe)         # Mean(alpha) / Std(alpha)
      + (0.15 * z_profit_factor)  # Sum(gains) / |Sum(pertes)|
      + (0.10 * log_freq_bonus)   # log2(trades) / log2(max_trades)
      + (0.05 * recency_bonus)    # Poids exponentiel (half-life 6 mois)
```

**Contraintes:**
- Minimum 5 trades round-trip pour etre classe
- Montants estimes via midpoints des ranges de disclosure
- Rolling window de 2 ans
- Recalcul complet: hebdomadaire (dimanche minuit)
- Mise a jour incrementale: a chaque nouveau trade

### Mapping des Ranges de Montants
```javascript
const AMOUNT_MIDPOINTS = {
  '$1,001 - $15,000': 8_000,
  '$15,001 - $50,000': 32_500,
  '$50,001 - $100,000': 75_000,
  '$100,001 - $250,000': 175_000,
  '$250,001 - $500,000': 375_000,
  '$500,001 - $1,000,000': 750_000,
  '$1,000,001 - $5,000,000': 3_000_000,
  '$5,000,001 - $25,000,000': 15_000_000,
  '$25,000,001 - $50,000,000': 37_500_000,
  'Over $50,000,000': 75_000_000,
};
```

## Niveaux d'Alerte

### HIGH (Discord @everyone)
- Top-5 senateur achete > $100K
- Cluster: 3+ politiciens achetent le meme ticker en 30 jours
- Buffett: nouvelle position ou exit complet
- Ackman/Druckenmiller: nouvelle position

### MEDIUM (Discord notification standard)
- Top-20 senateur achete > $50K
- 13F: augmentation > 25% d'une position par un manager Tier 1/2
- Trade sur secteur correle au comite du senateur

### LOW (Discord log channel)
- Tout nouveau trade de politicien tracke
- 13F: changements mineurs
- Changements de ranking

## Fund Managers a Tracker

### Tier 1 — TOUJOURS tracker + alertes
| Manager | Fond | CIK | Style | Concentration |
|---------|------|-----|-------|---------------|
| Warren Buffett | Berkshire Hathaway | 0001067983 | Deep value | Tres haute |
| Bill Ackman | Pershing Square | 0001336528 | Activist | Tres haute (6-10 pos.) |
| Stanley Druckenmiller | Duquesne Family | 0001536411 | Macro + growth | Haute |
| David Tepper | Appaloosa | 0001656456 | Distressed | Haute |

### Tier 2 — Tracker + alertes sur mouvements significatifs
| Manager | Fond | CIK | Style | Concentration |
|---------|------|-----|-------|---------------|
| David Einhorn | Greenlight Capital | 0001079114 | Value | Haute |
| Seth Klarman | Baupost Group | 0001061768 | Deep value | Moyenne |
| Dan Loeb | Third Point | 0001040273 | Event-driven | Moyenne-haute |
| Carl Icahn | Icahn Enterprises | 0000049588 | Activist | Haute |

### Tier 3 — Tracker passivement
| Manager | Fond | CIK | Style | Concentration |
|---------|------|-----|-------|---------------|
| Michael Burry | Scion Asset | 0001649339 | Contrarian | Haute (petit AUM) |
| Chase Coleman | Tiger Global | 0001167483 | Tech/growth | Basse |
| Ray Dalio | Bridgewater | 0001350694 | Macro | Tres basse |

## Sources de Donnees — Endpoints Exacts

### SEC EDGAR
```
# Soumissions d'un CIK (JSON, filings recents)
https://data.sec.gov/submissions/CIK{padded_cik}.json

# RSS des derniers Form 4
https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&count=100&output=atom

# Recherche full-text (EFTS)
https://efts.sec.gov/LATEST/search-index?forms=4&dateRange=custom&startdt={date}

# Header obligatoire:
User-Agent: StockTracker mokhtari.digix@gmail.com
# Rate limit: 10 req/sec max (viser 8)
```

### Senate eFD
```
# Recherche PTR (POST)
https://efdsearch.senate.gov/search/home/
Content-Type: application/x-www-form-urlencoded
Body: filer_type=1&report_type=11&submitted_start_date={7_days_ago}

# Detail d'un rapport
https://efdsearch.senate.gov/search/view/ptr/{report_id}/
```

### House Clerk
```
# Feed XML annuel
https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{year}FD.xml
```

### Quiver Quantitative
```
# Trades recents (API key requise, free tier: 50 req/jour)
https://api.quiverquant.com/beta/live/congresstrading
Authorization: Bearer {QUIVER_API_KEY}
```

### Congress.gov API (comites, membres)
```
# Membres du Congres
https://api.congress.gov/v3/member?api_key={key}
# Cle gratuite via api.data.gov
```

## Comite-Secteur Mapping (Signal Alpha)

| Comite | Secteurs correles | ETFs de reference |
|--------|-------------------|-------------------|
| Finance | Financial, Healthcare, Tech | XLF, XLV, XLK |
| Armed Services | Defense, Industrial | XLI, ITA |
| Intelligence | Broad market (intel classifie) | SPY, QQQ |
| Banking | Banques, Fintech, Crypto | XLF, KRE |
| Commerce | Tech, Telecom | XLK, XLC |
| Energy | Oil/Gas, Renewables | XLE, ICLN |
| HELP (Sante) | Biotech, Pharma | XBI, IBB, XLV |

**Boost de signal:** quand un senateur du comite Armed Services achete Lockheed Martin → +50% d'importance sur l'alerte.

## Phases de Developpement

### Phase 1 — MVP (2 semaines)
**Objectif:** Alertes Discord fonctionnelles pour trades Congress + Buffett

- [ ] Setup projet (package.json, tsconfig, .env)
- [ ] Schema SQLite + migrations
- [ ] Ingestion EDGAR (Form 4 polling, CIK-specific pour Berkshire)
- [ ] Ingestion Quiver Quantitative (Congress trades)
- [ ] Parsers: Form 4 XML, Quiver JSON
- [ ] Normalizer + dedup basique
- [ ] Alert engine + Discord webhook
- [ ] Scheduler (node-cron)
- [ ] PM2 setup + auto-start Mac
- [ ] Seed historique (3 mois via Quiver)
- [ ] Tests unitaires parsers

### Phase 2 — Ranking + 13F (2 semaines)
**Objectif:** Ranking senateurs, tracking 13F des fund managers

- [ ] Ingestion 13F EDGAR (Berkshire + Tier 1 funds)
- [ ] Parser 13F XML
- [ ] Portfolio diff (quarter-over-quarter)
- [ ] Algorithme de ranking composite
- [ ] Integration prix Yahoo Finance
- [ ] Backtesting basique (script)
- [ ] Detection clusters multi-politiciens
- [ ] Alertes enrichies (niveaux HIGH/MEDIUM/LOW)
- [ ] Monitoring source health

### Phase 3 — Frontend Dashboard (2 semaines)
**Objectif:** Interface web complete

- [ ] API Fastify (tous les endpoints)
- [ ] SSE pour updates temps reel
- [ ] Dashboard page (alertes recentes, top 5, clusters)
- [ ] Rankings page (leaderboard, filtres)
- [ ] Senator detail page (historique, secteurs, performance)
- [ ] Buffett portfolio page (treemap, diff)
- [ ] Fund Managers page (multi-fonds, convergence)
- [ ] Alert history page
- [ ] Dark theme, responsive mobile
- [ ] TradingView charts

### Phase 4 — Polish & Enrichissement (2 semaines)
**Objectif:** Qualite production, features avancees

- [ ] Senate eFD scraping
- [ ] House Clerk XML ingestion
- [ ] Capitol Trades backup
- [ ] Unusual Whales (si budget OK)
- [ ] Committee-sector correlation scoring
- [ ] HHI (concentration) pour ponderation alertes 13F
- [ ] Correlation calendrier legislatif (Congress.gov API)
- [ ] Cross-fund convergence detection
- [ ] Conviction buy detection (position sizing signals)
- [ ] Health dashboard dans le frontend
- [ ] Backfill historique complet (2 ans)

### Phase 5 — Broker Integration (2 semaines, optionnel)
**Objectif:** Paper trading puis live

- [ ] Integration Alpaca API (paper trading)
- [ ] Position sizing rules (basees sur ranking + conviction)
- [ ] Paper trading automatique sur signaux HIGH
- [ ] Dashboard P&L paper
- [ ] Migration vers live trading (apres validation)

## Configuration (.env.example)

```env
# Discord
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
DISCORD_BOT_TOKEN=your_bot_token

# Data Sources
QUIVER_API_KEY=your_quiver_key
UNUSUAL_WHALES_API_KEY=optional_if_paid
CONGRESS_GOV_API_KEY=your_congress_key

# SEC EDGAR
SEC_USER_AGENT=StockTracker mokhtari.digix@gmail.com

# Prices
YAHOO_FINANCE_ENABLED=true

# Database
DB_PATH=./data/stocktracker.db

# API Server
API_PORT=3001
API_HOST=0.0.0.0

# Logging
LOG_LEVEL=info

# Polling Intervals (ms)
POLL_EDGAR=300000
POLL_QUIVER=900000
POLL_SENATE_EFD=1800000
POLL_HOUSE_CLERK=3600000

# Broker (Phase 5)
ALPACA_KEY_ID=
ALPACA_SECRET_KEY=
ALPACA_PAPER=true
```

## Estimation Temps Total

| Phase | Duree | Dependances |
|-------|-------|-------------|
| Phase 1 — MVP | 2 semaines | Aucune |
| Phase 2 — Ranking + 13F | 2 semaines | Phase 1 |
| Phase 3 — Frontend | 2 semaines | Phase 2 (API) |
| Phase 4 — Polish | 2 semaines | Phase 3 |
| Phase 5 — Broker | 2 semaines | Phase 4 |
| **Total** | **10 semaines** | |

Avec Claude Code comme scaffolder, les Phases 1-3 (MVP complet avec frontend) sont realisables en 4-6 semaines de travail concentre.

---

*Plan genere par Consensus Stochastique — 7 agents, 24 avril 2026*
