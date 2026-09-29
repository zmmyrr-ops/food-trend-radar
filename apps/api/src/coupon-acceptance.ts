import type { PGlite } from "@electric-sql/pglite";
import {
  type ConditionSnapshot,
  compareConditions,
} from "./coupon-condition-comparison.js";

export async function couponAcceptance(
  db: PGlite,
  runId: string,
  now = Date.now(),
) {
  const run = (
    await db.query<{ id: string; status: string }>(
      "SELECT id,status FROM coupon_runs WHERE id=$1",
      [runId],
    )
  ).rows[0];
  if (!run) return null;
  // One statement captures task counts and evidence together, avoiding a mixed baseline during collection.
  const result = (
    await db.query<{
      tasks: { state: string; count: number }[];
      items: {
        brand_id: string;
        brand_name: string;
        product_id: string;
        comparison_status: string;
        current: ConditionSnapshot;
        previous: ConditionSnapshot | null;
      }[];
    }>(
      `
  SELECT
    (SELECT coalesce(jsonb_agg(s),'[]') FROM (SELECT state,count(*)::int AS count FROM coupon_tasks WHERE run_id=$1 GROUP BY state) s) AS tasks,
    (SELECT coalesce(jsonb_agg(e),'[]') FROM (
      SELECT i.brand_id,b.name AS brand_name,i.product_id,t.comparison_status,
        jsonb_build_object('run_id',i.run_id,'observed_at',i.observed_at,'payload',i.payload,
          'rules',CASE WHEN cr.product_id IS NULL THEN NULL ELSE jsonb_build_object('observed_at',cr.observed_at,'payload',cr.payload) END,
          'stores',CASE WHEN cs.product_id IS NULL THEN NULL ELSE jsonb_build_object('observed_at',cs.observed_at,'payload',cs.payload) END) AS current,
        CASE WHEN p.product_id IS NULL OR pt.state IS DISTINCT FROM 'complete' THEN NULL ELSE jsonb_build_object('run_id',p.run_id,'observed_at',p.observed_at,'payload',p.payload,
          'rules',CASE WHEN pr.product_id IS NULL THEN NULL ELSE jsonb_build_object('observed_at',pr.observed_at,'payload',pr.payload) END,
          'stores',CASE WHEN ps.product_id IS NULL THEN NULL ELSE jsonb_build_object('observed_at',ps.observed_at,'payload',ps.payload) END) END AS previous
      FROM coupon_items i JOIN coupon_tasks t ON t.run_id=i.run_id AND t.brand_id=i.brand_id
      JOIN brands b ON b.id=i.brand_id
      LEFT JOIN coupon_items p ON p.run_id=t.previous_run_id AND p.brand_id=i.brand_id AND p.product_id=i.product_id
      LEFT JOIN coupon_tasks pt ON pt.run_id=p.run_id AND pt.brand_id=p.brand_id
      LEFT JOIN coupon_rule_snapshots cr ON cr.run_id=i.run_id AND cr.product_id=i.product_id
      LEFT JOIN coupon_store_snapshots cs ON cs.run_id=i.run_id AND cs.product_id=i.product_id
      LEFT JOIN coupon_rule_snapshots pr ON pr.run_id=p.run_id AND pr.product_id=p.product_id
      LEFT JOIN coupon_store_snapshots ps ON ps.run_id=p.run_id AND ps.product_id=p.product_id
      WHERE i.run_id=$1 AND t.state='complete' AND i.payload->>'identity'='name_match'
      ORDER BY i.brand_id,i.product_id
    ) e) AS items`,
      [runId],
    )
  ).rows[0];
  const counts = {
    candidates: result.items.length,
    fresh: 0,
    current_rules_ready: 0,
    current_stores_ready: 0,
    comparable_previous: 0,
    price_drop_clues: 0,
    same_price_quantity_clues: 0,
    same_returned_conditions_drop: 0,
  };
  const blockers: Record<string, number> = {};
  const samples: {
    brand_id: string;
    brand_name: string;
    product_id: string;
    signal: string;
    delta_fen: number | null;
    blockers: string[];
  }[] = [];
  for (const item of result.items) {
    const c = compareConditions(
      item.current,
      item.previous,
      item.comparison_status,
      now,
    );
    if (c.current_evidence.fresh) counts.fresh++;
    if (c.current_evidence.fresh && c.current_evidence.rules_ready)
      counts.current_rules_ready++;
    if (c.current_evidence.fresh && c.current_evidence.stores_ready)
      counts.current_stores_ready++;
    if (c.baseline_status === "COMPARABLE" && item.previous)
      counts.comparable_previous++;
    if (
      c.signal === "price_drop_same_returned_conditions" ||
      c.signal === "price_drop_conditions_unverified"
    )
      counts.price_drop_clues++;
    if (c.signal === "listed_quantity_increase_same_price")
      counts.same_price_quantity_clues++;
    if (c.signal === "price_drop_same_returned_conditions")
      counts.same_returned_conditions_drop++;
    for (const reason of c.blockers)
      blockers[reason] = (blockers[reason] ?? 0) + 1;
    if (c.signal !== "no_confirmed_improvement" && samples.length < 20)
      samples.push({
        brand_id: item.brand_id,
        brand_name: item.brand_name,
        product_id: item.product_id,
        signal: c.signal,
        delta_fen: c.price.delta_fen,
        blockers: c.blockers,
      });
  }
  const total = result.tasks.reduce((sum, t) => sum + t.count, 0);
  const complete = result.tasks.find((t) => t.state === "complete")?.count ?? 0;
  return {
    version: "coupon-acceptance-v1",
    checked_at: new Date(now).toISOString(),
    run,
    scan: {
      total,
      complete,
      finished: total > 0 && complete === total && run.status === "complete",
      states: result.tasks,
    },
    counts,
    blockers,
    samples,
    verdict: "not_accepted",
    remaining: [
      "品牌身份和复杂权益尚未完整核验",
      "未取得严格同权益比较的真实验收证据",
    ],
    caveat:
      "只核验指定轮次已完成品牌的名称候选；统计单位为品牌×券。扫描结束不代表优惠识别验收通过，降价线索不等于更优惠。",
  };
}
