import assert from "node:assert/strict";
import test from "node:test";
import { auditSalesHeat } from "../src/sales-heat-audit.js";

const sample = (n: string, h: number) => ({
  monthly_sales: "月售 " + n,
  observed_at: new Date(Date.UTC(2026, 8, 29) - h * 3600000).toISOString(),
});
const item = () => ({
  brand_id: "a",
  product_id: "1",
  samples: [sample("160", 0), sample("100", 6), sample("40", 18)],
  net_change: 60,
  hours: 6,
  speed: 10,
  previous_speed: 5,
  acceleration: 5 / 9,
  baseline_windows: 1,
  baseline_speed: null as number | null,
  lift_ratio: null as number | null,
});
test("audit independently reproduces speeds and unequal-window acceleration", () => {
  const r = auditSalesHeat([item()]);
  assert.equal(r.passed, true);
  assert.equal(r.counts.positive_acceleration, 1);
});
test("audit rejects wrong numbers, ambiguous displays and missing samples", () => {
  for (const bad of [
    { ...item(), speed: 12 },
    { ...item(), acceleration: 5 / 6 },
    {
      ...item(),
      samples: [sample("1万+", 0), sample("100", 6), sample("40", 18)],
    },
    {
      ...item(),
      samples: [
        { ...sample("160", 0), missing: true },
        sample("100", 6),
        sample("40", 18),
      ],
    },
  ])
    assert.equal(auditSalesHeat([bad]).passed, false);
});
test("audit reproduces historical median and rejects zero-baseline lift", () => {
  const x = {
    ...item(),
    samples: [
      sample("400", 0),
      sample("160", 12),
      sample("100", 24),
      sample("70", 30),
      sample("40", 36),
      sample("10", 42),
    ],
    net_change: 240,
    hours: 12,
    speed: 20,
    previous_speed: 5,
    acceleration: 15 / 12,
    baseline_windows: 4,
    baseline_speed: 5,
    lift_ratio: 4,
  };
  assert.equal(auditSalesHeat([x]).passed, true);
  assert.equal(auditSalesHeat([{ ...x, baseline_speed: 0 }]).passed, false);
});
