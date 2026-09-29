import type { PGlite } from "@electric-sql/pglite";
import { storeCoverageAudit } from "./store-coverage-audit.js";

/** Local evidence only: never invokes a platform request or infers undocumented semantics. */
export async function sourceDiagnostics(db: PGlite) {
  const sales = (
    await db.query<{
      coupons: number;
      provenance_captured: number;
      missing_display: number;
    }>(`SELECT count(*)::int AS coupons,
    count(*) FILTER (WHERE i.payload#>>'{source_evidence,sales,semantics}'='unverified')::int AS provenance_captured,
    count(*) FILTER (WHERE coalesce(i.payload->>'monthly_sales','')='')::int AS missing_display
    FROM coupon_items i JOIN coupon_baselines b ON b.run_id=i.run_id AND b.brand_id=i.brand_id
    JOIN brands br ON br.id=i.brand_id AND br.active WHERE i.payload->>'identity'='name_match'`)
  ).rows[0];
  const fields = (
    await db.query<{
      field: string;
      coupons: number;
    }>(`SELECT f.key AS field,count(*)::int AS coupons
    FROM coupon_items i JOIN coupon_baselines b ON b.run_id=i.run_id AND b.brand_id=i.brand_id
    JOIN brands br ON br.id=i.brand_id AND br.active
    CROSS JOIN LATERAL jsonb_object_keys(coalesce(i.payload#>'{source_evidence,sales,observed_count_fields}','{}'::jsonb)) f(key)
    WHERE i.payload->>'identity'='name_match'
    GROUP BY f.key ORDER BY f.key`)
  ).rows;
  const queue = [];
  for (const [kind, table] of [
    ["rules", "coupon_rule_tasks"],
    ["stores", "coupon_store_tasks"],
  ] as const) {
    const rows = (
      await db.query<{
        state: string;
        error_code: string | null;
        count: number;
        waiting_backoff: number;
        retrying: number;
        max_retries: number;
        oldest_baseline_at: string;
      }>(`SELECT t.state,t.error_code,count(*)::int AS count,
      count(*) FILTER(WHERE t.state='queued' AND t.retry_at>now())::int AS waiting_backoff,
      count(*) FILTER(WHERE t.state='queued' AND t.retries>0)::int AS retrying,
      max(t.retries)::int AS max_retries,
      min(s.completed_at) AS oldest_baseline_at
      FROM ${table} t JOIN coupon_baselines b ON b.run_id=t.run_id AND b.brand_id=t.brand_id
      JOIN brands br ON br.id=t.brand_id AND br.active
      JOIN coupon_tasks s ON s.run_id=b.run_id AND s.brand_id=b.brand_id AND s.state='complete'
      WHERE s.completed_at>now()-interval '36 hours'
      GROUP BY t.state,t.error_code ORDER BY t.state,t.error_code`)
    ).rows;
    queue.push(...rows.map((row) => ({ kind, ...row })));
  }
  const requests = (
    await db.query<{
      kind: string;
      outcome: string;
      count: number;
      latest_finished_at: string | null;
      latest_recovered_at: string | null;
    }>(`SELECT kind,outcome,count(*)::int AS count,max(finished_at) AS latest_finished_at,max(recovered_at) AS latest_recovered_at
    FROM coupon_requests WHERE started_at>now()-interval '24 hours'
    GROUP BY kind,outcome ORDER BY kind,outcome`)
  ).rows;
  return {
    generated_at: new Date().toISOString(),
    sales: {
      ...sales,
      fields,
      source_field: "product_info.sold_count_display",
      verification: {
        window: "unknown",
        geography: "unknown",
        refresh_frequency: "unknown",
        refunds_and_resets: "unknown",
        exact_count_field: "unverified",
      },
      caveat:
        "字段出现不代表统计口径已确认。旧快照未保存字段清单，不据此断言接口没有精确销量；新证据随正常采集积累。",
    },
    store_coverage: await storeCoverageAudit(db),
    queue,
    requests,
    request_recovery: {
      interrupted: requests
        .filter((r) => r.outcome === "INTERRUPTED")
        .reduce((n, r) => n + Number(r.count), 0),
      note: "仅在取得数据库独占锁后的服务启动阶段，将上次进程未完成的请求标记为中断。恢复时间不是请求结束时间；游标和重试预算保持不变。",
    },
    caveat:
      "仅统计启用品牌当前新鲜基线的补采。failed 为本轮终止，incomplete 为来源字段或范围不全，queued 为待执行（含退避）；不会自动无限重试。任务数不是剩余请求数，门店可能需要多批。",
  };
}
