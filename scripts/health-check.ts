import { getDb } from "../src/db/queries.js";
import { EdgarSource } from "../src/ingestion/edgar.js";
import { QuiverSource } from "../src/ingestion/quiver.js";

const db = getDb();
const counts = {
  politicians: (db.prepare("SELECT count(*) AS n FROM politicians").get() as any).n,
  trades: (db.prepare("SELECT count(*) AS n FROM trades").get() as any).n,
  holdings: (db.prepare("SELECT count(*) AS n FROM fund_holdings").get() as any).n,
  rankings: (db.prepare("SELECT count(*) AS n FROM rankings").get() as any).n,
  alerts: (db.prepare("SELECT count(*) AS n FROM alerts").get() as any).n
};
const sources = await Promise.all([new EdgarSource().healthCheck(), new QuiverSource().healthCheck()]);
console.log(JSON.stringify({ ok: true, counts, sources }, null, 2));
