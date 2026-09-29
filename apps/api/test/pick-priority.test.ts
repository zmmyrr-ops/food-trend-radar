import assert from "node:assert/strict";
import test from "node:test";
import { couponDiscount, pickPriority } from "../src/pick-priority.js";

test("优先分封顶且不冒充概率，不将缺失权重分配给已有指标", () => {
  const full = pickPriority({
    speed: 100,
    acceleration: 10,
    reduction_rate: 0.3,
  });
  assert.equal(full.score, 55);
  assert.equal(full.coverage, 55);
  assert.deepEqual(full.missing, ["原价折扣", "品牌指数", "环境销售适配"]);
  const missing = pickPriority({
    speed: null,
    acceleration: null,
    reduction_rate: null,
  });
  assert.equal(missing.score, 0);
  assert.equal(missing.coverage, 0);
  const zero = pickPriority({ speed: 0, acceleration: 0, reduction_rate: 0 });
  assert.equal(zero.score, 0);
  assert.equal(zero.coverage, 55);
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
    55,
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
