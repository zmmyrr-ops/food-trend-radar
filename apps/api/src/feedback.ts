import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { Express } from "express";
import { z } from "zod";
import { ownerOf } from "./accounts.js";

export function registerFeedback(app: Express, db: PGlite) {
  const ready = db.exec(
    `CREATE TABLE IF NOT EXISTS user_feedback(id uuid PRIMARY KEY,owner_id uuid NOT NULL,content text NOT NULL,status text NOT NULL DEFAULT 'pending',reply text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()); CREATE INDEX IF NOT EXISTS user_feedback_owner ON user_feedback(owner_id,created_at DESC);`,
  );
  app.get("/api/v3/feedback", async (req, res) => {
    await ready;
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .default(0)
      .parse(req.query.offset);
    const owner = res.locals.account?.role === "admin" ? null : ownerOf(req);
    const items = await db.query(
      `SELECT id,content,status,reply,created_at,updated_at FROM user_feedback WHERE ($1::uuid IS NULL OR owner_id=$1) ORDER BY created_at DESC,id LIMIT 20 OFFSET $2`,
      [owner, offset],
    );
    const total = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM user_feedback WHERE ($1::uuid IS NULL OR owner_id=$1)`,
      [owner],
    );
    res.json({ items: items.rows, total: total.rows[0].count });
  });
  app.post("/api/v3/feedback", async (req, res) => {
    await ready;
    const { content } = z
      .object({ content: z.string().trim().min(5).max(2000) })
      .strict()
      .parse(req.body);
    const owner = ownerOf(req);
    const result = await db.transaction(async (tx) => {
      const duplicate = await tx.query(
        `SELECT id FROM user_feedback WHERE owner_id=$1 AND content=$2 AND status='pending' LIMIT 1`,
        [owner, content],
      );
      if (duplicate.rows.length) return { duplicate: true };
      const count = await tx.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM user_feedback WHERE owner_id=$1 AND created_at>now()-interval '1 day'`,
        [owner],
      );
      if (count.rows[0].count >= 10) return { limited: true };
      await tx.query(
        `INSERT INTO user_feedback(id,owner_id,content) VALUES($1,$2,$3)`,
        [randomUUID(), owner, content],
      );
      return { ok: true };
    });
    if (result.limited) {
      res.status(429).json({ error: { message: "每天最多提交10条问题反馈" } });
      return;
    }
    res.status(result.duplicate ? 200 : 201).json(result);
  });
  app.post("/api/v3/feedback/:id/reply", async (req, res) => {
    if (res.locals.account?.role !== "admin") {
      res.status(403).json({ error: { message: "仅管理员可处理反馈" } });
      return;
    }
    await ready;
    const id = z.uuid().parse(req.params.id);
    const v = z
      .object({
        status: z.enum(["pending", "resolved"]),
        reply: z.string().trim().min(1).max(2000),
      })
      .strict()
      .parse(req.body);
    const result = await db.query(
      `UPDATE user_feedback SET status=$2,reply=$3,updated_at=now() WHERE id=$1 RETURNING id`,
      [id, v.status, v.reply],
    );
    if (!result.rows.length) {
      res.status(404).json({ error: { message: "反馈不存在" } });
      return;
    }
    res.json({ ok: true });
  });
}
