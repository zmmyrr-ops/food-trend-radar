import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { conditionRisks } from "./condition-risks.js";
import type { ConditionSnapshot } from "./coupon-condition-comparison.js";
import { couponUseOutlook } from "./coupon-use-outlook.js";
import type { Group, RuleText } from "./rule-structure.js";

type Entry = {
  brand_id: string;
  brand_name: string;
  side: "current" | "previous";
  snapshot: ConditionSnapshot;
};
const normalize = (s: string) =>
  s.normalize("NFKC").replace(/\s+/g, " ").trim();
export function returnedPackageKey(groups: Group[], rules: RuleText[]) {
  if (
    conditionRisks(rules, rules).conflicting ||
    !groups.length ||
    !rules.some((r) => r.value.some((v) => v.content.trim()))
  )
    return null;
  const packages: string[] = [];
  for (const g of groups) {
    if (
      !g.item_list.length ||
      ((g.option_count != null || g.total_count != null) &&
        (g.option_count == null ||
          g.total_count == null ||
          g.option_count !== g.total_count ||
          g.option_count <= 0))
    )
      return null;
    const items: string[] = [];
    for (const i of g.item_list) {
      if (
        !i.name.trim() ||
        !i.unit?.trim() ||
        i.count == null ||
        !Number.isFinite(i.count) ||
        i.count <= 0
      )
        return null;
      items.push(
        JSON.stringify([normalize(i.name), normalize(i.unit), i.count]),
      );
    }
    if (new Set(items).size !== items.length) return null;
    packages.push(
      JSON.stringify([
        normalize(g.group_name ?? ""),
        g.option_count ?? null,
        g.total_count ?? null,
        items.sort(),
      ]),
    );
  }
  const keys = [...new Set(rules.map((r) => r.key))].sort();
  const texts = keys.map((k) => [
    k,
    [
      ...new Set(
        rules
          .filter((r) => r.key === k)
          .flatMap((r) => r.value.map((v) => normalize(v.content))),
      ),
    ].sort(),
  ]);
  return createHash("sha256")
    .update(JSON.stringify([packages.sort(), texts]))
    .digest("hex");
}
const horizon = 36 * 3600000;
function evidenceWithin(
  s: ConditionSnapshot,
  kind: "rules" | "stores",
  until: number,
) {
  const time = Date.parse(s[kind]?.observed_at ?? ""),
    priceTime = Date.parse(s.observed_at);
  return (
    Number.isFinite(time) &&
    time >= priceTime &&
    time <= until &&
    time - priceTime <= horizon
  );
}
function fixedPrice(s: ConditionSnapshot) {
  const p = s.payload;
  return (
    p.identity === "name_match" &&
    p.price_min_fen !== null &&
    Number.isSafeInteger(p.price_min_fen) &&
    p.price_min_fen > 0 &&
    p.price_min_fen === p.price_max_fen
  );
}
function storeIds(s: ConditionSnapshot, until: number) {
  const p = s.stores?.payload;
  if (
    !p?.complete ||
    !evidenceWithin(s, "stores", until) ||
    p.reported_count <= 0 ||
    p.stores.length !== p.reported_count ||
    new Set(p.stores.map((x) => x.poi_id)).size !== p.reported_count
  )
    return null;
  return p.stores
    .map((x) => x.poi_id)
    .sort()
    .join(",");
}
export function crossCouponMatches(entries: Entry[], now = Date.now()) {
  const keyCache = new Map<ConditionSnapshot, string | null>();
  const key = (s: ConditionSnapshot) => {
    if (!keyCache.has(s))
      keyCache.set(
        s,
        s.rules
          ? returnedPackageKey(s.rules.payload.groups, s.rules.payload.rules)
          : null,
      );
    return keyCache.get(s)!;
  };
  const previous = new Map<string, Entry[]>();
  for (const e of entries.filter((e) => e.side === "previous")) {
    const bucket = previous.get(e.brand_id) ?? [];
    bucket.push(e);
    previous.set(e.brand_id, bucket);
  }
  const results = [];
  for (const e of entries.filter((e) => e.side === "current")) {
    const s = e.snapshot,
      at = Date.parse(s.observed_at),
      prior = previous.get(e.brand_id) ?? [];
    if (
      !Number.isFinite(at) ||
      at > now ||
      now - at > horizon ||
      !fixedPrice(s) ||
      prior.some(
        (p) => p.snapshot.payload.product_id === s.payload.product_id,
      ) ||
      s.rules?.payload.status !== "received" ||
      !evidenceWithin(s, "rules", now)
    )
      continue;
    const signature = key(s);
    if (!signature) continue;
    const comparable = prior
      .filter(({ snapshot: old }) => {
        const before = Date.parse(old.observed_at);
        if (
          // Generic package rows can omit size, audience or fulfilment details.
          // Require the complete normalized title as well; do not strip marketing text.
          !normalize(s.payload.name) ||
          normalize(old.payload.name) !== normalize(s.payload.name) ||
          !s.payload.platform_brand_id ||
          old.payload.platform_brand_id !== s.payload.platform_brand_id ||
          !fixedPrice(old) ||
          !Number.isFinite(before) ||
          before > at ||
          at - before > horizon ||
          old.rules?.payload.status !== "received" ||
          !evidenceWithin(old, "rules", at)
        )
          return false;
        if (key(old) !== signature) return false;
        const oldStores = storeIds(old, at),
          newStores = storeIds(s, now);
        return !oldStores || !newStores || oldStores === newStores;
      })
      .sort(
        (a, b) =>
          a.snapshot.payload.price_min_fen! -
            b.snapshot.payload.price_min_fen! ||
          a.snapshot.payload.product_id.localeCompare(
            b.snapshot.payload.product_id,
          ),
      );
    const old = comparable[0]?.snapshot;
    if (!old || s.payload.price_min_fen! >= old.payload.price_min_fen!)
      continue;
    const sameStores =
      storeIds(old, at) !== null && storeIds(old, at) === storeIds(s, now);
    results.push({
      use_outlook: couponUseOutlook(
        {
          price_observed_at: s.observed_at,
          rules_observed_at: s.rules.observed_at,
          rules: s.rules.payload.rules,
        },
        now,
      ),
      brand_id: e.brand_id,
      brand_name: e.brand_name,
      product_id: s.payload.product_id,
      previous_product_id: old.payload.product_id,
      run_id: s.run_id,
      previous_run_id: old.run_id,
      title: s.payload.name,
      previous_title: old.payload.name,
      current_price_fen: s.payload.price_min_fen!,
      previous_price_fen: old.payload.price_min_fen!,
      saving_fen: old.payload.price_min_fen! - s.payload.price_min_fen!,
      reduction_rate:
        (old.payload.price_min_fen! - s.payload.price_min_fen!) /
        old.payload.price_min_fen!,
      observed_at: s.observed_at,
      previous_observed_at: old.observed_at,
      signature,
      groups: s.rules.payload.groups,
      reference_count: comparable.length,
      store_status: sameStores ? "same_returned_stores" : "unknown",
      evidence_times: {
        current_rules: s.rules.observed_at,
        previous_rules: old.rules!.observed_at,
      },
      reason:
        "不同券 ID，商品标题、列示套餐数量、单位和已返回条款相同；相对上轮同组最低票面价更低",
      caveat:
        "仅为跨券比价线索，不证明替换上架或完整权益相同；品牌归属、资格费用及完整适用门店仍待核验。",
    });
  }
  return results.sort(
    (a, b) =>
      b.reduction_rate - a.reduction_rate ||
      b.saving_fen - a.saving_fen ||
      a.product_id.localeCompare(b.product_id),
  );
}
export async function crossCouponOpportunities(db: PGlite, now = Date.now()) {
  const entries = (
    await db.query<Entry>(`WITH platform_brands AS MATERIALIZED (
      SELECT DISTINCT i.brand_id,i.payload->>'platform_brand_id' AS platform_id
      FROM coupon_items i JOIN coupon_baselines b ON b.brand_id=i.brand_id AND b.run_id=i.run_id
      JOIN brands br ON br.id=i.brand_id AND br.active
      WHERE i.payload->>'identity'='name_match' AND coalesce(i.payload->>'platform_brand_id','')<>''
    ), conflicts AS MATERIALIZED (
      SELECT platform_id FROM platform_brands GROUP BY platform_id HAVING count(DISTINCT brand_id)>1
    ), base AS (
    SELECT b.brand_id,b.run_id,t.previous_run_id,br.name AS brand_name
    FROM coupon_baselines b JOIN brands br ON br.id=b.brand_id AND br.active
    JOIN coupon_tasks t ON t.run_id=b.run_id AND t.brand_id=b.brand_id AND t.state='complete' AND t.comparison_status='COMPARABLE' AND t.completed_at BETWEEN now()-interval '36 hours' AND now()
  ), versions AS (
    SELECT brand_id,brand_name,run_id,'current' AS side FROM base
    UNION ALL SELECT brand_id,brand_name,previous_run_id,'previous' AS side FROM base
  ) SELECT v.brand_id,v.brand_name,v.side,jsonb_build_object('run_id',i.run_id,'observed_at',i.observed_at,'payload',i.payload,
    'rules',CASE WHEN r.product_id IS NULL THEN NULL ELSE jsonb_build_object('observed_at',r.observed_at,'payload',r.payload) END,
    'stores',CASE WHEN s.product_id IS NULL THEN NULL ELSE jsonb_build_object('observed_at',s.observed_at,'payload',s.payload) END) AS snapshot
    FROM versions v JOIN coupon_tasks t ON t.brand_id=v.brand_id AND t.run_id=v.run_id AND t.state='complete'
    JOIN coupon_items i ON i.brand_id=v.brand_id AND i.run_id=v.run_id
    LEFT JOIN coupon_rule_snapshots r ON r.run_id=i.run_id AND r.product_id=i.product_id
    LEFT JOIN coupon_store_snapshots s ON s.run_id=i.run_id AND s.product_id=i.product_id
    WHERE i.payload->>'identity'='name_match' AND coalesce(i.payload->>'platform_brand_id','') NOT IN(SELECT platform_id FROM conflicts)`)
  ).rows;
  return crossCouponMatches(entries, now);
}
