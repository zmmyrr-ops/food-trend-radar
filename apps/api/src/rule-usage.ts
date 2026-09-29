import type { RuleText } from "./rule-structure.js";

/** Whole-clause matching only: store-specific or conditional text stays unresolved. */
export function parseUsage(rules: RuleText[]) {
  type Fact = {
    dimension: string;
    value: string;
    evidence: string;
    key: string;
  };
  const facts: Fact[] = [];
  const unparsed: { key: string; evidence: string }[] = [];
  const definitions: Record<string, Record<string, [string, string][]>> = {
    food_consumption_rule: {
      仅堂食: [["consumption", "dine_in_only"]],
      "不支持堂食，仅支持打包外带": [["consumption", "takeaway_only"]],
      堂食或餐前外带均可: [["consumption", "dine_in_or_takeaway"]],
    },
    appointment_rule: {
      无需预约: [["reservation", "not_required"]],
      "到店消费：无需预约，高峰期可能需要排队": [
        ["reservation", "not_required"],
      ],
      需提前预约: [["reservation", "required"]],
    },
    food_use_rule: {
      不与店内优惠同享: [["stacking_store_promotions", "forbidden"]],
      不可与其他代金券叠加使用: [["stacking_other_vouchers", "forbidden"]],
      不能在包间消费时使用: [["private_room", "forbidden"]],
      单次消费不限制使用张数: [["redemption_per_visit", "unlimited"]],
    },
    other_rules: {
      包间不可用: [["private_room", "forbidden"]],
      "叠加规则：不限使用张数": [["redemption_per_visit", "unlimited"]],
    },
    refund_rule: {
      "整单退款：全部未使用随时退还全部实付金额、全部未使用过期自动退": [
        ["refund_fully_unused", "anytime"],
        ["refund_expired_fully_unused", "automatic"],
      ],
      "整单退款：核销前，支持随时退，过期自动退": [
        ["refund_fully_unused", "anytime"],
        ["refund_expired_fully_unused", "automatic"],
      ],
    },
  };
  const normalize = (s: string) =>
    s
      .normalize("NFKC")
      .trim()
      .replace(/[。！!]$/u, "");
  for (const rule of rules) {
    if (!(rule.key in definitions)) continue;
    for (const { content } of rule.value) {
      const text = normalize(content);
      let found = Object.entries(definitions[rule.key]).find(
        ([clause]) => normalize(clause) === text,
      )?.[1];
      if (!found && rule.key === "food_use_rule") {
        const m = text.match(
          /^(?:单次消费最多使用(\d+)张团购券|当前商品每桌限用(\d+)张券)$/,
        );
        if (m) {
          const quantity = Number(m[1] ?? m[2]);
          if (Number.isSafeInteger(quantity) && quantity > 0)
            found = [
              [
                m[1] ? "redemption_per_visit" : "redemption_per_table",
                String(quantity),
              ],
            ];
        }
      }
      if (found)
        for (const [dimension, value] of found)
          facts.push({ dimension, value, evidence: content, key: rule.key });
      else unparsed.push({ key: rule.key, evidence: content });
    }
  }
  const dimensions = [...new Set(facts.map((x) => x.dimension))];
  return {
    version: "usage-v1",
    facts,
    conflicts: dimensions.filter(
      (d) =>
        new Set(facts.filter((x) => x.dimension === d).map((x) => x.value))
          .size > 1,
    ),
    unparsed,
    complete: false,
  };
}
