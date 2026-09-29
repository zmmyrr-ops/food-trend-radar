import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { z } from "zod";
import type { SerialGate } from "./coupons.js";
import { enrichmentQuery } from "./enrichment-priority.js";
import { structureRules } from "./rule-structure.js";
export const RULES_ENDPOINT =
  "https://eos.douyin.com/life/alliance/v2/goods/product/commodity/detail/get";
const item = z.object({
  name: z.string(),
  count: z.number().nonnegative().nullable().optional(),
  unit: z.string().optional(),
  price: z.number().nonnegative().nullable().optional(),
});
const schema = z.object({
  status_code: z.literal(0),
  commodity_info: z
    .object({
      item_groups: z
        .array(
          z.object({
            group_name: z.string().optional(),
            option_count: z.number().optional(),
            total_count: z.number().optional(),
            item_list: z.array(item),
          }),
        )
        .optional(),
    })
    .optional(),
  use_rule_info: z
    .object({
      title: z.string().optional(),
      body: z
        .array(
          z.object({
            key: z.string(),
            name: z.string(),
            value: z.array(
              z.object({
                content: z.string(),
                note_type: z.number().optional(),
              }),
            ),
          }),
        )
        .optional(),
    })
    .optional(),
});
export function normalizeRules(raw: unknown) {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error("BUSINESS_OR_SCHEMA_ERROR");
  const d = parsed.data;
  const groups = d.commodity_info?.item_groups ?? [];
  const rules = d.use_rule_info?.body ?? [];
  const canonical = (v: unknown) =>
    createHash("sha256").update(JSON.stringify(v)).digest("hex");
  const normalizeText = (s: string) =>
    s.normalize("NFKC").replace(/\s+/g, " ").trim();
  const ruleFingerprint = canonical(
    rules
      .map((r) => [r.key, r.value.map((v) => normalizeText(v.content)).sort()])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
  return {
    version: "commodity-v1",
    structured: structureRules(groups, rules),
    groups,
    rules,
    rule_fingerprint: ruleFingerprint,
    commodity_fingerprint: canonical(groups),
    status: groups.length && rules.length ? "received" : "incomplete",
    full_comparability: false,
    limitations: [
      "全部适用门店尚未核验",
      "自然语言限制未全部结构化，缺失不代表无限制",
    ],
  };
}
export async function initRules(db: PGlite) {
  await db.exec(`CREATE TABLE IF NOT EXISTS coupon_rule_tasks(run_id uuid NOT NULL,product_id text NOT NULL,brand_id uuid NOT NULL,state text NOT NULL DEFAULT 'queued',error_code text,retries int NOT NULL DEFAULT 0,retry_at timestamptz,PRIMARY KEY(run_id,product_id));
ALTER TABLE coupon_rule_tasks ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;
  CREATE TABLE IF NOT EXISTS coupon_rule_snapshots(run_id uuid NOT NULL,product_id text NOT NULL,payload jsonb NOT NULL,observed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(run_id,product_id));
  ALTER TABLE coupon_requests ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'selection';`);
}
export function createRuleWorker(
  db: PGlite,
  options: {
    gate: SerialGate;
    fetchRules: (productId: string) => Promise<unknown>;
    paused: () => Promise<boolean>;
    retryDelayMs?: number;
  },
) {
  async function enqueue(brandId?: string) {
    const r = await db.query(
      `INSERT INTO coupon_rule_tasks(run_id,product_id,brand_id) SELECT DISTINCT ON (i.run_id,i.product_id) i.run_id,i.product_id,i.brand_id FROM coupon_items i JOIN coupon_baselines b ON b.run_id=i.run_id AND b.brand_id=i.brand_id JOIN brands br ON br.id=i.brand_id AND br.active JOIN coupon_tasks source_task ON source_task.run_id=i.run_id AND source_task.brand_id=i.brand_id WHERE source_task.state='complete' AND source_task.completed_at>now()-interval '36 hours' AND i.payload->>'identity'='name_match' ${brandId ? "AND i.brand_id=$1" : ""} ORDER BY i.run_id,i.product_id,i.brand_id ON CONFLICT DO NOTHING RETURNING product_id`,
      brandId ? [brandId] : [],
    );
    return r.rows.length;
  }
  let priorityTurns = 0;
  async function next() {
    // Do not fetch historical jobs after a newer complete brand baseline supersedes them.
    await db.query(
      "UPDATE coupon_rule_tasks t SET state='superseded',error_code='BASELINE_OBSOLETE' WHERE t.state='queued' AND NOT EXISTS(SELECT 1 FROM coupon_baselines b JOIN brands br ON br.id=b.brand_id AND br.active JOIN coupon_tasks source_task ON source_task.run_id=b.run_id AND source_task.brand_id=b.brand_id WHERE b.run_id=t.run_id AND b.brand_id=t.brand_id AND source_task.state='complete' AND source_task.completed_at>now()-interval '36 hours')",
    );
    const t = (
      await db.query<{
        run_id: string;
        product_id: string;
        brand_id: string;
        retries: number;
        retry_at: string | null;
      }>(enrichmentQuery("coupon_rule_tasks", ++priorityTurns % 4 !== 0))
    ).rows[0];
    if (!t) return false;
    try {
      const payload = await options.gate.run(
        async () => {
          if (await options.paused()) throw new Error("PAUSED");
          await db.query(
            "UPDATE coupon_rule_tasks SET last_attempt_at=now() WHERE run_id=$1 AND product_id=$2",
            [t.run_id, t.product_id],
          );
          const requestId = randomUUID(),
            started = new Date();
          const prior = (
            await db.query<{ finished_at: string | null }>(
              "SELECT finished_at FROM coupon_requests ORDER BY started_at DESC LIMIT 1",
            )
          ).rows[0];
          const gap = prior?.finished_at
            ? Math.max(0, +started - Date.parse(prior.finished_at))
            : null;
          await db.query(
            "INSERT INTO coupon_requests(id,run_id,brand_id,cursor,attempt,started_at,gap_ms,outcome,kind) VALUES($1,$2,$3,$4,$5,$6,$7,'in_flight','commodity')",
            [
              requestId,
              t.run_id,
              t.brand_id,
              t.product_id,
              t.retries + 1,
              started.toISOString(),
              gap,
            ],
          );
          let outcome = "OK";
          try {
            return normalizeRules(await options.fetchRules(t.product_id));
          } catch (e) {
            outcome = e instanceof Error ? e.message : "RULE_FETCH_ERROR";
            throw e;
          } finally {
            await db.query(
              "UPDATE coupon_requests SET finished_at=now(),outcome=$2 WHERE id=$1",
              [requestId, outcome],
            );
          }
        },
        t.retry_at ? Date.parse(t.retry_at) : 0,
      );
      await db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO coupon_rule_snapshots(run_id,product_id,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [t.run_id, t.product_id, JSON.stringify(payload)],
        );
        await tx.query(
          "UPDATE coupon_rule_tasks SET state=$3,error_code=NULL WHERE run_id=$1 AND product_id=$2",
          [
            t.run_id,
            t.product_id,
            payload.status === "received" ? "complete" : "incomplete",
          ],
        );
      });
      return true;
    } catch (e) {
      const code = e instanceof Error ? e.message : "RULE_FETCH_ERROR";
      if (code === "PAUSED") return false;
      if (
        [
          "AUTH_MISSING",
          "AUTH_EXPIRED",
          "RATE_LIMITED",
          "REQUEST_TIMEOUT",
          "BUSINESS_OR_SCHEMA_ERROR",
          "INVALID_RESPONSE",
        ].includes(code)
      ) {
        await db.query(
          "UPDATE coupon_rule_tasks SET error_code=$3 WHERE run_id=$1 AND product_id=$2",
          [t.run_id, t.product_id, code],
        );
        await db.query(
          "UPDATE coupon_settings SET pause_reason=$1 WHERE id=1",
          [code],
        );
        return false;
      }
      if (
        ["NETWORK_ERROR", "UPSTREAM_UNAVAILABLE"].includes(code) &&
        t.retries < 2
      ) {
        await db.query(
          "UPDATE coupon_rule_tasks SET retries=retries+1,retry_at=$3,error_code=$4 WHERE run_id=$1 AND product_id=$2",
          [
            t.run_id,
            t.product_id,
            new Date(
              Date.now() + (options.retryDelayMs ?? 5000) * (t.retries + 1),
            ).toISOString(),
            code,
          ],
        );
        return true;
      }
      await db.query(
        "UPDATE coupon_rule_tasks SET state='failed',error_code=$3 WHERE run_id=$1 AND product_id=$2",
        [t.run_id, t.product_id, code],
      );
      return true;
    }
  }
  return { enqueue, next };
}
