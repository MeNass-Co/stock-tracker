# Stock Tracker

Implementation of `PLAN.md` Phase 1 and Phase 2, plus the Phase 3 React scaffold.

## Setup

```bash
npm install
cd frontend && npm install
```

## Backend

```bash
npm run dev
npm run seed
npm run backtest
npm run health
npm test
```

PM2 on macOS:

```bash
npm run build
npm run pm2:start
npm run pm2:save
npm run pm2:startup
```

## Frontend

```bash
cd frontend
npm run dev
```

The Vite server proxies `/api` and `/health` to `http://localhost:3001`.
