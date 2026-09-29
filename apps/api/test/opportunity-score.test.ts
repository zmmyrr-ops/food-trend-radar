import assert from "node:assert/strict";
import test from "node:test";
import {
  novelty,
  point,
  samePriceTolerance,
  saturation,
  scoreOpportunity,
  unknown,
  unverifiedOpportunity,
  valueScore,
} from "../src/opportunity-score.js";

const gates = {
  identity: true,
  shanghai: true,
  available: true,
  value: true,
  creatorCoverage: true,
};
const sample = {
  value: point(80),
  novelty: point(100),
  heat: point(60),
  environment: point(70),
  deduction: { low: 10, high: 10 },
  gates,
  confirmedChange: true,
};
test("V3 known score and unknown deduction preserve bounds", () => {
  assert.deepEqual(scoreOpportunity(sample).range, { low: 69, high: 69 });
  assert.deepEqual(
    scoreOpportunity({ ...sample, deduction: { low: 0, high: 30 } }).range,
    { low: 49, high: 79 },
  );
  assert.deepEqual(valueScore(unknown(), point(100), point(100)), {
    low: 40,
    high: 100,
  });
  assert.equal(unverifiedOpportunity().alert, false);
});
test("gate blocks high scores; incomplete search is not zero competition", () => {
  const high = { ...sample, value: point(100), deduction: saturation(0, true) };
  assert.equal(scoreOpportunity(high).alert, true);
  assert.equal(
    scoreOpportunity({ ...high, gates: { ...gates, shanghai: false } }).alert,
    false,
  );
  assert.deepEqual(saturation(0, false), { low: 0, high: 30 });
  assert.deepEqual(saturation(15, false), { low: 20, high: 30 });
  assert.throws(() => saturation(-1, true));
  assert.throws(() =>
    scoreOpportunity({ ...sample, heat: { low: 80, high: 20 } }),
  );
});
test("novelty boundaries and price tolerance", () => {
  assert.equal(novelty(24, true).low, 100);
  assert.equal(novelty(25, true).low, 70);
  assert.equal(novelty(49, true).low, 40);
  assert.equal(novelty(73, true).low, 10);
  assert.equal(novelty(0, false).low, 30);
  assert.deepEqual(novelty(-1, true), unknown());
  assert.equal(samePriceTolerance(1000), 100);
  assert.equal(samePriceTolerance(10000), 300);
});
