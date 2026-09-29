import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { z } from "zod";
import type { SerialGate } from "./coupons.js";
import { enrichmentQuery } from "./enrichment-priority.js";

const id = z.string().regex(/^\d+$/);
const detailSchema = z.object({
  status_code: z.literal(0),
  poi_count: z.number().int().nonnegative(),
  poi_id_list: z.array(id),
});
const pageSchema = z.object({
  status_code: z.literal(0),
  poi_list: z.array(
    z.object({
      poi: z.object({
        poi_id: id,
        poi_name: z.string(),
        city_name: z.string().optional(),
        ad_code: z.string().optional(),
        address: z.string().optional(),
        district_name: z.string().optional(),
      }),
    }),
  ),
});
export function parseStoreScope(raw: unknown) {
  const p = detailSchema.safeParse(raw);
  if (!p.success) throw new Error("BUSINESS_OR_SCHEMA_ERROR");
  const ids = [...new Set(p.data.poi_id_list)];
  return {
    count: p.data.poi_count,
    ids,
    lookup_allowed:
      ids.length > 0 &&
      ids.length <= 1000 &&
      ids.length <= p.data.poi_count &&
      ids.length === p.data.poi_id_list.length,
    consistent:
      ids.length === p.data.poi_count &&
      ids.length === p.data.poi_id_list.length,
  };
}
export function parseStorePage(raw: unknown, requested: string[]) {
  // Observed for an individual product: do not pause unrelated brand scans.
  // Unknown business responses still fail closed below.
  if (
    z
      .object({
        status_code: z.literal(2062000001),
        status_msg: z.literal("参数不合法"),
      })
      .safeParse(raw).success
  )
    throw new Error("STORE_INVALID_ARGUMENTS");
  const p = pageSchema.safeParse(raw);
  if (!p.success) throw new Error("BUSINESS_OR_SCHEMA_ERROR");
  const stores = p.data.poi_list.map((x) => x.poi);
  if (
    stores.some((x) => !requested.includes(x.poi_id)) ||
    new Set(stores.map((x) => x.poi_id)).size !== stores.length
  )
    throw new Error("STORE_SCOPE_MISMATCH");
  return stores.map((s) => ({
    ...s,
    shanghai: s.city_name === "上海市" && /^310\d{3}$/.test(s.ad_code ?? ""),
  }));
}
export async function initStores(db: PGlite) {
  await db.exec(`CREATE TABLE IF NOT EXISTS coupon_store_tasks(run_id uuid,product_id text,brand_id uuid,state text NOT NULL DEFAULT 'queued',scope jsonb,cursor int NOT NULL DEFAULT 0,error_code text,retries int NOT NULL DEFAULT 0,retry_at timestamptz,PRIMARY KEY(run_id,product_id));
ALTER TABLE coupon_store_tasks ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;
CREATE TABLE IF NOT EXISTS coupon_store_items(run_id uuid,product_id text,poi_id text,payload jsonb NOT NULL,PRIMARY KEY(run_id,product_id,poi_id));
CREATE TABLE IF NOT EXISTS coupon_store_snapshots(run_id uuid,product_id text,payload jsonb NOT NULL,observed_at timestamptz DEFAULT now(),PRIMARY KEY(run_id,product_id));`);
}
/** Resume only unqueried batches in a fresh current baseline; never retry missing IDs in a loop. */
export async function resumePartialStoreTasks(db: PGlite) {
  return (
    await db.query(`UPDATE coupon_store_tasks t SET state='queued',retries=0,retry_at=NULL
    WHERE t.state='incomplete' AND t.error_code='STORE_IDS_MISSING'
      AND t.scope->>'lookup_allowed'='true' AND t.cursor>0
      AND t.cursor<jsonb_array_length(t.scope->'ids')
      AND EXISTS(SELECT 1 FROM coupon_baselines b
        JOIN brands brand ON brand.id=b.brand_id AND brand.active
        JOIN coupon_tasks source ON source.run_id=b.run_id AND source.brand_id=b.brand_id AND source.state='complete'
        JOIN coupon_items i ON i.run_id=b.run_id AND i.brand_id=b.brand_id AND i.product_id=t.product_id
        WHERE b.run_id=t.run_id AND b.brand_id=t.brand_id
          AND i.observed_at BETWEEN now()-interval '36 hours' AND now())
    RETURNING product_id`)
  ).rows.length;
}

export function createStoreWorker(
  db: PGlite,
  opts: {
    gate: SerialGate;
    paused: () => Promise<boolean>;
    fetchDetail: (id: string) => Promise<unknown>;
    fetchPois: (id: string, ids: string[]) => Promise<unknown>;
    retryDelayMs?: number;
  },
) {
  async function enqueue(brand?: string) {
    const r = await db.query(
      `INSERT INTO coupon_store_tasks(run_id,product_id,brand_id) SELECT DISTINCT ON(i.run_id,i.product_id) i.run_id,i.product_id,i.brand_id FROM coupon_items i JOIN coupon_baselines b ON b.run_id=i.run_id AND b.brand_id=i.brand_id JOIN brands br ON br.id=i.brand_id AND br.active JOIN coupon_tasks source_task ON source_task.run_id=i.run_id AND source_task.brand_id=i.brand_id WHERE source_task.state='complete' AND source_task.completed_at>now()-interval '36 hours' AND i.payload->>'identity'='name_match' ${brand ? "AND i.brand_id=$1" : ""} ORDER BY i.run_id,i.product_id,i.brand_id ON CONFLICT DO NOTHING RETURNING product_id`,
      brand ? [brand] : [],
    );
    return r.rows.length;
  }
  let priorityTurns = 0;
  let resumedPartials = false;
  async function next() {
    if (!resumedPartials) {
      await resumePartialStoreTasks(db);
      resumedPartials = true;
    }
    await db.query(
      "UPDATE coupon_store_tasks t SET state='superseded',error_code='BASELINE_OBSOLETE' WHERE t.state='queued' AND NOT EXISTS(SELECT 1 FROM coupon_baselines b JOIN brands br ON br.id=b.brand_id AND br.active JOIN coupon_tasks source_task ON source_task.run_id=b.run_id AND source_task.brand_id=b.brand_id WHERE b.run_id=t.run_id AND b.brand_id=t.brand_id AND source_task.state='complete' AND source_task.completed_at>now()-interval '36 hours')",
    );
    const t = (
      await db.query<{
        run_id: string;
        product_id: string;
        brand_id: string;
        scope: ReturnType<typeof parseStoreScope> | null;
        cursor: number;
        retries: number;
        retry_at: string | null;
      }>(enrichmentQuery("coupon_store_tasks", ++priorityTurns % 4 !== 0))
    ).rows[0];
    if (!t) return false;
    try {
      const result = await opts.gate.run(
        async () => {
          if (await opts.paused()) throw new Error("PAUSED");
          await db.query(
            "UPDATE coupon_store_tasks SET last_attempt_at=now() WHERE run_id=$1 AND product_id=$2",
            [t.run_id, t.product_id],
          );
          const request = randomUUID(),
            started = new Date();
          const prior = (
            await db.query<{ finished_at: string | null }>(
              "SELECT finished_at FROM coupon_requests ORDER BY started_at DESC LIMIT 1",
            )
          ).rows[0];
          await db.query(
            "INSERT INTO coupon_requests(id,run_id,brand_id,cursor,attempt,started_at,gap_ms,outcome,kind) VALUES($1,$2,$3,$4,$5,$6,$7,'in_flight',$8)",
            [
              request,
              t.run_id,
              t.brand_id,
              `${t.product_id}:${t.cursor}`,
              t.retries + 1,
              started.toISOString(),
              prior?.finished_at
                ? Math.max(0, +started - Date.parse(prior.finished_at))
                : null,
              t.scope ? "store_lookup" : "store_scope",
            ],
          );
          let outcome = "OK";
          try {
            return t.scope
              ? {
                  scope: null,
                  stores: parseStorePage(
                    await opts.fetchPois(
                      t.product_id,
                      t.scope.ids.slice(t.cursor, t.cursor + 20),
                    ),
                    t.scope.ids.slice(t.cursor, t.cursor + 20),
                  ),
                }
              : {
                  scope: parseStoreScope(await opts.fetchDetail(t.product_id)),
                  stores: null,
                };
          } catch (e) {
            outcome = e instanceof Error ? e.message : "STORE_FETCH_ERROR";
            throw e;
          } finally {
            await db.query(
              "UPDATE coupon_requests SET finished_at=now(),outcome=$2 WHERE id=$1",
              [request, outcome],
            );
          }
        },
        t.retry_at ? Date.parse(t.retry_at) : 0,
      );
      if (result.scope) {
        await db.query(
          "UPDATE coupon_store_tasks SET scope=$3,retries=0,retry_at=NULL,state=$4,error_code=$5 WHERE run_id=$1 AND product_id=$2",
          [
            t.run_id,
            t.product_id,
            JSON.stringify(result.scope),
            result.scope.lookup_allowed ? "queued" : "incomplete",
            !result.scope.consistent
              ? "STORE_COUNT_MISMATCH"
              : !result.scope.ids.length
                ? "EMPTY_STORE_SCOPE"
                : result.scope.ids.length > 1000
                  ? "STORE_SCOPE_LIMIT"
                  : null,
          ],
        );
        return true;
      }
      const stores = result.stores ?? [];
      const scope = t.scope!;
      const requested = scope.ids.slice(t.cursor, t.cursor + 20);
      await db.transaction(async (tx) => {
        for (const store of stores)
          await tx.query(
            "INSERT INTO coupon_store_items VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            [t.run_id, t.product_id, store.poi_id, JSON.stringify(store)],
          );
        const cursor = t.cursor + requested.length;
        const all = (
          await tx.query<{
            payload: ReturnType<typeof parseStorePage>[number];
          }>(
            "SELECT payload FROM coupon_store_items WHERE run_id=$1 AND product_id=$2 ORDER BY poi_id",
            [t.run_id, t.product_id],
          )
        ).rows.map((x) => x.payload);
        const receivedIds = new Set(all.map((s) => s.poi_id));
        const missingIds = scope.ids
          .slice(0, cursor)
          .filter((id) => !receivedIds.has(id));
        const missing = missingIds.length > 0;
        const finished = cursor >= scope.ids.length;
        await tx.query(
          "UPDATE coupon_store_tasks SET cursor=$3,retries=0,retry_at=NULL,state=$4,error_code=$5 WHERE run_id=$1 AND product_id=$2",
          [
            t.run_id,
            t.product_id,
            cursor,
            !finished
              ? "queued"
              : scope.consistent && !missing
                ? "complete"
                : "incomplete",
            missing
              ? "STORE_IDS_MISSING"
              : !scope.consistent
                ? "STORE_COUNT_MISMATCH"
                : null,
          ],
        );
        if (finished) {
          await tx.query(
            "INSERT INTO coupon_store_snapshots(run_id,product_id,payload) VALUES($1,$2,$3) ON CONFLICT(run_id,product_id) DO UPDATE SET payload=excluded.payload,observed_at=now()",
            [
              t.run_id,
              t.product_id,
              JSON.stringify({
                reported_count: scope.count,
                matched_count: all.length,
                complete:
                  scope.consistent && !missing && all.length === scope.count,
                returned_id_count: scope.ids.length,
                queried_id_count: cursor,
                missing_ids: missingIds,
                unverified_count: Math.max(0, scope.count - all.length),
                stores: all,
                shanghai_count: all.filter((s) => s.shanghai).length,
                source: "product_detail+poi_id_lookup",
                note: "平台返回门店范围；仍需结合券使用规则。最多核验1000个门店ID。",
              }),
            ],
          );
        }
      });
      return true;
    } catch (e) {
      const code = e instanceof Error ? e.message : "STORE_FETCH_ERROR";
      if (code === "PAUSED") return false;
      if (
        [
          "AUTH_MISSING",
          "AUTH_EXPIRED",
          "RATE_LIMITED",
          "REQUEST_TIMEOUT",
          "BUSINESS_OR_SCHEMA_ERROR",
          "INVALID_RESPONSE",
          "STORE_SCOPE_MISMATCH",
        ].includes(code)
      ) {
        await db.query(
          "UPDATE coupon_settings SET pause_reason=$1 WHERE id=1",
          [code],
        );
        await db.query(
          "UPDATE coupon_store_tasks SET error_code=$3 WHERE run_id=$1 AND product_id=$2",
          [t.run_id, t.product_id, code],
        );
        return false;
      }
      if (
        ["NETWORK_ERROR", "UPSTREAM_UNAVAILABLE"].includes(code) &&
        t.retries < 2
      ) {
        await db.query(
          "UPDATE coupon_store_tasks SET retries=retries+1,retry_at=$3,error_code=$4 WHERE run_id=$1 AND product_id=$2",
          [
            t.run_id,
            t.product_id,
            new Date(
              Date.now() + (opts.retryDelayMs ?? 5000) * (t.retries + 1),
            ).toISOString(),
            code,
          ],
        );
        return true;
      }
      await db.query(
        "UPDATE coupon_store_tasks SET state='failed',error_code=$3 WHERE run_id=$1 AND product_id=$2",
        [t.run_id, t.product_id, code],
      );
      return true;
    }
  }
  return { enqueue, next };
}
