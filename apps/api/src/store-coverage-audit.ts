import type { PGlite } from "@electric-sql/pglite";

type StoreEvidence = {
  brand_id: string;
  brand_name: string;
  product_id: string;
  run_id: string;
  title: string;
  state: string;
  error_code: string | null;
  reported_count: number | null;
  returned_count: number | null;
  queried_count: number;
  received_count: number | null;
  snapshot_complete: boolean | null;
  shanghai_count?: number | null;
  observed_at: string | null;
};
export function classifyStoreCoverage(row: StoreEvidence) {
  if (row.state === "failed") return "request_failed";
  if (row.reported_count === null || row.returned_count === null)
    return row.state === "queued" ? "scope_pending" : "scope_unknown";
  if (row.returned_count === 0) return "empty_scope";
  if (row.returned_count > 1000) return "scope_limit";
  if (
    row.returned_count > row.reported_count ||
    row.queried_count > row.returned_count ||
    (row.received_count !== null && row.received_count > row.returned_count)
  )
    return "scope_inconsistent";
  if (row.state === "queued" && row.queried_count < row.returned_count)
    return "lookup_pending";
  if (row.queried_count < row.returned_count) return "lookup_unfinished";
  if (row.received_count === null) return "snapshot_missing";
  if (row.received_count < row.returned_count) return "lookup_missing";
  if (row.returned_count < row.reported_count) return "scope_truncated";
  if (row.snapshot_complete && row.state === "complete") return "complete";
  return "scope_inconsistent";
}
const labels: Record<ReturnType<typeof classifyStoreCoverage>, string> = {
  request_failed: "本轮请求已终止",
  scope_pending: "等待获取门店范围",
  scope_unknown: "范围证据缺失",
  empty_scope: "平台未返回门店 ID",
  scope_limit: "超过单券 1000 个门店保护上限",
  scope_inconsistent: "门店计数或完成状态矛盾",
  lookup_pending: "已取得范围，等待查询剩余门店",
  lookup_unfinished: "仍有未查询门店，但任务已停止",
  snapshot_missing: "已查询范围，缺少最终门店快照",
  lookup_missing: "查询结束，部分门店 ID 未返回",
  scope_truncated: "返回的门店 ID 少于平台声明总数",
  complete: "返回范围已完整核对",
};

/** One local aggregate query, no platform calls and no inferred missing store identities. */
export async function storeCoverageAudit(db: PGlite) {
  const rows = (
    await db.query<StoreEvidence>(`SELECT t.brand_id,br.name AS brand_name,t.run_id,t.product_id,i.payload->>'name' AS title,
    t.state,t.error_code,(t.scope->>'count')::int AS reported_count,
    jsonb_array_length(t.scope->'ids') AS returned_count,t.cursor AS queried_count,
    (s.payload->>'matched_count')::int AS received_count,
    (s.payload->>'shanghai_count')::int AS shanghai_count,
    (s.payload->>'complete')::boolean AS snapshot_complete,s.observed_at
    FROM coupon_store_tasks t JOIN coupon_baselines b ON b.run_id=t.run_id AND b.brand_id=t.brand_id
    JOIN brands br ON br.id=t.brand_id AND br.active
    JOIN coupon_tasks source ON source.run_id=t.run_id AND source.brand_id=t.brand_id AND source.state='complete'
    JOIN coupon_items i ON i.run_id=t.run_id AND i.brand_id=t.brand_id AND i.product_id=t.product_id
    LEFT JOIN coupon_store_snapshots s ON s.run_id=t.run_id AND s.product_id=t.product_id
    WHERE source.completed_at BETWEEN now()-interval '36 hours' AND now() AND i.payload->>'identity'='name_match'
    ORDER BY br.name,t.product_id`)
  ).rows;
  const groups = new Map<
    string,
    {
      reason: string;
      label: string;
      coupons: number;
      source_id_gap: number;
      lookup_gap: number;
      examples: StoreEvidence[];
    }
  >();
  for (const row of rows) {
    const reason = classifyStoreCoverage(row);
    const group = groups.get(reason) ?? {
      reason,
      label: labels[reason],
      coupons: 0,
      source_id_gap: 0,
      lookup_gap: 0,
      examples: [],
    };
    group.coupons++;
    if (row.reported_count !== null && row.returned_count !== null)
      group.source_id_gap += Math.max(
        0,
        row.reported_count - row.returned_count,
      );
    // Count lookup gaps only for finished batches with a persisted final snapshot.
    if (
      row.received_count !== null &&
      row.returned_count !== null &&
      row.queried_count >= row.returned_count
    )
      group.lookup_gap += Math.max(0, row.returned_count - row.received_count);
    if (group.examples.length < 3) group.examples.push(row);
    groups.set(reason, group);
  }
  return {
    total: rows.length,
    with_shanghai_evidence: rows.filter((r) => (r.shanghai_count ?? 0) > 0)
      .length,
    partial_with_shanghai_evidence: rows.filter(
      (r) =>
        (r.shanghai_count ?? 0) > 0 && classifyStoreCoverage(r) !== "complete",
    ).length,
    groups: [...groups.values()].sort(
      (a, b) => b.coupons - a.coupons || a.reason.localeCompare(b.reason),
    ),
    caveat:
      "已取得上海门店不代表取得全部上海门店，也不代表完整权益已核验。缺口按券累计，同一门店可能重复计数；不是缺失门店去重总数。声明总数与返回 ID 不一致时不猜测原因、不标完整、不自动无限重查。待查询状态不能当作平台缺失。",
  };
}
