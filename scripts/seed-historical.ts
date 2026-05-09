import { QuiverSource } from "../src/ingestion/quiver.js";
import { getDb, insertTrades } from "../src/db/queries.js";

const db = getDb();
const quiver = new QuiverSource();
const trades = await quiver.fetchNewTrades();
const results = insertTrades(db, trades);
console.log(
  JSON.stringify(
    {
      source: "quiver",
      fetched: trades.length,
      inserted: results.filter((result) => result.inserted).length,
      note: "Quiver free tier exposes the live Congress endpoint specified in PLAN.md; historical depth depends on the API key tier."
    },
    null,
    2
  )
);
