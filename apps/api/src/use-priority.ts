import type { couponUseOutlook } from "./coupon-use-outlook.js";
import type { pickPriority } from "./pick-priority.js";

type Outlook = ReturnType<typeof couponUseOutlook>;
export function applyUsePenalty(
  priority: ReturnType<typeof pickPriority>,
  outlook: Outlook,
  historical: Outlook | null = null,
) {
  const previous =
    outlook.evidence_status !== "current" &&
    !!historical?.has_explicit_exclusion;
  const evidence = previous ? historical! : outlook;
  const excluded = evidence.days.filter(
    (d) => d.status === "explicitly_excluded",
  );
  const holiday = [
    ...new Set(excluded.map((d) => d.holiday).filter(Boolean)),
  ].join("、");
  const ratio =
    excluded.reduce((n, d) => n + Date.parse(d.to) - Date.parse(d.from), 0) /
    (72 * 3600000);
  const before = priority.score;
  const score = !excluded.length
    ? before
    : previous
      ? Math.min(before, 20)
      : Math.min(
          holiday ? 20 : 100,
          Math.round(before * Math.max(0, 1 - ratio) * 10) / 10,
        );
  const reason = excluded.length
    ? `${previous ? "上次采集显示" : ""}${holiday || "部分日期"}不可用${previous ? "，本轮规则待复核，优先分暂限20分" : evidence.fully_excluded ? "，未来72小时均禁用，优先分为0" : `，按未来72小时受限时长降分${holiday ? "，最高20分" : ""}`}`
    : outlook.evidence_status !== "current"
      ? "使用规则待核验，未视为可用"
      : "未命中明确禁用日期，可用性仍需核验";
  return {
    ...priority,
    version: "priority-v5",
    score,
    availability_gate: {
      before_score: before,
      penalty: Math.round((before - score) * 10) / 10,
      reason,
      historical: previous,
      evidence_at: evidence.rules_observed_at,
      excluded_dates: excluded.map((d) => d.date),
      evidence: [...new Set(excluded.flatMap((d) => d.reasons))],
    },
  };
}
