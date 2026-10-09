import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { brandInput, categories } from "@radar/contracts";
import type { Express } from "express";
import { z } from "zod";
import { ownerOf } from "./accounts.js";
import { changePoints } from "./points.js";

const normalize = (s: string) =>
  s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
const submission = z
  .object({
    name: z.string().trim().min(1).max(80),
    address: z.string().trim().min(1).max(300),
    category: z.enum(categories),
    url: z
      .union([
        z.literal(""),
        z
          .string()
          .url()
          .max(2000)
          .regex(/^https?:\/\//),
      ])
      .default(""),
    note: z.string().trim().max(1000).default(""),
  })
  .strict();
export function registerShopReports(app: Express, db: PGlite) {
  const ready =
    db.exec(`CREATE TABLE IF NOT EXISTS shop_reports(id uuid PRIMARY KEY,owner_id uuid NOT NULL,name text NOT NULL,address text NOT NULL,category text NOT NULL,url text NOT NULL,note text NOT NULL,dedupe text NOT NULL,status text NOT NULL DEFAULT 'pending',brand_id uuid,review_note text,reviewed_by uuid,created_at timestamptz NOT NULL DEFAULT now(),reviewed_at timestamptz);
    ALTER TABLE shop_reports ADD COLUMN IF NOT EXISTS reward_points int NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS shop_reports_owner ON shop_reports(owner_id,created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS shop_reports_pending ON shop_reports(owner_id,dedupe) WHERE status='pending';`);
  app.get("/api/v3/shop-reports", async (req, res) => {
    await ready;
    const admin = res.locals.account?.role === "admin";
    const q = z
      .object({
        offset: z.coerce.number().int().min(0).default(0),
        status: z
          .enum(["all", "pending", "approved", "rejected"])
          .default("all"),
      })
      .parse(req.query);
    const args = [admin ? null : ownerOf(req), q.status];
    const where =
      "($1::uuid IS NULL OR r.owner_id=$1) AND ($2='all' OR r.status=$2)";
    const items = await db.query(
      `SELECT r.id,r.name,r.address,r.category,r.url,r.note,r.status,r.brand_id,r.review_note,r.created_at,r.reviewed_at,r.reward_points,b.name AS brand_name FROM shop_reports r LEFT JOIN brands b ON b.id=r.brand_id WHERE ${where} ORDER BY r.created_at DESC,r.id LIMIT 20 OFFSET $3`,
      [...args, q.offset],
    );
    const total = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM shop_reports r WHERE ${where}`,
      args,
    );
    res.json({ items: items.rows, total: total.rows[0].count });
  });
  app.post("/api/v3/shop-reports", async (req, res) => {
    await ready;
    const v = submission.parse(req.body),
      owner = ownerOf(req),
      dedupe = normalize(v.name) + "|" + normalize(v.address);
    const existing = await db.query<{ id: string }>(
      "SELECT id FROM shop_reports WHERE owner_id=$1 AND dedupe=$2 AND status='pending'",
      [owner, dedupe],
    );
    if (existing.rows.length) {
      res.json({ id: existing.rows[0].id, duplicate: true });
      return;
    }
    const count = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM shop_reports WHERE owner_id=$1 AND created_at>now()-interval '1 day'",
      [owner],
    );
    if (count.rows[0].count >= 10) {
      res
        .status(429)
        .json({ error: { message: "每天最多上报10家店铺，请明天再试" } });
      return;
    }
    const id = randomUUID();
    const out = await db.query<{ id: string }>(
      "INSERT INTO shop_reports(id,owner_id,name,address,category,url,note,dedupe) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(owner_id,dedupe) WHERE status='pending' DO NOTHING RETURNING id",
      [id, owner, v.name, v.address, v.category, v.url, v.note, dedupe],
    );
    res
      .status(out.rows.length ? 201 : 200)
      .json({ id: out.rows[0]?.id, duplicate: !out.rows.length });
  });
  app.post("/api/v3/shop-reports/:id/review", async (req, res) => {
    if (res.locals.account?.role !== "admin") {
      res.status(403).json({ error: { message: "仅管理员可审核" } });
      return;
    }
    await ready;
    const id = z.uuid().parse(req.params.id);
    const v = z
      .discriminatedUnion("decision", [
        z
          .object({
            decision: z.literal("reject"),
            note: z.string().trim().min(1).max(1000),
          })
          .strict(),
        z
          .object({
            decision: z.literal("approve"),
            note: z.string().trim().max(1000).default(""),
            brand_id: z.uuid().optional(),
            brand: brandInput.optional(),
          })
          .strict()
          .refine(
            (x) => Boolean(x.brand_id) !== Boolean(x.brand),
            "请选择已有品牌或填写新品牌",
          ),
      ])
      .parse(req.body);
    try {
      const result = await db.transaction(async (tx) => {
        const report = (
          await tx.query<any>(
            "SELECT * FROM shop_reports WHERE id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (!report) throw Error("上报记录不存在");
        if (report.status !== "pending")
          throw Error("该上报已处理，请刷新列表");
        let brandId: string | null = null;
        if (v.decision === "approve") {
          if (v.brand_id) {
            const old = (
              await tx.query<any>("SELECT * FROM brands WHERE id=$1", [
                v.brand_id,
              ])
            ).rows[0];
            if (!old) throw Error("品牌不存在，请重新搜索");
            if (!old.active) {
              await tx.query(
                "INSERT INTO changes(entity_type,entity_id,snapshot) VALUES('brand',$1,$2)",
                [old.id, JSON.stringify(old)],
              );
              await tx.query(
                "UPDATE brands SET active=true,revision=revision+1 WHERE id=$1",
                [old.id],
              );
            }
            brandId = old.id;
          } else if (v.brand) {
            const b = v.brand;
            const duplicate = (
              await tx.query("SELECT id FROM brands WHERE name_key=$1", [
                normalize(b.name),
              ])
            ).rows[0];
            if (duplicate) throw Error("该品牌已存在，请搜索并关联已有品牌");
            brandId = randomUUID();
            await tx.query(
              "INSERT INTO brands(id,name,name_key,category,aliases,shanghai_evidence_url,active,keywords) VALUES($1,$2,$3,$4,$5,$6,true,$7)",
              [
                brandId,
                b.name,
                normalize(b.name),
                b.category,
                JSON.stringify(b.aliases),
                b.shanghai_evidence_url,
                JSON.stringify(b.keywords.length ? b.keywords : [b.name]),
              ],
            );
          }
        }
        const rewarded =
          v.decision === "approve" && brandId
            ? await changePoints(
                tx,
                report.owner_id,
                20,
                `品牌上报收录奖励：${report.name}`,
                `shop-report-reward:${report.owner_id}:${brandId}`,
              )
            : false;
        await tx.query(
          "UPDATE shop_reports SET status=$2,brand_id=$3,review_note=$4,reviewed_by=$5,reviewed_at=now(),reward_points=$6 WHERE id=$1",
          [
            id,
            v.decision === "approve" ? "approved" : "rejected",
            brandId,
            v.note,
            ownerOf(req),
            rewarded ? 20 : 0,
          ],
        );
        return { brand_id: brandId, reward_points: rewarded ? 20 : 0 };
      });
      res.json(result);
    } catch (e) {
      res.status(409).json({
        error: {
          message: e instanceof Error ? e.message : "审核失败，请重试",
        },
      });
    }
  });
}
