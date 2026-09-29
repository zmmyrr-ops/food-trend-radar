import assert from "node:assert/strict";
import test from "node:test";
import { parseRestrictions } from "../src/rule-restrictions.js";
import { ruleChanges, structureRules } from "../src/rule-structure.js";
import { parseUsage } from "../src/rule-usage.js";

const rule = (key: string, ...lines: string[]) => ({
  key,
  name: key,
  value: lines.map((content) => ({ content })),
});

test("real coupon usage distinguishes redemption, stacking and fully-unused refunds", () => {
  const rules = [
    rule("food_consumption_rule", "不支持堂食，仅支持打包外带"),
    rule("appointment_rule", "到店消费：无需预约，高峰期可能需要排队"),
    rule(
      "food_use_rule",
      "不与店内优惠同享",
      "单次消费最多使用3张团购券",
      "当前商品每桌限用1张券",
    ),
    rule(
      "refund_rule",
      "整单退款：核销前，支持随时退，过期自动退",
      "部分退款：未使用部分全部退，消费者可退金额=实付金额-已使用部分优惠均摊后的价格",
    ),
  ];
  const usage = structureRules([], rules).usage;
  assert.deepEqual(
    usage.facts.map((x) => [x.dimension, x.value]),
    [
      ["consumption", "takeaway_only"],
      ["reservation", "not_required"],
      ["stacking_store_promotions", "forbidden"],
      ["redemption_per_visit", "3"],
      ["redemption_per_table", "1"],
      ["refund_fully_unused", "anytime"],
      ["refund_expired_fully_unused", "automatic"],
    ],
  );
  assert.equal(usage.unparsed.length, 1);
  assert.equal(usage.complete, false);
});
test("conditional and store-scoped wording cannot become universal permissions", () => {
  const r = parseUsage([
    rule(
      "other_rules",
      "备注：久光中心店周末和节假日不参加团购活动",
      "除国庆外无需预约",
    ),
    rule("food_consumption_rule", "仅堂食，机场店除外", "并非仅堂食"),
    rule(
      "food_use_rule",
      "单次消费最多使用3张团购券，会员除外",
      "单次消费最多使用0张团购券",
    ),
    rule("refund_rule", "核销后不可退款", "部分退款：未使用部分全部退"),
    rule("appointment_rule", "建议提前预约"),
  ]);
  assert.equal(r.facts.length, 0);
  assert.equal(r.unparsed.length, 9);
  assert.equal(parseUsage([]).complete, false);
});
test("conflicts stay visible while different restriction dimensions remain separate", () => {
  const r = parseUsage([
    rule("food_consumption_rule", "仅堂食", "堂食或餐前外带均可"),
    rule(
      "food_use_rule",
      "单次消费不限制使用张数",
      "单次消费最多使用3张团购券",
      "当前商品每桌限用1张券",
      "不可与其他代金券叠加使用",
    ),
    rule("appointment_rule", "无需预约", "需提前预约"),
  ]);
  assert.deepEqual(r.conflicts, [
    "consumption",
    "redemption_per_visit",
    "reservation",
  ]);
  assert.equal(r.facts.length, 8);
});
test("purchase limits retain per-person versus per-order scope and ticket units", () => {
  const r = parseRestrictions([
    rule(
      "purchase_restriction_rule",
      "每人最多买1张",
      "每单最多买5张",
      "每人每天最多买2份",
    ),
  ]);
  assert.deepEqual(
    r.purchase_limits.facts.map((f) => [f.quantity, f.basis, f.unit, f.period]),
    [
      [1, "人", "张", "unspecified"],
      [5, "单", "张", "unspecified"],
      [2, "人", "份", "每天"],
    ],
  );
  assert.equal(r.purchase_limits.conflicting, false);
  assert.equal(r.purchase_limits.unparsed.length, 0);
  assert.equal(
    parseRestrictions([
      rule("purchase_restriction_rule", "每人最多买1张", "每人最多买2张"),
    ]).purchase_limits.conflicting,
    true,
  );
});
test("consumption and scope changes receive business labels without value upgrade", () => {
  const previous = {
    groups: [],
    rules: [
      rule("food_consumption_rule", "仅堂食"),
      rule("application_scope", "全场通用"),
    ],
  };
  const r = ruleChanges(
    {
      groups: [],
      rules: [
        rule("food_consumption_rule", "堂食或餐前外带均可"),
        rule("application_scope", "除套餐，酒水外全场通用"),
      ],
    },
    previous,
  );
  assert.deepEqual(r.changes, ["堂食与外带条件", "适用范围"]);
  assert.equal(r.value_verdict, "unverified");
});
