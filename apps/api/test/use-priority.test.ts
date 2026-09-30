import assert from "node:assert/strict";
import test from "node:test";
import { couponUseOutlook } from "../src/coupon-use-outlook.js";
import { pickPriority } from "../src/pick-priority.js";
import { applyUsePenalty } from "../src/use-priority.js";

const now = Date.parse("2026-09-30T02:00:00Z");
const base = pickPriority({
  speed: 100,
  acceleration: 10,
  reduction_rate: null,
  discount_rate: 0.34,
});
function outlook(at = now) {
  return couponUseOutlook(
    {
      price_observed_at: new Date(at - 60000).toISOString(),
      rules_observed_at: new Date(at).toISOString(),
      rules: [
        {
          key: "use_date",
          name: "可用日期",
          value: [
            {
              content:
                "不可用日期: 国庆节(10.01-10.07)、2026.10.01 至 2026.10.07",
            },
          ],
        },
      ],
    },
    at,
  );
}
test("国庆带括号日期和点号范围能识别，临近节假日降分，全部禁用归零", () => {
  const r = outlook();
  assert.equal(r.has_explicit_exclusion, true);
  assert.equal(r.unparsed_dates.length, 0);
  assert.ok(applyUsePenalty(base, r).score <= 20);
  assert.equal(
    applyUsePenalty(base, outlook(Date.parse("2026-10-01T02:00:00Z"))).score,
    0,
  );
});
test("旧规则风险仅作待复核降权，不冒充本轮已确认；完全缺失不推定不可用", () => {
  const missing = couponUseOutlook(
    {
      price_observed_at: new Date(now).toISOString(),
      rules_observed_at: null,
      rules: null,
    },
    now,
  );
  assert.equal(applyUsePenalty(base, missing).score, base.score);
  const r = applyUsePenalty(base, missing, outlook());
  assert.ok(r.score <= 20);
  assert.equal(r.availability_gate.historical, true);
});
