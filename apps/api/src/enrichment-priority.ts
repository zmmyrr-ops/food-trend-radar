/** Preserve one ordinary queue turn in four, so changing coupons cannot starve baseline collection. */
export function enrichmentQuery(
  table: "coupon_rule_tasks" | "coupon_store_tasks",
  prioritize: boolean,
) {
  return `SELECT t.* FROM ${table} t
    LEFT JOIN coupon_diffs d ON d.run_id=t.run_id AND d.brand_id=t.brand_id AND d.product_id=t.product_id
    WHERE t.state='queued'
    ORDER BY CASE WHEN t.retry_at>now() THEN 1 ELSE 0 END, ${
      prioritize
        ? `CASE
      WHEN d.kind='PRICE_CHANGED_UNVERIFIED' AND (d.new_payload->>'price_min_fen')::bigint=(d.new_payload->>'price_max_fen')::bigint AND (d.old_payload->>'price_min_fen')::bigint=(d.old_payload->>'price_max_fen')::bigint AND (d.new_payload->>'price_min_fen')::bigint<(d.old_payload->>'price_min_fen')::bigint THEN 0
      WHEN d.kind='NEW_OBSERVED' AND NOT EXISTS(SELECT 1 FROM coupon_catalog c WHERE c.brand_id=t.brand_id AND c.product_id=t.product_id AND c.run_id<>t.run_id) AND NOT EXISTS(SELECT 1 FROM coupon_items prior JOIN coupon_tasks pt ON pt.run_id=prior.run_id AND pt.brand_id=prior.brand_id AND pt.state='complete' WHERE prior.brand_id=t.brand_id AND prior.product_id=t.product_id AND prior.run_id<>t.run_id AND prior.observed_at<d.observed_at) THEN 1
      ELSE 3 END,`
        : ""
    }
      t.last_attempt_at NULLS FIRST,t.run_id,t.product_id LIMIT 1`;
}
