import assert from "node:assert/strict";
import test from "node:test";
import { calendarDay, parseForecast } from "../src/environment.js";

test("Shanghai calendar handles makeup Sunday and unknown years", () => {
  assert.equal(calendarDay("2026-09-20").kind, "makeup_workday");
  assert.equal(calendarDay("2026-09-25").name, "中秋节");
  assert.equal(calendarDay("2027-01-01").kind, "unknown");
  assert.equal(calendarDay("2026-02-30").kind, "unknown");
});
test("weather rejects stale/incomplete forecasts and preserves observation provenance", () => {
  const now = new Date("2026-09-21T00:30:00Z");
  const h = {
    time: Array.from(
      { length: 73 },
      (_, i) => Date.parse("2026-09-21T00:00:00Z") / 1000 + i * 3600,
    ),
    temperature_2m: Array(73).fill(25),
    precipitation_probability: Array(73).fill(30),
  };
  const result = parseForecast({ hourly: h }, now);
  assert.equal(result.hours.length, 72);
  assert.equal(result.issued_at, null);
  assert.equal(result.observed_at, now.toISOString());
  assert.throws(() => parseForecast({ hourly: h }, new Date("2026-09-25")));
  assert.throws(() => parseForecast({ hourly: { ...h, time: [1] } }, now));
});
