import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { Express } from "express";
import { z } from "zod";
import type { scoreOpportunity } from "./opportunity-score.js";
export async function createAlerts(db: PGlite) {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS radar_alerts(id text PRIMARY KEY,kind text NOT NULL,title text NOT NULL,created_at timestamptz DEFAULT now(),acknowledged_at timestamptz,payload jsonb NOT NULL)",
  );
  async function emit(
    key: string,
    kind: string,
    title: string,
    payload: unknown,
  ) {
    const id = createHash("sha256").update(key).digest("hex");
    await db.query(
      "INSERT INTO radar_alerts(id,kind,title,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [id, kind, title, JSON.stringify(payload)],
    );
    return id;
  }
  async function opportunity(
    brandId: string,
    productId: string,
    evidenceRevision: string,
    score: ReturnType<typeof scoreOpportunity>,
  ) {
    if (
      !score.alert ||
      score.gate !== "eligible" ||
      score.missing.length ||
      score.range.low < 70
    )
      return null;
    return emit(
      `opportunity:${brandId}:${productId}:${evidenceRevision}:${score.version}`,
      "opportunity",
      "发现已核验的优惠机会",
      { brandId, productId, evidenceRevision, score },
    );
  }
  async function health() {
    const pause = (
      await db.query<{ pause_reason: string | null }>(
        "SELECT pause_reason FROM coupon_settings WHERE id=1",
      )
    ).rows[0]?.pause_reason;
    const latest =
      (
        await db.query<{ id: string }>(
          "SELECT id FROM coupon_runs ORDER BY started_at DESC LIMIT 1",
        )
      ).rows[0]?.id ?? "none";
    if (pause && pause !== "USER_PAUSED")
      await emit(`capture:${latest}:${pause}`, "capture", "采集已自动暂停", {
        reason: pause,
        run_id: latest,
      });
  }
  function register(app: Express) {
    app.get("/api/v3/alerts", async (_req, res) =>
      res.json({
        items: (
          await db.query(
            "SELECT * FROM radar_alerts ORDER BY created_at DESC LIMIT 100",
          )
        ).rows,
      }),
    );
    app.post("/api/v3/alerts/:id/ack", async (req, res) => {
      const id = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(req.params.id);
      const result = await db.query(
        "UPDATE radar_alerts SET acknowledged_at=coalesce(acknowledged_at,now()) WHERE id=$1 RETURNING id",
        [id],
      );
      res
        .status(result.rows.length ? 200 : 404)
        .json({ acknowledged: result.rows.length > 0 });
    });
  }
  return { emit, opportunity, health, register };
}
