import type { PGlite } from "@electric-sql/pglite";
import { z } from "zod";
import { weatherOutlook } from "./weather-outlook.js";

const forecastSchema = z.object({
  hourly: z.object({
    time: z.array(z.number()),
    temperature_2m: z.array(z.number().nullable()),
    precipitation_probability: z.array(z.number().min(0).max(100).nullable()),
  }),
});
export function parseForecast(value: unknown, observedAt: Date) {
  const { hourly: h } = forecastSchema.parse(value);
  if (
    h.time.length !== h.temperature_2m.length ||
    h.time.length !== h.precipitation_probability.length
  )
    throw new Error("WEATHER_SCHEMA");
  const now = observedAt.getTime();
  const hours = h.time
    .map((t, i) => ({
      valid_at: new Date(t * 1000).toISOString(),
      temperature: h.temperature_2m[i],
      precipitation_probability: h.precipitation_probability[i],
    }))
    .filter(
      (x) =>
        Date.parse(x.valid_at) >= now &&
        Date.parse(x.valid_at) <= now + 72 * 3600000,
    );
  if (
    hours.length < 71 ||
    hours.some(
      (h, i) =>
        i > 0 &&
        Date.parse(h.valid_at) - Date.parse(hours[i - 1].valid_at) !== 3600000,
    )
  )
    throw new Error("WEATHER_INCOMPLETE_OR_STALE");
  return {
    source: "Open-Meteo",
    source_url: "https://open-meteo.com/en/docs",
    observed_at: observedAt.toISOString(),
    issued_at: null,
    hours,
  };
}
const holidays = [
  ["2026-01-01", "2026-01-03", "元旦"],
  ["2026-02-15", "2026-02-23", "春节"],
  ["2026-04-04", "2026-04-06", "清明节"],
  ["2026-05-01", "2026-05-05", "劳动节"],
  ["2026-06-19", "2026-06-21", "端午节"],
  ["2026-09-25", "2026-09-27", "中秋节"],
  ["2026-10-01", "2026-10-07", "国庆节"],
];
const workdays = new Set([
  "2026-01-04",
  "2026-02-14",
  "2026-02-28",
  "2026-05-09",
  "2026-09-20",
  "2026-10-10",
]);
export function calendarDay(date: string) {
  if (
    !/^2026-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
  )
    return { date, kind: "unknown", name: null };
  const holiday = holidays.find(([start, end]) => date >= start && date <= end);
  return {
    date,
    kind: workdays.has(date)
      ? "makeup_workday"
      : holiday
        ? "holiday"
        : [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())
          ? "weekend"
          : "workday",
    name: holiday?.[2] ?? null,
  };
}
export async function createEnvironment(db: PGlite) {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS environment_snapshots(id bigserial PRIMARY KEY,observed_at timestamptz NOT NULL,payload jsonb NOT NULL); CREATE TABLE IF NOT EXISTS environment_health(id int PRIMARY KEY,error text,checked_at timestamptz); INSERT INTO environment_health(id) VALUES(1) ON CONFLICT DO NOTHING",
  );
  let running = false;
  async function refresh() {
    if (running) return;
    running = true;
    try {
      const last = (
        await db.query<{ observed_at: Date }>(
          "SELECT observed_at FROM environment_snapshots ORDER BY id DESC LIMIT 1",
        )
      ).rows[0];
      if (
        last &&
        Date.now() - new Date(last.observed_at).getTime() < 6 * 3600000
      )
        return;
      const health = (
        await db.query<{ checked_at: Date }>(
          "SELECT checked_at FROM environment_health WHERE id=1",
        )
      ).rows[0];
      if (
        health?.checked_at &&
        Date.now() - new Date(health.checked_at).getTime() < 3600000
      )
        return;
      const response = await fetch(
        "https://api.open-meteo.com/v1/forecast?latitude=31.2304&longitude=121.4737&hourly=temperature_2m,precipitation_probability&forecast_days=4&timezone=Asia%2FShanghai&timeformat=unixtime",
        { signal: AbortSignal.timeout(20000), redirect: "error" },
      );
      if (!response.ok) throw new Error("WEATHER_HTTP_FAILED");
      const payload = parseForecast(await response.json(), new Date());
      await db.query(
        "INSERT INTO environment_snapshots(observed_at,payload) VALUES($1,$2)",
        [payload.observed_at, JSON.stringify(payload)],
      );
      await db.query(
        "UPDATE environment_health SET error=NULL,checked_at=now() WHERE id=1",
      );
    } catch {
      await db.query(
        "UPDATE environment_health SET error='WEATHER_UNAVAILABLE',checked_at=now() WHERE id=1",
      );
    } finally {
      running = false;
    }
  }
  async function status() {
    const latest =
      (
        await db.query<{ payload: ReturnType<typeof parseForecast> }>(
          "SELECT payload FROM environment_snapshots ORDER BY id DESC LIMIT 1",
        )
      ).rows[0]?.payload ?? null;
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Shanghai",
    });
    return {
      forecast: latest,
      outlook: weatherOutlook(latest),
      stale:
        !latest || Date.now() - Date.parse(latest.observed_at) > 12 * 3600000,
      health: (
        await db.query(
          "SELECT error,checked_at FROM environment_health WHERE id=1",
        )
      ).rows[0],
      calendar: calendarDay(today),
      calendar_version: "国办发明电〔2025〕7号",
      calendar_source:
        "https://www.beijing.gov.cn/zhengce/zhengcefagui/202511/t20251104_4258873.html",
      scoring_status:
        "天气与节假日只作背景证据；券适用条件和品类规则未核实，不自动加分",
      attribution:
        "Weather data by Open-Meteo (CC BY 4.0); free endpoint limited to non-commercial evaluation",
    };
  }
  return { refresh, status };
}
