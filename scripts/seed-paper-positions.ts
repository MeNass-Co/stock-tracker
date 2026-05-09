import "dotenv/config";
import { config } from "../src/config.js";
import { getDb, insertStockExecution, insertStockPosition } from "../src/db/queries.js";
import { AlpacaClient } from "../src/execution/alpaca-client.js";

const SEED_POSITIONS = [
  { ticker: "NVDA", senator: "Markwayne Mullin", rank: 5, notional: 5000 },
  { ticker: "MSFT", senator: "Markwayne Mullin", rank: 5, notional: 5000 },
  { ticker: "GOOGL", senator: "Markwayne Mullin", rank: 5, notional: 5000 },
  { ticker: "AAPL", senator: "Markwayne Mullin", rank: 5, notional: 5000 },
  { ticker: "UNH", senator: "Markwayne Mullin", rank: 5, notional: 4000 },
  { ticker: "UBER", senator: "John Hickenlooper", rank: 9, notional: 3000 },
  { ticker: "JPM", senator: "Markwayne Mullin", rank: 5, notional: 4000 },
  { ticker: "META", senator: "Markwayne Mullin", rank: 5, notional: 4000 },
];

async function main() {
  const alpaca = new AlpacaClient();
  const db = getDb();

  const account = await alpaca.getAccount();
  console.log(`Alpaca paper account: $${account.equity} equity, $${account.cash} cash`);

  const clock = await alpaca.getClock();
  console.log(`Market ${clock.is_open ? "OPEN" : "CLOSED"}`);
  if (!clock.is_open) console.log(`Queued orders will execute at next open: ${clock.next_open}`);

  for (const pos of SEED_POSITIONS) {
    try {
      const asset = await alpaca.getAsset(pos.ticker);
      if (!asset?.tradable || !asset.fractionable) {
        console.log(`SKIP ${pos.ticker} — not tradable/fractionable`);
        continue;
      }

      const order = await alpaca.submitOrder({
        symbol: pos.ticker,
        notional: pos.notional,
        side: "buy",
        type: "market",
        time_in_force: "day",
      });

      console.log(`BUY $${pos.notional} ${pos.ticker} — order ${order.id} (${order.status})`);

      const qty = order.filled_qty ? Number(order.filled_qty) : 0;
      const price = order.filled_avg_price ? Number(order.filled_avg_price) : 0;

      const executionId = insertStockExecution(db, {
        triggerType: "senator_trade",
        triggerId: undefined,
        sleeve: "senator",
        ticker: pos.ticker,
        direction: "buy",
        quantity: qty,
        limitPrice: undefined,
        amountUsd: pos.notional,
        status: order.status === "filled" ? "filled" : "submitted",
        senatorName: pos.senator,
        senatorRank: pos.rank,
        fundName: null,
        notes: `paper-seed: copy ${pos.senator} (rank #${pos.rank})`,
        alpacaOrderId: order.id,
      });

      if (order.status === "filled" && price > 0) {
        insertStockPosition(db, {
          entryExecutionId: executionId,
          sleeve: "senator",
          ticker: pos.ticker,
          quantity: qty,
          avgEntryPrice: price,
          stopLossPrice: price * 0.92,
          triggerType: "senator_trade",
        });
        console.log(`  → FILLED ${qty} @ $${price.toFixed(2)}`);
      }
    } catch (err) {
      console.log(`ERROR ${pos.ticker}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log("\nSeed complete. Position monitor will manage stop-losses and trailing stops.");
  db.close();
}

main().catch(console.error);
