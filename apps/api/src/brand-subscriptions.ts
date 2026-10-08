import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { inChannel } from "@radar/contracts";
import type { Express } from "express";
import { z } from "zod";
import { ownerOf } from "./accounts.js";

const readiness = new WeakMap<PGlite, Promise<unknown>>();
function init(db: PGlite) {
  let p = readiness.get(db);
  if (!p) {
    p =
      db.exec(`CREATE TABLE IF NOT EXISTS brand_subscriptions(owner_id uuid NOT NULL,brand_id uuid NOT NULL REFERENCES brands(id),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,brand_id));
      CREATE TABLE IF NOT EXISTS subscription_messages(id uuid PRIMARY KEY,owner_id uuid NOT NULL,brand_id uuid NOT NULL,product_id text NOT NULL,kind text NOT NULL,event_key text NOT NULL,brand_name text NOT NULL,title text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),read_at timestamptz,UNIQUE(owner_id,brand_id,product_id,event_key));
      ALTER TABLE subscription_messages ADD COLUMN IF NOT EXISTS cleared_at timestamptz;
      CREATE INDEX IF NOT EXISTS subscription_message_owner ON subscription_messages(owner_id,created_at DESC);`);
    readiness.set(db, p);
  }
  return p;
}
const lastSync = new WeakMap<PGlite, number>();
export async function syncSubscriptionMessages(db: PGlite) {
  if (Date.now() - (lastSync.get(db) ?? 0) < 60000) return;
  await init(db);
  if (
    !(
      await db.query<{ present: boolean }>(
        "SELECT to_regclass('coupon_pool_candidates') IS NOT NULL AND to_regclass('coupon_discoveries') IS NOT NULL AS present",
      )
    ).rows[0].present
  )
    return;
  const rows = (
    await db.query<{
      owner_id: string;
      brand_id: string;
      product_id: string;
      kind: string;
      event_key: string;
      brand_name: string;
      title: string;
    }>(`
    WITH candidates AS (
      SELECT s.owner_id,c.brand_id,c.product_id,b.name AS brand_name,c.payload->>'title' AS title,
      CASE WHEN d.discovered_at>=s.created_at AND d.discovered_at>now()-interval '24 hours' THEN 'new' ELSE 'surge' END AS kind,
      CASE WHEN d.discovered_at>=s.created_at AND d.discovered_at>now()-interval '24 hours' THEN 'new:'||d.discovered_at::text ELSE 'surge:'||to_char(now() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') END AS event_key
      FROM brand_subscriptions s JOIN brands b ON b.id=s.brand_id AND b.active
      JOIN coupon_pool_candidates c ON c.brand_id=s.brand_id
      JOIN coupon_baselines cb ON cb.brand_id=c.brand_id AND cb.run_id=c.run_id
      LEFT JOIN coupon_discoveries d ON d.brand_id=c.brand_id AND d.product_id=c.product_id
      WHERE c.observed_at>now()-interval '36 hours' AND c.observed_at>=s.created_at AND (c.sale_end IS NULL OR c.sale_end>now())
      AND ((d.discovered_at>=s.created_at AND d.discovered_at>now()-interval '24 hours') OR ((c.payload->>'speed')::numeric>=20 AND (c.payload->>'acceleration')::numeric>=3))
    ) SELECT * FROM candidates x WHERE NOT EXISTS(SELECT 1 FROM subscription_messages m WHERE m.owner_id=x.owner_id AND m.brand_id=x.brand_id AND m.product_id=x.product_id AND (m.event_key=x.event_key OR (m.kind=x.kind AND m.created_at>now()-interval '24 hours'))) LIMIT 500
  `)
  ).rows;
  for (const r of rows)
    await db.query(
      "INSERT INTO subscription_messages(id,owner_id,brand_id,product_id,kind,event_key,brand_name,title) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
      [
        randomUUID(),
        r.owner_id,
        r.brand_id,
        r.product_id,
        r.kind,
        r.event_key,
        r.brand_name,
        r.title,
      ],
    );
  lastSync.set(db, Date.now());
}
export function registerBrandSubscriptions(app: Express, db: PGlite) {
  const ready = init(db);
  app.get("/api/v3/brand-subscriptions/search", async (req, res) => {
    await ready;
    const q = z.string().trim().min(1).max(80).parse(req.query.q);
    const rows = await db.query(
      "SELECT id,name,category FROM brands WHERE active AND (strpos(lower(name),lower($1))>0 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(aliases) a WHERE strpos(lower(a),lower($1))>0)) ORDER BY name LIMIT 20",
      [q],
    );
    res.json({ items: rows.rows });
  });
  app.get("/api/v3/brand-subscriptions", async (req, res) => {
    await ready;
    res.json({
      items: (
        await db.query(
          "SELECT s.brand_id,b.name FROM brand_subscriptions s JOIN brands b ON b.id=s.brand_id WHERE s.owner_id=$1 ORDER BY b.name",
          [ownerOf(req)],
        )
      ).rows,
    });
  });
  app.post("/api/v3/brand-subscriptions", async (req, res) => {
    await ready;
    const v = z
      .object({ brand_id: z.string().uuid(), subscribed: z.boolean() })
      .parse(req.body);
    if (v.subscribed)
      await db.query(
        "INSERT INTO brand_subscriptions(owner_id,brand_id) SELECT $1,id FROM brands WHERE id=$2 AND active ON CONFLICT DO NOTHING",
        [ownerOf(req), v.brand_id],
      );
    else
      await db.query(
        "DELETE FROM brand_subscriptions WHERE owner_id=$1 AND brand_id=$2",
        [ownerOf(req), v.brand_id],
      );
    res.json({ ok: true });
  });
  app.get("/api/v3/brand-subscriptions/messages", async (req, res) => {
    await ready;
    const owner = ownerOf(req);
    const items = (
      await db.query<Record<string, unknown>>(
        "SELECT m.id,m.brand_id,m.product_id,m.kind,m.brand_name,m.title,m.created_at,m.read_at,b.category FROM subscription_messages m JOIN brands b ON b.id=m.brand_id WHERE m.owner_id=$1 AND m.cleared_at IS NULL ORDER BY m.created_at DESC,m.id LIMIT 50",
        [owner],
      )
    ).rows;
    const count = (
      await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM subscription_messages WHERE owner_id=$1 AND cleared_at IS NULL AND read_at IS NULL",
        [owner],
      )
    ).rows[0].count;
    res.json({
      items: items.map((m) => ({
        ...m,
        channel: inChannel(String(m.category), "leisure") ? "leisure" : "food",
      })),
      unread: count,
    });
  });
  app.delete("/api/v3/brand-subscriptions/messages", async (req, res) => {
    await ready;
    await db.query(
      "UPDATE subscription_messages SET cleared_at=now(),read_at=coalesce(read_at,now()) WHERE owner_id=$1 AND cleared_at IS NULL",
      [ownerOf(req)],
    );
    res.json({ ok: true });
  });
  app.post("/api/v3/brand-subscriptions/read", async (req, res) => {
    await ready;
    const ids = z.array(z.string().uuid()).max(50).parse(req.body.ids);
    await db.query(
      "UPDATE subscription_messages SET read_at=now() WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND read_at IS NULL",
      [ownerOf(req), ids],
    );
    res.json({ ok: true });
  });
}
