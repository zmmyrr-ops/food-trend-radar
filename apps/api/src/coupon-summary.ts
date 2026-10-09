import type { PGlite } from "@electric-sql/pglite";
import { saleDeadline } from "./coupon-pool.js";
export async function readCouponSummary(
  db: Pick<PGlite, "query">,
  brand: string,
  id: string,
) {
  const row = (
    await db.query<any>(
      `SELECT b.name AS brand_name,b.icon_url,i.payload,i.observed_at,
    t.state AS baseline_state,
    EXISTS(SELECT 1 FROM coupon_items c WHERE c.brand_id=$1 AND c.product_id=$2 AND c.run_id=cb.run_id) AS in_latest
    FROM (SELECT payload,observed_at FROM coupon_known_items WHERE brand_id=$1 AND product_id=$2
      UNION ALL SELECT payload,observed_at FROM coupon_items WHERE brand_id=$1 AND product_id=$2) i
    JOIN brands b ON b.id=$1 LEFT JOIN coupon_baselines cb ON cb.brand_id=b.id
    LEFT JOIN coupon_tasks t ON t.brand_id=b.id AND t.run_id=cb.run_id
    WHERE i.payload->>'identity'='name_match' ORDER BY i.observed_at DESC LIMIT 1`,
      [brand, id],
    )
  ).rows[0];
  if (!row) return null;
  const p = row.payload,
    end = saleDeadline(
      String(p.sale_end ?? "")
        .replace(/^(\d{4})\.(\d{2})\.(\d{2})/, "$1-$2-$3")
        .replace(/( \d{2}:\d{2})$/, "$1:00"),
    );
  const availability =
    end && Date.parse(end) <= Date.now()
      ? "expired"
      : row.baseline_state === "complete" && !row.in_latest
        ? "unavailable"
        : "available";
  return {
    brand_name: row.brand_name,
    icon_url: row.icon_url,
    title: p.name,
    price_fen: p.price_min_fen,
    origin_price_fen: p.origin_price_fen,
    shop_name: p.poi_name,
    address: p.address,
    sale_end: p.sale_end,
    availability,
    availability_message:
      availability === "expired"
        ? "该券已失效（已过销售截止时间）"
        : availability === "unavailable"
          ? "该券当前已不在售券列表，可能已下架或失效。以下为历史券信息。"
          : null,
  };
}
