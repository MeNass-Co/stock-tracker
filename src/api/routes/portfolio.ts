import type Database from "better-sqlite3";
import type { FastifyPluginCallback } from "fastify";
import { fundHoldings } from "../../db/queries.js";
import { BUFFETT_FUND } from "../../tracking/buffett-tracker.js";
import { FUND_MANAGERS } from "../../tracking/fund-manager-tracker.js";

export function portfolioRoutes(db: Database.Database): FastifyPluginCallback {
  return (fastify, _options, done) => {
    fastify.get("/", async (request) => {
      const fundCik = (request.query as any).fundCik as string | undefined;
      return fundHoldings(db, fundCik);
    });

    fastify.get("/buffett", async () => ({
      fund: BUFFETT_FUND,
      holdings: fundHoldings(db, BUFFETT_FUND.cik)
    }));

    fastify.get("/funds", async () => FUND_MANAGERS);
    done();
  };
}
