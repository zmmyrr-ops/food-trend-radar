import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { Express } from "express";
import { z } from "zod";
import { readConditionComparison } from "./coupon-condition-comparison.js";
import {
  salesEvidenceAssessment,
  type scoreOpportunity,
} from "./opportunity-score.js";
import { createSalesHeat } from "./sales-heat.js";
import {
  scoreEvidenceJoins,
  scoreEvidenceMatches,
} from "./score-evidence-sql.js";

export async function createScoreHistory(
  db: PGlite,
  notify: (
    brand: string,
    product: string,
    revision: string,
    score: ReturnType<typeof scoreOpportunity>,
  ) => Promise<unknown>,
) {
  await db.exec(`CREATE TABLE IF NOT EXISTS coupon_score_history(id text PRIMARY KEY,brand_id uuid NOT NULL,product_id text NOT NULL,run_id uuid NOT NULL,evidence_revision text NOT NULL,scored_at timestamptz NOT NULL DEFAULT now(),payload jsonb NOT NULL);
    CREATE INDEX IF NOT EXISTS coupon_score_history_lookup ON coupon_score_history(brand_id,product_id,scored_at DESC);
    CREATE TABLE IF NOT EXISTS coupon_score_checks(brand_id uuid,product_id text,checked_at timestamptz NOT NULL,PRIMARY KEY(brand_id,product_id));`);
  let refreshTurns = 0;
  async function refresh(limit = 100) {
    const prioritize = ++refreshTurns % 4 !== 0;
    const candidates = (
      await db.query<{ brand_id: string; product_id: string }>(
        `SELECT i.brand_id,i.product_id FROM coupon_items i JOIN coupon_baselines b ON b.run_id=i.run_id AND b.brand_id=i.brand_id JOIN coupon_tasks t ON t.run_id=i.run_id AND t.brand_id=i.brand_id JOIN brands br ON br.id=i.brand_id AND br.active LEFT JOIN coupon_score_checks c ON c.brand_id=i.brand_id AND c.product_id=i.product_id ${scoreEvidenceJoins} WHERE t.state='complete' AND i.payload->>'identity'='name_match' AND i.observed_at<=now() AND i.observed_at>now()-interval '36 hours' ORDER BY ${prioritize ? "CASE WHEN c.checked_at IS NOT NULL AND greatest(i.observed_at,prior.observed_at,rule_now.observed_at,store_now.observed_at,rule_before.observed_at,store_before.observed_at)>c.checked_at THEN 0 ELSE 1 END," : ""} c.checked_at NULLS FIRST,i.brand_id,i.product_id LIMIT $1`,
        [limit],
      )
    ).rows;
    const heatByCoupon = new Map(
      (await createSalesHeat(db).read()).map((x) => [
        `${x.brand_id}:${x.product_id}`,
        x,
      ]),
    );
    let inserted = 0;
    for (const row of candidates) {
      const evidence = await readConditionComparison(
        db,
        row.product_id,
        row.brand_id,
      );
      if (!evidence) continue;
      // Only the complete store snapshot can currently establish this one gate.
      // Price/title clues are never silently upgraded into verified value or identity.
      const sales =
        heatByCoupon.get(`${row.brand_id}:${row.product_id}`) ?? null;
      const score = salesEvidenceAssessment(
        evidence.current_evidence.fresh &&
          (evidence.current_evidence.shanghai_count ?? 0) > 0,
        sales?.speed !== null && sales?.speed !== undefined,
      );
      const payload = {
        score,
        evidence,
        features: {
          value: null,
          novelty: "unconfirmed",
          heat: null,
          environment: null,
          sales_heat: sales,
          scoring_policy:
            "销量使用原始速度、加速度和历史倍数；综合分未校准，不赋分、不自动推荐。",
        },
        adapter_version: "sales-evidence-v4",
      };
      const revision = createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex");
      const id = randomUUID();
      await db.transaction(async (tx) => {
        const latest = (
          await tx.query<{ evidence_revision: string }>(
            "SELECT evidence_revision FROM coupon_score_history WHERE brand_id=$1 AND product_id=$2 ORDER BY scored_at DESC,id DESC LIMIT 1",
            [row.brand_id, row.product_id],
          )
        ).rows[0];
        const r =
          latest?.evidence_revision === revision
            ? { rows: [] }
            : await tx.query(
                "INSERT INTO coupon_score_history(id,brand_id,product_id,run_id,evidence_revision,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id",
                [
                  id,
                  row.brand_id,
                  row.product_id,
                  evidence.current_run_id,
                  revision,
                  JSON.stringify(payload),
                ],
              );
        inserted += r.rows.length;
        await tx.query(
          "INSERT INTO coupon_score_checks VALUES($1,$2,now()) ON CONFLICT(brand_id,product_id) DO UPDATE SET checked_at=excluded.checked_at",
          [row.brand_id, row.product_id],
        );
      });
      // Alert deduplication and eligibility checks remain the responsibility of the same alert service.
      await notify(row.brand_id, row.product_id, revision, score);
    }
    return { checked: candidates.length, inserted };
  }
  function register(app: Express) {
    app.get("/api/v3/coupons/:id/scores", async (req, res) => {
      const product = z.string().regex(/^\d+$/).parse(req.params.id),
        brand = z.uuid().parse(req.query.brand_id);
      const items = (
        await db.query(
          "SELECT run_id,scored_at,evidence_revision,payload FROM coupon_score_history WHERE brand_id=$1 AND product_id=$2 ORDER BY scored_at DESC,id DESC LIMIT 100",
          [brand, product],
        )
      ).rows;
      res.json({ current_version: "V4.2.sales-evidence", items });
    });
    app.get("/api/v3/rankings", async (req, res) => {
      const gate = z
        .enum(["watch", "eligible"])
        .default("watch")
        .parse(req.query.gate);
      const items = (
        await db.query(
          `SELECT s.brand_id,b.name AS brand_name,s.product_id,s.run_id,s.scored_at,s.payload FROM coupon_baselines base JOIN brands b ON b.id=base.brand_id AND b.active JOIN coupon_items i ON i.brand_id=base.brand_id AND i.run_id=base.run_id JOIN coupon_tasks t ON t.run_id=i.run_id AND t.brand_id=i.brand_id AND t.state='complete' ${scoreEvidenceJoins} JOIN LATERAL(SELECT h.* FROM (SELECT * FROM coupon_score_history WHERE brand_id=i.brand_id AND product_id=i.product_id AND run_id=i.run_id ORDER BY scored_at DESC,id DESC LIMIT 1) h WHERE ${scoreEvidenceMatches}) s ON true WHERE i.observed_at<=now() AND i.observed_at>now()-interval '36 hours' AND s.payload->'score'->>'gate'=$1 ORDER BY (s.payload#>>'{features,sales_heat,speed}')::numeric DESC NULLS LAST,s.scored_at DESC,s.brand_id,s.product_id LIMIT 100`,
          [gate],
        )
      ).rows;
      res.json({
        items,
        caveat:
          "仅包含已完成 V4 评估的当前新鲜基线，按月售净增速度排序；未生成综合分，不是推荐。完整实时销量排序见热度榜。",
      });
    });
  }
  return { refresh, register };
}
