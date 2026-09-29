import assert from "node:assert/strict";
import test from "node:test";
import { structureRules } from "../src/rule-structure.js";
import { parseVoucherTerms } from "../src/voucher-terms.js";

const rules = (...lines: string[]) => [
  {
    key: "other_rules",
    name: "其他",
    value: lines.map((content) => ({ content })),
  },
];
const channel =
  "此券可在线下门店堂食使用、小程序订单可使用（代金券金额不可抵扣小程序订单中包装费及配送费）不兑现、不找零、不转赠，且不能与其他优惠同时使用。";
const settlement =
  "此券为电子代金券，支付时以线下门店称重商品（除串串类商品外）后的实际结算价格为准，超出券面金额时需补差价（差价可使用您账户内的余额支付），如不能接受请勿下单，敬请谅解。";

test("voucher clauses preserve channel scope, exclusions and unknown cash payable", () => {
  const parsed = structureRules(
    [],
    rules(channel, settlement, "此券仅限鸭脖、鸭掌、毛豆使用。"),
  );
  const facts = parsed.voucher.facts;
  assert.deepEqual(
    facts.find((f) => f.dimension === "mini_program_excluded_costs")?.values,
    ["包装费", "配送费"],
  );
  assert.equal(
    facts.some((f) => f.dimension === "excluded_costs"),
    false,
  );
  assert.deepEqual(
    facts.find((f) => f.dimension === "excess_payment")?.values,
    ["required"],
  );
  assert.deepEqual(
    facts.find((f) => f.dimension === "excluded_items")?.values,
    ["串串类商品"],
  );
  assert.equal(
    facts.find((f) => f.dimension === "redemption_channels")?.evidence,
    channel,
  );
  assert.equal(parsed.voucher.unparsed.length, 0);
  assert.equal(parsed.comparable, false);
  assert.equal(parsed.restrictions.fees.total_fen, null);
  assert.equal(parsed.voucher.complete, false);
});

test("voucher parser does not generalize exceptions, eligibility or changed compound clauses", () => {
  const input = [
    "此券仅限会员使用。",
    "此券仅限鸭脖、毛豆使用，但节假日除外。",
    "部分门店不找零",
    channel.replace("且不能", "但周末可以"),
    settlement.replace("需补差价", "无需补差价"),
    "此券仅限鸭脖、指定商品使用。",
  ];
  const result = parseVoucherTerms(rules(...input));
  assert.deepEqual(result.facts, []);
  assert.equal(result.unparsed.length, input.length);
  assert.deepEqual(
    parseVoucherTerms([
      { key: "refund_rule", name: "退款", value: [{ content: "不找零" }] },
    ]).facts,
    [],
  );
});

test("conflicting settlement declarations stay visible; list ordering does not create conflicts", () => {
  const result = parseVoucherTerms(
    rules(
      "不找零。",
      "可以找零。",
      "本券仅限毛豆、鸭脖使用。",
      "本券仅限鸭脖、毛豆使用。",
    ),
  );
  assert.deepEqual(result.conflicts, ["change_return"]);
  assert.equal(result.facts.length, 4);
  assert.equal(result.complete, false);
});
