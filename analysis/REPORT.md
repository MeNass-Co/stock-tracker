# Congressional Copy-Trading Alpha Study

*Generated 2026-07-01 on branch `alpha-analysis`. All numbers are **excess returns vs SPY** (never raw), measured from the close of the first trading day **after** the disclosure (filing) date — the earliest moment a copier could act. Medians and 5/95-winsorized means only. Machine-readable stats: `analysis/results.json`.*

---

## 1. Headline

**There is no aggregate alpha in copying congressional buys. There is measurable, filter-dependent alpha in a narrow slice — and the live filter is already capturing most of it, except for one parameter (the 45-day filing-delay cap) that is demonstrably too loose.**

| Signal | n (+30d) | Median excess +30d | Winsorized mean | Hit rate |
|---|---|---|---|---|
| **All congressional buys** | 593 | **-1.47%** | -0.84% | 39.97% |
| Live gates (amount >= $15k, delay <= 45d) | 128 | **+0.04%** | +0.61% | 50.0% |
| **Proposed: amount >= $15k, delay <= 15d** | 24 | **+1.90%** | +1.32% | 58.3% |
| Buys by currently-ranked (top-15) politicians | 92 | **+1.09%** | +2.38% | 53.3% |
| Buys by unranked politicians (same period) | 27 | -2.97% | +4.00% | 40.7% |

At +90d the proposed filter holds up (+4.48% median, n = 19, hit 52.6%) while the raw sample deteriorates (-3.77% median, n = 289). The n = 24/19 cells are small — treat the *magnitude* as noisy, the *ordering* (fresh + sized > sized > everything) as the finding, because it is monotone across horizons and consistent with the delay-bucket analysis below.

**Who has alpha (buys, n >= 8 shown, sorted by +90d median excess):** only **Tim Moore (House)** shows a genuinely strong record: +6.82% median @ +30d (n = 11, hit 63.6%), **+30.29% median @ +90d (n = 9, hit 77.8%)**, with a fast 8-day median filing delay. Shelley Moore Capito is mildly positive @ +90d (+8.22%, n = 8). At the other end, **April McClain Delaney** (-4.03% @ +30d, n = 42, hit 14.3%) and **Gilbert Cisneros** (-2.77% @ +30d, **n = 165**, hit 38.2%) are reliably value-destroying to copy — Cisneros's n is large enough that this is the single most statistically solid per-politician result in the dataset.

**Sells:** House sells DO predict underperformance (sold names: -2.26% median @ +30d n = 362, -7.59% @ +90d n = 119) — but House *buys* underperform almost identically, so this is "House members hold laggards", not tradable sell-timing skill. Senate sells are uninformative (~0.0% median at every horizon, hit 48-54%). **Do not build a short/exit signal from congressional sells.**

**13F conviction sleeve:** +1.19% cumulative excess vs SPY over Feb 18 - Jun 30, 2026 (sleeve +10.69% vs SPY +9.50%), positive in both quarterly legs, 32% one-way turnover at the single rebalance. One rebalance observed — this is a sanity check, not a validation.

### Recommended live signal-filter changes

| Parameter | Current | Recommended | Evidence |
|---|---|---|---|
| Filing-delay cap | 45 days | **15 days** | <=15d bucket: +0.27% median @30d, 51.2% hit (n=127). 15-30d bucket: **-2.00%**, 36.9% hit (n=339). >30d: -1.80%, 37.0% hit (n=127). The 45d cap admits the worst bucket in the study. Expected impact: moves the copied set from ~0% to ~+1.9% median @30d, at the cost of ~80% fewer signals. |
| Amount floor $15k | keep | **keep** | <$15k bucket (63% of all buys): -1.90% median @30d, 37.2% hit (n=465). The floor is doing real work. |
| Rank gate (top-15/top-30) | keep | **keep** | Ranked +1.09% vs unranked -2.97% median @30d on post-ranking disclosures (n=92 vs 27; +30d only, ~2 months of history — directional, not proof). |
| Chamber restriction | none | **none** (do NOT go senate-only) | Senate buys beat House in aggregate (-0.6% vs -2.6% median @30d), but the only politician with real alpha (Tim Moore) is House, and the fresh+sized senate-only cell is negative (n=11). The rank gate handles chamber quality better than a blanket ban. |
| Per-politician blocklist | none | **consider**: exclude Cisneros / McClain Delaney sourced signals | n=165 / n=42 @30d, hit 38%/14% — large-n negative records; the rank gate mostly excludes them already, so this is belt-and-braces. |
| Sell-side copying (sensitive-committee exception) | active | leave as-is, expect nothing | No evidence sells predict underperformance beyond the House-laggard effect. |

---

## 2. Data audited (live DB, read-only)

| Table | Rows | Range |
|---|---|---|
| `trades` | 1,506 (737 buy / 749 sell / 20 exchange; 1,491 with ticker) | trade_date 2025-05-15 -> 2026-06-16; filing_date 2025-06-09 -> 2026-06-18 |
| `politicians` | 75 (54 house / 21 senate) | — |
| `rankings` | 999 rows, 56 runs, top-15 per chamber | 2026-04-25 -> 2026-07-01 |
| `fund_holdings` | 374 rows, 6 funds, 3 report dates | 2023-12-31 (Greenlight only, stale), 2025-12-31, 2026-03-31 — **zero tickers, CUSIP only** |
| `prices` (live) | 1,586 rows / 335 tickers | sparse — not usable for this study; own cache built instead |

Price cache built for the study: `data/analysis-prices.sqlite` — **524 symbols, 151,703 daily bars, 2025-05-01 -> 2026-06-30** (Alpaca free tier, IEX feed, `adjustment=all`). 30 symbols returned no IEX data (OTC/foreign ADRs/mutual funds: NSRGY, RYCEY, SFTBF, VWUAX, ...) and 1 "ticker" is a bond CUSIP (`571903BM4`); the affected 39 trades (2.6%) were dropped. 1,440 of 1,486 buy/sell stock trades produced a usable entry.

## 3. Methodology

- **Entry**: close of the first trading day strictly after `filing_date`. Never the transaction date — the median transaction->disclosure delay is ~25 days, and any study keyed on trade_date measures information a copier never had.
- **Horizons**: +30/+90/+180 **calendar** days from entry; exit at the first trading day on/after the target. **Full windows only** — trades whose window extends past 2026-06-30 are excluded from that horizon's stats rather than capped, to avoid mixing horizons (this is the one deliberate deviation from "capped by data end": capping would blend 10-day and 180-day returns into one cell).
- **Excess** = stock return - SPY return over identical entry/exit dates.
- **Aggregation**: median, 5/95 winsorized mean, hit rate (share beating SPY), n reported everywhere. Per-politician table thresholded at n >= 8 buys.
- **Sector split**: **not available** — no sector column in `trades`, and `raw_data` carries no sector field. Skipped rather than faked.

### Ranking validation
1. **Live-history test**: rankings exist only since 2026-04-25 (~2 months). For each buy *filed* after that date, the politician's ranked/unranked status was taken from the latest ranking run computed **before** the filing date (no look-ahead). Only the +30d horizon has complete windows. Result: ranked +1.09% vs unranked -2.97% median (n = 92 vs 27). Supportive but thin — stated plainly: **this is 2 months of one market regime.**
2. **Split-sample test** (because the history is thin): politicians ranked on first-half (filings before 2026-04-07) median +90d excess, min 5 observations -> 10 eligible, top 5 vs bottom 5; measured on second-half buys @ +30d. Top half: -1.11% median, 47.4% hit (n = 19). Bottom half: **-3.17% median, 35.1% hit (n = 148)**. Ordering preserved (top > bottom by ~2pp median, +12pp hit rate) but the top half is not positive — **past performance ranks the bad ones better than it finds the good ones.** The ranking's real, defensible function is *exclusion*, which is exactly how the signal filter uses it.

### 13F sleeve
- Universe: 5 active funds (Appaloosa, Baupost, Berkshire, Duquesne, Pershing Square; Greenlight excluded — single stale 2023 snapshot). Holdings have **no tickers**; the top positions were mapped CUSIP->ticker by hand (38 CUSIPs, all mapped; 3 index-ETF CUSIPs excluded per the live blocklist's spirit).
- **Policy**: top-5 non-ETF positions per fund by market value, conviction-weighted (weight proportional to the number of funds holding the name in their top-5 -> AMZN 12%, GOOGL/META/QSR/UBER/TSM 8% at various dates, rest 4%), rebalanced at the first trading day after each 13F filing deadline, long-only, no leverage.
- **Measured** (2 usable snapshots): leg 1 (2026-02-18 -> 2026-05-15): sleeve +8.62% vs SPY +8.01%. Leg 2 (2026-05-18 -> 2026-06-30): +1.90% vs +1.38%. **Cumulative +10.69% vs +9.50%, excess +1.19%.** Turnover at the one rebalance: 32% one-way -> roughly 130% annualized round-trip, cheap at zero-commission fractional execution.
- Honest framing: 4.5 months, one rebalance, one regime — structurally sound (45-day-stale holdings of low-turnover concentrated funds decay slowly; the conviction overlap AMZN/GOOGL/UBER is a real signal of independent agreement), empirically unproven. Run it small or paper-first.

## 4. Detailed tables

### Buys by chamber (median excess / hit rate)
| Chamber | +30d | +90d | +180d |
|---|---|---|---|
| Senate | -0.60% / 40.6% (n=229) | -2.29% / 41.2% (n=211) | -2.02% / 38.5% (n=104) |
| House | -2.64% / 39.6% (n=364) | -10.26% / 32.1% (n=78) | n=0 |

(+180d is senate-only by construction: house ingestion history is too recent for complete 180d windows.)

### Buys by filing-delay bucket
| Delay | +30d median / hit | +90d median / hit |
|---|---|---|
| <=15d | **+0.27% / 51.2%** (n=127) | -0.39% / 50.0% (n=60) |
| 15-30d | -2.00% / 36.9% (n=339) | -5.61% / 35.2% (n=193) |
| >30d | -1.80% / 37.0% (n=127) | -2.35% / 38.9% (n=36) |

### Buys by amount bucket
| Amount | +30d median / hit | +90d median / hit |
|---|---|---|
| <$15k | -1.90% / 37.2% (n=465) | -4.14% / 36.2% (n=196) |
| $15-50k | -0.60% / 46.5% (n=101) | -1.62% / 42.9% (n=70) |
| $50-100k | +1.90% / 73.3% (n=15) | +0.42% / 53.8% (n=13) |
| $100-250k | -0.61% / 44.4% (n=9) | -1.88% / 50.0% (n=8) |
| >$250k | +0.13% / 66.7% (n=3) | -29.59% / 0% (n=2) |

Monotone-ish improvement up to $100k, then nothing (n collapses). The $15k floor is the defensible cut; a $50k floor would leave ~15 signals over 13 months — untradeable.

### Per-politician (buys, n >= 8), sorted by +90d median excess
| Politician | Chamber | n buys | Med. delay | +30d med / hit | +90d med / hit | +180d med / hit |
|---|---|---|---|---|---|---|
| Tim Moore | House | 12 | 8d | +6.82% / 63.6% (11) | **+30.29% / 77.8% (9)** | — |
| John Fetterman | Senate | 8 | 4d | -0.34% / 37.5% (8) | +22.31% (n=1) | +60.99% (n=1) |
| Shelley Moore Capito | Senate | 11 | 23d | -2.69% / 36.4% (11) | +8.22% / 62.5% (8) | -1.75% / 42.9% (7) |
| Markwayne Mullin | Senate | 59 | 18d | -0.53% / 47.5% (59) | -1.22% / 44.1% (59) | -29.80% / 14.3% (7) |
| David J. Taylor | House | 29 | 8d | +2.56% / 66.7% (24) | -1.67% / 40.0% (15) | — |
| John Boozman | Senate | 114 | 25d | -0.66% / 30.3% (99) | -2.41% / 39.6% (91) | -0.42% / 41.2% (51) |
| Angus King | Senate | 23 | 28d | +0.27% / 52.2% (23) | -3.45% / 43.5% (23) | +0.15% / 52.4% (21) |
| Josh Gottheimer | House | 25 | 27d | +1.90% / 60.0% (15) | -9.21% (n=1) | — |
| Maria Elvira Salazar | House | 39 | 28d | -0.66% / 46.7% (30) | — | — |
| Jared Moskowitz | House | 19 | 30d | -7.20% / 42.1% (19) | — | — |
| April McClain Delaney | House | 64 | 21d | **-4.03% / 14.3% (42)** | -9.80% / 22.2% (9) | — |
| Gilbert Cisneros | House | 217 | 25d | **-2.77% / 38.2% (165)** | -14.70% / 22.2% (27) | — |

Fetterman's +90/+180 cells are n=1 — decoration, not evidence. Tim Moore's record is real but 9-11 observations; his current #1 house rank is consistent with it.

## 5. Caveats — read before acting

1. **IEX feed**: Alpaca free tier serves IEX-only prices — thinner venue, occasional stale closes on illiquid names; 30 OTC/foreign symbols missing entirely (2.6% of trades dropped, disproportionately foreign ADRs).
2. **Short history, one regime**: 13 months of disclosures, and the +90/+180d columns only cover trades filed before ~2026-04 / ~2026-01 respectively. The +180d column is entirely senate. Every chamber x horizon comparison partially confounds *who* with *when*.
3. **Ranking validation is 2 months old**: 56 ranking runs since 2026-04-25, +30d horizon only. The split-sample fallback shows persistence of *bad* performance, not of good.
4. **Small n everywhere that matters**: the proposed delay<=15d filter cell is n=24 @30d. The monotone bucket structure (n=127/339/127) is the evidence; the +1.9% point estimate is not.
5. **Survivorship & selection**: politicians and tickers enter the DB when ingestion started (2025-06); no delisted-ticker handling (a delisted name's truncated window is silently excluded — mild upward bias on losers' horizons).
6. **Disclosure-date assumption**: entry at next close after `filing_date` assumes same-evening detection; the live system polls intraday, so real fills could be slightly better (it can act on the disclosure day itself) — the study is conservative here.
7. **No transaction costs/slippage** modeled; at fractional zero-commission and this signal frequency the drag is small but nonzero.
8. **13F mapping is manual**: 38 CUSIPs hand-mapped; correctness verified by name but not against a CUSIP master file.
9. **Amount midpoints are range midpoints** — a "$1,001-$15,000" filing carries almost no sizing information.

## 6. Reproduce

```bash
npx tsx analysis/fetch-prices.ts     # resumable; ~4 min cold, throttled to ~150 req/min
npx tsx analysis/run-analysis.ts     # writes analysis/results.json
```

Live DB is opened `readonly`; the only file written outside `analysis/` is `data/analysis-prices.sqlite`.
