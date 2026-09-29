import assert from "node:assert/strict";
import test from "node:test";
import { parseRestrictions } from "../src/rule-restrictions.js";

const rule = (key: string, ...lines: string[]) => ({
  key,
  name: key,
  value: lines.map((content) => ({ content })),
});
test("explicit qualifications, per-unit fees and purchase limits retain evidence and units", () => {
  const r = parseRestrictions([
    rule("other_rules", "仅限会员", "另收服务费12.50元/人", "锅底费20元/桌"),
    rule("purchase_restriction_rule", "每人每天最多买2份"),
  ]);
  assert.equal(r.eligibility.facts[0].kind, "member");
  assert.deepEqual(
    r.fees.charges.map((x) => [x.amount_fen, x.basis]),
    [
      [1250, "人"],
      [2000, "桌"],
    ],
  );
  assert.equal(r.fees.total_fen, null);
  assert.equal(r.purchase_limits.facts[0].quantity, 2);
  assert.equal(r.purchase_limits.facts[0].period, "每天");
  assert.equal(r.complete, false);
});
test("negation, conditional pricing and informal suggestions cannot become unconditional facts", () => {
  const r = parseRestrictions([
    rule(
      "other_rules",
      "非新客也可购买，但会员另付服务费",
      "此套餐建议本人使用，不可转赠转售（谨防诈骗）",
      "节假日加收服务费10元/人",
      "服务费10%",
      "儿童价格：1.2m以下免费",
      "同桌需同档位",
    ),
    rule("purchase_restriction_rule", "每人每天最多买2份，会员除外"),
  ]);
  assert.equal(r.eligibility.facts.length, 0);
  assert.equal(r.fees.charges.length, 0);
  assert.equal(r.eligibility.unparsed.length, 5);
  assert.equal(r.fees.unparsed.length, 3);
  assert.equal(r.purchase_limits.facts.length, 0);
});
test("contradictory declarations and missing amounts stay unknown", () => {
  const r = parseRestrictions([
    rule(
      "other_rules",
      "新老客均可使用",
      "仅限新客",
      "无附加费",
      "服务费10元/人",
      "服务费20元/人",
    ),
    rule("purchase_restriction_rule", "每人每天最多买2份", "每人每天最多买3份"),
  ]);
  assert.equal(r.eligibility.conflicting, true);
  assert.equal(r.fees.conflicting, true);
  assert.equal(r.purchase_limits.conflicting, true);
  assert.equal(r.fees.total_fen, null);
  assert.equal(parseRestrictions([]).fees.total_fen, null);
});
