import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { Express } from "express";
import { z } from "zod";
import { assessCoupon } from "./coupon-evidence.js";
import { couponUseOutlook } from "./coupon-use-outlook.js";
import type { Coupon } from "./coupons.js";
import { readModel } from "./read-model-cache.js";
import type { RuleText } from "./rule-structure.js";
import {
  scoreEvidenceJoins,
  scoreEvidenceMatches,
} from "./score-evidence-sql.js";

type Row = {
  brand_id: string;
  brand_name: string;
  product_id: string;
  run_id: string;
  observed_at: string;
  payload: Coupon;
  old_payload: Coupon | null;
  comparison_status: string;
  kind: string | null;
  score_payload: {
    score: {
      gate: string;
      range: { low: number; high: number };
      missing: string[];
    };
    evidence: {
      signal: string;
      blockers: string[];
      rules?: { status: string; changes: string[] };
      evidence_times?: {
        current_rules: string | null;
        previous_rules: string | null;
      };
    };
    features: Record<string, unknown>;
  } | null;
  disposition: string | null;
  disposition_revision: string | null;
  identity_conflict: boolean;
  previously_seen: boolean;
  first_seen_at: string;
  current_rule_payload?: { rules: RuleText[] } | null;
  current_rule_at?: string | null;
};
export function boardCandidate(row: Row) {
  if (
    row.identity_conflict ||
    row.payload.identity !== "name_match" ||
    row.comparison_status !== "COMPARABLE"
  )
    return null;
  const assessment = assessCoupon(row.payload, row.old_payload);
  const ruleChanges =
    row.score_payload?.evidence.rules?.status === "changed"
      ? row.score_payload.evidence.rules.changes
      : [];
  const kind =
    row.score_payload?.evidence.signal === "listed_quantity_increase_same_price"
      ? "quantity_increase"
      : assessment.price_direction === "lower"
        ? "price_drop"
        : row.kind === "NEW_OBSERVED" && !row.old_payload
          ? row.previously_seen
            ? "reappeared"
            : "first_observed"
          : ruleChanges.length > 0
            ? "terms_changed"
            : row.disposition === "watching"
              ? "watched"
              : null;
  if (!kind) return null;
  const signature = (p: Coupon | null) =>
    p && {
      name: p.name,
      min: p.price_min_fen,
      max: p.price_max_fen,
      brand: p.platform_brand_id,
      poi: p.poi_id,
      sale_end: p.sale_end,
      status: p.status,
    };
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        brand: row.brand_id,
        product: row.product_id,
        kind,
        current: signature(row.payload),
        previous: signature(row.old_payload),
        rule_changes: ruleChanges,
        rule_times: ruleChanges.length
          ? row.score_payload?.evidence.evidence_times
          : null,
      }),
    )
    .digest("hex");
  const sameConditions =
    row.score_payload?.evidence.signal ===
    "price_drop_same_returned_conditions";
  return {
    use_outlook: couponUseOutlook({
      price_observed_at: row.observed_at,
      rules_observed_at: row.current_rule_at ?? null,
      rules: row.current_rule_payload?.rules ?? null,
    }),
    brand_id: row.brand_id,
    brand_name: row.brand_name,
    product_id: row.product_id,
    run_id: row.run_id,
    title: row.payload.name,
    observed_at: row.observed_at,
    first_seen_at: row.first_seen_at,
    kind,
    revision,
    current_price_fen: row.payload.price_min_fen,
    current_price_max_fen: row.payload.price_max_fen,
    previous_price_fen: row.old_payload?.price_min_fen ?? null,
    previous_price_max_fen: row.old_payload?.price_max_fen ?? null,
    saving_fen: assessment.delta_fen === null ? null : -assessment.delta_fen,
    reduction_rate: assessment.reduction_rate,
    priority:
      kind === "quantity_increase"
        ? 3
        : kind === "price_drop"
          ? sameConditions
            ? 3
            : 2
          : kind === "first_observed"
            ? 1
            : 0,
    reason:
      kind === "quantity_increase"
        ? "价格相同，已返回套餐项数量增加，其他已返回规则与门店一致；完整价值待核验"
        : kind === "price_drop"
          ? sameConditions
            ? "票面降价，已返回的规则与门店范围相同；完整权益仍待核验"
            : "票面降价，需同时检查权益是否缩水"
          : kind === "first_observed"
            ? "系统首次完整记录此券；不代表平台刚上架"
            : kind === "reappeared"
              ? "历史完整快照已出现，上轮未见、本轮再次出现；不算新品或新优惠"
              : kind === "watched"
                ? "已关注，本轮未发现新的优惠变化"
                : "已采集的套餐或核销规则发生变化；不代表优惠提升",
    changed_fields: [
      ...new Set([...assessment.changed_fields, ...ruleChanges]),
    ],
    disposition:
      row.disposition === "watching"
        ? "watching"
        : row.disposition_revision === revision
          ? (row.disposition ?? "new")
          : "new",
    score: row.score_payload?.score ?? null,
    race_status: "unknown",
    blockers: row.score_payload?.evidence.blockers ?? [
      "当前证据尚无匹配的评分结果，完整权益与品牌身份仍待核验",
    ],
    missing_sources: [
      "月售净增速度见热度榜；综合分尚未校准",
      "品牌指数未接通，无法判断当前热度",
    ],
  };
}
export type BoardCandidate = NonNullable<ReturnType<typeof boardCandidate>>;
export function sortCandidates(items: BoardCandidate[]) {
  return items.sort(
    (a, b) =>
      b.priority - a.priority ||
      (b.reduction_rate ?? 0) - (a.reduction_rate ?? 0) ||
      (b.saving_fen ?? 0) - (a.saving_fen ?? 0) ||
      Date.parse(b.observed_at) - Date.parse(a.observed_at) ||
      `${a.brand_id}:${a.product_id}`.localeCompare(
        `${b.brand_id}:${b.product_id}`,
      ),
  );
}
export async function createOpportunityBoard(
  db: PGlite,
  emit: (
    key: string,
    kind: string,
    title: string,
    payload: unknown,
  ) => Promise<unknown>,
) {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS coupon_dispositions(brand_id uuid NOT NULL,product_id text NOT NULL,revision text NOT NULL,state text NOT NULL CHECK(state IN ('watching','dismissed')),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(brand_id,product_id));
    CREATE INDEX IF NOT EXISTS coupon_items_brand_product_observed ON coupon_items(brand_id,product_id,observed_at);`,
  );
  async function loadCandidates() {
    const rows = (
      await db.query<Row>(`WITH platform_brands AS MATERIALIZED (
        SELECT DISTINCT other.brand_id,other.payload->>'platform_brand_id' AS platform_id
        FROM coupon_items other JOIN coupon_baselines ob ON ob.run_id=other.run_id AND ob.brand_id=other.brand_id
        JOIN brands obr ON obr.id=other.brand_id AND obr.active
        WHERE other.payload->>'identity'='name_match' AND coalesce(other.payload->>'platform_brand_id','')<>''
      ), conflicts AS MATERIALIZED (
        SELECT platform_id FROM platform_brands GROUP BY platform_id HAVING count(DISTINCT brand_id)>1
      ) SELECT i.brand_id,br.name AS brand_name,i.product_id,i.run_id,i.observed_at,i.payload,d.old_payload,d.kind,t.comparison_status,s.payload AS score_payload,a.state AS disposition,a.revision AS disposition_revision,
      history.first_seen_at,history.first_seen_at<i.observed_at AS previously_seen,rule_now.payload AS current_rule_payload,rule_now.observed_at AS current_rule_at,
      EXISTS(SELECT 1 FROM conflicts WHERE platform_id=i.payload->>'platform_brand_id') AS identity_conflict
      FROM coupon_items i JOIN coupon_baselines b ON b.brand_id=i.brand_id AND b.run_id=i.run_id JOIN brands br ON br.id=i.brand_id AND br.active JOIN coupon_tasks t ON t.run_id=i.run_id AND t.brand_id=i.brand_id AND t.state='complete'
      JOIN coupon_diffs d ON d.run_id=i.run_id AND d.brand_id=i.brand_id AND d.product_id=i.product_id
      LEFT JOIN LATERAL(SELECT min(prior.observed_at) AS first_seen_at FROM coupon_items prior JOIN coupon_tasks prior_task ON prior_task.brand_id=prior.brand_id AND prior_task.run_id=prior.run_id AND prior_task.state='complete' WHERE prior.brand_id=i.brand_id AND prior.product_id=i.product_id AND prior.observed_at<=i.observed_at) history ON true
      LEFT JOIN coupon_dispositions a ON a.brand_id=i.brand_id AND a.product_id=i.product_id
      ${scoreEvidenceJoins}
      LEFT JOIN LATERAL(SELECT h.payload FROM (SELECT * FROM coupon_score_history WHERE brand_id=i.brand_id AND product_id=i.product_id AND run_id=i.run_id ORDER BY scored_at DESC,id DESC LIMIT 1) h WHERE ${scoreEvidenceMatches}) s ON true
      WHERE i.observed_at<=now() AND i.observed_at>now()-interval '36 hours' AND t.comparison_status='COMPARABLE' AND i.payload->>'identity'='name_match' AND (d.kind IN ('PRICE_CHANGED_UNVERIFIED','NEW_OBSERVED','TERMS_CHANGED_UNVERIFIED') OR s.payload->'evidence'->'rules'->>'status'='changed' OR a.state='watching')`)
    ).rows;
    return sortCandidates(
      rows.map(boardCandidate).filter((x): x is BoardCandidate => x !== null),
    );
  }
  // Share only concurrent reads; completed reads are never cached, so evidence
  // and disposition changes are visible to the next request immediately.
  const loadCached = readModel(db, "opportunity-board-v1", loadCandidates);
  let activeCandidates: ReturnType<typeof loadCandidates> | undefined;
  function candidates() {
    if (!activeCandidates)
      activeCandidates = loadCached().finally(() => {
        activeCandidates = undefined;
      });
    return activeCandidates;
  }
  async function digest() {
    const runs = (
      await db.query<{ id: string; finished_at: string }>(
        "SELECT id,finished_at FROM coupon_runs WHERE status='complete' AND finished_at>now()-interval '36 hours' AND NOT EXISTS(SELECT 1 FROM radar_alerts a WHERE a.kind='scan_digest' AND a.payload->>'run_id'=coupon_runs.id::text) ORDER BY finished_at DESC LIMIT 5",
      )
    ).rows;
    if (!runs.length) return;
    const all = await candidates();
    for (const run of runs) {
      const found = all.filter(
        (x) =>
          x.run_id === run.id &&
          x.disposition !== "dismissed" &&
          x.kind !== "watched" &&
          x.kind !== "reappeared",
      );
      await emit(
        `scan-digest:${run.id}`,
        "scan_digest",
        `本轮扫描完成：${found.length} 条待核验选题线索`,
        {
          run_id: run.id,
          finished_at: run.finished_at,
          count: found.length,
          quantity_increases: found.filter(
            (x) => x.kind === "quantity_increase",
          ).length,
          price_drops: found.filter((x) => x.kind === "price_drop").length,
          first_observed: found.filter((x) => x.kind === "first_observed")
            .length,
          terms_changed: found.filter((x) => x.kind === "terms_changed").length,
          top: found.slice(0, 10).map((x) => ({
            brand: x.brand_name,
            title: x.title,
            product_id: x.product_id,
            brand_id: x.brand_id,
            reason: x.reason,
          })),
          caveat:
            "仅统计当前新鲜完整基线中的变化线索；首次建库或基线重建不算上新。不是已核验推荐；销量热度另按完整快照计算。",
        },
      );
    }
  }
  function register(app: Express) {
    app.get("/api/v3/selection-board", async (req, res) => {
      const filter = z
        .enum([
          "all",
          "price_drop",
          "quantity_increase",
          "first_observed",
          "reappeared",
          "terms_changed",
          "watching",
          "dismissed",
        ])
        .default("all")
        .parse(req.query.filter);
      const brand = z.uuid().optional().parse(req.query.brand_id);
      const offset = z.coerce
        .number()
        .int()
        .min(0)
        .default(0)
        .parse(req.query.offset);
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .parse(req.query.limit);
      const usage = z
        .enum(["any", "has_exclusions", "not_fully_excluded"])
        .default("any")
        .parse(req.query.usage);
      const search = z
        .string()
        .trim()
        .max(100)
        .default("")
        .parse(req.query.search)
        .toLocaleLowerCase();
      const minSaving = z.coerce
        .number()
        .int()
        .min(0)
        .max(100000000)
        .default(0)
        .parse(req.query.min_saving_fen);
      const minDrop = z.coerce
        .number()
        .min(0)
        .max(100)
        .default(0)
        .parse(req.query.min_drop_percent);
      const order = z
        .enum(["priority", "saving", "reduction", "newest"])
        .default("priority")
        .parse(req.query.order);
      const all = (await candidates()).filter(
        (x) => !brand || x.brand_id === brand,
      );
      let items = all.filter((x) =>
        filter === "dismissed"
          ? x.disposition === "dismissed"
          : x.disposition !== "dismissed" &&
            ((filter === "all" &&
              x.kind !== "watched" &&
              x.kind !== "reappeared") ||
              (filter === "watching" && x.disposition === "watching") ||
              x.kind === filter),
      );
      items = items.filter(
        (x) =>
          (!search ||
            `${x.brand_name} ${x.title}`
              .toLocaleLowerCase()
              .includes(search)) &&
          (minSaving === 0 || (x.saving_fen ?? 0) >= minSaving) &&
          (minDrop === 0 || (x.reduction_rate ?? 0) * 100 >= minDrop),
      );
      items = items.filter(
        (x) =>
          usage === "any" ||
          (usage === "has_exclusions"
            ? x.use_outlook.has_explicit_exclusion
            : !x.use_outlook.fully_excluded),
      );
      if (order !== "priority")
        items.sort(
          (a, b) =>
            (order === "saving"
              ? (b.saving_fen ?? 0) - (a.saving_fen ?? 0)
              : order === "reduction"
                ? (b.reduction_rate ?? 0) - (a.reduction_rate ?? 0)
                : Date.parse(b.observed_at) - Date.parse(a.observed_at)) ||
            a.product_id.localeCompare(b.product_id),
        );
      const baseline = (
        await db.query(
          "SELECT count(*)::int AS enabled,count(*) FILTER(WHERE t.completed_at>now()-interval '36 hours')::int AS fresh,count(*) FILTER(WHERE t.completed_at>now()-interval '36 hours' AND t.comparison_status='COMPARABLE')::int AS comparable FROM brands br LEFT JOIN coupon_baselines b ON b.brand_id=br.id LEFT JOIN coupon_tasks t ON t.run_id=b.run_id AND t.brand_id=b.brand_id WHERE br.active",
        )
      ).rows[0];
      res.json({
        items: items.slice(offset, offset + limit),
        total: items.length,
        offset,
        limit,
        baseline,
        summary: {
          reappeared: all.filter((x) => x.kind === "reappeared").length,
          quantity_increase: all.filter((x) => x.kind === "quantity_increase")
            .length,
          price_drop: all.filter((x) => x.kind === "price_drop").length,
          first_observed: all.filter((x) => x.kind === "first_observed").length,
          terms_changed: all.filter((x) => x.kind === "terms_changed").length,
        },
        generated_at: new Date().toISOString(),
        caveat:
          "按变化类型、降价比例和金额排序；这是选题线索，不是已核验推荐或爆款概率。",
      });
    });
    app.put(
      "/api/v3/selection-board/:product/disposition",
      async (req, res) => {
        const product = z.string().regex(/^\d+$/).parse(req.params.product);
        const body = z
          .object({
            brand_id: z.uuid(),
            revision: z.string().regex(/^[a-f0-9]{64}$/),
            state: z.enum(["watching", "dismissed", "new"]),
          })
          .strict()
          .parse(req.body);
        const candidate = (await candidates()).find(
          (x) => x.brand_id === body.brand_id && x.product_id === product,
        );
        if (!candidate || candidate.revision !== body.revision)
          return res.status(409).json({
            error: { message: "券已变化或离开当前有效基线，请刷新后重试" },
          });
        if (body.state === "new")
          await db.query(
            "DELETE FROM coupon_dispositions WHERE brand_id=$1 AND product_id=$2",
            [body.brand_id, product],
          );
        else
          await db.query(
            "INSERT INTO coupon_dispositions(brand_id,product_id,revision,state) VALUES($1,$2,$3,$4) ON CONFLICT(brand_id,product_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,updated_at=now()",
            [body.brand_id, product, body.revision, body.state],
          );
        res.json({ ok: true });
      },
    );
  }
  return { register, digest, candidates };
}
