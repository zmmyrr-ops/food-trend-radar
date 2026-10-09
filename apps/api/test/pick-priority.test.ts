import assert from "node:assert/strict";
import test from "node:test";
import { couponDiscount, pickPriority } from "../src/pick-priority.js";

test("优先分封顶且不冒充概率，不将缺失权重分配给已有指标", () => {
  const full = pickPriority({
    speed: 100,
    acceleration: 10,
    reduction_rate: 0.3,
  });
  assert.equal(full.score, 33);
  assert.equal(full.coverage, 33);
  assert.deepEqual(full.missing, [
    "销售额增速（估算）",
    "原价折扣",
    "品牌指数",
    "新上券",
  ]);
  const missing = pickPriority({
    speed: null,
    acceleration: null,
    reduction_rate: null,
  });
  assert.equal(missing.score, 0);
  assert.equal(missing.coverage, 0);
  const zero = pickPriority({ speed: 0, acceleration: 0, reduction_rate: 0 });
  assert.equal(zero.score, 0);
  assert.equal(zero.coverage, 33);
  assert.equal(
    pickPriority({ speed: -10, acceleration: -10, reduction_rate: -1 }).score,
    0,
  );
  assert.equal(
    pickPriority({ speed: Infinity, acceleration: NaN, reduction_rate: null })
      .coverage,
    0,
  );
  assert.equal(
    pickPriority({ speed: 1e6, acceleration: 1e6, reduction_rate: 1 }).score,
    33,
  );
});
test("优惠更强、热度更快会单调提高排序，关注不参与分数", () => {
  const base = { speed: 10, acceleration: 1, reduction_rate: 0.05 };
  const score = pickPriority(base).score;
  for (const input of [
    { ...base, speed: 20 },
    { ...base, acceleration: 2 },
    { ...base, reduction_rate: 0.1 },
  ])
    assert.ok(pickPriority(input).score > score);
});

test("原价折扣独立于上次降价；多规格、异常和缺失价格不计分", () => {
  assert.equal(couponDiscount(5000, 5000, 10000).rate, 0.5);
  assert.equal(couponDiscount(10000, 10000, 10000).rate, 0);
  for (const [price, max, origin] of [
    [5000, 8000, 10000],
    [5000, null, 10000],
    [5000, 5000, 0],
    [5000, 5000, 4000],
    [0, 0, 10000],
  ]) {
    assert.equal(couponDiscount(price, max, origin).rate, null);
  }
  const base = { speed: null, acceleration: null, reduction_rate: null };
  assert.equal(pickPriority({ ...base, discount_rate: 0.2 }).score, 10);
  assert.equal(pickPriority({ ...base, discount_rate: 0.5 }).score, 25);
  assert.equal(pickPriority({ ...base, discount_rate: 0.8 }).score, 25);
  assert.equal(pickPriority({ ...base, discount_rate: null }).coverage, 0);
  assert.equal(pickPriority({ ...base, discount_rate: 0 }).coverage, 25);
});

test("南京大牌档1%优惠降权，已知弱折扣不能被涨速或历史降价救回", () => {
  const input = {
    speed: 25.6,
    acceleration: 9.42,
    discount_rate: 0.01,
    reduction_rate: null,
  };
  const result = pickPriority(input);
  assert.equal(result.raw_score, 18);
  assert.equal(result.score, 0.9);
  assert.equal(result.value_gate.eligible, false);
  assert.equal(
    pickPriority({ ...input, reduction_rate: 0.5 }).value_gate.eligible,
    false,
  );
  assert.equal(
    pickPriority({ ...input, discount_rate: 0.1 }).value_gate.eligible,
    true,
  );
  assert.equal(
    pickPriority({ ...input, discount_rate: 0.2 }).value_gate.factor,
    1,
  );
  assert.equal(
    pickPriority({ ...input, discount_rate: null }).value_gate.eligible,
    false,
  );
  assert.equal(
    pickPriority({ ...input, discount_rate: null, reduction_rate: 0.2 })
      .value_gate.eligible,
    true,
  );
});

test("代金券卖点不放大缺失数据，保留低优惠约束", () => {
  const input = {
    title: "100元代金券|四店齐开•开业钜惠•叠加三张",
    speed: 78.18748,
    price_fen: 6900,
    acceleration: null,
    reduction_rate: null,
    discount_rate: 0.31,
    is_new: false,
  };
  const result = pickPriority(input);
  assert.equal(result.raw_score, 48.8);
  assert.equal(result.score, 59.5);
  assert.equal("evidence_factor" in result, false);
  assert.equal(result.selling_points[0].value, 4.65);
  assert.equal(
    pickPriority({ ...input, discount_rate: 0.5 }).selling_points[0].value,
    7.5,
  );
  assert.equal(result.selling_points[1].value, 6);
  assert.equal(
    pickPriority({ ...input, title: "100元代金券 不可叠加三张" })
      .selling_points[1].value,
    0,
  );
  assert.equal(
    pickPriority({ ...input, title: "三张叠加优惠套餐" }).selling_points[1]
      .value,
    0,
  );
  assert.ok(pickPriority({ ...input, discount_rate: 0.01 }).score < 5);
  assert.equal(pickPriority({ ...input, discount_rate: null }).score, 0);
  assert.equal(pickPriority({ ...input, speed: null }).score, 26.2);
});

test("销售分结合实际售价，缺失价格不虚构销售额，高价零增长不得分", () => {
  const base = { speed: 30, acceleration: null, reduction_rate: null };
  const sales = (price_fen: number | null, speed = 30) =>
    pickPriority({ ...base, price_fen, speed }).parts.slice(0, 2);
  assert.ok(sales(10000)[1].value! > sales(1000)[1].value!);
  assert.equal(sales(10000)[0].value, sales(1000)[0].value);
  assert.deepEqual(
    sales(10000000, 0).map((x) => x.value),
    [0, 0],
  );
  for (const price of [null, 0, -100, NaN, Infinity, 1.5])
    assert.equal(sales(price)[1].value, null);
  assert.deepEqual(
    sales(10000000, 100000).map((x) => x.value),
    [18, 22],
  );
  assert.equal(
    pickPriority({ ...base, price_fen: 10000, speed: null }).parts[1].value,
    null,
  );
  assert.ok(sales(10000, 30)[1].value! > sales(1000, 100)[1].value!);
});

test("销售额拉开区分度，加速度最多5分且不补偿缺失", () => {
  const base = {
    speed: 10,
    price_fen: 10000,
    acceleration: null,
    reduction_rate: null,
    discount_rate: 0.3,
    is_new: false,
  };
  const revenue = (yuan: number) =>
    pickPriority({ ...base, price_fen: 100, speed: yuan }).parts[1].value!;
  assert.equal(revenue(100), 2.2);
  assert.equal(revenue(1000), 7);
  assert.equal(revenue(5000), 15.6);
  assert.equal(revenue(10000), 22);
  assert.ok(revenue(5395) - revenue(437) > 11);
  const missing = pickPriority(base);
  assert.equal(
    pickPriority({ ...base, acceleration: 100 }).score - missing.score,
    5,
  );
  assert.equal(pickPriority({ ...base, acceleration: 0 }).score, missing.score);
  assert.equal(
    pickPriority({ ...base, acceleration: -5 }).score,
    missing.score,
  );
  assert.ok(revenue(5000) - revenue(4000) > revenue(9000) - revenue(8000));
});
