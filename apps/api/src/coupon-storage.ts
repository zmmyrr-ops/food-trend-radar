import type { PGlite, Transaction } from "@electric-sql/pglite";
import type { Express } from "express";
import { createSalesHeat } from "./sales-heat.js";

type DB = Pick<PGlite, "query" | "exec"> | Transaction;
export async function initCouponStorage(db: DB) {
  await db.exec(`
    ALTER TABLE coupon_tasks ADD COLUMN IF NOT EXISTS archived_recalled int;
    ALTER TABLE coupon_tasks ADD COLUMN IF NOT EXISTS archived_matched int;
    CREATE TABLE IF NOT EXISTS coupon_request_daily(day date NOT NULL,outcome text NOT NULL,requests bigint NOT NULL,PRIMARY KEY(day,outcome));
    CREATE TABLE IF NOT EXISTS coupon_storage_failures(brand_id uuid PRIMARY KEY,error text NOT NULL,attempted_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS coupon_catalog(brand_id uuid NOT NULL,product_id text NOT NULL,first_seen_at timestamptz NOT NULL,observed_at timestamptz NOT NULL,run_id uuid NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(brand_id,product_id));
    CREATE TABLE IF NOT EXISTS coupon_sales_points(brand_id uuid NOT NULL,product_id text NOT NULL,run_id uuid NOT NULL,observed_at timestamptz NOT NULL,task_at timestamptz NOT NULL,query_signature text,missing boolean NOT NULL DEFAULT false,payload jsonb NOT NULL,rules jsonb,PRIMARY KEY(brand_id,product_id,run_id));
    CREATE INDEX IF NOT EXISTS coupon_sales_points_time ON coupon_sales_points(brand_id,product_id,task_at DESC);
    CREATE TABLE IF NOT EXISTS coupon_change_history(brand_id uuid NOT NULL,product_id text NOT NULL,run_id uuid NOT NULL,kind text NOT NULL,observed_at timestamptz NOT NULL,old_payload jsonb,new_payload jsonb,PRIMARY KEY(brand_id,product_id,run_id));
    CREATE OR REPLACE VIEW coupon_history_items AS
      SELECT run_id,brand_id,product_id,payload,observed_at FROM coupon_items
      UNION ALL SELECT p.run_id,p.brand_id,p.product_id,p.payload,p.observed_at FROM coupon_sales_points p WHERE NOT EXISTS(SELECT 1 FROM coupon_items i WHERE i.run_id=p.run_id AND i.brand_id=p.brand_id AND i.product_id=p.product_id) AND NOT p.missing;
    CREATE OR REPLACE VIEW coupon_known_items AS
      SELECT brand_id,product_id,run_id,payload,observed_at FROM coupon_catalog
      UNION ALL SELECT i.brand_id,i.product_id,i.run_id,i.payload,i.observed_at FROM coupon_items i WHERE NOT EXISTS(SELECT 1 FROM coupon_catalog c WHERE c.brand_id=i.brand_id AND c.product_id=i.product_id);
    CREATE TABLE IF NOT EXISTS coupon_storage_migrations(brand_id uuid PRIMARY KEY,migrated_at timestamptz NOT NULL DEFAULT now(),last_compacted_at timestamptz);
  `);
}
/** Preserve the minimal sales evidence; never use wall clock time as the observation time. */
export async function captureCouponStorage(
  db: DB,
  brand: string,
  run?: string,
) {
  const args = [brand, run ?? null];
  await db.query(
    `INSERT INTO coupon_catalog
    SELECT DISTINCT ON(i.product_id) i.brand_id,i.product_id,
      min(i.observed_at) OVER(PARTITION BY i.product_id),i.observed_at,i.run_id,i.payload
    FROM coupon_items i JOIN coupon_tasks t ON t.run_id=i.run_id AND t.brand_id=i.brand_id
    WHERE i.brand_id=$1 AND t.state='complete' AND ($2::uuid IS NULL OR i.run_id=$2)
    ORDER BY i.product_id,i.observed_at DESC,i.run_id
    ON CONFLICT(brand_id,product_id) DO UPDATE SET
      first_seen_at=least(coupon_catalog.first_seen_at,excluded.first_seen_at),
      observed_at=greatest(coupon_catalog.observed_at,excluded.observed_at),
      run_id=CASE WHEN excluded.observed_at>=coupon_catalog.observed_at THEN excluded.run_id ELSE coupon_catalog.run_id END,
      payload=CASE WHEN excluded.observed_at>=coupon_catalog.observed_at THEN excluded.payload ELSE coupon_catalog.payload END`,
    args,
  );
  await db.query(
    `INSERT INTO coupon_sales_points
    SELECT i.brand_id,i.product_id,i.run_id,i.observed_at,coalesce(t.completed_at,i.observed_at),t.query_signature,false,
      jsonb_build_object('monthly_sales',i.payload->'monthly_sales','name',i.payload->'name','platform_brand_id',i.payload->'platform_brand_id','identity',i.payload->'identity','price_min_fen',i.payload->'price_min_fen','price_max_fen',i.payload->'price_max_fen','origin_price_fen',i.payload->'origin_price_fen'),
      CASE WHEN r.product_id IS NULL THEN NULL ELSE jsonb_build_object('observed_at',r.observed_at,'status',r.payload->>'status','commodity_fingerprint',r.payload->>'commodity_fingerprint','rule_fingerprint',r.payload->>'rule_fingerprint') END
    FROM coupon_items i JOIN coupon_tasks t ON t.run_id=i.run_id AND t.brand_id=i.brand_id
    LEFT JOIN coupon_rule_snapshots r ON r.run_id=i.run_id AND r.product_id=i.product_id
    WHERE i.brand_id=$1 AND t.state='complete' AND i.observed_at>now()-interval '30 days' AND ($2::uuid IS NULL OR i.run_id=$2)
    ON CONFLICT(brand_id,product_id,run_id) DO UPDATE SET rules=coalesce(excluded.rules,coupon_sales_points.rules)`,
    args,
  );
  await db.query(
    `INSERT INTO coupon_sales_points
    SELECT d.brand_id,d.product_id,d.run_id,coalesce(t.completed_at,d.observed_at),coalesce(t.completed_at,d.observed_at),t.query_signature,true,'{}',NULL
    FROM coupon_diffs d JOIN coupon_tasks t ON t.run_id=d.run_id AND t.brand_id=d.brand_id
    WHERE d.brand_id=$1 AND t.state='complete' AND d.kind='NOT_SEEN' AND d.observed_at>now()-interval '30 days' AND ($2::uuid IS NULL OR d.run_id=$2)
    ON CONFLICT DO NOTHING`,
    args,
  );
  await db.query(
    `INSERT INTO coupon_change_history SELECT brand_id,product_id,run_id,kind,observed_at,old_payload,new_payload FROM coupon_diffs
    WHERE brand_id=$1 AND kind NOT IN ('UNCHANGED','BASELINE','BASELINE_RESET') AND ($2::uuid IS NULL OR run_id=$2) ON CONFLICT DO NOTHING`,
    args,
  );
}
export async function compactCouponBrand(db: PGlite, brand: string) {
  return db.transaction(async (tx) => {
    const heat = createSalesHeat(tx as unknown as PGlite);
    const before = await heat.readBrand(brand);
    await captureCouponStorage(tx, brand);
    await tx.query(
      "INSERT INTO coupon_storage_migrations(brand_id) VALUES($1) ON CONFLICT DO NOTHING",
      [brand],
    );
    const after = await heat.readBrand(brand);
    const comparable = (rows: typeof before) =>
      JSON.stringify(
        rows
          .map((r) => ({
            id: r.product_id,
            price: r.price_fen,
            speed: r.speed,
            acceleration: r.acceleration,
            net: r.net_change,
            hours: r.hours,
            content: r.content_comparison,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
    if (comparable(before) !== comparable(after))
      throw new Error(`STORAGE_VALIDATION_FAILED:${brand}`);
    // Keep a boundary on each side of content, query, missing or sales-decrease changes.
    await tx.query(
      `WITH points AS (
      SELECT *,row_number() OVER w AS recent,
      lag(payload-'monthly_sales') OVER w IS DISTINCT FROM payload-'monthly_sales' OR
      lead(payload-'monthly_sales') OVER w IS DISTINCT FROM payload-'monthly_sales' OR
      lag(query_signature) OVER w IS DISTINCT FROM query_signature OR lead(query_signature) OVER w IS DISTINCT FROM query_signature OR
      lag(missing) OVER w IS DISTINCT FROM missing OR lead(missing) OVER w IS DISTINCT FROM missing OR
      lag(rules->>'commodity_fingerprint') OVER w IS DISTINCT FROM rules->>'commodity_fingerprint' OR
      lead(rules->>'commodity_fingerprint') OVER w IS DISTINCT FROM rules->>'commodity_fingerprint' OR
      lag(rules->>'rule_fingerprint') OVER w IS DISTINCT FROM rules->>'rule_fingerprint' OR
      lead(rules->>'rule_fingerprint') OVER w IS DISTINCT FROM rules->>'rule_fingerprint' OR
      coalesce(regexp_replace(payload->>'monthly_sales','[月售 ,]','','g'),'') !~ '^[0-9]+$' OR
      (CASE WHEN regexp_replace(payload->>'monthly_sales','[月售 ,]','','g') ~ '^[0-9]+$' THEN regexp_replace(payload->>'monthly_sales','[月售 ,]','','g')::numeric END) < (CASE WHEN regexp_replace(lead(payload->>'monthly_sales') OVER w,'[月售 ,]','','g') ~ '^[0-9]+$' THEN regexp_replace(lead(payload->>'monthly_sales') OVER w,'[月售 ,]','','g')::numeric END) OR
      (CASE WHEN regexp_replace(lag(payload->>'monthly_sales') OVER w,'[月售 ,]','','g') ~ '^[0-9]+$' THEN regexp_replace(lag(payload->>'monthly_sales') OVER w,'[月售 ,]','','g')::numeric END) < (CASE WHEN regexp_replace(payload->>'monthly_sales','[月售 ,]','','g') ~ '^[0-9]+$' THEN regexp_replace(payload->>'monthly_sales','[月售 ,]','','g')::numeric END) AS boundary,
      row_number() OVER(PARTITION BY product_id,date_trunc(CASE WHEN observed_at>now()-interval '72 hours' THEN 'hour' ELSE 'day' END,observed_at) ORDER BY observed_at DESC,run_id) AS bucket
      FROM coupon_sales_points WHERE brand_id=$1 WINDOW w AS (PARTITION BY product_id ORDER BY task_at DESC,run_id DESC)
    ) DELETE FROM coupon_sales_points p USING points x WHERE p.brand_id=x.brand_id AND p.product_id=x.product_id AND p.run_id=x.run_id
      AND (x.observed_at<now()-interval '30 days' OR (x.recent>16 AND NOT x.boundary AND x.bucket>1))`,
      [brand],
    );
    await tx.query(
      `UPDATE coupon_tasks t SET archived_recalled=v.recalled,archived_matched=v.matched FROM (SELECT run_id,count(*)::int AS recalled,count(*) FILTER(WHERE payload->>'identity'='name_match')::int AS matched FROM coupon_items WHERE brand_id=$1 GROUP BY run_id) v WHERE t.brand_id=$1 AND t.run_id=v.run_id AND t.state='complete' AND t.archived_recalled IS NULL`,
      [brand],
    );
    // Retain current + previous complete scan and in-progress scans.
    const deleted = await tx.query(
      `DELETE FROM coupon_items i USING coupon_tasks t WHERE i.brand_id=$1 AND t.brand_id=i.brand_id AND t.run_id=i.run_id AND t.state='complete'
      AND NOT EXISTS(SELECT 1 FROM coupon_baselines b JOIN coupon_tasks current ON current.run_id=b.run_id AND current.brand_id=b.brand_id WHERE b.brand_id=i.brand_id AND (i.run_id=b.run_id OR i.run_id=current.previous_run_id)) RETURNING i.product_id`,
      [brand],
    );
    await tx.query(
      `DELETE FROM coupon_diffs d WHERE d.brand_id=$1 AND EXISTS(SELECT 1 FROM coupon_tasks t WHERE t.brand_id=d.brand_id AND t.run_id=d.run_id AND t.state='complete')
      AND NOT EXISTS(SELECT 1 FROM coupon_baselines b JOIN coupon_tasks t ON t.run_id=b.run_id AND t.brand_id=b.brand_id WHERE b.brand_id=d.brand_id AND (d.run_id=b.run_id OR d.run_id=t.previous_run_id))`,
      [brand],
    );
    await tx.query(
      `INSERT INTO coupon_storage_migrations(brand_id,last_compacted_at) VALUES($1,now()) ON CONFLICT(brand_id) DO UPDATE SET last_compacted_at=now()`,
      [brand],
    );
    return deleted.rows.length;
  });
}
export async function compactFailedScans(db: PGlite) {
  return db.transaction(async (tx) => {
    const targets = (
      await tx.query(`SELECT t.run_id,t.brand_id FROM coupon_tasks t JOIN coupon_runs r ON r.id=t.run_id WHERE t.state='partial' AND r.status<>'running'
    AND EXISTS(SELECT 1 FROM coupon_items i WHERE i.run_id=t.run_id AND i.brand_id=t.brand_id)
    AND EXISTS(SELECT 1 FROM coupon_tasks n JOIN coupon_runs nr ON nr.id=n.run_id WHERE n.brand_id=t.brand_id AND n.state IN ('partial','complete') AND nr.started_at>r.started_at)
    ORDER BY r.started_at,t.brand_id LIMIT 100`)
    ).rows;
    if (!targets.length) return 0;
    const args = [JSON.stringify(targets)];
    await tx.query(
      `UPDATE coupon_tasks t SET archived_recalled=coalesce(t.archived_recalled,(SELECT count(*)::int FROM coupon_items i WHERE i.run_id=t.run_id AND i.brand_id=t.brand_id)),archived_matched=coalesce(t.archived_matched,(SELECT count(*)::int FROM coupon_items i WHERE i.run_id=t.run_id AND i.brand_id=t.brand_id AND i.payload->>'identity'='name_match')) FROM jsonb_to_recordset($1) AS d(run_id uuid,brand_id uuid) WHERE t.run_id=d.run_id AND t.brand_id=d.brand_id`,
      args,
    );
    const deleted = await tx.query(
      `DELETE FROM coupon_items i USING jsonb_to_recordset($1) AS d(run_id uuid,brand_id uuid) WHERE i.run_id=d.run_id AND i.brand_id=d.brand_id RETURNING i.product_id`,
      args,
    );
    return deleted.rows.length;
  });
}
export function createCouponStorageMaintenance(db: PGlite) {
  let active: Promise<unknown> | undefined;
  const run = () => {
    if (active) return active;
    active = (async () => {
      const brands = (
        await db.query<{ id: string }>(
          `SELECT b.id FROM brands b LEFT JOIN coupon_storage_migrations m ON m.brand_id=b.id WHERE EXISTS(SELECT 1 FROM coupon_baselines cb WHERE cb.brand_id=b.id) AND (m.last_compacted_at IS NULL OR m.last_compacted_at<now()-interval '1 hour') AND NOT EXISTS(SELECT 1 FROM coupon_storage_failures f WHERE f.brand_id=b.id AND f.attempted_at>now()-interval '1 hour') ORDER BY m.last_compacted_at NULLS FIRST,b.id LIMIT 10`,
        )
      ).rows;
      let removed = await compactFailedScans(db);
      for (const b of brands) {
        try {
          removed += await compactCouponBrand(db, b.id);
          await db.query(
            "DELETE FROM coupon_storage_failures WHERE brand_id=$1",
            [b.id],
          );
        } catch (error) {
          await db.query(
            "INSERT INTO coupon_storage_failures(brand_id,error) VALUES($1,$2) ON CONFLICT(brand_id) DO UPDATE SET error=excluded.error,attempted_at=now()",
            [b.id, String(error).slice(0, 200)],
          );
        }
      }
      await db.exec(`DELETE FROM coupon_pages p WHERE observed_at<now()-interval '7 days' AND EXISTS(SELECT 1 FROM coupon_tasks t WHERE t.run_id=p.run_id AND t.brand_id=p.brand_id AND t.state='complete');
        WITH deleted AS (DELETE FROM coupon_requests WHERE finished_at<now()-CASE WHEN outcome='OK' THEN interval '7 days' ELSE interval '30 days' END RETURNING finished_at,outcome)
        INSERT INTO coupon_request_daily SELECT (finished_at AT TIME ZONE 'Asia/Shanghai')::date,outcome,count(*) FROM deleted GROUP BY 1,2
        ON CONFLICT(day,outcome) DO UPDATE SET requests=coupon_request_daily.requests+excluded.requests;`);
      return { brands: brands.length, removed };
    })().finally(() => {
      active = undefined;
    });
    return active;
  };
  function register(app: Express) {
    app.post("/api/v3/storage/reclaim", async (_req, res) => {
      if (active) await active;
      await db.exec("VACUUM (FULL, ANALYZE) coupon_items");
      await db.exec("VACUUM (FULL, ANALYZE) coupon_diffs");
      await db.exec("CHECKPOINT");
      res.json({ ok: true });
    });
    app.post("/api/v3/storage/compact", async (_req, res) =>
      res.json(await run()),
    );
    app.get("/api/v3/storage/status", async (_req, res) =>
      res.json(
        (
          await db.query(
            `SELECT (SELECT count(*)::int FROM coupon_items) AS full_snapshots,(SELECT count(*)::int FROM coupon_catalog) AS catalog,(SELECT count(*)::int FROM coupon_sales_points) AS sales_points,(SELECT count(*)::int FROM coupon_change_history) AS changes,(SELECT count(*)::int FROM coupon_storage_migrations) AS migrated_brands,(SELECT count(*)::int FROM coupon_baselines) AS total_brands,(SELECT coalesce(jsonb_agg(f),'[]') FROM coupon_storage_failures f) AS failures,(SELECT jsonb_object_agg(relname,pg_total_relation_size(oid)) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('coupon_items','coupon_diffs','coupon_catalog','coupon_sales_points','coupon_change_history')) AS table_bytes,(SELECT coalesce(jsonb_agg(x),'[]') FROM (SELECT coalesce(t.state,'orphan') AS state,count(*)::int AS count FROM coupon_items i LEFT JOIN coupon_tasks t ON t.run_id=i.run_id AND t.brand_id=i.brand_id GROUP BY t.state) x) AS snapshot_states`,
          )
        ).rows[0],
      ),
    );
  }
  return { run, register };
}
