import assert from "node:assert/strict";
import test from "node:test";
import {
  creatorDeduction,
  growthPercentile,
  heatGrowth,
} from "../src/external-features.js";

const asOf = new Date("2026-09-21T00:00:00Z");
test("creator counts exclude future observations, different coupons and duplicate authors", () => {
  const base = {
    videoId: "1",
    authorId: "a",
    couponVersion: "c",
    publishedAt: "2026-09-20",
    observedAt: "2026-09-20",
  };
  const result = creatorDeduction(
    [
      base,
      base,
      { ...base, videoId: "2" },
      { ...base, videoId: "3", authorId: "b", observedAt: "2026-09-22" },
      { ...base, videoId: "4", couponVersion: "other" },
      { ...base, videoId: "5", authorId: null },
    ],
    "c",
    asOf,
    true,
  );
  assert.equal(result.authors, 1);
  assert.equal(result.matchedVideos, 2);
  assert.equal(result.coverage, "partial");
  assert.deepEqual(result.deduction, { low: 0, high: 30 });
});
test("index growth needs contiguous as-of evidence and sufficient comparable cohort", () => {
  const points = Array.from({ length: 8 }, (_, i) => ({
    source: "s",
    metric: "search_index",
    value: i === 7 ? 200 : 100,
    validAt: new Date(+asOf - (7 - i) * 86400000).toISOString(),
    observedAt: new Date(+asOf - (7 - i) * 86400000).toISOString(),
  }));
  assert.equal(heatGrowth(points, "s", "search_index", asOf).growth, 1);
  assert.equal(
    heatGrowth(points.slice(1), "s", "search_index", asOf).growth,
    null,
  );
  assert.equal(heatGrowth(points, "s", "monthly_sales", asOf).growth, null);
  assert.equal(
    heatGrowth(
      points.map((p) => ({ ...p, observedAt: "2026-09-22" })),
      "s",
      "search_index",
      asOf,
    ).growth,
    null,
  );
  assert.deepEqual(growthPercentile(1, [0, 1]), { low: 0, high: 100 });
  assert.equal(growthPercentile(1, Array(20).fill(0)).low, 100);
});
