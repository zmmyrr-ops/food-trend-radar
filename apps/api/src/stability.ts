import type { PGlite } from "@electric-sql/pglite";
import { slotAt } from "./coupons.js";

const halfDay = 12 * 3600000;
type Run = {
  id: string;
  slot: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  tasks: number;
  completed: number;
  short_gaps: number;
  failures: number;
};
export function stabilityReport(runs: Run[], now = Date.now()) {
  const boundary = Date.parse(slotAt(new Date(now)));
  const slots = Array.from({ length: 14 }, (_, i) => {
    const start = boundary - (14 - i) * halfDay,
      end = start + halfDay,
      slot = slotAt(new Date(start));
    const matches = runs.filter((r) => r.slot === slot),
      run = matches.length === 1 ? matches[0] : null;
    const timely =
      !!run &&
      Date.parse(run.started_at) >= start &&
      Date.parse(run.started_at) < end &&
      !!run.finished_at &&
      Date.parse(run.finished_at) >= Date.parse(run.started_at) &&
      Date.parse(run.finished_at) <= end;
    const passed =
      !!run &&
      timely &&
      run.status === "complete" &&
      run.tasks > 0 &&
      run.tasks === run.completed &&
      run.short_gaps === 0;
    return {
      slot,
      run_id: run?.id ?? null,
      status: passed
        ? "passed"
        : !matches.length
          ? "missing"
          : matches.length > 1
            ? "duplicate"
            : !timely
              ? "late_or_incomplete"
              : run?.short_gaps
                ? "interval_violation"
                : "incomplete",
      tasks: run?.tasks ?? 0,
      completed: run?.completed ?? 0,
      failures: run?.failures ?? 0,
    };
  });
  return {
    generated_at: new Date(now).toISOString(),
    current_slot: slotAt(new Date(now)),
    required: 14,
    passed: slots.filter((s) => s.status === "passed").length,
    complete: slots.every((s) => s.status === "passed"),
    slots,
    caveat:
      "检查最近 14 个已结束的上海 00:00/12:00 时段：各定时轮次必须在本时段内完成全部已创建品牌任务且无小于 1 秒请求间隔。手动扫描不抵扣漏跑；当前时段不提前判失败。该结果不代表权益完整、平台覆盖完整或逐秒在线率。",
  };
}
export async function readStability(db: PGlite, now = Date.now()) {
  const rows = (
    await db.query<Run>(
      `SELECT r.id,r.slot,r.status,r.started_at,r.finished_at,
    (SELECT count(*)::int FROM coupon_tasks t WHERE t.run_id=r.id) AS tasks,
    (SELECT count(*)::int FROM coupon_tasks t WHERE t.run_id=r.id AND t.state='complete') AS completed,
    (SELECT count(*)::int FROM coupon_requests q WHERE q.run_id=r.id AND q.gap_ms<1000) AS short_gaps,
    (SELECT count(*)::int FROM coupon_requests q WHERE q.run_id=r.id AND q.outcome NOT IN ('OK','in_flight')) AS failures
    FROM coupon_runs r WHERE r.slot IS NOT NULL AND r.started_at>=$1`,
      [new Date(now - 9 * 86400000).toISOString()],
    )
  ).rows;
  return stabilityReport(rows, now);
}
