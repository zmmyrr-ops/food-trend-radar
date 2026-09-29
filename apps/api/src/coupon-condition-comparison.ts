import type { PGlite } from "@electric-sql/pglite";
import { conditionRisks } from "./condition-risks.js";
import { assessCoupon } from "./coupon-evidence.js";
import type { Coupon } from "./coupons.js";
import { increasedQuantities } from "./package-quantity.js";
import {
  type Group,
  type RuleText,
  ruleChanges,
  ruleDifferences,
} from "./rule-structure.js";

type Evidence<T> = { observed_at: string; payload: T };
type Rules = { status: string; groups: Group[]; rules: RuleText[] };
type Stores = {
  complete: boolean;
  reported_count: number;
  stores: { poi_id: string; shanghai: boolean }[];
};
export type ConditionSnapshot = {
  run_id: string;
  observed_at: string;
  payload: Coupon;
  rules: Evidence<Rules> | null;
  stores: Evidence<Stores> | null;
};
const horizon = 36 * 3600000;
export function compareConditions(
  current: ConditionSnapshot,
  previous: ConditionSnapshot | null,
  baselineStatus: string,
  now = Date.now(),
) {
  const usable = (s: ConditionSnapshot, e: Evidence<unknown> | null) => {
    const itemAt = Date.parse(s.observed_at),
      at = Date.parse(e?.observed_at ?? "");
    return (
      !!e &&
      Number.isFinite(at) &&
      Number.isFinite(itemAt) &&
      at >= itemAt &&
      at <= now &&
      (s !== previous || at <= Date.parse(current.observed_at)) &&
      at - itemAt <= horizon
    );
  };
  const fresh =
    now >= Date.parse(current.observed_at) &&
    now - Date.parse(current.observed_at) <= horizon;
  const paired =
    baselineStatus === "COMPARABLE" &&
    !!previous &&
    current.payload.product_id === previous.payload.product_id &&
    Date.parse(previous.observed_at) <= Date.parse(current.observed_at);
  const rulesReady = (s: ConditionSnapshot) =>
    usable(s, s.rules) &&
    s.rules?.payload.status === "received" &&
    !!s.rules.payload.groups.length &&
    !!s.rules.payload.rules.length;
  const storesReady = (s: ConditionSnapshot) => {
    const p = s.stores?.payload;
    return (
      usable(s, s.stores) &&
      !!p?.complete &&
      p.reported_count > 0 &&
      p.stores.length === p.reported_count &&
      new Set(p.stores.map((x) => x.poi_id)).size === p.reported_count
    );
  };
  const textReady = (s: ConditionSnapshot) =>
    usable(s, s.rules) &&
    !!s.rules?.payload.rules.some((r) =>
      r.value.some((v) => v.content.trim().length > 0),
    );
  const textsPaired = paired && textReady(current) && textReady(previous!);
  const rulesPaired = paired && rulesReady(current) && rulesReady(previous!);
  const forComparison = (s: ConditionSnapshot) => ({
    rules: s.rules!.payload.rules,
    groups: rulesPaired ? s.rules!.payload.groups : [],
  });
  const changes = textsPaired
    ? ruleChanges(forComparison(current), forComparison(previous!)).changes
    : [];
  const restrictions = textsPaired
    ? conditionRisks(
        previous!.rules!.payload.rules,
        current.rules!.payload.rules,
      )
    : null;
  const storesPaired = paired && storesReady(current) && storesReady(previous!);
  const beforeIds = new Set(
    storesPaired ? previous!.stores!.payload.stores.map((x) => x.poi_id) : [],
  );
  const afterIds = new Set(
    storesPaired ? current.stores!.payload.stores.map((x) => x.poi_id) : [],
  );
  const added = storesPaired
    ? [...afterIds].filter((id) => !beforeIds.has(id)).sort()
    : [];
  const removed = storesPaired
    ? [...beforeIds].filter((id) => !afterIds.has(id)).sort()
    : [];
  const price = assessCoupon(
    current.payload,
    paired ? previous!.payload : null,
  );
  const blockers = [
    "品牌映射仍需核验",
    "资格、附加费用与自然语言例外尚未完整核验",
  ];
  if (restrictions) blockers.push(...restrictions.risks.map((x) => x.message));
  if (!fresh) blockers.push("当前券快照已过期或时间异常");
  if (!paired) blockers.push(`缺少可比较的上一轮券记录（${baselineStatus}）`);
  if (!rulesReady(current))
    blockers.push("本轮套餐和规则缺失、不完整或采集时间不合格");
  if (!storesReady(current))
    blockers.push("本轮完整门店证据缺失或采集时间不合格");
  if (paired && !rulesReady(previous!))
    blockers.push("上一轮套餐和规则证据不足");
  if (paired && !storesReady(previous!))
    blockers.push("上一轮完整门店证据不足");
  if (changes.length) blockers.push(`返回条件发生变化：${changes.join("、")}`);
  if (added.length || removed.length)
    blockers.push(
      `门店范围变化：新增 ${added.length} 家，减少 ${removed.length} 家`,
    );
  if (price.changed_fields.length)
    blockers.push(`券字段变化：${price.changed_fields.join("、")}`);
  const sameReturned =
    !restrictions?.conflicting &&
    rulesPaired &&
    storesPaired &&
    !changes.length &&
    !added.length &&
    !removed.length &&
    !price.changed_fields.length;
  const quantityChanges =
    !restrictions?.conflicting &&
    fresh &&
    rulesPaired &&
    storesPaired &&
    !added.length &&
    !removed.length &&
    !price.changed_fields.length &&
    price.price_direction === "same" &&
    changes.every((x) => x === "套餐内容或数量")
      ? increasedQuantities(
          previous!.rules!.payload.groups,
          current.rules!.payload.groups,
        )
      : [];
  return {
    version: "condition-comparison-v3",
    condition_risks: restrictions?.risks ?? [],
    coupon_differences: price.field_differences,
    quantity_changes: quantityChanges,
    rule_differences: textsPaired
      ? ruleDifferences(forComparison(current), forComparison(previous!))
      : [],
    baseline_status: baselineStatus,
    current_run_id: current.run_id,
    previous_run_id: previous?.run_id ?? null,
    current_observed_at: current.observed_at,
    previous_observed_at: previous?.observed_at ?? null,
    evidence_times: {
      current_rules: current.rules?.observed_at ?? null,
      current_stores: current.stores?.observed_at ?? null,
      previous_rules: previous?.rules?.observed_at ?? null,
      previous_stores: previous?.stores?.observed_at ?? null,
    },
    current_evidence: {
      fresh,
      rules_ready: rulesReady(current),
      rule_text_ready: textReady(current),
      stores_ready: storesReady(current),
      shanghai_count: storesReady(current)
        ? current.stores!.payload.stores.filter((x) => x.shanghai).length
        : null,
    },
    rules: {
      scope: rulesPaired
        ? "package_and_text"
        : textsPaired
          ? "text_only"
          : "unavailable",
      status: textsPaired
        ? changes.length
          ? "changed"
          : rulesPaired
            ? "same_returned_conditions"
            : "same_returned_text"
        : "unknown",
      changes,
    },
    stores: {
      status: storesPaired
        ? added.length || removed.length
          ? "changed"
          : "same"
        : "unknown",
      added_ids: added,
      removed_ids: removed,
    },
    price: {
      direction: price.price_direction,
      delta_fen: price.delta_fen,
      reduction_rate: price.reduction_rate,
    },
    signal:
      fresh && sameReturned && price.price_direction === "lower"
        ? "price_drop_same_returned_conditions"
        : fresh && paired && price.price_direction === "lower"
          ? "price_drop_conditions_unverified"
          : quantityChanges.length
            ? "listed_quantity_increase_same_price"
            : "no_confirmed_improvement",
    value_verdict: "unverified",
    blockers,
  };
}
export async function readConditionComparison(
  db: PGlite,
  product: string,
  brand: string,
  now = Date.now(),
) {
  // Follow the recorded baseline link, never substitute the latest independently collected rules/stores.
  const task = (
    await db.query<{
      run_id: string;
      previous_run_id: string | null;
      comparison_status: string;
    }>(
      "SELECT t.run_id,t.previous_run_id,t.comparison_status FROM coupon_baselines b JOIN coupon_tasks t ON t.run_id=b.run_id AND t.brand_id=b.brand_id WHERE b.brand_id=$1 AND t.state='complete'",
      [brand],
    )
  ).rows[0];
  if (!task) return null;
  async function snapshot(run: string): Promise<ConditionSnapshot | null> {
    const row = (
      await db.query<{ run_id: string; observed_at: string; payload: Coupon }>(
        "SELECT run_id,observed_at,payload FROM coupon_items WHERE run_id=$1 AND brand_id=$2 AND product_id=$3",
        [run, brand, product],
      )
    ).rows[0];
    if (!row) return null;
    const rules =
      (
        await db.query<Evidence<Rules>>(
          "SELECT observed_at,payload FROM coupon_rule_snapshots WHERE run_id=$1 AND product_id=$2",
          [run, product],
        )
      ).rows[0] ?? null;
    const stores =
      (
        await db.query<Evidence<Stores>>(
          "SELECT observed_at,payload FROM coupon_store_snapshots WHERE run_id=$1 AND product_id=$2",
          [run, product],
        )
      ).rows[0] ?? null;
    return { ...row, rules, stores };
  }
  const current = await snapshot(task.run_id);
  if (!current) return null;
  return compareConditions(
    current,
    task.previous_run_id ? await snapshot(task.previous_run_id) : null,
    task.comparison_status,
    now,
  );
}
