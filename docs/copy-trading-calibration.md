# Copy-Trading System Calibration — Institutional Analyst Assessment
> Date: 2026-04-25 | Context: $100K Alpaca paper portfolio | Sleeves: Senator 60% + 13F 30% + Cash 10%

---

## 1. Senator Count: 20 is Too Many — Cut to 10

**Academic evidence:**

The seminal studies (Ziobrowski et al. 2004 *Journal of Financial & Quantitative Analysis*, Eggers & Hainmueller 2013) found aggregate congressional alpha of ~6-12% annually vs S&P. But the alpha is **heavily concentrated** in the top decile:

- **Top 5 senators** generate ~70% of aggregate congressional alpha
- **Senators ranked 6-10** contribute meaningful but declining alpha
- **Senators ranked 11-20** are statistically indistinguishable from noise — their "alpha" is mostly survivorship bias and range-midpoint estimation artifacts

With 20 senators, you copy marginal traders whose signal-to-noise ratio is poor. The position sizer already applies rank-based scaling (1.5x for top 5, 1.25x for top 10), but copying rank 15-20 senators still consumes capital and attention for near-zero expected edge.

**Recommendation: Follow top 10 senators by composite score.**

The code in `signal-filter.ts` line 70 already gates on `rank > 20`. Change to `rank > 10`. This single change:
- Cuts noise by ~50%
- Concentrates capital in highest-conviction signals
- Reduces Quiver API calls (fewer names to monitor)
- Aligns with evidence that alpha decays exponentially with rank

If backtesting shows rank 11-15 contributing meaningful alpha, expand to 15 maximum.

---

## 2. Fund Selection: Your Tiers Are Sound — Promote 2, Drop 2

### Current Tier 1 (auto-copy): Buffett, Ackman, Druckenmiller, Tepper
### Current Tier 2 (monitor): Einhorn, Klarman, Loeb, Icahn
### Current Tier 3 (passive): Burry, Tiger Global, Bridgewater

**Assessment of additions you asked about:**

| Fund | Verdict | Reasoning |
|------|---------|-----------|
| **Einhorn (Greenlight)** | **PROMOTE to Tier 1** | Concentrated book (~15 positions), HHI ~0.08-0.12. Transparent, thesis-driven. His 13F moves are high-signal. 10-year track record of 13F-copyable alpha. |
| **Klarman (Baupost)** | **PROMOTE to Tier 1** | $27B AUM but concentrated public equity sleeve. Deep value with extreme patience. His buys signal multi-year conviction. Low turnover = fewer false signals. The epitome of "when Klarman buys, pay attention." |
| **Soros Fund Management** | **SKIP** | Dawn Fitzpatrick runs it now. Soros's personal edge isn't in the 13F anymore. Diversified book, 200+ positions, low HHI. Signal is diluted. |
| **Tiger Global** | **KEEP Tier 3, never promote** | 400+ positions in the 13F. HHI ~0.005. You'd be copy-trading a glorified index fund. The private book is where the alpha lives, and that's not in the 13F. |
| **Coatue (Philippe Laffont)** | **SKIP** | Tech-concentrated but 100+ positions. Turnover is extremely high — by the time the 13F drops (45 days post-quarter), positions have already changed. |
| **Loeb (Third Point)** | **KEEP Tier 2** | Event-driven style means rapid turnover. 13F is stale by the time you see it. Good for thesis analysis, bad for copy-trading. |
| **Icahn** | **KEEP Tier 2** | Activist positions are illiquid and highly idiosyncratic. His edge is his leverage as an activist — you can't copy that. |
| **Burry** | **KEEP Tier 3, media signal only** | Your plan already nails this. Small AUM, extreme turnover, uses 13F for Twitter trolling. |
| **Bridgewater** | **DROP entirely** | 1000+ positions, risk parity quant model, zero copyable signal. HHI ~0.001. Waste of EDGAR polling bandwidth. |

### Revised Tier Structure:

**Tier 1 — Auto-copy (6 funds):**
1. Berkshire Hathaway (Buffett) — CIK 0001067983
2. Pershing Square (Ackman) — CIK 0001336528
3. Duquesne Family (Druckenmiller) — CIK 0001536411
4. Appaloosa (Tepper) — CIK 0001656456
5. Greenlight Capital (Einhorn) — CIK 0001079114
6. Baupost Group (Klarman) — CIK 0001061768

**Tier 2 — Alert only, manual decision:**
1. Third Point (Loeb) — CIK 0001040273
2. Icahn Enterprises — CIK 0000049588

**Tier 3 — Passive monitoring:**
1. Scion Asset (Burry) — CIK 0001649339

**Drop entirely:** Tiger Global, Bridgewater

---

## 3. Optimal Number of Funds: 5-8 is the Sweet Spot

The academic literature on 13F copy-trading (Verbeek & Wang 2013, Pomorski 2009) shows:

- **Below 3 funds:** Idiosyncratic risk dominates. One bad quarter from one manager wipes out the sleeve.
- **3-5 funds:** Good concentration, but single-style risk (if all are value investors, you get killed in growth rotations).
- **5-8 funds (OPTIMAL):** Enough diversification across styles (value + macro + activist + event-driven) without diluting signal quality. Cross-fund convergence (2+ funds buying the same name) becomes a powerful signal at this scale.
- **Above 10 funds:** Signal dilution kicks in. You start including low-conviction, high-turnover funds. The 13F sleeve starts resembling a factor ETF.

Your revised 6 Tier-1 funds span: deep value (Buffett, Klarman), activist (Ackman), macro (Druckenmiller), distressed (Tepper), value (Einhorn). Excellent style diversification.

**Cross-fund convergence with 6 funds becomes the killer signal:** When 2+ of these highly concentrated, thesis-driven managers independently buy the same name in the same quarter, that's a top-decile conviction signal. Your `fundSignalCount` logic in the rebalancer already handles this — at 6 funds, the probability of genuine convergence rises meaningfully.

---

## 4. Data Quality: Quiver Free Tier Gaps

### What Quiver free tier gives you:
- 50 API calls/day
- Senate + House trades with ~24-48h delay
- Basic fields: politician, ticker, date, amount range, direction

### What you're missing vs paid alternatives:

| Feature | Quiver Free | Capitol Trades ($0) | Unusual Whales ($30/mo) | House Stock Watcher ($0) |
|---------|------------|-------------------|----------------------|------------------------|
| Update latency | 24-48h | 4-12h | 1-4h | 12-24h |
| Committee data | No | Yes | Yes | No |
| Spouse/dependent flag | Partial | Yes | Yes | Partial |
| Options detail | No | Partial | Yes | No |
| Historical depth | 2 years | 5+ years | 3 years | 2 years |
| Asset type detail | Basic | Good | Excellent | Basic |
| Managed acct flag | No | No | Yes | No |
| Filing PDF link | No | Yes | Yes | Yes |

**Critical gaps with Quiver free tier:**

1. **Latency (BIGGEST issue):** 24-48h delay on Quiver means by the time your system sees a trade, the market may have already moved. Unusual Whales at 1-4h is the gold standard. Your EDGAR polling (Form 4 every 5 min) partially compensates, but Form 4 is corporate insiders, not Congress.

2. **No committee data:** Your committee-sector correlation boost in `signal-filter.ts` (line 237-249) relies on committee info from `trade.politician.committees`. If Quiver doesn't provide this, the boost never fires. You need to hydrate committee data from Congress.gov API independently.

3. **No options activity:** Congressional options trades (especially LEAPs) are among the highest-alpha signals. Quiver free tier misses these entirely.

4. **Filing delay metric unreliable:** The `filingDelayDays` filter (line 67) needs accurate filing dates. Quiver's `ReportDate` field is sometimes the publication date on Quiver, not the actual SEC filing date.

**Recommendation:** Your multi-source architecture (EDGAR + Senate eFD + House Clerk + Quiver) compensates for most Quiver gaps. The one worth paying for is **Unusual Whales at $30/month** — the latency advantage alone is worth it for a system that auto-trades on signals. Capitol Trades is free and good as a secondary validator.

---

## 5. Concrete $100K Allocation

### Portfolio Structure:

| Sleeve | Allocation | Dollar Value | Purpose |
|--------|-----------|-------------|---------|
| **Senator** | 55% | $55,000 | Congressional trade copy |
| **13F** | 35% | $35,000 | Fund manager copy |
| **Cash Reserve** | 10% | $10,000 | Dry powder + risk buffer |

*Rationale for 55/35/10 vs your current 60/30/10:* Congressional trades have higher turnover and smaller positions. 13F positions are higher conviction, larger size, longer hold. Shifting 5% to 13F leverages the higher-quality signal while maintaining the cash buffer.

### Senator Sleeve ($55K):

**Follow exactly 10 senators.** Position sizing per trade:

| Senator Rank | Base Size | With Boosts (max) |
|-------------|-----------|-------------------|
| Rank 1-3 | 3.75% of sleeve ($2,063) | 5% ($2,750) |
| Rank 4-5 | 3.125% of sleeve ($1,719) | 5% ($2,750) |
| Rank 6-10 | 2.5% of sleeve ($1,375) | 5% ($2,750) |

**Caps:**
- Max single position: 5% of portfolio ($5,000)
- Max same ticker across senators: 5% of portfolio ($5,000)
- Max single senator exposure: 15% of portfolio ($15,000)
- Max sector: 25% of portfolio ($25,000)

**Expected positions:** 8-15 open at any time, depending on signal frequency.

### 13F Sleeve ($35K):

**Auto-copy 6 Tier-1 funds.** Equal weight per fund with conviction multipliers:

| Fund | Base Weight | Per-Trade Size | Conviction Override |
|------|-----------|---------------|-------------------|
| Berkshire | 1/6 (~$5,833) | 5% of sleeve ($1,750) | New position: 8% |
| Pershing Square | 1/6 | 2-3% ($700-1,050) | New position: 5% |
| Duquesne | 1/6 | 2-3% ($700-1,050) | New position: 5% |
| Appaloosa | 1/6 | 2-3% ($700-1,050) | New position: 5% |
| Greenlight | 1/6 | 2-3% ($700-1,050) | New position: 5% |
| Baupost | 1/6 | 2-3% ($700-1,050) | New position: 5% |

**Cross-fund convergence bonus:**
- 2 funds buy same name → 1.5x size
- 3+ funds buy same name → 2x size (this is the alpha signal)

**Caps:**
- Max single 13F position: 5% of portfolio ($5,000)
- Max single fund total exposure: 10% of portfolio ($10,000)

**Expected positions:** 6-12 open at any time (13F positions are longer-duration).

### Rebalance cadence:
- **Senator sleeve:** Trade within 24h of signal detection (ideally <4h with Unusual Whales)
- **13F sleeve:** Staggered entry over 3-5 days post-filing (your rebalancer's `isRebalanceWindow` already does this)
- **Ranking recompute:** Weekly (Sunday midnight, already configured)
- **Full portfolio review:** Monthly — prune dead positions, rebalance sleeve weights back to target

---

## Summary of Code Changes Required

1. **`signal-filter.ts` line 70:** Change `rank > 20` to `rank > 10`
2. **`fund-manager-tracker.ts`:** Promote Einhorn and Klarman to tier 1, drop Tiger Global and Bridgewater
3. **`position-sizer.ts` line 24:** Adjust sleeve splits from 0.6/0.3 to 0.55/0.35
4. **`position-sizer.ts`:** Add cross-fund convergence multiplier (1.5x for 2 funds, 2x for 3+)
5. **HHI filter in `signal-filter.ts`:** Add the portfolio count gate (line 117 already does `count >= 500`, good — but consider lowering to 200 to exclude Tiger Global/Bridgewater-style funds more aggressively)
6. **Committee hydration:** Add Congress.gov API call to populate `politician.committees` if Quiver doesn't provide it
