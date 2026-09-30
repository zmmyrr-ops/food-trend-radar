import type { PGlite } from "@electric-sql/pglite";

/** Current brand baseline only. Never substitute a newer unrelated run or older snapshot. */
export async function currentCouponDetail(
  db: PGlite,
  brand: string,
  product: string,
  kind: "rules" | "stores",
  now = Date.now(),
) {
  const row = (
    await db.query<{
      run_id: string;
      observed_at: string | null;
      payload: { poi_name?: string; address?: string } | null;
    }>(
      `SELECT b.run_id,i.observed_at,i.payload FROM coupon_baselines b JOIN coupon_tasks t ON t.run_id=b.run_id AND t.brand_id=b.brand_id AND t.state='complete' LEFT JOIN coupon_items i ON i.run_id=b.run_id AND i.brand_id=b.brand_id AND i.product_id=$2 WHERE b.brand_id=$1`,
      [brand, product],
    )
  ).rows[0];
  const at = Date.parse(row?.observed_at ?? "");
  const status = !row
    ? "no_baseline"
    : !row.observed_at
      ? "not_in_baseline"
      : !Number.isFinite(at) || at > now || now - at > 36 * 3600000
        ? "stale"
        : "current";
  const context = {
    scope: "brand_current_baseline",
    brand_id: brand,
    run_id: row?.run_id ?? null,
    price_observed_at: row?.observed_at ?? null,
    status,
  };
  const source_shop =
    kind === "stores" && row?.payload?.poi_name
      ? {
          name: row.payload.poi_name,
          address: row.payload.address || "",
          observed_at: row.observed_at,
          semantics: "platform_nearest_poi",
        }
      : null;
  if (status !== "current")
    return { context, source_shop, items: [], tasks: [] };
  const snapshots =
    kind === "rules" ? "coupon_rule_snapshots" : "coupon_store_snapshots";
  const taskTable =
    kind === "rules" ? "coupon_rule_tasks" : "coupon_store_tasks";
  const items = (
    await db.query<{
      run_id: string;
      observed_at: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT run_id,observed_at,payload FROM ${snapshots} WHERE run_id=$1 AND product_id=$2 AND observed_at>=$3 AND observed_at<=$4 AND observed_at<=$3::timestamptz+interval '36 hours'`,
      [row!.run_id, product, row!.observed_at, new Date(now).toISOString()],
    )
  ).rows;
  const tasks = (
    await db.query(
      `SELECT state,error_code${kind === "stores" ? ",scope,cursor" : ""} FROM ${taskTable} WHERE run_id=$1 AND product_id=$2`,
      [row!.run_id, product],
    )
  ).rows;
  return { context, source_shop, items, tasks };
}
