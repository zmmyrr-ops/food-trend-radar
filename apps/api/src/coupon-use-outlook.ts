import { calendarDay } from "./environment.js";
import { type RuleText, structureRules } from "./rule-structure.js";

const dayMs = 86400000,
  offset = 8 * 3600000;
const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const holidayNames = [
  "元旦",
  "春节",
  "清明节",
  "劳动节",
  "端午节",
  "中秋节",
  "国庆节",
];
const localDate = (n: number) =>
  new Date(n + offset).toISOString().slice(0, 10);
const validDate = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(`${s}T00:00:00Z`)) &&
  new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
export function couponUseOutlook(
  input: {
    price_observed_at: string;
    rules_observed_at: string | null;
    rules: RuleText[] | null;
  },
  now = Date.now(),
) {
  const price = Date.parse(input.price_observed_at),
    ruleAt = Date.parse(input.rules_observed_at ?? "");
  const usable =
    Number.isFinite(price) &&
    price <= now &&
    now - price <= 36 * 3600000 &&
    Number.isFinite(ruleAt) &&
    ruleAt >= price &&
    ruleAt <= now &&
    ruleAt - price <= 36 * 3600000 &&
    !!input.rules?.some((r) => r.value.some((v) => v.content.trim()));
  const rules = usable ? input.rules! : [];
  const exclusions: {
    kind: "weekday" | "holiday" | "date";
    values: string[];
    evidence: string;
  }[] = [];
  const unresolved: string[] = [];
  for (const rule of rules.filter((r) => r.key === "use_date"))
    for (const { content } of rule.value) {
      const text = content
        .normalize("NFKC")
        .trim()
        .replace(/[。!]$/, "");
      if (/^(?:有效期\s*:\s*)?购买后\s*\d+\s*天内有效$/.test(text)) continue;
      const match = text.match(/^不可用日期\s*:\s*(.+)$/);
      if (!match) {
        unresolved.push(content);
        continue;
      }
      const parsed: typeof exclusions = [];
      let recognized = true;
      for (const raw of match[1].split(/[、,;；]/)) {
        const token = raw.trim();
        if (weekdays.includes(token))
          parsed.push({ kind: "weekday", values: [token], evidence: content });
        else if (holidayNames.includes(token))
          parsed.push({ kind: "holiday", values: [token], evidence: content });
        else if (validDate(token))
          parsed.push({
            kind: "date",
            values: [token, token],
            evidence: content,
          });
        else {
          const range = token.match(
            /^(\d{4}-\d{2}-\d{2})\s*(?:至|~|～|—)\s*(\d{4}-\d{2}-\d{2})$/,
          );
          const week = token.match(
            /^周([一二三四五六日])(?:至|—|-|~|～)周?([一二三四五六日])$/,
          );
          if (
            range &&
            validDate(range[1]) &&
            validDate(range[2]) &&
            range[1] <= range[2]
          )
            parsed.push({
              kind: "date",
              values: [range[1], range[2]],
              evidence: content,
            });
          else if (week) {
            const order = [
              "周一",
              "周二",
              "周三",
              "周四",
              "周五",
              "周六",
              "周日",
            ];
            const start = order.indexOf(`周${week[1]}`),
              end = order.indexOf(`周${week[2]}`);
            if (start <= end)
              parsed.push({
                kind: "weekday",
                values: order.slice(start, end + 1),
                evidence: content,
              });
            else recognized = false;
          } else recognized = false;
        }
      }
      // An exception in the same clause invalidates the entire automatic interpretation.
      if (recognized) exclusions.push(...parsed);
      else unresolved.push(content);
    }
  const structured = structureRules([], rules),
    end = now + 72 * 3600000;
  const days = [];
  for (
    let start = Math.floor((now + offset) / dayMs) * dayMs - offset;
    start < end;
    start += dayMs
  ) {
    const date = localDate(start),
      calendar = calendarDay(date),
      weekday = weekdays[new Date(`${date}T00:00:00Z`).getUTCDay()];
    const matches = exclusions.filter((x) =>
      x.kind === "date"
        ? date >= x.values[0] && date <= x.values[1]
        : x.kind === "weekday"
          ? x.values.includes(weekday)
          : calendar.name !== null && x.values.includes(calendar.name),
    );
    days.push({
      date,
      weekday,
      calendar_kind: calendar.kind,
      holiday: calendar.name,
      from: new Date(Math.max(now, start)).toISOString(),
      to: new Date(Math.min(end, start + dayMs)).toISOString(),
      status: matches.length ? "explicitly_excluded" : "unconfirmed",
      reasons: [...new Set(matches.map((x) => x.evidence))],
    });
  }
  return {
    version: "coupon-use-outlook-v1",
    generated_at: new Date(now).toISOString(),
    until: new Date(end).toISOString(),
    evidence_status: usable ? "current" : "missing_or_stale",
    rules_observed_at: usable ? input.rules_observed_at : null,
    days,
    has_explicit_exclusion: days.some(
      (d) => d.status === "explicitly_excluded",
    ),
    fully_excluded: days.every((d) => d.status === "explicitly_excluded"),
    time_windows: structured.availability.windows,
    unparsed_times: structured.availability.unparsed_times,
    unparsed_dates: unresolved,
    purchase_relative_days: structured.validity.purchase_relative_days,
    caveat:
      "按当前轮次明确禁用条款与上海日历匹配；未命中不等于可用，门店、预约、资格和例外仍需核验。购买后有效天数不从采集时间起算；时段只展示原文识别结果，不推断完整营业时间。",
  };
}
