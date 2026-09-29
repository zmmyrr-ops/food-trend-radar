import type { RuleText } from "./rule-structure.js";

/** Full clauses only. A redemption exclusion is not a quantified surcharge. */
export function parseVoucherTerms(rules: RuleText[]) {
  const facts: {
    dimension: string;
    values: string[];
    evidence: string;
    key: string;
  }[] = [];
  const unparsed: { key: string; evidence: string }[] = [];
  const definitions: Record<string, [string, string[]][]> = {
    不兑现: [["cash_exchange", ["forbidden"]]],
    不找零: [["change_return", ["forbidden"]]],
    不转赠: [["transfer", ["forbidden"]]],
    "不兑现、不找零、不转赠": [
      ["cash_exchange", ["forbidden"]],
      ["change_return", ["forbidden"]],
      ["transfer", ["forbidden"]],
    ],
    可以找零: [["change_return", ["allowed"]]],
    不可与其他优惠同时使用: [["stacking_promotions", ["forbidden"]]],
    超出券面金额需补差价: [["excess_payment", ["required"]]],
    代金券金额不可抵扣包装费及配送费: [
      ["excluded_costs", ["包装费", "配送费"]],
    ],
  };
  for (const rule of rules) {
    if (!["other_rules", "food_use_rule"].includes(rule.key)) continue;
    for (const { content } of rule.value) {
      const text = content
        .normalize("NFKC")
        .trim()
        .replace(/[。!]$/, "");
      let found = Object.hasOwn(definitions, text)
        ? definitions[text]
        : undefined;
      // A full, explicit list; conditions, exceptions and prose are not item names.
      const list = text.match(/^(?:此券|本券|本代金券)仅限([^,;。:()]+)使用$/);
      if (!found && list) {
        const names = list[1].split("、").map((s) => s.trim());
        if (
          names.length <= 80 &&
          names.every(
            (s) =>
              s.length > 0 &&
              s.length <= 24 &&
              !/除|不|但|仅|限|如|需|须|门店|订单|会员|学生|新客|顾客|人群|消费者|堂食|外带|打包|购买|满|元|节假|周[一二三四五六日末]|可用|有效|指定/.test(
                s,
              ),
          )
        )
          found = [["eligible_scope", [...new Set(names)].sort()]];
      }
      if (
        !found &&
        /^(?:此券|本券)可在线下门店堂食使用、小程序订单可使用\(代金券金额不可抵扣小程序订单中包装费及配送费\)不兑现、不找零、不转赠,且不能与其他优惠同时使用$/.test(
          text,
        )
      ) {
        found = [
          ["redemption_channels", ["线下门店堂食", "小程序订单"]],
          ["mini_program_excluded_costs", ["包装费", "配送费"]],
          ["cash_exchange", ["forbidden"]],
          ["change_return", ["forbidden"]],
          ["transfer", ["forbidden"]],
          ["stacking_promotions", ["forbidden"]],
        ];
      }
      if (
        !found &&
        /^(?:此券|本券)为电子代金券,支付时以线下门店称重商品\(除串串类商品外\)后的实际结算价格为准,超出券面金额时需补差价\(差价可使用您账户内的余额支付\),如不能接受请勿下单,敬请谅解$/.test(
          text,
        )
      ) {
        found = [
          ["settlement_basis", ["线下门店称重商品实际结算价格"]],
          ["excluded_items", ["串串类商品"]],
          ["excess_payment", ["required"]],
        ];
      }
      if (found) {
        for (const [dimension, values] of found)
          facts.push({ dimension, values, evidence: content, key: rule.key });
      } else if (
        /代金券|此券|本券|券面|抵扣|找零|兑现|补差|转赠|包装费|配送费/.test(
          text,
        )
      ) {
        unparsed.push({ key: rule.key, evidence: content });
      }
    }
  }
  const conflicts = [...new Set(facts.map((f) => f.dimension))].filter(
    (d) =>
      new Set(
        facts
          .filter((f) => f.dimension === d)
          .map((f) => JSON.stringify(f.values)),
      ).size > 1,
  );
  return {
    version: "voucher-terms-v1",
    facts,
    conflicts,
    unparsed,
    complete: false,
  };
}
