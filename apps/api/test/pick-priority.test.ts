import assert from "node:assert/strict";
import test from "node:test";
import { pickPriority } from "../src/pick-priority.js";

test("优先分封顶且不冒充概率，不将缺失权重分配给已有指标", () => {
  const full = pickPriority({
    speed: 100,
    acceleration: 10,
    reduction_rate: 0.3,
  });
  assert.equal(full.score, 80);
  assert.equal(full.coverage, 80);
  assert.deepEqual(full.missing, ["品牌指数", "环境销售适配"]);
  const missing = pickPriority({
    speed: null,
    acceleration: null,
    reduction_rate: null,
  });
  assert.equal(missing.score, 0);
  assert.equal(missing.coverage, 0);
  const zero = pickPriority({ speed: 0, acceleration: 0, reduction_rate: 0 });
  assert.equal(zero.score, 0);
  assert.equal(zero.coverage, 80);
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
    80,
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
