/** Platform reference price is not proof of historical transaction value. */
export function couponDiscount(
  price: number | null | undefined,
  maximum: number | null | undefined,
  original: number | null | undefined,
) {
  const valid = (n: number | null | undefined): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n > 0;
  if (!valid(price) || !valid(original))
    return { rate: null, reason: "售价或平台原价缺失，折扣暂缺" };
  if (!valid(maximum) || maximum !== price)
    return { rate: null, reason: "多规格或价格范围不完整，原价对应规格待核验" };
  if (original < price)
    return { rate: null, reason: "平台原价低于售价，价格口径待核验" };
  return {
    rate: 1 - price / original,
    reason: "按平台原价计算，不代表历史成交价",
  };
}

/** Initial transparent ranking rules, not a calibrated probability or value verdict. */
export function pickPriority(input: {
  title?: string;
  price_fen?: number | null;
  is_new?: boolean;
  discount_rate?: number | null;
  brand_growth?: number | null;
  speed: number | null;
  acceleration: number | null;
  reduction_rate: number | null;
}) {
  const valid = (n: number | null) => n !== null && Number.isFinite(n);
  const parts = [
    {
      name: "销量升温",
      weight: 18,
      value: valid(input.speed)
        ? 18 *
          Math.min(1, Math.log1p(Math.max(0, input.speed!)) / Math.log(101))
        : null,
    },
    {
      name: "销售额增速（估算）",
      weight: 12,
      value:
        valid(input.speed) &&
        Number.isSafeInteger(input.price_fen) &&
        input.price_fen! > 0
          ? 12 *
            Math.min(
              1,
              Math.log1p(Math.max(0, input.speed!) * (input.price_fen! / 100)) /
                Math.log(10001),
            )
          : null,
    },
    {
      name: "增长加快",
      weight: 15,
      value: valid(input.acceleration)
        ? 15 * Math.min(1, Math.max(0, input.acceleration!) / 10)
        : null,
    },
    {
      name: "较上次降价",
      weight: 10,
      value: valid(input.reduction_rate)
        ? 10 * Math.min(1, Math.max(0, input.reduction_rate!) / 0.3)
        : null,
    },
    {
      name: "原价折扣",
      weight: 25,
      value:
        input.discount_rate != null &&
        Number.isFinite(input.discount_rate) &&
        input.discount_rate >= 0 &&
        input.discount_rate < 1
          ? 25 * Math.min(1, input.discount_rate / 0.5)
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
    {
      name: "新上券",
      weight: 10,
      value: input.is_new === undefined ? null : input.is_new ? 10 : 0,
    },
  ].map((x) => ({
    ...x,
    value: x.value === null ? null : Math.round(x.value * 10) / 10,
  }));
  const raw_score =
    Math.round(parts.reduce((n, x) => n + (x.value ?? 0), 0) * 10) / 10;
  const hasDiscount =
    input.discount_rate != null &&
    Number.isFinite(input.discount_rate) &&
    input.discount_rate >= 0 &&
    input.discount_rate < 1;
  const hasReduction =
    valid(input.reduction_rate) &&
    input.reduction_rate! >= 0 &&
    input.reduction_rate! <= 1;
  // A known weak current discount cannot be rescued by historical price movement.
  const rate = hasDiscount
    ? input.discount_rate!
    : hasReduction
      ? input.reduction_rate!
      : null;
  const factor =
    rate === null ? 0 : Math.min(1, Math.round(rate * 1000000) / 1000000 / 0.2);
  const eligible = rate !== null && Math.round(rate * 1000000) >= 100000;
  const basis = hasDiscount ? "相对平台原价" : "相对上次售价（原价折扣缺失）";
  const reason =
    rate === null
      ? "优惠证据不足，暂不进入优先券"
      : `${basis}优惠 ${(rate * 100).toFixed(1)}%；${eligible ? "达到基础优惠评分门槛，优先券另需满足质量与增长条件" : "不足10%，不进入优先券"}；优惠不足20%时按比例降低总分`;
  const coverage = parts.reduce(
    (n, x) => n + (x.value === null ? 0 : x.weight),
    0,
  );
  // Only compensate incomplete history when both price value and actual movement exist.
  // At most 25% uplift; unknown evidence can never produce a perfect score.
  const evidence_factor =
    hasDiscount && valid(input.speed) ? 100 / Math.max(80, coverage) : 1;
  const title = input.title ?? "";
  const voucher = /代金券/.test(title);
  const stackable =
    voucher &&
    !/(?:不|不可|不能|禁止|无法|仅限|限用).{0,4}叠加/.test(title) &&
    /(?:叠加\s*(?:[2-9]|[1-9]\d+|[二两三四五六七八九十]+)\s*张|(?:[2-9]|[二两三四五六七八九十]+)张.{0,3}叠加)/.test(
      title,
    );
  const selling_points = [
    {
      name: "代金券折扣分加成（1.3倍）",
      value: voucher
        ? Math.round(
            (parts.find((x) => x.name === "原价折扣")?.value ?? 0) * 0.3 * 100,
          ) / 100
        : 0,
    },
    { name: "明确支持多张叠加", value: stackable ? 6 : 0 },
  ];
  const selling_score = selling_points.reduce((n, x) => n + x.value, 0);
  const adjusted_score = Math.min(
    100,
    raw_score * evidence_factor + selling_score,
  );
  return {
    version: "priority-v8",
    evidence_factor,
    selling_points,
    adjusted_score: Math.round(adjusted_score * 10) / 10,
    raw_score,
    value_gate: { rate, factor, eligible, reason },
    score: Math.round(adjusted_score * factor * 10) / 10,
    coverage: parts.reduce((n, x) => n + (x.value === null ? 0 : x.weight), 0),
    parts,
    missing: parts.filter((x) => x.value === null).map((x) => x.name),
  };
}
