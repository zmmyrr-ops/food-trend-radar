import type { PGlite } from "@electric-sql/pglite";
import type { Express } from "express";
import { z } from "zod";
import { ownerOf } from "./accounts.js";

const readiness = new WeakMap<PGlite, Promise<unknown>>();
function init(db: PGlite) {
  let ready = readiness.get(db);
  if (!ready) {
    ready = db.exec(`CREATE TABLE IF NOT EXISTS brand_blacklist (
      owner_id uuid NOT NULL, brand_id uuid NOT NULL REFERENCES brands(id),
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,brand_id)
    )`);
    readiness.set(db, ready);
  }
  return ready;
}
export async function readBrandBlacklist(db: PGlite, owner: string) {
  await init(db);
  return new Set(
    (
      await db.query<{ brand_id: string }>(
        "SELECT brand_id FROM brand_blacklist WHERE owner_id=$1",
        [owner],
      )
    ).rows.map((r) => r.brand_id),
  );
}
export function registerBrandBlacklist(app: Express, db: PGlite) {
  app.get("/api/v3/brand-blacklist", async (req, res) => {
    await init(db);
    res.json({
      items: (
        await db.query(
          "SELECT s.brand_id,b.name FROM brand_blacklist s JOIN brands b ON b.id=s.brand_id WHERE s.owner_id=$1 ORDER BY b.name",
          [ownerOf(req)],
        )
      ).rows,
    });
  });
  app.get("/api/v3/brand-blacklist/search", async (req, res) => {
    const q = z.string().trim().min(1).max(80).parse(req.query.q);
    res.json({
      items: (
        await db.query(
          "SELECT id,name FROM brands WHERE active AND (strpos(lower(name),lower($1))>0 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(aliases) a WHERE strpos(lower(a),lower($1))>0)) ORDER BY name LIMIT 20",
          [q],
        )
      ).rows,
    });
  });
  app.post("/api/v3/brand-blacklist", async (req, res) => {
    await init(db);
    const v = z
      .object({ brand_id: z.string().uuid(), blocked: z.boolean() })
      .strict()
      .parse(req.body);
    if (v.blocked) {
      const found = await db.query(
        "SELECT id FROM brands WHERE id=$1 AND active",
        [v.brand_id],
      );
      if (!found.rows.length)
        return res
          .status(404)
          .json({ error: { message: "品牌不存在或已停用" } });
      await db.query(
        "INSERT INTO brand_blacklist(owner_id,brand_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [ownerOf(req), v.brand_id],
      );
    } else {
      await db.query(
        "DELETE FROM brand_blacklist WHERE owner_id=$1 AND brand_id=$2",
        [ownerOf(req), v.brand_id],
      );
    }
    res.json({ ok: true });
  });
}
