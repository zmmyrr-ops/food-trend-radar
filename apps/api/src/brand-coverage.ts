import type { PGlite } from "@electric-sql/pglite";
export function coverageState(
  recalled: number,
  matched: number,
  named: number,
) {
  if (!recalled) return "no_recall";
  if (matched) return "name_candidates";
  return named ? "different_platform_names" : "missing_platform_identity";
}
export function reviewState(
  row: {
    name: string;
    aliases: string[];
    query_name: string | null;
    query_aliases: string[] | null;
    completed_at: string | null;
    recalled: number;
    matched: number;
    named: number;
  },
  now = Date.now(),
) {
  const configPending =
    !!row.query_name &&
    (row.name !== row.query_name ||
      JSON.stringify([...row.aliases].sort()) !==
        JSON.stringify([...(row.query_aliases ?? [])].sort()));
  const age = now - Date.parse(row.completed_at ?? "");
  const fresh = Number.isFinite(age) && age >= 0 && age <= 36 * 3600000;
  return {
    config_pending: configPending,
    baseline_fresh: fresh,
    status: !row.completed_at
      ? "no_baseline"
      : configPending
        ? "config_pending"
        : !fresh
          ? "stale_baseline"
          : coverageState(row.recalled, row.matched, row.named),
  };
}
export async function brandCoverage(db: PGlite) {
  const rows = (
    await db.query<{
      brand_id: string;
      name: string;
      aliases: string[];
      query_name: string | null;
      query_aliases: string[] | null;
      completed_at: string | null;
      recalled: number;
      matched: number;
      named: number;
      platform_names: { name: string; count: number }[];
    }>(`SELECT b.id AS brand_id,b.name,b.aliases,t.name AS query_name,t.aliases AS query_aliases,t.completed_at,t.state,
    count(i.product_id)::int AS recalled,
    count(i.product_id) FILTER(WHERE i.payload->>'identity'='name_match')::int AS matched,
    count(i.product_id) FILTER(WHERE coalesce(i.payload->>'platform_brand_name','')<>'')::int AS named,
    coalesce((SELECT jsonb_agg(n) FROM (SELECT x.payload->>'platform_brand_name' AS name,count(*)::int AS count FROM coupon_items x WHERE x.run_id=cb.run_id AND x.brand_id=b.id AND coalesce(x.payload->>'platform_brand_name','')<>'' GROUP BY x.payload->>'platform_brand_name' ORDER BY count(*) DESC,x.payload->>'platform_brand_name' LIMIT 5) n),'[]'::jsonb) AS platform_names
    FROM brands b LEFT JOIN coupon_baselines cb ON cb.brand_id=b.id LEFT JOIN coupon_tasks t ON t.brand_id=b.id AND t.run_id=cb.run_id LEFT JOIN coupon_items i ON i.brand_id=b.id AND i.run_id=cb.run_id WHERE b.active GROUP BY b.id,b.name,cb.run_id,t.completed_at,t.state,t.name,t.aliases ORDER BY b.name`)
  ).rows;
  const items = rows.map((r) => ({
    ...r,
    coverage: coverageState(r.recalled, r.matched, r.named),
    review: reviewState(r),
  }));
  const counts = items.reduce<Record<string, number>>((out, r) => {
    out[r.coverage] = (out[r.coverage] ?? 0) + 1;
    return out;
  }, {});
  return {
    items,
    counts,
    reviewed_at: new Date().toISOString(),
    review_counts: items.reduce<Record<string, number>>((out, r) => {
      out[r.review.status] = (out[r.review.status] ?? 0) + 1;
      return out;
    }, {}),
    caveat:
      "名称匹配只是候选归属；无匹配或无召回不代表品牌没有券。平台分支名称仅供诊断，不自动合并。",
  };
}
