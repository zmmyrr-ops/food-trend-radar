/** Initial transparent ranking rules, not a calibrated probability or value verdict. */
export function pickPriority(input: {
  brand_growth?: number | null;
  speed: number | null;
  acceleration: number | null;
  reduction_rate: number | null;
}) {
  const valid = (n: number | null) => n !== null && Number.isFinite(n);
  const parts = [
    {
      name: "销量升温",
      weight: 35,
      value: valid(input.speed)
        ? 35 *
          Math.min(1, Math.log1p(Math.max(0, input.speed!)) / Math.log(101))
        : null,
    },
    {
      name: "增长加快",
      weight: 20,
      value: valid(input.acceleration)
        ? 20 * Math.min(1, Math.max(0, input.acceleration!) / 10)
        : null,
    },
    {
      name: "票面优惠",
      weight: 25,
      value: valid(input.reduction_rate)
        ? 25 * Math.min(1, Math.max(0, input.reduction_rate!) / 0.3)
        : null,
    },
    {
      name: "品牌指数",
      weight: 10,
      value:
        input.brand_growth != null && Number.isFinite(input.brand_growth)
          ? 10 * Math.min(1, Math.max(0, (input.brand_growth + 0.25) / 0.5))
          : null,
    },
    { name: "环境销售适配", weight: 10, value: null },
  ].map((x) => ({
    ...x,
    value: x.value === null ? null : Math.round(x.value * 10) / 10,
  }));
  return {
    version: "priority-v2",
    score: Math.round(parts.reduce((n, x) => n + (x.value ?? 0), 0) * 10) / 10,
    coverage: parts.reduce((n, x) => n + (x.value === null ? 0 : x.weight), 0),
    parts,
    missing: parts.filter((x) => x.value === null).map((x) => x.name),
  };
}
