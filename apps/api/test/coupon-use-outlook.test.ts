import assert from "node:assert/strict";
import test from "node:test";
import { couponUseOutlook } from "../src/coupon-use-outlook.js";

const now = Date.parse("2026-09-28T11:00:00Z");
function input(texts: string[], at = now) {
  return {
    price_observed_at: new Date(at - 60000).toISOString(),
    rules_observed_at: new Date(at).toISOString(),
    rules: texts.map((content) => ({
      key: "use_date",
      name: "可用日期",
      value: [{ content }],
    })),
  };
}
test("72h Shanghai window clips four calendar dates and matches named holiday exclusions", () => {
  const result = couponUseOutlook(input(["不可用日期：国庆节"]), now);
  assert.deepEqual(
    result.days.map((d) => d.date),
    ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"],
  );
  assert.deepEqual(
    result.days
      .filter((d) => d.status === "explicitly_excluded")
      .map((d) => d.date),
    ["2026-10-01"],
  );
  assert.equal(
    result.days.reduce((n, d) => n + Date.parse(d.to) - Date.parse(d.from), 0),
    72 * 3600000,
  );
  assert.equal(result.fully_excluded, false);
  assert.equal(result.days[0].status, "unconfirmed");
});
test("conditional clauses, generic legal holidays and invalid ranges never become unconditional bans", () => {
  for (const clause of [
    "不可用日期：周一、会员除外",
    "不可用日期：法定节假日",
    "不可用日期：2026-02-30",
    "不可用日期：2026-10-01至2026-09-28",
    "不可用日期：周日至周一",
    "国庆期间部分门店不可用",
  ]) {
    const result = couponUseOutlook(input([clause]), now);
    assert.equal(result.has_explicit_exclusion, false, clause);
    assert.deepEqual(result.unparsed_dates, [clause]);
  }
});
test("explicit ranges can exclude a whole window, while purchase validity does not start at collection", () => {
  const result = couponUseOutlook(
    input(["不可用日期：2026-09-28至2026-10-01", "购买后15天内有效"]),
    now,
  );
  assert.equal(result.fully_excluded, true);
  assert.equal(result.purchase_relative_days, 15);
  assert.equal(
    couponUseOutlook(input(["购买后1天内有效"]), now).has_explicit_exclusion,
    false,
  );
  const at = Date.parse("2026-09-28T16:00:00Z");
  assert.equal(
    couponUseOutlook(input(["不可用日期：周一至周日"], at), at).days.length,
    3,
  );
});
test("literal weekday restriction still applies on a makeup workday, unknown year never invents holidays", () => {
  const at = Date.parse("2026-09-20T00:00:00Z");
  const result = couponUseOutlook(input(["不可用日期：周日"], at), at);
  assert.equal(result.days[0].calendar_kind, "makeup_workday");
  assert.equal(result.days[0].status, "explicitly_excluded");
  const next = Date.parse("2027-10-01T00:00:00Z");
  const unknown = couponUseOutlook(input(["不可用日期：国庆节"], next), next);
  assert.equal(unknown.has_explicit_exclusion, false);
  assert.equal(unknown.days[0].calendar_kind, "unknown");
});
test("missing, empty, future, stale or pre-price rules do not produce usage claims", () => {
  const baseline = input(["不可用日期：周一至周日"]);
  for (const data of [
    { ...baseline, rules: null },
    { ...baseline, rules: [] },
    input(["不可用日期：周一至周日"], now + 60000),
    input(["不可用日期：周一至周日"], now - 37 * 3600000),
    { ...baseline, rules_observed_at: new Date(now - 120000).toISOString() },
  ]) {
    const result = couponUseOutlook(data, now);
    assert.equal(result.evidence_status, "missing_or_stale");
    assert.equal(result.has_explicit_exclusion, false);
  }
});
test("time windows retain seconds and overnight semantics without turning into confirmed availability", () => {
  const data = input(["购买后15天内有效"]);
  data.rules.push({
    key: "use_time",
    name: "使用时间",
    value: [{ content: "22:00:00—02:30:00" }],
  });
  const result = couponUseOutlook(data, now);
  assert.deepEqual(result.time_windows, [
    { start: "22:00:00", end: "02:30:00", overnight: true },
  ]);
  assert.ok(result.days.every((d) => d.status === "unconfirmed"));
});
