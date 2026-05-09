import type Database from "better-sqlite3";
import type { FastifyPluginCallback } from "fastify";
import { recentTrades } from "../../db/queries.js";

export function tradesRoutes(db: Database.Database): FastifyPluginCallback {
  return (fastify, _options, done) => {
    fastify.get("/", async (request) => {
      const limit = Number((request.query as any).limit ?? 100);
      return recentTrades(db, limit);
    });
    done();
  };
}
