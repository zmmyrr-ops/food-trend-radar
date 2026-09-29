import { parseRestrictions } from "./rule-restrictions.js";
import { parseUsage } from "./rule-usage.js";
import { parseVoucherTerms } from "./voucher-terms.js";
export type RuleText = {
  key: string;
  name: string;
  value: { content: string }[];
};
export type Group = {
  group_name?: string;
  option_count?: number;
  total_count?: number;
  item_list: { name: string; count?: number | null; unit?: string }[];
};
export function structureRules(groups: Group[], rules: RuleText[]) {
  const entries = rules.flatMap((r) =>
    r.value.map((v) => ({
      key: r.key,
      original: v.content,
      text: v.content.normalize("NFKC").trim(),
    })),
  );
  const dates = entries.filter((e) => e.key === "use_date").map((e) => e.text);
  const dayValues = [
    ...new Set(
      dates.flatMap((s) =>
        [...s.matchAll(/^(?:有效期\s*:\s*)?购买后\s*(\d+)\s*天内有效$/g)].map(
          (m) => Number(m[1]),
        ),
      ),
    ),
  ];
  const exclusions = dates.filter((s) => /^不可用日期\s*[:：]/.test(s));
  const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const holidays = [
    "元旦",
    "春节",
    "清明节",
    "劳动节",
    "端午节",
    "中秋节",
    "国庆节",
  ];
  const tokens = exclusions.flatMap((s) =>
    s
      .replace(/^不可用日期\s*[:：]\s*/, "")
      .split(/[、,，;；]/)
      .map((t) => t.trim()),
  );
  const days = new Set<string>();
  for (const token of tokens) {
    if (weekdays.includes(token)) days.add(token);
    const range = token.match(
      /^周([一二三四五六日])(?:至|—|-|~|～)周?([一二三四五六日])$/,
    );
    if (range) {
      const start = weekdays.indexOf(`周${range[1]}`),
        end = weekdays.indexOf(`周${range[2]}`);
      if (start <= end)
        for (let i = start; i <= end; i++) days.add(weekdays[i]);
    }
  }
  const excludedWeekdays = weekdays.filter((d) => days.has(d));
  const excludedHolidays = holidays.filter((d) =>
    tokens.some(
      (t) => t === d || new RegExp(`^${d}\\([0-9.\\-—~至]+\\)$`).test(t),
    ),
  );
  const timeEntries = entries.filter((e) => e.key === "use_time");
  const windows: { start: string; end: string; overnight: boolean }[] = [];
  const unknownTimes: string[] = [];
  for (const e of timeEntries) {
    const pieces = e.text.split(/[、,，；;]/).map((s) => s.trim());
    if (!pieces.length) continue;
    const parsed = pieces.map((s) =>
      s.match(
        /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*[-—~～至]\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/,
      ),
    );
    if (
      parsed.some(
        (m) =>
          !m ||
          +m[1] > 23 ||
          +m[4] > 23 ||
          +m[2] > 59 ||
          +m[5] > 59 ||
          +(m[3] ?? 0) > 59 ||
          +(m[6] ?? 0) > 59,
      )
    ) {
      unknownTimes.push(e.text);
      continue;
    }
    for (const m of parsed) {
      if (!m) continue;
      const start = `${m[1].padStart(2, "0")}:${m[2]}${m[3] !== undefined ? `:${m[3]}` : ""}`,
        end = `${m[4].padStart(2, "0")}:${m[5]}${m[6] !== undefined ? `:${m[6]}` : ""}`;
      windows.push({
        start,
        end,
        overnight:
          `${m[4].padStart(2, "0")}:${m[5]}:${m[6] ?? "00"}` <
          `${m[1].padStart(2, "0")}:${m[2]}:${m[3] ?? "00"}`,
      });
    }
  }
  const eligibility = entries
    .filter((e) => /新客|新用户|会员|学生|本人|转赠|转售/.test(e.text))
    .map((e) => e.original);
  const fees = entries
    .filter((e) =>
      /附加费|额外收费|另付|另收|加收|服务费|锅底费|茶位费/.test(e.text),
    )
    .map((e) => e.original);
  const purchaseLimits = entries
    .filter((e) => e.key === "purchase_restriction_rule")
    .map((e) => e.original);
  const reservations = entries
    .filter((e) => e.key === "appointment_rule")
    .map((e) => e.original);
  const benefits = groups.map((g) => ({
    name: g.group_name ?? "",
    selection:
      g.option_count != null && g.total_count != null
        ? { choose: g.option_count, from: g.total_count }
        : null,
    items: g.item_list.map((i) => ({
      name: i.name,
      quantity: i.count ?? null,
      unit: i.unit ?? null,
    })),
  }));
  return {
    version: "rule-structure-v3",
    restrictions: parseRestrictions(rules),
    usage: parseUsage(rules),
    voucher: parseVoucherTerms(rules),
    validity: {
      purchase_relative_days:
        dayValues.length === 1 && dayValues[0] > 0 ? dayValues[0] : null,
      conflicting: dayValues.length > 1,
      evidence: dates,
    },
    availability: {
      windows,
      unparsed_times: unknownTimes,
      excluded_weekdays: excludedWeekdays,
      excluded_holidays: excludedHolidays,
      exclusion_evidence: exclusions,
      exclusions_complete: false,
    },
    eligibility: {
      status: eligibility.length ? "mentioned" : "unknown",
      evidence: eligibility,
    },
    fees: { amount_fen: null, evidence: fees, status: "unverified" },
    purchase_limits: purchaseLimits,
    reservations,
    benefits,
    comparable: false,
    missing: [
      "全部适用门店及品牌身份核验",
      "资格与附加费用的完整解释",
      "具体日期、例外和其他自然语言限制的完整解释",
    ],
  };
}
export function ruleChanges(
  current: { groups: Group[]; rules: RuleText[] },
  previous?: { groups: Group[]; rules: RuleText[] },
) {
  if (!previous)
    return {
      status: "first_baseline",
      changes: [] as string[],
      value_verdict: "unverified",
    };
  const normalize = (s: string) =>
    s.normalize("NFKC").replace(/\s+/g, " ").trim();
  const texts = (rules: RuleText[], key: string) =>
    rules
      .filter((r) => r.key === key)
      .flatMap((r) => r.value.map((v) => normalize(v.content)))
      .sort();
  const names: Record<string, string> = {
    use_date: "有效期或可用日期",
    use_time: "可用时段",
    purchase_restriction_rule: "购买限制",
    appointment_rule: "预约条件",
    food_use_rule: "使用规则",
    food_consumption_rule: "堂食与外带条件",
    application_scope: "适用范围",
    other_rules: "其他限制",
    refund_rule: "退款条件",
  };
  const keys = new Set([...current.rules, ...previous.rules].map((r) => r.key));
  const changes = [...keys]
    .filter(
      (k) =>
        JSON.stringify(texts(current.rules, k)) !==
        JSON.stringify(texts(previous.rules, k)),
    )
    .map((k) => names[k] ?? `规则 ${k}`);
  const groupSignature = (groups: Group[]) =>
    groups
      .map((g) =>
        JSON.stringify({
          name: normalize(g.group_name ?? ""),
          choose: g.option_count ?? null,
          total: g.total_count ?? null,
          items: g.item_list
            .map((i) =>
              JSON.stringify({
                name: normalize(i.name),
                quantity: i.count ?? null,
                unit: i.unit ?? null,
              }),
            )
            .sort(),
        }),
      )
      .sort();
  if (
    JSON.stringify(groupSignature(current.groups)) !==
    JSON.stringify(groupSignature(previous.groups))
  )
    changes.unshift("套餐内容或数量");
  return {
    status: changes.length ? "conditions_changed" : "same_returned_conditions",
    changes,
    value_verdict: "unverified",
  };
}

/** Explain returned differences without interpreting them as better value. */
export function ruleDifferences(
  current: { groups: Group[]; rules: RuleText[] },
  previous: { groups: Group[]; rules: RuleText[] },
) {
  const normalize = (s: string) =>
    s.normalize("NFKC").replace(/\s+/g, " ").trim();
  const values = (rules: RuleText[], key: string) =>
    [
      ...new Set(
        rules
          .filter((r) => r.key === key)
          .flatMap((r) => r.value.map((v) => normalize(v.content))),
      ),
    ].sort();
  const labels: Record<string, string> = {
    use_date: "有效期或可用日期",
    use_time: "可用时段",
    purchase_restriction_rule: "购买限制",
    appointment_rule: "预约条件",
    food_use_rule: "使用规则",
    food_consumption_rule: "堂食与外带条件",
    application_scope: "适用范围",
    other_rules: "其他限制",
    refund_rule: "退款条件",
  };
  const details: {
    field: string;
    label: string;
    before: string[];
    after: string[];
  }[] = [];
  for (const key of new Set(
    [...previous.rules, ...current.rules].map((r) => r.key),
  )) {
    const before = values(previous.rules, key),
      after = values(current.rules, key);
    if (JSON.stringify(before) !== JSON.stringify(after))
      details.push({
        field: key,
        label: labels[key] ?? `规则 ${key}`,
        before,
        after,
      });
  }
  if (ruleChanges(current, previous).changes.includes("套餐内容或数量")) {
    const groups = (xs: Group[]) =>
      xs.map(
        (g) =>
          `${g.group_name || "套餐"}${g.option_count != null || g.total_count != null ? `（${g.total_count ?? "未知"}选${g.option_count ?? "未知"}）` : ""}：${g.item_list.map((i) => `${i.name} × ${i.count ?? "数量未知"}${i.unit ?? "（单位未知）"}`).join("；")}`,
      );
    details.unshift({
      field: "groups",
      label: "套餐内容或数量",
      before: groups(previous.groups),
      after: groups(current.groups),
    });
  }
  return details;
}
