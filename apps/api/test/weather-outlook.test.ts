import assert from "node:assert/strict";
import test from "node:test";
import { weatherOutlook } from "../src/weather-outlook.js";

test("72-hour outlook uses Shanghai dates, future covered hours and holiday calendar", () => {
  const now = Date.parse("2026-09-30T15:30:00Z");
  const r = weatherOutlook(
    {
      source: "test",
      source_url: "https://example.com",
      issued_at: null,
      observed_at: new Date(now).toISOString(),
      hours: [
        {
          valid_at: "2026-09-30T15:00:00Z",
          temperature: 99,
          precipitation_probability: 100,
        },
        {
          valid_at: "2026-09-30T16:00:00Z",
          temperature: 24,
          precipitation_probability: 60,
        },
        {
          valid_at: "2026-09-30T17:00:00Z",
          temperature: 20,
          precipitation_probability: 30,
        },
      ],
    },
    now,
  );
  assert.equal(r.days[0].date, "2026-09-30");
  assert.equal(r.days[1].name, "国庆节");
  assert.equal(r.days[1].temperature_max, 24);
  assert.equal(r.days[1].temperature_min, 20);
  assert.equal(r.days[1].rain_probability_max, 60);
  assert.equal(r.covered_hours, 2);
  assert.equal(r.days[0].hours, 0);
});
test("expired and future observed weather cannot appear as current conditions", () => {
  const now = Date.parse("2026-09-30T15:30:00Z");
  for (const delta of [-13, 1]) {
    const r = weatherOutlook(
      {
        source: "test",
        source_url: "https://example.com",
        issued_at: null,
        observed_at: new Date(now + delta * 3600000).toISOString(),
        hours: [
          {
            valid_at: "2026-09-30T16:00:00Z",
            temperature: 24,
            precipitation_probability: 60,
          },
        ],
      },
      now,
    );
    assert.equal(r.stale, true);
    assert.equal(r.covered_hours, 0);
    assert.equal(r.days[1].temperature_max, null);
  }
});
