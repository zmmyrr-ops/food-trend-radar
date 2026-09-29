import { calendarDay, type parseForecast } from "./environment.js";
export function weatherOutlook(
  forecast: ReturnType<typeof parseForecast> | null,
  now = Date.now(),
) {
  const stale =
    !forecast ||
    now - Date.parse(forecast.observed_at) > 12 * 3600000 ||
    Date.parse(forecast.observed_at) > now;
  const localDate = (at: number) =>
    new Date(at + 8 * 3600000).toISOString().slice(0, 10);
  const days = new Map<
    string,
    {
      date: string;
      kind: string;
      name: string | null;
      hours: number;
      temperature_min: number | null;
      temperature_max: number | null;
      rain_probability_max: number | null;
    }
  >();
  const end = now + 72 * 3600000;
  for (let at = now; at < end; at += 3600000) {
    const date = localDate(at);
    if (!days.has(date))
      days.set(date, {
        ...calendarDay(date),
        hours: 0,
        temperature_min: null,
        temperature_max: null,
        rain_probability_max: null,
      });
  }
  if (!stale)
    for (const h of forecast!.hours) {
      const at = Date.parse(h.valid_at);
      if (at < now || at >= end) continue;
      const d = days.get(localDate(at));
      if (!d) continue;
      d.hours++;
      if (h.temperature !== null) {
        d.temperature_min =
          d.temperature_min === null
            ? h.temperature
            : Math.min(d.temperature_min, h.temperature);
        d.temperature_max =
          d.temperature_max === null
            ? h.temperature
            : Math.max(d.temperature_max, h.temperature);
      }
      if (h.precipitation_probability !== null)
        d.rain_probability_max =
          d.rain_probability_max === null
            ? h.precipitation_probability
            : Math.max(d.rain_probability_max, h.precipitation_probability);
    }
  return {
    as_of: new Date(now).toISOString(),
    until: new Date(end).toISOString(),
    stale,
    days: [...days.values()],
    covered_hours: [...days.values()].reduce((n, d) => n + d.hours, 0),
    note: "按已覆盖小时汇总，首尾可能不足一天；降水为最高小时概率，不代表全天概率。天气和节假日不直接等于销量提升。",
  };
}
