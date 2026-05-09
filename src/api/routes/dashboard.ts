import type Database from "better-sqlite3";
import type { FastifyPluginCallback } from "fastify";
import { detectClusters } from "../../ranking/cluster-detector.js";
import { latestRankings, recentAlerts, recentTrades } from "../../db/queries.js";

export function dashboardRoutes(db: Database.Database): FastifyPluginCallback {
  return (fastify, _options, done) => {
    fastify.get("/", async () => ({
      alerts: recentAlerts(db, 10),
      topRankings: latestRankings(db, 5),
      recentTrades: recentTrades(db, 25),
      clusters: detectClusters(db)
    }));
    done();
  };
}
