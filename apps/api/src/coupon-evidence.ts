import type { Coupon } from "./coupons.js";

/** Title clues are not redemption rules and never grant eligibility. */
export function titleClues(title: string) {
  return [
    ["新客", /新客|首单|首次购买/],
    ["会员", /会员/],
    ["时段限制", /工作日|周一至周五|午市|晚市|限时段/],
    ["节假日限制", /节假日.*(?:不可|不适用|除外)/],
    ["附加费用", /加价|补差|另付|服务费/],
    ["预约", /预约/],
  ]
    .filter(([, re]) => (re as RegExp).test(title))
    .map(([label]) => String(label));
}

export function assessCoupon(
  current: Coupon,
  old: Coupon | null,
  identityConflict = false,
) {
  const reasons: string[] = [];
  if (identityConflict)
    reasons.push("平台品牌 ID 同时对应多个候选品牌，归属冲突");
  else if (current.identity !== "name_match")
    reasons.push("平台品牌名称与检索品牌不匹配或缺失");
  else reasons.push("仅有品牌名称匹配线索，尚未核验品牌映射");
  if (current.city_evidence !== "上海市")
    reasons.push("缺少关联门店位于上海的明确来源字段");
  reasons.push("全部适用门店、核销期限、资格与附加费用尚未取得");
  const changed: string[] = [];
  const fieldDifferences: {
    field: string;
    label: string;
    before: string | null;
    after: string | null;
  }[] = [];
  if (old) {
    for (const [key, label] of [
      ["name", "商品名称"],
      ["poi_id", "关联门店"],
      ["platform_brand_id", "平台品牌 ID"],
      ["sale_end", "销售截止时间"],
      ["status", "平台状态"],
    ] as const)
      if (old[key] !== current[key]) {
        changed.push(label);
        fieldDifferences.push({
          field: key,
          label,
          before: old[key] == null ? null : String(old[key]),
          after: current[key] == null ? null : String(current[key]),
        });
      }
  }
  let priceDirection = "unknown";
  let deltaFen: number | null = null;
  let reductionRate: number | null = null;
  if (old) {
    const values = [
      old.price_min_fen,
      old.price_max_fen,
      current.price_min_fen,
      current.price_max_fen,
    ];
    if (values.every((v) => v !== null && Number.isSafeInteger(v) && v >= 0)) {
      if (
        old.price_min_fen === old.price_max_fen &&
        current.price_min_fen === current.price_max_fen
      ) {
        deltaFen =
          (current.price_min_fen as number) - (old.price_min_fen as number);
        priceDirection =
          deltaFen < 0 ? "lower" : deltaFen > 0 ? "higher" : "same";
        if ((old.price_min_fen as number) > 0)
          reductionRate = -deltaFen / (old.price_min_fen as number);
      } else priceDirection = "range_not_comparable";
    }
  }
  if (changed.length)
    reasons.push(`同时变化：${changed.join("、")}，不能认定同规格`);
  const clues = titleClues(current.name);
  if (clues.length) reasons.push(`标题提示：${clues.join("、")}（待详情核验）`);
  return {
    version: "evidence-v1",
    identity_conflict: identityConflict,
    city_status:
      current.city_evidence === "上海市"
        ? "associated_poi_shanghai"
        : "unknown",
    price_direction: priceDirection,
    delta_fen: deltaFen,
    reduction_rate: reductionRate,
    changed_fields: changed,
    field_differences: fieldDifferences,
    title_clues: clues,
    reasons,
    value_verdict: "unverified",
    same_price_better: null,
  };
}
