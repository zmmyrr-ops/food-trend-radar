import type { PGlite } from "@electric-sql/pglite";
import { indexAvailable } from "./brand-index.js";
import { syncSubscriptionMessages } from "./brand-subscriptions.js";
import type { combinePicks } from "./coupon-picks.js";
import { couponUseOutlook } from "./coupon-use-outlook.js";
import { pickPriority } from "./pick-priority.js";
import { applyUsePenalty } from "./use-priority.js";

type Pick = ReturnType<typeof combinePicks>[number];
export function saleDeadline(value: unknown): string | null {
  const text = String(value ?? "").trim();
  let at: number;
  if (/^\d{10}$/.test(text)) at = Number(text) * 1000;
  else if (/^\d{13}$/.test(text)) at = Number(text);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(text))
    at = Date.parse(`${text}T23:59:59+08:00`);
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text))
    at = Date.parse(`${text.replace(" ", "T")}+08:00`);
  else if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text))
    at = Date.parse(text);
  else return null;
  return Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : null;
}

export function updatePoolClock(x: Pick, now = Date.now()): Pick {
  if (!x.usage_inputs) return x; // Existing precomputed snapshots are replaced by the dirty queue.
  const isNew =
    !!x.discovered_at &&
    now >= Date.parse(x.discovered_at) &&
    now < Date.parse(x.discovered_at) + 24 * 3600000;
  const outlook = couponUseOutlook(x.usage_inputs.current, now);
  const historical = x.usage_inputs.historical
    ? couponUseOutlook(x.usage_inputs.historical, now)
    : null;
  const index = x.brand_index;
  const usable = index ? indexAvailable(index, now) : false;
  return {
    ...x,
    is_new: isNew,
    use_outlook: outlook,
    brand_index: index ? { ...index, usable } : null,
    priority: applyUsePenalty(
      pickPriority({
        is_new: isNew,
        discount_rate: x.discount.rate,
        brand_growth: usable ? index!.mom : null,
        speed: x.speed,
        acceleration: x.acceleration,
        reduction_rate: x.reduction_rate,
      }),
      outlook,
      historical,
    ),
  };
}

export async function createCouponPool(
  db: PGlite,
  buildBrand: (brand: string) => Promise<Pick[]>,
) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS coupon_pool_candidates(brand_id uuid NOT NULL,product_id text NOT NULL,run_id uuid NOT NULL,observed_at timestamptz NOT NULL,sale_end timestamptz,payload jsonb NOT NULL,calculated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(brand_id,product_id));
    CREATE INDEX IF NOT EXISTS coupon_pool_expiry ON coupon_pool_candidates(sale_end);
    CREATE TABLE IF NOT EXISTS coupon_pool_dirty(brand_id uuid PRIMARY KEY,revision bigint NOT NULL DEFAULT 1,changed_at timestamptz NOT NULL DEFAULT now());
    CREATE OR REPLACE FUNCTION coupon_pool_mark_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE rowdata jsonb; target uuid;
    BEGIN
      rowdata := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
      IF TG_TABLE_NAME='brands' THEN target := (rowdata->>'id')::uuid;
      ELSE target := (rowdata->>'brand_id')::uuid; END IF;
      IF target IS NOT NULL THEN
        INSERT INTO coupon_pool_dirty(brand_id) VALUES(target) ON CONFLICT(brand_id) DO UPDATE SET revision=coupon_pool_dirty.revision+1,changed_at=now();
      ELSE
        INSERT INTO coupon_pool_dirty(brand_id) SELECT DISTINCT b.brand_id FROM coupon_baselines b JOIN coupon_items i ON i.brand_id=b.brand_id AND i.run_id=b.run_id WHERE i.product_id=rowdata->>'product_id'
        ON CONFLICT(brand_id) DO UPDATE SET revision=coupon_pool_dirty.revision+1,changed_at=now();
      END IF;
      RETURN NULL;
    END $$;
  `);
  for (const table of [
    "brands",
    "coupon_baselines",
    "coupon_rule_snapshots",
    "coupon_store_snapshots",
    "coupon_dispositions",
    "brand_index_observations",
  ])
    await db.exec(
      `DROP TRIGGER IF EXISTS pool_dirty ON ${table}; CREATE TRIGGER pool_dirty AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION coupon_pool_mark_dirty();`,
    );
  // Preserve the existing complete result while the first incremental pass fills richer evidence.
  await db.exec(`INSERT INTO coupon_pool_candidates(brand_id,product_id,run_id,observed_at,payload,calculated_at)
    SELECT (p->>'brand_id')::uuid,p->>'product_id',b.run_id,(p->>'observed_at')::timestamptz,p || jsonb_build_object('run_id',b.run_id,'sale_end',i.payload->>'sale_end'),r.calculated_at
    FROM radar_read_models r CROSS JOIN LATERAL jsonb_array_elements(r.payload) p JOIN coupon_baselines b ON b.brand_id=(p->>'brand_id')::uuid JOIN coupon_items i ON i.brand_id=b.brand_id AND i.run_id=b.run_id AND i.product_id=p->>'product_id'
    WHERE date_trunc('milliseconds',i.observed_at)=date_trunc('milliseconds',(p->>'observed_at')::timestamptz) AND r.name='coupon-picks-v5' AND r.calculated_at>now()-interval '36 hours' ON CONFLICT DO NOTHING;
    INSERT INTO coupon_pool_dirty(brand_id) SELECT id FROM brands WHERE active ON CONFLICT DO NOTHING;`);
  const deadlines = (
    await db.query<{ brand_id: string; product_id: string; value: unknown }>(
      "SELECT brand_id,product_id,payload->>'sale_end' AS value FROM coupon_pool_candidates WHERE sale_end IS NULL",
    )
  ).rows.flatMap((x) => {
    const end = saleDeadline(x.value);
    return end
      ? [{ brand_id: x.brand_id, product_id: x.product_id, sale_end: end }]
      : [];
  });
  if (deadlines.length)
    await db.query(
      "UPDATE coupon_pool_candidates c SET sale_end=v.sale_end FROM jsonb_to_recordset($1) AS v(brand_id uuid,product_id text,sale_end timestamptz) WHERE c.brand_id=v.brand_id AND c.product_id=v.product_id",
      [JSON.stringify(deadlines)],
    );
  let tail = Promise.resolve();
  let stopped = false;
  function refreshBrand(brand: string) {
    const work = tail.then(async () => {
      const stamp = (
        await db.query<{ revision: string }>(
          "SELECT revision::text FROM coupon_pool_dirty WHERE brand_id=$1",
          [brand],
        )
      ).rows[0];
      const baseline = (
        await db.query<{ run_id: string }>(
          "SELECT run_id FROM coupon_baselines WHERE brand_id=$1",
          [brand],
        )
      ).rows[0];
      const items = await buildBrand(brand);
      if (items.some((x) => x.run_id !== baseline?.run_id)) return;
      await db.transaction(async (tx) => {
        const current = (
          await tx.query<{ run_id: string }>(
            "SELECT run_id FROM coupon_baselines WHERE brand_id=$1",
            [brand],
          )
        ).rows[0];
        if (current?.run_id !== baseline?.run_id) return;
        await tx.query(
          "DELETE FROM coupon_pool_candidates WHERE brand_id=$1 AND NOT (product_id = ANY($2::text[]))",
          [brand, baseline ? items.map((x) => x.product_id) : []],
        );
        if (baseline)
          for (const x of items) {
            await tx.query(
              "INSERT INTO coupon_pool_candidates(brand_id,product_id,run_id,observed_at,sale_end,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(brand_id,product_id) DO UPDATE SET run_id=excluded.run_id,observed_at=excluded.observed_at,sale_end=excluded.sale_end,payload=excluded.payload,calculated_at=now() WHERE (coupon_pool_candidates.run_id,coupon_pool_candidates.observed_at,coupon_pool_candidates.sale_end,coupon_pool_candidates.payload) IS DISTINCT FROM (excluded.run_id,excluded.observed_at,excluded.sale_end,excluded.payload)",
              [
                brand,
                x.product_id,
                baseline.run_id,
                x.observed_at,
                saleDeadline(x.sale_end),
                JSON.stringify(x),
              ],
            );
          }
        if (stamp)
          await tx.query(
            "DELETE FROM coupon_pool_dirty WHERE brand_id=$1 AND revision=$2",
            [brand, stamp.revision],
          );
      });
    });
    tail = work.catch(() => undefined);
    return work;
  }
  let lastClock = 0;
  async function refreshClock() {
    if (Date.now() - lastClock < 60000) return;
    const rows = (
      await db.query<{ payload: Pick }>(
        "SELECT payload FROM coupon_pool_candidates",
      )
    ).rows;
    const changed = rows.flatMap(({ payload }) => {
      const next = updatePoolClock(payload);
      return JSON.stringify(next.priority) !==
        JSON.stringify(payload.priority) ||
        next.use_outlook.fully_excluded !== payload.use_outlook.fully_excluded
        ? [
            {
              brand_id: next.brand_id,
              product_id: next.product_id,
              payload: next,
            },
          ]
        : [];
    });
    if (changed.length)
      await db.query(
        `UPDATE coupon_pool_candidates c SET payload=v.payload FROM jsonb_to_recordset($1) AS v(brand_id uuid,product_id text,payload jsonb) WHERE c.brand_id=v.brand_id AND c.product_id=v.product_id`,
        [JSON.stringify(changed)],
      );
    await db.exec(
      "DELETE FROM coupon_pool_candidates WHERE sale_end<=now() OR observed_at<now()-interval '36 hours'",
    );
    lastClock = Date.now();
  }
  let pumping: Promise<void> | undefined;
  function tick() {
    if (stopped) return Promise.resolve();
    if (!pumping)
      pumping = (async () => {
        await refreshClock();
        const dirty = (
          await db.query<{ brand_id: string }>(
            "SELECT brand_id FROM coupon_pool_dirty ORDER BY changed_at,brand_id LIMIT 10",
          )
        ).rows;
        for (const x of dirty) {
          if (stopped) break;
          await refreshBrand(x.brand_id);
        }
        await syncSubscriptionMessages(db);
      })().finally(() => {
        pumping = undefined;
      });
    return pumping;
  }
  // Keep the complete current set; only selectPicks limits the recommended view.
  async function read() {
    const rows = (
      await db.query<{
        payload: Pick;
        category: string;
      }>(`SELECT c.payload,b.category FROM coupon_pool_candidates c JOIN brands b ON b.id=c.brand_id AND b.active JOIN coupon_baselines cb ON cb.brand_id=c.brand_id AND cb.run_id=c.run_id
      WHERE c.observed_at BETWEEN now()-interval '36 hours' AND now() AND (c.sale_end IS NULL OR c.sale_end>now())
      ORDER BY (c.payload#>>'{priority,score}')::numeric DESC,c.brand_id,c.product_id`)
    ).rows;
    return rows
      .filter(({ payload }) => {
        const end = saleDeadline(payload.sale_end);
        return !end || Date.parse(end) > Date.now();
      })
      .map((x) => updatePoolClock({ ...x.payload, category: x.category }))
      .sort((a, b) => b.priority.score - a.priority.score);
  }
  return {
    refreshBrand,
    tick,
    read,
    stop: async () => {
      stopped = true;
      await pumping;
      await tail;
    },
  };
}
