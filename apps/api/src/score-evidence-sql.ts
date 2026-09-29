/** Fixed aliases shared by readers; compare stored evidence versions, not scoring age. */
export const scoreEvidenceJoins = `
LEFT JOIN coupon_items prior ON prior.run_id=t.previous_run_id AND prior.brand_id=i.brand_id AND prior.product_id=i.product_id
LEFT JOIN coupon_rule_snapshots rule_now ON rule_now.run_id=i.run_id AND rule_now.product_id=i.product_id
LEFT JOIN coupon_store_snapshots store_now ON store_now.run_id=i.run_id AND store_now.product_id=i.product_id
LEFT JOIN coupon_rule_snapshots rule_before ON rule_before.run_id=prior.run_id AND rule_before.product_id=i.product_id
LEFT JOIN coupon_store_snapshots store_before ON store_before.run_id=prior.run_id AND store_before.product_id=i.product_id`;

// PGlite JSON timestamps have millisecond precision. Missing evidence must equal NULL,
// so a deletion also invalidates the cached score instead of keeping old proof alive.
export const scoreEvidenceMatches = `
  h.payload->'score'->>'version'='V4.2.sales-evidence'
  AND h.payload->'evidence'->>'baseline_status'=t.comparison_status
  AND (h.payload->'evidence'->>'previous_run_id') IS NOT DISTINCT FROM prior.run_id::text
  AND ${[
    ["current_observed_at", "i.observed_at"],
    ["previous_observed_at", "prior.observed_at"],
    ["evidence_times,current_rules", "rule_now.observed_at"],
    ["evidence_times,current_stores", "store_now.observed_at"],
    ["evidence_times,previous_rules", "rule_before.observed_at"],
    ["evidence_times,previous_stores", "store_before.observed_at"],
  ]
    .map(
      ([path, column]) =>
        `date_trunc('milliseconds',(h.payload#>>'{evidence,${path}}')::timestamptz) IS NOT DISTINCT FROM date_trunc('milliseconds',${column})`,
    )
    .join(" AND ")}`;
