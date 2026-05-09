import type Database from "better-sqlite3";
import type { FastifyPluginCallback } from "fastify";

export function senatorsRoutes(db: Database.Database): FastifyPluginCallback {
  return (fastify, _options, done) => {
    fastify.get("/", async () =>
      db
        .prepare(
          `SELECT p.*,
                  count(t.id) AS trade_count
           FROM politicians p
           LEFT JOIN trades t ON t.politician_id = p.id
           WHERE p.chamber = 'senate'
           GROUP BY p.id
           ORDER BY p.name`
        )
        .all()
    );

    fastify.get("/:id", async (request) => {
      const id = Number((request.params as any).id);
      const politician = db.prepare("SELECT * FROM politicians WHERE id = ?").get(id);
      const trades = db.prepare("SELECT * FROM trades WHERE politician_id = ? ORDER BY trade_date DESC").all(id);
      return { politician, trades };
    });
    done();
  };
}
