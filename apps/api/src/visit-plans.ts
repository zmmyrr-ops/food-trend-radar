import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { ownerOf } from "./accounts.js";
import { registerMaps } from "./maps.js";

const uuid = z.string().uuid();
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v);
    return Number.isFinite(+d) && d.toISOString().slice(0, 10) === v;
  }, "日期无效");
const planInput = z.object({ name: z.string().trim().min(1).max(80), date });
const storeInput = z.object({
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().min(1).max(300),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  brand_id: uuid.nullable().default(null),
  product_id: z.string().max(80).nullable().default(null),
});
export type VisitStore = {
  id: string;
  plan_id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  brand_id: string | null;
  product_id: string | null;
  plan_name: string;
  date: string;
};
export async function ownedVisitStore(db: PGlite, id: string, owner: string) {
  return (
    await db.query<VisitStore>(
      `SELECT s.*,p.name plan_name,p.date FROM visit_plan_stores s JOIN visit_plans p ON p.id=s.plan_id WHERE s.id=$1 AND p.owner_id=$2 AND p.deleted_at IS NULL AND s.deleted_at IS NULL`,
      [uuid.parse(id), owner],
    )
  ).rows[0];
}
export async function createVisitPlans(db: PGlite) {
  await db.exec(`CREATE TABLE IF NOT EXISTS visit_plans(id uuid PRIMARY KEY,owner_id uuid NOT NULL,name text NOT NULL,date text NOT NULL,created_at timestamptz DEFAULT now(),deleted_at timestamptz);
 CREATE INDEX IF NOT EXISTS visit_plans_owner ON visit_plans(owner_id);
 CREATE TABLE IF NOT EXISTS visit_plan_stores(id uuid PRIMARY KEY,plan_id uuid NOT NULL REFERENCES visit_plans(id),name text NOT NULL,address text NOT NULL,lat double precision NOT NULL,lng double precision NOT NULL,brand_id uuid,product_id text,position integer NOT NULL DEFAULT 0,identity text NOT NULL,deleted_at timestamptz);
 ALTER TABLE visit_plan_stores ADD COLUMN IF NOT EXISTS coupon_refs jsonb NOT NULL DEFAULT '[]'::jsonb;
 CREATE UNIQUE INDEX IF NOT EXISTS visit_store_unique ON visit_plan_stores(plan_id,identity) WHERE deleted_at IS NULL;`);
  const wrap =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (e) {
        res.status(e instanceof z.ZodError ? 400 : 400).json({
          error: {
            message:
              e instanceof z.ZodError
                ? "请检查名称、日期和地图位置"
                : e instanceof Error
                  ? e.message
                  : "操作失败",
          },
        });
      }
    };
  const owned = async (id: unknown, req: Request) => {
    const p = (
      await db.query(
        "SELECT * FROM visit_plans WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL",
        [uuid.parse(id), ownerOf(req)],
      )
    ).rows[0];
    if (!p) throw Error("计划不存在");
    return p;
  };
  return {
    register(app: Express) {
      registerMaps(app);
      app.get(
        "/api/v3/visit-plans",
        wrap(async (req, res) => {
          const plans = (
            await db.query<{ id: string; name: string; date: string }>(
              `SELECT * FROM visit_plans WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY date DESC,created_at DESC`,
              [ownerOf(req)],
            )
          ).rows;
          const stores = (
            await db.query<VisitStore>(
              `SELECT s.* FROM visit_plan_stores s JOIN visit_plans p ON p.id=s.plan_id WHERE p.owner_id=$1 AND p.deleted_at IS NULL AND s.deleted_at IS NULL ORDER BY s.position,s.id`,
              [ownerOf(req)],
            )
          ).rows;
          res.json({
            items: plans.map((p) => ({
              ...p,
              stores: stores.filter((s) => s.plan_id === p.id),
            })),
          });
        }),
      );
      app.post(
        "/api/v3/visit-plans",
        wrap(async (req, res) => {
          const v = planInput.parse(req.body),
            id = randomUUID();
          await db.query(
            "INSERT INTO visit_plans(id,owner_id,name,date) VALUES($1,$2,$3,$4)",
            [id, ownerOf(req), v.name, v.date],
          );
          res.status(201).json({ id });
        }),
      );
      app.patch(
        "/api/v3/visit-plans/:id",
        wrap(async (req, res) => {
          await owned(req.params.id, req);
          const v = planInput.parse(req.body);
          await db.query("UPDATE visit_plans SET name=$2,date=$3 WHERE id=$1", [
            req.params.id,
            v.name,
            v.date,
          ]);
          res.json({ ok: true });
        }),
      );
      app.delete(
        "/api/v3/visit-plans/:id",
        wrap(async (req, res) => {
          await owned(req.params.id, req);
          await db.query(
            "UPDATE visit_plans SET deleted_at=now() WHERE id=$1",
            [req.params.id],
          );
          res.json({ ok: true });
        }),
      );
      app.post(
        "/api/v3/visit-plans/:id/stores",
        wrap(async (req, res) => {
          await owned(req.params.id, req);
          const v = storeInput.parse(req.body),
            id = randomUUID();
          if (Boolean(v.brand_id) !== Boolean(v.product_id))
            throw Error("券关联信息不完整");
          if (
            v.brand_id &&
            !(
              await db.query(
                "SELECT 1 FROM coupon_items WHERE brand_id=$1 AND product_id=$2 LIMIT 1",
                [v.brand_id, v.product_id],
              )
            ).rows.length
          )
            throw Error("关联券不存在");
          const identity = (v.name + "|" + v.address)
            .normalize("NFKC")
            .toLowerCase()
            .replace(/\s/g, "");
          const out = await db.query<{ id: string }>(
            `INSERT INTO visit_plan_stores(id,plan_id,name,address,lat,lng,brand_id,product_id,position,identity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,(SELECT coalesce(max(position),0)+1 FROM visit_plan_stores WHERE plan_id=$2),$9) ON CONFLICT(plan_id,identity) WHERE deleted_at IS NULL DO NOTHING RETURNING id`,
            [
              id,
              req.params.id,
              v.name,
              v.address,
              v.lat,
              v.lng,
              v.brand_id,
              v.product_id,
              identity,
            ],
          );
          const savedId =
            out.rows[0]?.id ||
            (
              await db.query<{ id: string }>(
                "SELECT id FROM visit_plan_stores WHERE plan_id=$1 AND identity=$2 AND deleted_at IS NULL",
                [req.params.id, identity],
              )
            ).rows[0]?.id;
          if (v.brand_id && v.product_id && savedId) {
            const ref = JSON.stringify([
              { brand_id: v.brand_id, product_id: v.product_id },
            ]);
            await db.query(
              "UPDATE visit_plan_stores SET coupon_refs=coupon_refs || $2::jsonb WHERE id=$1 AND NOT coupon_refs @> $2::jsonb",
              [savedId, ref],
            );
          }
          res
            .status(out.rows.length ? 201 : 200)
            .json({ id: savedId, duplicate: !out.rows.length });
        }),
      );
      app.patch(
        "/api/v3/visit-plans/:id/stores/:store",
        wrap(async (req, res) => {
          await owned(req.params.id, req);
          const s = await ownedVisitStore(
            db,
            uuid.parse(req.params.store),
            ownerOf(req),
          );
          if (!s || s.plan_id !== req.params.id) throw Error("店铺不存在");
          const v = storeInput
            .omit({ brand_id: true, product_id: true })
            .parse(req.body);
          const identity = (v.name + "|" + v.address)
            .normalize("NFKC")
            .toLowerCase()
            .replace(/\s/g, "");
          await db.query(
            "UPDATE visit_plan_stores SET name=$2,address=$3,lat=$4,lng=$5,identity=$6 WHERE id=$1",
            [s.id, v.name, v.address, v.lat, v.lng, identity],
          );
          res.json({ ok: true });
        }),
      );
      app.delete(
        "/api/v3/visit-plans/:id/stores/:store",
        wrap(async (req, res) => {
          await owned(req.params.id, req);
          await db.query(
            "UPDATE visit_plan_stores SET deleted_at=now() WHERE id=$1 AND plan_id=$2",
            [uuid.parse(req.params.store), req.params.id],
          );
          res.json({ ok: true });
        }),
      );
      app.put(
        "/api/v3/visit-plans/:id/order",
        wrap(async (req, res) => {
          await owned(req.params.id, req);
          const ids = z.array(uuid).max(100).parse(req.body.ids);
          await db.transaction(async (tx) => {
            const rows = (
              await tx.query<{ id: string }>(
                "SELECT id FROM visit_plan_stores WHERE plan_id=$1 AND deleted_at IS NULL",
                [req.params.id],
              )
            ).rows;
            if (
              ids.length !== rows.length ||
              new Set(ids).size !== ids.length ||
              rows.some((r) => !ids.includes(r.id))
            )
              throw Error("店铺列表已变化，请刷新后重试");
            for (let i = 0; i < ids.length; i++)
              await tx.query(
                "UPDATE visit_plan_stores SET position=$2 WHERE id=$1",
                [ids[i], i],
              );
          });
          res.json({ ok: true });
        }),
      );
      app.get(
        "/api/v3/visit-stores/:id",
        wrap(async (req, res) => {
          const item = await ownedVisitStore(
            db,
            uuid.parse(req.params.id),
            ownerOf(req),
          );
          if (!item) {
            res.status(404).json({ error: { message: "计划店铺不存在" } });
            return;
          }
          res.json({ item });
        }),
      );
    },
  };
}
