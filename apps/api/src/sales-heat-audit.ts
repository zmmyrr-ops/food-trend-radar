type Sample = { observed_at: string; monthly_sales: string; missing?: boolean };
type Item = {
  brand_id: string;
  product_id: string;
  samples: Sample[];
  net_change: number | null;
  hours: number | null;
  speed: number | null;
  previous_speed: number | null;
  acceleration: number | null;
  baseline_windows: number;
  baseline_speed: number | null;
  lift_ratio: number | null;
};
/** Recalculate published numbers from raw displays; do not call salesTrend or reuse parsed_value. */
export function auditSalesHeat(items: Item[]) {
  const errors: { brand_id: string; product_id: string; field: string }[] = [];
  const counts = {
    coupons: items.length,
    speed: 0,
    acceleration: 0,
    positive_acceleration: 0,
    baseline: 0,
    lift: 0,
  };
  const integer = (s: string) => {
    const raw = s
      .normalize("NFKC")
      .trim()
      .replace(/^月售\s*/, "");
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(raw)) return null;
    const n = Number(raw.replaceAll(",", ""));
    return Number.isSafeInteger(n) ? n : null;
  };
  for (const x of items) {
    const error = (field: string) =>
      errors.push({ brand_id: x.brand_id, product_id: x.product_id, field });
    const eq = (
      actual: number | null,
      expected: number | null,
      field: string,
    ) => {
      if (
        actual === null ||
        expected === null ||
        !Number.isFinite(actual) ||
        !Number.isFinite(expected) ||
        Math.abs(actual - expected) > 1e-8 * Math.max(1, Math.abs(expected))
      )
        error(field);
    };
    const window = (i: number) => {
      const a = x.samples[i],
        b = x.samples[i + 1];
      if (!a || !b || a.missing || b.missing) return null;
      const av = integer(a.monthly_sales),
        bv = integer(b.monthly_sales);
      const at = Date.parse(a.observed_at),
        bt = Date.parse(b.observed_at),
        hours = (at - bt) / 3600000;
      if (
        av === null ||
        bv === null ||
        !Number.isFinite(hours) ||
        hours < 1 ||
        hours > 36
      )
        return null;
      return {
        delta: av - bv,
        hours,
        speed: (av - bv) / hours,
        midpoint: (at + bt) / 2,
      };
    };
    const current = window(0),
      prior = window(1);
    if (x.speed !== null) {
      counts.speed++;
      eq(x.speed, current?.speed ?? null, "speed");
      eq(x.hours, current?.hours ?? null, "hours");
      eq(x.net_change, current?.delta ?? null, "net_change");
    }
    if (x.acceleration !== null) {
      counts.acceleration++;
      if (x.acceleration > 0) counts.positive_acceleration++;
      const eligible =
        current && prior && current.delta >= 0 && prior.delta >= 0;
      eq(
        x.acceleration,
        eligible
          ? (current.speed - prior.speed) /
              ((current.midpoint - prior.midpoint) / 3600000)
          : null,
        "acceleration",
      );
      eq(x.previous_speed, prior?.speed ?? null, "previous_speed");
      if (x.speed === null) error("acceleration_without_speed");
    }
    if (x.baseline_speed !== null) {
      counts.baseline++;
      const windows = Array.from(
        { length: Math.min(16, Math.max(0, x.baseline_windows)) },
        (_, i) => window(i + 1),
      );
      const valid =
        Number.isInteger(x.baseline_windows) &&
        x.baseline_windows >= 4 &&
        x.baseline_windows <= 14 &&
        windows.every((w) => w && w.delta >= 0) &&
        windows.reduce((s, w) => s + (w?.hours ?? 0), 0) >= 24;
      const sorted = windows.map((w) => w?.speed ?? NaN).sort((a, b) => a - b),
        m = Math.floor(sorted.length / 2);
      eq(
        x.baseline_speed,
        valid
          ? sorted.length % 2
            ? sorted[m]
            : (sorted[m - 1] + sorted[m]) / 2
          : null,
        "baseline_speed",
      );
    }
    if (x.lift_ratio !== null) {
      counts.lift++;
      eq(
        x.lift_ratio,
        x.speed !== null &&
          x.speed >= 0 &&
          x.baseline_speed !== null &&
          x.baseline_speed > 0
          ? x.speed / x.baseline_speed
          : null,
        "lift_ratio",
      );
    }
  }
  return {
    version: "numeric-audit-v1",
    counts,
    passed: errors.length === 0,
    errors,
    caveat:
      "仅独立复算已发布数字，不验证平台统计定义、品牌归属或完整权益；未知指标不算验收通过。",
  };
}
