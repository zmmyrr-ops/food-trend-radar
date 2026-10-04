import { createHash, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { leisureCategories } from "@radar/contracts";
import type { Express } from "express";
import { z } from "zod";
import { brandCoverage } from "./brand-coverage.js";
import {
  cacheBrandIcon,
  platformImage,
  seedOfficialBrandIcons,
} from "./brand-icons.js";
import { readConditionComparison } from "./coupon-condition-comparison.js";
import { assessCoupon } from "./coupon-evidence.js";
import { createRuleWorker, initRules, RULES_ENDPOINT } from "./coupon-rules.js";
import { captureCouponStorage, initCouponStorage } from "./coupon-storage.js";
import { createStoreWorker, initStores } from "./coupon-stores.js";
import { couponUseOutlook } from "./coupon-use-outlook.js";
import { currentCouponDetail } from "./current-coupon-detail.js";
import { salesEvidenceAssessment } from "./opportunity-score.js";
import { RequestDeadline } from "./request-deadline.js";
import {
  type Group,
  type RuleText,
  ruleChanges,
  structureRules,
} from "./rule-structure.js";

export const ENDPOINT =
  "https://eos.douyin.com/life/alliance/v2/goods/selection/get";
export const SELECTION_SCOPE = {
  from_type: "5",
  sort_type: "8",
  city: "310000",
  first_category: "1000000",
  count: "12",
  image_size: '{"width":360}',
} as const;
export function selectionScope(category = "其他餐饮") {
  if (!(leisureCategories as readonly string[]).includes(category))
    return SELECTION_SCOPE;
  const { first_category: _foodOnly, ...scope } = SELECTION_SCOPE;
  return scope;
}
export function buildSelectionUrl(
  name: string,
  cursor: string,
  category = "其他餐饮",
) {
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({
    ...selectionScope(category),
    key_word: name,
    cursor,
  }).toString();
  return url;
}
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const norm = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s·•]/g, "");
export function parseLossless(text: string): unknown {
  return JSON.parse(text, ((
    _key: string,
    value: unknown,
    ctx?: { source: string },
  ) => {
    if (
      typeof value === "number" &&
      !Number.isSafeInteger(value) &&
      Number.isInteger(value)
    ) {
      if (!ctx?.source) throw new Error("LOSSLESS_JSON_UNSUPPORTED");
      return ctx.source;
    }
    return value;
  }) as Parameters<typeof JSON.parse>[1]);
}
const obj = z.record(z.string(), z.unknown());
const pageSchema = z.object({
  status_code: z.literal(0),
  cursor: z.union([z.string(), z.number()]),
  has_more: z.boolean(),
  product_list: z.array(obj),
});
const money = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const str = (v: unknown) =>
  typeof v === "string"
    ? v
    : typeof v === "number" && Number.isSafeInteger(v)
      ? String(v)
      : "";
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
export type Coupon = {
  product_id: string;
  name: string;
  price_min_fen: number | null;
  price_max_fen: number | null;
  origin_price_fen: number | null;
  brand_icon_url?: string | null;
  brand_icon_kind?: string;
  platform_brand_id: string;
  platform_brand_name: string;
  poi_id: string;
  poi_name: string;
  address: string;
  monthly_sales: string;
  sale_end: string;
  status: number | null;
  identity: "name_match" | "unresolved";
  terms_status: "unknown";
  signature: string;
  city_evidence?: string;
  sold_start_time?: number | null;
  source_evidence?: Record<string, unknown>;
};
export function normalizeCoupon(
  raw: Record<string, unknown>,
  names: string[],
): Coupon {
  const p = record(raw.product_info),
    poi = record(raw.nearest_poi_info),
    b = record(poi.brand_data),
    price = record(p.price_range);
  const product_id = str(raw.product_id);
  if (!product_id || typeof p.product_name !== "string")
    throw new Error("INVALID_PRODUCT");
  const c: Coupon = {
    product_id,
    name: p.product_name,
    price_min_fen: money(price.min),
    price_max_fen: money(price.max),
    origin_price_fen: money(p.origin_price) || null,
    brand_icon_url:
      platformImage(b.brand_logo) ||
      platformImage(b.logo_url) ||
      platformImage(poi.poi_image),
    brand_icon_kind:
      platformImage(b.brand_logo) || platformImage(b.logo_url)
        ? "brand_logo"
        : "shop_icon",
    platform_brand_id: str(b.brand_id),
    platform_brand_name: str(b.brand_name),
    poi_id: str(poi.poi_id),
    poi_name: str(poi.poi_name),
    address: str(poi.address),
    monthly_sales: str(p.sold_count_display),
    sale_end: str(p.product_sold_end_time),
    status: money(p.status),
    identity:
      names.some((n) => n && norm(n) === norm(str(b.brand_name))) ||
      (!str(b.brand_name) &&
        str(record(record(poi.poi_display_info).poi_distance_display).value) ===
          "上海市" &&
        names.some((n) => n && norm(n) === norm(str(poi.poi_name))))
        ? "name_match"
        : "unresolved",
    terms_status: "unknown",
    city_evidence: str(
      record(record(poi.poi_display_info).poi_distance_display).value,
    ),
    sold_start_time: money(p.sold_start_time),
    source_evidence: {
      sales: {
        source: "product_info.sold_count_display",
        raw: str(p.sold_count_display),
        semantics: "unverified",
        observed_count_fields: Object.fromEntries(
          Object.entries(p).filter(
            ([key, value]) =>
              /^(?:[a-z_]*(?:sold|sales)[a-z_]*count[a-z_]*|[a-z_]*count[a-z_]*(?:sold|sales)[a-z_]*)$/.test(
                key,
              ) &&
              key.length <= 64 &&
              ((typeof value === "number" && Number.isSafeInteger(value)) ||
                (typeof value === "string" && value.length <= 128)),
          ),
        ),
      },
      product_id,
      product_name: p.product_name,
      price_range: { min: money(price.min), max: money(price.max) },
      brand_data: { brand_id: str(b.brand_id), brand_name: str(b.brand_name) },
      poi_id: str(poi.poi_id),
      poi_name: str(poi.poi_name),
      address: str(poi.address),
      city_display: str(
        record(record(poi.poi_display_info).poi_distance_display).value,
      ),
    },
    signature: "",
  };
  c.signature = hash([
    c.name,
    c.price_min_fen,
    c.price_max_fen,
    c.sale_end,
    c.status,
    c.poi_id,
  ]);
  return c;
}
export function diffCoupon(
  old: Coupon | undefined,
  current: Coupon,
  baseline: boolean,
) {
  if (!baseline) return "BASELINE";
  if (!old) return "NEW_OBSERVED";
  if (
    [
      old.price_min_fen,
      old.price_max_fen,
      current.price_min_fen,
      current.price_max_fen,
    ].some((v) => v === null) &&
    (old.price_min_fen !== current.price_min_fen ||
      old.price_max_fen !== current.price_max_fen)
  )
    return "PRICE_DATA_CHANGED";
  if (
    old.price_min_fen !== current.price_min_fen ||
    old.price_max_fen !== current.price_max_fen
  )
    return "PRICE_CHANGED_UNVERIFIED";
  return ["name", "sale_end", "status", "poi_id", "platform_brand_id"].every(
    (key) => old[key as keyof Coupon] === current[key as keyof Coupon],
  )
    ? "UNCHANGED"
    : "TERMS_CHANGED_UNVERIFIED";
}
export function slotAt(now: Date) {
  const local = new Date(now.getTime() + 8 * 3600000);
  return `${local.toISOString().slice(0, 10)}T${local.getUTCHours() >= 12 ? "12" : "00"}:00:00+08:00`;
}
export class SerialGate {
  private tail: Promise<unknown> = Promise.resolve();
  private next = 0;
  constructor(
    private sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    private clock = Date.now,
    private random = Math.random,
  ) {
    this.next = this.clock() + 5000;
  }
  run<T>(call: () => Promise<T>, notBefore = 0): Promise<T> {
    const job = this.tail.then(async () => {
      await this.sleep(
        Math.max(0, Math.max(this.next, notBefore) - this.clock()),
      );
      try {
        return await call();
      } finally {
        this.next = this.clock() + 3000 + Math.floor(this.random() * 2001);
      }
    });
    this.tail = job.catch(() => {});
    return job;
  }
}
export async function initCoupons(db: PGlite) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS coupon_settings(id int PRIMARY KEY CHECK(id=1), enabled boolean NOT NULL DEFAULT false, pause_reason text);
    INSERT INTO coupon_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS coupon_runs(id uuid PRIMARY KEY, slot text UNIQUE, status text NOT NULL, started_at timestamptz DEFAULT now(), finished_at timestamptz);
    CREATE TABLE IF NOT EXISTS coupon_tasks(run_id uuid REFERENCES coupon_runs(id), brand_id uuid REFERENCES brands(id), name text NOT NULL, aliases jsonb NOT NULL, state text NOT NULL DEFAULT 'queued', cursor text NOT NULL DEFAULT '0', pages int NOT NULL DEFAULT 0, error_code text, PRIMARY KEY(run_id,brand_id));
    ALTER TABLE coupon_tasks ADD COLUMN IF NOT EXISTS position int NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS coupon_pages(run_id uuid, brand_id uuid, cursor text, next_cursor text, has_more boolean, digest text, observed_at timestamptz DEFAULT now(), PRIMARY KEY(run_id,brand_id,cursor));
    CREATE TABLE IF NOT EXISTS coupon_items(run_id uuid, brand_id uuid, product_id text, payload jsonb NOT NULL, observed_at timestamptz DEFAULT now(), PRIMARY KEY(run_id,brand_id,product_id));
    CREATE TABLE IF NOT EXISTS coupon_identity_refreshes(brand_id uuid,query_signature text,run_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(brand_id,query_signature));
    ALTER TABLE brands ADD COLUMN IF NOT EXISTS icon_url text;
    CREATE TABLE IF NOT EXISTS brand_icons(brand_id uuid PRIMARY KEY REFERENCES brands(id),source_url text NOT NULL,kind text NOT NULL,mime text NOT NULL,content text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS coupon_baselines(brand_id uuid PRIMARY KEY, run_id uuid NOT NULL);
    CREATE TABLE IF NOT EXISTS coupon_diffs(run_id uuid, brand_id uuid, product_id text, kind text, old_payload jsonb, new_payload jsonb, observed_at timestamptz DEFAULT now(), PRIMARY KEY(run_id,brand_id,product_id));
    CREATE TABLE IF NOT EXISTS coupon_discoveries(brand_id uuid NOT NULL,product_id text NOT NULL,discovered_at timestamptz NOT NULL,PRIMARY KEY(brand_id,product_id));
    ALTER TABLE coupon_tasks ADD COLUMN IF NOT EXISTS query_signature text;
    ALTER TABLE coupon_tasks ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT '其他餐饮';
    ALTER TABLE coupon_tasks ADD COLUMN IF NOT EXISTS completed_at timestamptz;
    ALTER TABLE coupon_tasks ADD COLUMN IF NOT EXISTS comparison_status text;
    ALTER TABLE coupon_tasks ADD COLUMN IF NOT EXISTS previous_run_id uuid;
    ALTER TABLE coupon_tasks ADD COLUMN IF NOT EXISTS retries int NOT NULL DEFAULT 0;
    ALTER TABLE coupon_tasks ADD COLUMN IF NOT EXISTS retry_at timestamptz;
    CREATE TABLE IF NOT EXISTS coupon_requests(id uuid PRIMARY KEY, run_id uuid NOT NULL, brand_id uuid NOT NULL, cursor text NOT NULL, attempt int NOT NULL, started_at timestamptz NOT NULL, finished_at timestamptz, gap_ms bigint, outcome text NOT NULL);
    ALTER TABLE coupon_requests ADD COLUMN IF NOT EXISTS recovered_at timestamptz;
    CREATE INDEX IF NOT EXISTS coupon_requests_started ON coupon_requests(started_at DESC);
    CREATE OR REPLACE VIEW coupon_brand_candidates AS
      SELECT i.brand_id,i.payload->>'platform_brand_id' AS platform_brand_id,
        min(i.payload->>'platform_brand_name') AS platform_brand_name,
        count(*)::int AS product_count,max(i.observed_at) AS observed_at
      FROM coupon_items i JOIN coupon_baselines b ON b.brand_id=i.brand_id AND b.run_id=i.run_id
      WHERE i.payload->>'identity'='name_match' AND coalesce(i.payload->>'platform_brand_id','')<>''
      GROUP BY i.brand_id,i.payload->>'platform_brand_id';
    CREATE INDEX IF NOT EXISTS coupon_diffs_time ON coupon_diffs(observed_at DESC);
  `);
  // Reconcile only current baselines for exact Shanghai POI names missing brand metadata.
  await db.exec(`WITH repaired AS (
    UPDATE coupon_items i SET payload=jsonb_set(i.payload,'{identity}','"name_match"'::jsonb)
    FROM brands b,coupon_baselines cb
    WHERE i.brand_id=b.id AND cb.brand_id=b.id AND cb.run_id=i.run_id
      AND i.payload->>'identity'='unresolved'
      AND coalesce(i.payload->>'platform_brand_name','')=''
      AND i.payload->>'city_evidence'='上海市'
      AND (lower(trim(i.payload->>'poi_name'))=lower(trim(b.name))
        OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(b.aliases) a(value) WHERE lower(trim(a.value))=lower(trim(i.payload->>'poi_name'))))
    RETURNING i.brand_id
  ) UPDATE coupon_baselines SET run_id=run_id WHERE brand_id IN (SELECT brand_id FROM repaired);`);
  await seedOfficialBrandIcons(db);
  await initRules(db);
  await initStores(db);
  await initCouponStorage(db);
  await db.exec(`    INSERT INTO coupon_discoveries
      SELECT d.brand_id,d.product_id,min(d.observed_at) FROM coupon_diffs d
      WHERE d.kind='NEW_OBSERVED' AND d.observed_at>now()-interval '24 hours'
      AND d.new_payload->>'identity'='name_match' AND NOT EXISTS(SELECT 1 FROM coupon_catalog c WHERE c.brand_id=d.brand_id AND c.product_id=d.product_id AND c.first_seen_at<(SELECT i.observed_at FROM coupon_items i WHERE i.brand_id=d.brand_id AND i.product_id=d.product_id AND i.run_id=d.run_id))
      AND NOT EXISTS(SELECT 1 FROM coupon_items i JOIN coupon_tasks t ON t.run_id=i.run_id AND t.brand_id=i.brand_id WHERE i.brand_id=d.brand_id AND i.product_id=d.product_id AND i.run_id<>d.run_id AND t.state='complete' AND i.observed_at<d.observed_at)
      GROUP BY d.brand_id,d.product_id ON CONFLICT DO NOTHING;
`);
}
export function createCoupons(
  db: PGlite,
  opts: {
    credentialPath?: string;
    fetchPage?: (
      name: string,
      cursor: string,
      category?: string,
    ) => Promise<unknown>;
    fetchStoreDetail?: (id: string) => Promise<unknown>;
    fetchStorePois?: (id: string, ids: string[]) => Promise<unknown>;
    fetchRules?: (productId: string) => Promise<unknown>;
    gate?: SerialGate;
    maxPages?: number;
    unmatchedPageLimit?: number;
    retryDelayMs?: number;
    policyVersion?: string;
    onBrandComplete?: (brand: string) => Promise<unknown>;
    maxBaselineAgeMs?: number;
  } = {},
) {
  const iconAttempts = new Map<string, number>();
  const querySignature = (
    name: string,
    aliases: string[],
    category = "其他餐饮",
  ) =>
    hash({
      endpoint: ENDPOINT,
      scope: selectionScope(category),
      scene: "all_omitted",
      name,
      aliases: [...aliases].sort(),
      version: opts.policyVersion ?? "selection-food-all-v2",
    });
  const gate = opts.gate ?? new SerialGate();
  const requestDeadline = new RequestDeadline();
  let worker: Promise<void> | undefined;
  let stopping = false;
  let creating = false;
  async function settings() {
    return (
      await db.query<{ enabled: boolean; pause_reason: string | null }>(
        "SELECT * FROM coupon_settings WHERE id=1",
      )
    ).rows[0];
  }
  async function fetchPage(name: string, cursor: string, category: string) {
    if (opts.fetchPage) return opts.fetchPage(name, cursor, category);
    return fetchJson(buildSelectionUrl(name, cursor, category));
  }
  async function fetchJson(url: URL) {
    if (url.origin !== "https://eos.douyin.com")
      throw new Error("HOST_NOT_ALLOWED");
    if (!opts.credentialPath) throw new Error("AUTH_MISSING");
    let headers: Record<string, string>;
    try {
      headers = z
        .record(z.string(), z.string())
        .parse(JSON.parse(await readFile(opts.credentialPath, "utf8")));
    } catch {
      throw new Error("AUTH_MISSING");
    }
    const allowed = new Set([
      "cookie",
      "x-secsdk-csrf-token",
      "user-agent",
      "referer",
      "accept",
      "accept-language",
    ]);
    headers = Object.fromEntries(
      Object.entries(headers).filter(([k]) => allowed.has(k.toLowerCase())),
    );
    return requestDeadline.run(async (signal) => {
      let response: Response;
      try {
        response = await fetch(url, {
          headers,
          redirect: "error",
          signal,
        });
      } catch {
        throw new Error("NETWORK_ERROR");
      }
      if (!response.ok) await response.body?.cancel();
      if ([401, 403].includes(response.status)) throw new Error("AUTH_EXPIRED");
      if (response.status === 429) throw new Error("RATE_LIMITED");
      if ([502, 503, 504].includes(response.status))
        throw new Error("UPSTREAM_UNAVAILABLE");
      if (!response.ok) throw new Error("HTTP_ERROR");
      let text: string;
      try {
        text = await response.text();
      } catch {
        throw new Error("NETWORK_ERROR");
      }
      if (text.length > 5_000_000) throw new Error("RESPONSE_TOO_LARGE");
      try {
        return parseLossless(text);
      } catch {
        throw new Error("INVALID_RESPONSE");
      }
    });
  }
  const ruleWorker = createRuleWorker(db, {
    gate,
    paused: async () => stopping || !!(await settings()).pause_reason,
    retryDelayMs: opts.retryDelayMs,
    fetchRules: async (productId) => {
      if (opts.fetchRules) return opts.fetchRules(productId);
      const url = new URL(RULES_ENDPOINT);
      url.search = new URLSearchParams({
        from_type: "5",
        product_id: productId,
      }).toString();
      return fetchJson(url);
    },
  });
  const storesEnabled = !!(opts.credentialPath || opts.fetchStoreDetail);
  const storeWorker = createStoreWorker(db, {
    gate,
    paused: async () => stopping || !!(await settings()).pause_reason,
    retryDelayMs: opts.retryDelayMs,
    fetchDetail: async (id) => {
      if (opts.fetchStoreDetail) return opts.fetchStoreDetail(id);
      const u = new URL(
        "https://eos.douyin.com/life/alliance/v2/goods/product/detail/get",
      );
      u.search = new URLSearchParams({
        from_type: "5",
        product_id: id,
        image_size: '{"width":360}',
        with_calendar: "true",
      }).toString();
      return fetchJson(u);
    },
    fetchPois: async (id, ids) => {
      if (opts.fetchStorePois) return opts.fetchStorePois(id, ids);
      const u = new URL(
        "https://eos.douyin.com/life/alliance/v1/goods/product_info/poi_list/get",
      );
      u.search = new URLSearchParams({
        product_id: id,
        poi_id_list: JSON.stringify(ids),
        count: "20",
        cursor: "0",
      }).toString();
      return fetchJson(u);
    },
  });
  let preferStores = true;
  const rulesEnabled = !!(opts.credentialPath || opts.fetchRules);
  async function commitBrand(run: string, brand: string) {
    await db.transaction(async (tx) => {
      const base = (
        await tx.query<{ run_id: string }>(
          "SELECT run_id FROM coupon_baselines WHERE brand_id=$1",
          [brand],
        )
      ).rows[0];
      const currentTask = (
        await tx.query<{ query_signature: string }>(
          "SELECT query_signature FROM coupon_tasks WHERE run_id=$1 AND brand_id=$2",
          [run, brand],
        )
      ).rows[0];
      const baselineTask = base
        ? (
            await tx.query<{
              query_signature: string | null;
              completed_at: string | null;
            }>(
              "SELECT query_signature,completed_at FROM coupon_tasks WHERE run_id=$1 AND brand_id=$2",
              [base.run_id, brand],
            )
          ).rows[0]
        : null;
      const comparisonStatus = !base
        ? "FIRST_BASELINE"
        : !baselineTask?.query_signature || !baselineTask.completed_at
          ? "LEGACY_BASELINE"
          : baselineTask.query_signature !== currentTask.query_signature
            ? "QUERY_CHANGED"
            : Date.now() - new Date(baselineTask.completed_at).getTime() >
                (opts.maxBaselineAgeMs ?? 36 * 3600000)
              ? "STALE_BASELINE"
              : "COMPARABLE";
      const old =
        base && comparisonStatus === "COMPARABLE"
          ? (
              await tx.query<{ payload: Coupon }>(
                "SELECT payload FROM coupon_items WHERE run_id=$1 AND brand_id=$2",
                [base.run_id, brand],
              )
            ).rows
          : [];
      const previous = new Map(
        old.map((x) => [x.payload.product_id, x.payload]),
      );
      const current = (
        await tx.query<{ payload: Coupon }>(
          "SELECT payload FROM coupon_items WHERE run_id=$1 AND brand_id=$2",
          [run, brand],
        )
      ).rows;
      for (const { payload: p } of current) {
        const before = previous.get(p.product_id);
        const kind =
          base && comparisonStatus !== "COMPARABLE"
            ? "BASELINE_RESET"
            : diffCoupon(before, p, !!base);
        await tx.query(
          "INSERT INTO coupon_diffs(run_id,brand_id,product_id,kind,old_payload,new_payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
          [
            run,
            brand,
            p.product_id,
            kind,
            before ? JSON.stringify(before) : null,
            JSON.stringify(p),
          ],
        );
        if (kind === "NEW_OBSERVED" && p.identity === "name_match")
          await tx.query(
            `INSERT INTO coupon_discoveries(brand_id,product_id,discovered_at)
            SELECT $1,$2,now() WHERE NOT EXISTS(SELECT 1 FROM coupon_catalog WHERE brand_id=$1 AND product_id=$2) AND NOT EXISTS(SELECT 1 FROM coupon_items i JOIN coupon_tasks t ON t.run_id=i.run_id AND t.brand_id=i.brand_id WHERE i.brand_id=$1 AND i.product_id=$2 AND i.run_id<>$3 AND t.state='complete') ON CONFLICT DO NOTHING`,
            [brand, p.product_id, run],
          );
        previous.delete(p.product_id);
      }
      for (const [id, p] of previous)
        await tx.query(
          "INSERT INTO coupon_diffs(run_id,brand_id,product_id,kind,old_payload,new_payload) VALUES($1,$2,$3,'NOT_SEEN',$4,NULL) ON CONFLICT DO NOTHING",
          [run, brand, id, JSON.stringify(p)],
        );
      await tx.query(
        "INSERT INTO coupon_baselines VALUES($1,$2) ON CONFLICT(brand_id) DO UPDATE SET run_id=excluded.run_id",
        [brand, run],
      );
      await tx.query(
        "UPDATE coupon_tasks SET state='complete',error_code=NULL,completed_at=now(),comparison_status=$3,previous_run_id=$4 WHERE run_id=$1 AND brand_id=$2",
        [run, brand, comparisonStatus, base?.run_id ?? null],
      );
      await captureCouponStorage(tx, brand, run);
    });
    await opts
      .onBrandComplete?.(brand)
      .catch(() => console.error("COUPON_POOL_REFRESH_FAILED"));
    if (rulesEnabled) await ruleWorker.enqueue(brand);
    if (storesEnabled) await storeWorker.enqueue(brand);
  }
  async function refreshChangedIdentities() {
    if (creating || !(await settings()).enabled) return false;
    if (creating) return false;
    creating = true;
    try {
      const brands = (
        await db.query<{
          id: string;
          name: string;
          aliases: string[];
          category: string;
          prior_category: string;
          prior_name: string;
          prior_aliases: string[];
        }>(
          "SELECT b.id,b.name,b.aliases,b.category,t.category AS prior_category,t.name AS prior_name,t.aliases AS prior_aliases FROM brands b JOIN coupon_baselines cb ON cb.brand_id=b.id JOIN coupon_tasks t ON t.run_id=cb.run_id AND t.brand_id=b.id WHERE b.active AND t.state='complete' ORDER BY b.name",
        )
      ).rows;
      const attempted = new Set(
        (
          await db.query<{ brand_id: string; query_signature: string }>(
            "SELECT brand_id,query_signature FROM coupon_identity_refreshes",
          )
        ).rows.map((x) => `${x.brand_id}:${x.query_signature}`),
      );
      const changed = brands.filter(
        (b) =>
          querySignature(b.name, b.aliases, b.category) !==
            querySignature(b.prior_name, b.prior_aliases, b.prior_category) &&
          !attempted.has(
            `${b.id}:${querySignature(b.name, b.aliases, b.category)}`,
          ),
      );
      if (!changed.length) return false;
      return await db.transaction(async (tx) => {
        if (
          (
            await tx.query(
              "SELECT id FROM coupon_runs WHERE status='running' LIMIT 1",
            )
          ).rows.length
        )
          return false;
        const run = randomUUID();
        await tx.query(
          "INSERT INTO coupon_runs(id,status) VALUES($1,'running')",
          [run],
        );
        for (const b of changed) {
          const signature = querySignature(b.name, b.aliases, b.category);
          await tx.query(
            "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,query_signature,category) VALUES($1,$2,$3,$4,$5,$6)",
            [
              run,
              b.id,
              b.name,
              JSON.stringify(b.aliases),
              signature,
              b.category,
            ],
          );
          await tx.query(
            "INSERT INTO coupon_identity_refreshes(brand_id,query_signature,run_id) VALUES($1,$2,$3)",
            [b.id, signature, run],
          );
        }
        return true;
      });
    } finally {
      creating = false;
    }
  }
  async function enrichOne() {
    if (preferStores && storesEnabled && (await storeWorker.next())) {
      preferStores = false;
      return true;
    }
    if (rulesEnabled && (await ruleWorker.next())) {
      preferStores = true;
      return true;
    }
    if (storesEnabled && (await storeWorker.next())) {
      preferStores = false;
      return true;
    }
    return false;
  }
  let selectionPagesSinceEnrichment = 0;
  async function process() {
    while (!stopping) {
      if ((await settings()).pause_reason) return;
      await db.exec(
        "UPDATE coupon_tasks t SET state='partial',error_code='BRAND_DISABLED' FROM brands b WHERE b.id=t.brand_id AND NOT b.active AND t.state='queued'",
      );
      // Close each drained run before moving to another scheduled observation.
      await db.exec(
        "UPDATE coupon_runs r SET status=CASE WHEN EXISTS(SELECT 1 FROM coupon_tasks t WHERE t.run_id=r.id AND t.state<>'complete') THEN 'partial' ELSE 'complete' END,finished_at=now() WHERE status='running' AND NOT EXISTS(SELECT 1 FROM coupon_tasks pending WHERE pending.run_id=r.id AND pending.state='queued')",
      );
      const t = (
        await db.query<{
          run_id: string;
          brand_id: string;
          name: string;
          aliases: string[];
          category: string;
          cursor: string;
          pages: number;
          retries: number;
          retry_at: string | null;
          query_signature: string | null;
        }>(
          "SELECT t.* FROM coupon_tasks t JOIN coupon_runs r ON r.id=t.run_id JOIN brands br ON br.id=t.brand_id AND br.active WHERE t.state='queued' AND r.status='running' AND (t.retry_at IS NULL OR t.retry_at<=now()) ORDER BY r.started_at,r.id,(t.pages/3),t.position,t.name,t.brand_id LIMIT 1",
        )
      ).rows[0];
      if (!t) {
        if (await refreshChangedIdentities()) continue;
        if (await enrichOne()) continue;
        return;
      }
      try {
        if (t.query_signature !== querySignature(t.name, t.aliases, t.category))
          throw new Error("QUERY_CHANGED_DURING_RUN");
        // A committed final page needs only finalization after restart, not a new request.
        const final = (
          await db.query(
            "SELECT 1 FROM coupon_pages WHERE run_id=$1 AND brand_id=$2 AND NOT has_more",
            [t.run_id, t.brand_id],
          )
        ).rows.length;
        if (final) {
          await commitBrand(t.run_id, t.brand_id);
          continue;
        }
        // A low-yield discovery query is incomplete, never an empty/full snapshot.
        // Previously matched brands retain full pagination even if early pages are noisy.
        const unmatchedLimit = opts.unmatchedPageLimit ?? 3;
        if (unmatchedLimit > 0 && t.pages >= unmatchedLimit) {
          const matched = await db.query(
            "SELECT 1 FROM coupon_items i WHERE i.brand_id=$2 AND (i.run_id=$1 OR i.run_id=(SELECT run_id FROM coupon_baselines WHERE brand_id=$2)) AND i.payload->>'identity'='name_match' LIMIT 1",
            [t.run_id, t.brand_id],
          );
          if (!matched.rows.length) {
            await db.query(
              "UPDATE coupon_tasks SET state='partial',error_code='NO_BRAND_MATCH',comparison_status='INCOMPLETE' WHERE run_id=$1 AND brand_id=$2",
              [t.run_id, t.brand_id],
            );
            continue;
          }
        }
        if (t.pages >= (opts.maxPages ?? 100)) throw new Error("PAGE_LIMIT");
        const raw = await gate.run(
          async () => {
            if (stopping || (await settings()).pause_reason)
              throw new Error("PAUSED");
            const requestId = randomUUID();
            const started = new Date();
            const previous = (
              await db.query<{ finished_at: string | null }>(
                "SELECT finished_at FROM coupon_requests ORDER BY started_at DESC LIMIT 1",
              )
            ).rows[0];
            const gap = previous?.finished_at
              ? Math.max(
                  0,
                  started.getTime() - new Date(previous.finished_at).getTime(),
                )
              : null;
            await db.query(
              "INSERT INTO coupon_requests(id,run_id,brand_id,cursor,attempt,started_at,gap_ms,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,'in_flight')",
              [
                requestId,
                t.run_id,
                t.brand_id,
                t.cursor,
                t.retries + 1,
                started.toISOString(),
                gap,
              ],
            );
            let outcome = "OK";
            try {
              const result = await fetchPage(t.name, t.cursor, t.category);
              if (!pageSchema.safeParse(result).success)
                throw new Error("BUSINESS_OR_SCHEMA_ERROR");
              return result;
            } catch (error) {
              const allowed = [
                "AUTH_MISSING",
                "AUTH_EXPIRED",
                "RATE_LIMITED",
                "REQUEST_TIMEOUT",
                "NETWORK_ERROR",
                "UPSTREAM_UNAVAILABLE",
                "HTTP_ERROR",
                "INVALID_RESPONSE",
                "RESPONSE_TOO_LARGE",
                "BUSINESS_OR_SCHEMA_ERROR",
              ];
              outcome =
                error instanceof Error && allowed.includes(error.message)
                  ? error.message
                  : "UNKNOWN_ERROR";
              throw error;
            } finally {
              await db.query(
                "UPDATE coupon_requests SET finished_at=$2,outcome=$3 WHERE id=$1",
                [requestId, new Date().toISOString(), outcome],
              );
            }
          },
          t.retry_at ? new Date(t.retry_at).getTime() : 0,
        );
        const parsed = pageSchema.safeParse(raw);
        if (!parsed.success) throw new Error("BUSINESS_OR_SCHEMA_ERROR");
        const page = parsed.data;
        const next = str(page.cursor);
        const products = page.product_list.map((p) =>
          normalizeCoupon(p, [t.name, ...t.aliases]),
        );
        const icon = products.find(
          (p) => p.identity === "name_match" && p.brand_icon_url,
        );
        if (
          icon &&
          opts.credentialPath &&
          !opts.fetchPage &&
          Date.now() - (iconAttempts.get(t.brand_id) || 0) > 86400000
        ) {
          const cached = await db.query(
            "SELECT 1 FROM brand_icons WHERE brand_id=$1 AND (kind='official_logo' OR updated_at>now()-interval '7 days')",
            [t.brand_id],
          );
          if (!cached.rows.length) {
            iconAttempts.set(t.brand_id, Date.now());
            try {
              await gate.run(() =>
                cacheBrandIcon(
                  db,
                  t.brand_id,
                  icon.brand_icon_url!,
                  icon.brand_icon_kind || "shop_icon",
                ),
              );
            } catch {
              /* An unavailable image must not fail coupon collection. */
            }
          }
        }
        const digest = hash(products.map((p) => p.product_id).sort());
        const repeat = (
          await db.query<{ digest: string }>(
            "SELECT digest FROM coupon_pages WHERE run_id=$1 AND brand_id=$2 AND (cursor=$3 OR digest=$4)",
            [t.run_id, t.brand_id, next, digest],
          )
        ).rows;
        if (
          (products.length > 0 && repeat.some((p) => p.digest === digest)) ||
          (page.has_more &&
            (!products.length || next === t.cursor || repeat.length))
        )
          throw new Error("PAGINATION_INVALID");
        await db.transaction(async (tx) => {
          for (const p of products)
            await tx.query(
              "INSERT INTO coupon_items(run_id,brand_id,product_id,payload) VALUES($1,$2,$3,$4) ON CONFLICT(run_id,brand_id,product_id) DO UPDATE SET payload=excluded.payload,observed_at=now()",
              [t.run_id, t.brand_id, p.product_id, JSON.stringify(p)],
            );
          await tx.query(
            "INSERT INTO coupon_pages(run_id,brand_id,cursor,next_cursor,has_more,digest) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
            [t.run_id, t.brand_id, t.cursor, next, page.has_more, digest],
          );
          await tx.query(
            "UPDATE coupon_tasks SET cursor=$3,pages=pages+1,retries=0,retry_at=NULL,error_code=NULL WHERE run_id=$1 AND brand_id=$2",
            [t.run_id, t.brand_id, next],
          );
        });
        if (!page.has_more) await commitBrand(t.run_id, t.brand_id);
        // Bound detail starvation while keeping list discovery the majority of requests.
        if (++selectionPagesSinceEnrichment >= 5) {
          selectionPagesSinceEnrichment = 0;
          await enrichOne();
        }
      } catch (error) {
        const known = new Set([
          "PAGE_LIMIT",
          "QUERY_CHANGED_DURING_RUN",
          "PAUSED",
          "AUTH_MISSING",
          "AUTH_EXPIRED",
          "RATE_LIMITED",
          "REQUEST_TIMEOUT",
          "HTTP_ERROR",
          "NETWORK_ERROR",
          "UPSTREAM_UNAVAILABLE",
          "INVALID_RESPONSE",
          "INVALID_PRODUCT",
          "RESPONSE_TOO_LARGE",
          "BUSINESS_OR_SCHEMA_ERROR",
          "PAGINATION_INVALID",
        ]);
        const code =
          error instanceof Error && known.has(error.message)
            ? error.message
            : "STORAGE_ERROR";
        if (code === "STORAGE_ERROR") {
          const diagnostic = error as {
            code?: string;
            constraint?: string;
            routine?: string;
          };
          console.error("Coupon persistence failed", {
            code: diagnostic?.code ?? "UNKNOWN",
            constraint: diagnostic?.constraint,
            routine: diagnostic?.routine,
          });
        }
        if (code === "PAUSED") return;
        if (
          ["NETWORK_ERROR", "UPSTREAM_UNAVAILABLE"].includes(code) &&
          t.retries < 2
        ) {
          const retryAt = new Date(
            Date.now() + (opts.retryDelayMs ?? 5000) * 2 ** t.retries,
          );
          await db.query(
            "UPDATE coupon_tasks SET retries=retries+1,retry_at=$3,error_code=$4 WHERE run_id=$1 AND brand_id=$2",
            [t.run_id, t.brand_id, retryAt.toISOString(), code],
          );
          continue;
        }
        if (
          [
            "AUTH_MISSING",
            "AUTH_EXPIRED",
            "RATE_LIMITED",
            "REQUEST_TIMEOUT",
            "BUSINESS_OR_SCHEMA_ERROR",
            "INVALID_RESPONSE",
            "STORAGE_ERROR",
          ].includes(code)
        ) {
          await db.query(
            "UPDATE coupon_settings SET pause_reason=$1 WHERE id=1",
            [code],
          );
          return;
        }
        await db.query(
          "UPDATE coupon_tasks SET state='partial',error_code=$3 WHERE run_id=$1 AND brand_id=$2",
          [t.run_id, t.brand_id, code],
        );
      }
    }
  }
  function kick() {
    if (!worker && !stopping)
      worker = process()
        .catch(async () => {
          await db.query(
            "UPDATE coupon_settings SET pause_reason='WORKER_ERROR' WHERE id=1",
          );
        })
        .finally(() => {
          worker = undefined;
        });
  }
  async function start(ids?: string[], slot?: string) {
    if (creating) throw new Error("RUN_BUSY");
    creating = true;
    try {
      let existing: { id: string; slot: string | null } | undefined = (
        await db.query<{ id: string; slot: string | null }>(
          "SELECT id,slot FROM coupon_runs WHERE status='running' ORDER BY started_at,id LIMIT 1",
        )
      ).rows[0];
      if (
        slot &&
        (await db.query("SELECT 1 FROM coupon_runs WHERE slot=$1", [slot])).rows
          .length
      )
        return null;
      // A scheduled slot is a distinct observation; a manual trigger may still merge.
      if (slot && existing?.slot !== slot) existing = undefined;
      const brands = (
        await db.query<{
          id: string;
          name: string;
          aliases: string[];
          category: string;
        }>(
          `SELECT id,name,aliases,category FROM brands WHERE active=true ${ids ? "AND id=ANY($1::uuid[])" : ""} ORDER BY name,id`,
          ids ? [ids] : [],
        )
      ).rows;
      if (!brands.length) throw new Error("NO_BRANDS");
      const id = existing?.id ?? randomUUID();
      await db.transaction(async (tx) => {
        if (existing)
          await tx.query(
            "UPDATE coupon_runs SET status='running',finished_at=NULL WHERE id=$1",
            [id],
          );
        else
          await tx.query(
            "INSERT INTO coupon_runs(id,slot,status) VALUES($1,$2,'running')",
            [id, slot ?? null],
          );
        for (const [position, b] of brands.entries()) {
          await tx.query(
            "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,query_signature,position,category) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(run_id,brand_id) DO NOTHING",
            [
              id,
              b.id,
              b.name,
              JSON.stringify(b.aliases),
              querySignature(b.name, b.aliases, b.category),
              position,
              b.category,
            ],
          );
          // Explicit recollection may refresh an untouched queued identity, but
          // must never mix a changed query into already collected pages.
          if (ids)
            await tx.query(
              `UPDATE coupon_tasks t SET name=$3,aliases=$4,query_signature=$5,category=$6,position=-1
             WHERE t.run_id=$1 AND t.brand_id=$2 AND t.state='queued' AND t.pages=0
             AND NOT EXISTS(SELECT 1 FROM coupon_requests r WHERE r.run_id=t.run_id AND r.brand_id=t.brand_id AND r.outcome='in_flight')`,
              [
                id,
                b.id,
                b.name,
                JSON.stringify(b.aliases),
                querySignature(b.name, b.aliases, b.category),
                b.category,
              ],
            );
        }
      });
      kick();
      return id;
    } finally {
      creating = false;
    }
  }
  let joinedCurrentRound = false;
  async function schedule() {
    const s = await settings();
    if (s.enabled && !s.pause_reason && !stopping && !creating) {
      // One round at a time. A new round begins only after the previous one drains.
      const running = (
        await db.query(
          "SELECT 1 FROM coupon_runs WHERE status='running' LIMIT 1",
        )
      ).rows.length;
      if (!running) {
        if (
          !(await db.query("SELECT 1 FROM brands WHERE active LIMIT 1")).rows
            .length
        )
          return;
        await start();
        joinedCurrentRound = true;
      } else if (!joinedCurrentRound) {
        // Upgrade/resume an old partial brand list without discarding completed work.
        await start();
        joinedCurrentRound = true;
      }
      kick();
    }
  }
  function register(app: Express) {
    app.get("/api/v3/brands/:id/icon", async (req, res) => {
      const id = z.uuid().parse(req.params.id);
      const item = (
        await db.query<{ mime: string; content: string }>(
          "SELECT mime,content FROM brand_icons WHERE brand_id=$1",
          [id],
        )
      ).rows[0];
      if (!item) return res.sendStatus(404);
      res.setHeader("Content-Type", item.mime);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.send(Buffer.from(item.content, "base64"));
    });
    app.get("/api/v3/coupons/:id/summary", async (req, res) => {
      const id = z.string().regex(/^\d+$/).parse(req.params.id);
      const brand = z.uuid().parse(req.query.brand_id);
      const item = (
        await db.query(
          `SELECT b.name AS brand_name,b.icon_url,i.payload->>'name' AS title,
        i.payload->'price_min_fen' AS price_fen,i.payload->'origin_price_fen' AS origin_price_fen,
        i.payload->>'poi_name' AS shop_name,i.payload->>'address' AS address,i.payload->>'sale_end' AS sale_end
        FROM coupon_items i JOIN brands b ON b.id=i.brand_id
        WHERE i.brand_id=$1 AND i.product_id=$2 AND i.payload->>'identity'='name_match'
        ORDER BY i.observed_at DESC LIMIT 1`,
          [brand, id],
        )
      ).rows[0];
      if (!item)
        return res.status(404).json({ error: { message: "暂无该券信息" } });
      res.json({ item });
    });
    app.get("/api/v3/coupons/:id/condition-comparison", async (req, res) => {
      const id = z.string().regex(/^\d+$/).parse(req.params.id);
      const brand = z.uuid().parse(req.query.brand_id);
      const item = await readConditionComparison(db, id, brand);
      if (!item)
        return res
          .status(404)
          .json({ error: { message: "本轮完整基线中没有该券" } });
      res.json(item);
    });
    app.post("/api/v3/stores/backfill", async (req, res) => {
      const input = z
        .object({ brand_id: z.uuid().optional() })
        .strict()
        .parse(req.body);
      if (!storesEnabled)
        return res.status(409).json({ error: { message: "门店来源未配置" } });
      const queued = await storeWorker.enqueue(input.brand_id);
      kick();
      res.status(202).json({ queued });
    });
    app.get("/api/v3/stores/status", async (_req, res) =>
      res.json({
        items: (
          await db.query(
            "SELECT state,count(*)::int AS count FROM coupon_store_tasks GROUP BY state ORDER BY state",
          )
        ).rows,
      }),
    );
    app.get("/api/v3/coupons/:id/stores", async (req, res) => {
      const id = z.string().regex(/^\d+$/).parse(req.params.id);
      const brand = z.uuid().optional().parse(req.query.brand_id);
      if (brand)
        return res.json(await currentCouponDetail(db, brand, id, "stores"));
      res.json({
        items: (
          await db.query(
            "SELECT run_id,observed_at,payload FROM coupon_store_snapshots WHERE product_id=$1 ORDER BY observed_at DESC LIMIT 20",
            [id],
          )
        ).rows,
        tasks: (
          await db.query(
            "SELECT t.run_id,t.state,t.error_code,t.scope,t.cursor FROM coupon_store_tasks t JOIN coupon_runs r ON r.id=t.run_id WHERE t.product_id=$1 ORDER BY r.started_at DESC LIMIT 20",
            [id],
          )
        ).rows,
      });
    });
    app.get("/api/v3/brand-coverage", async (_req, res) =>
      res.json(await brandCoverage(db)),
    );
    app.post("/api/v3/rules/backfill", async (req, res) => {
      const input = z
        .object({ brand_id: z.uuid().optional() })
        .strict()
        .parse(req.body);
      if (!rulesEnabled)
        return res.status(409).json({ error: { message: "规则采集尚未配置" } });
      const queued = await ruleWorker.enqueue(input.brand_id);
      kick();
      res.status(202).json({ queued });
    });
    app.get("/api/v3/rules/status", async (_req, res) =>
      res.json({
        items: (
          await db.query(
            "SELECT state,count(*)::int AS count FROM coupon_rule_tasks GROUP BY state ORDER BY state",
          )
        ).rows,
      }),
    );
    app.get("/api/v3/coupons/:id/use-outlook", async (req, res) => {
      const id = z.string().regex(/^\d+$/).parse(req.params.id),
        brand = z.uuid().parse(req.query.brand_id);
      const result = await currentCouponDetail(db, brand, id, "rules");
      res.json({
        context: result.context,
        ...couponUseOutlook({
          price_observed_at: result.context.price_observed_at ?? "",
          rules_observed_at: result.items[0]?.observed_at ?? null,
          rules:
            (result.items[0]?.payload.rules as RuleText[] | undefined) ?? null,
        }),
      });
    });
    app.get("/api/v3/coupons/:id/rules", async (req, res) => {
      const id = z.string().regex(/^\d+$/).parse(req.params.id);
      const brand = z.uuid().optional().parse(req.query.brand_id);
      if (brand) {
        const result = await currentCouponDetail(db, brand, id, "rules");
        return res.json({
          ...result,
          use_outlook: couponUseOutlook({
            price_observed_at: result.context.price_observed_at ?? "",
            rules_observed_at: result.items[0]?.observed_at ?? null,
            rules:
              (result.items[0]?.payload.rules as RuleText[] | undefined) ??
              null,
          }),
          items: result.items.map((row) => ({
            ...row,
            payload: {
              ...row.payload,
              structured: structureRules(
                row.payload.groups as Group[],
                row.payload.rules as RuleText[],
              ),
            },
          })),
        });
      }
      const rows = (
        await db.query<{
          run_id: string;
          observed_at: string;
          payload: { groups: Group[]; rules: RuleText[] };
        }>(
          "SELECT run_id,observed_at,payload FROM coupon_rule_snapshots WHERE product_id=$1 ORDER BY observed_at DESC LIMIT 20",
          [id],
        )
      ).rows;
      res.json({
        items: rows.map((row, index) => ({
          ...row,
          payload: {
            ...row.payload,
            structured: structureRules(row.payload.groups, row.payload.rules),
          },
          comparison: ruleChanges(row.payload, rows[index + 1]?.payload),
        })),
      });
    });
    app.get("/api/v3/brands", async (_req, res) =>
      res.json({
        items: (
          await db.query(
            "SELECT br.id,br.name,br.category,br.active,br.icon_url,t.completed_at AS last_collected_at FROM brands br LEFT JOIN coupon_baselines b ON b.brand_id=br.id LEFT JOIN coupon_tasks t ON t.run_id=b.run_id AND t.brand_id=br.id ORDER BY br.name,br.id",
          )
        ).rows,
      }),
    );
    app.get("/api/v3/status", async (_req, res) =>
      res.json({
        ...(await settings()),
        worker_active: !!worker,
        request_pending: requestDeadline.pending,
        credential_configured: opts.credentialPath
          ? await access(opts.credentialPath).then(
              () => true,
              () => false,
            )
          : false,
        schedule: "全天串行循环，每轮覆盖所有启用品牌",
        mode: "continuous",
        concurrency: 1,
        interval_ms: [3000, 5000],
        missing_sources: [
          "月售速度历史与统计口径",
          "平台指数",
          "环境适配与节假日核销条件",
          "规则结构化与全部适用门店核验",
        ],
        stage: "券快照、月售热度与天气背景",
        query_scope: "上海 · 美食及游玩 · 不限直播/短视频",
      }),
    );
    app.get("/api/v3/runs", async (_req, res) =>
      res.json({
        items: (
          await db.query(
            "SELECT r.*,extract(epoch from(coalesce(r.finished_at,now())-r.started_at))::int AS duration_seconds,(SELECT count(*)::int FROM coupon_runs prev WHERE prev.started_at<=r.started_at) AS round_number, (SELECT count(*)::int FROM coupon_tasks t WHERE t.run_id=r.id) AS total,(SELECT count(*)::int FROM coupon_tasks t WHERE t.run_id=r.id AND t.state='complete') AS completed,(SELECT count(*)::int FROM coupon_tasks t WHERE t.run_id=r.id AND t.state='partial') AS partial,(SELECT coalesce(sum(t.pages),0)::int FROM coupon_tasks t WHERE t.run_id=r.id) AS pages,(SELECT json_build_object('name',t.name,'pages',t.pages) FROM coupon_tasks t WHERE t.run_id=r.id AND t.state='queued' AND (t.retry_at IS NULL OR t.retry_at<=now()) ORDER BY (t.pages/3),t.position,t.name,t.brand_id LIMIT 1) AS current_brand FROM coupon_runs r ORDER BY started_at DESC LIMIT 30",
          )
        ).rows,
      }),
    );
    app.get("/api/v3/runs/:id", async (req, res) => {
      const id = z.uuid().parse(req.params.id);
      res.json({
        items: (
          await db.query(
            "SELECT t.brand_id,t.name,t.state,t.pages,t.error_code,t.retries,t.retry_at,t.comparison_status,t.completed_at,t.previous_run_id,coalesce(t.archived_recalled,(SELECT count(*)::int FROM coupon_items i WHERE i.run_id=t.run_id AND i.brand_id=t.brand_id)) AS recalled,coalesce(t.archived_matched,(SELECT count(*)::int FROM coupon_items i WHERE i.run_id=t.run_id AND i.brand_id=t.brand_id AND i.payload->>'identity'='name_match')) AS matched FROM coupon_tasks t WHERE run_id=$1 ORDER BY name",
            [id],
          )
        ).rows,
      });
    });
    app.get("/api/v3/runs/:id/requests", async (req, res) => {
      const id = z.uuid().parse(req.params.id);
      const { offset, limit } = z
        .object({
          offset: z.coerce.number().int().min(0).default(0),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .parse(req.query);
      const items = (
        await db.query(
          "SELECT q.*,b.name AS brand_name FROM coupon_requests q JOIN brands b ON b.id=q.brand_id WHERE run_id=$1 ORDER BY started_at,id LIMIT $2 OFFSET $3",
          [id, limit, offset],
        )
      ).rows;
      const summary = (
        await db.query(
          "SELECT count(*)::int AS total,min(gap_ms) AS min_gap_ms,count(*) FILTER (WHERE gap_ms < 1000)::int AS short_gaps,count(*) FILTER (WHERE outcome <> 'OK' AND outcome <> 'in_flight')::int AS non_success FROM coupon_requests WHERE run_id=$1",
          [id],
        )
      ).rows[0];
      res.json({ items, summary, offset, limit });
    });
    app.post("/api/v3/runs", async (req, res) => {
      const input = z
        .object({ brand_ids: z.array(z.uuid()).min(1).max(500).optional() })
        .parse(req.body);
      if ((await settings()).pause_reason)
        return res
          .status(409)
          .json({ error: { message: "采集已暂停，请检查来源后恢复" } });
      res.status(202).json({ id: await start(input.brand_ids) });
    });
    app.patch("/api/v3/settings", async (req, res) => {
      const v = z
        .object({
          enabled: z.boolean().optional(),
          paused: z.boolean().optional(),
        })
        .strict()
        .parse(req.body);
      if (v.enabled !== undefined)
        await db.query("UPDATE coupon_settings SET enabled=$1 WHERE id=1", [
          v.enabled,
        ]);
      if (v.paused !== undefined)
        await db.query(
          "UPDATE coupon_settings SET pause_reason=$1 WHERE id=1",
          [v.paused ? "USER_PAUSED" : null],
        );
      // A pause prevents the next request; the current request may still drain.
      // Never tie the HTTP response to a potentially stalled transport.
      if (v.paused === false || v.enabled === true) {
        await schedule();
        kick();
      }
      res.json({
        ...(await settings()),
        worker_active: !!worker,
        request_pending: requestDeadline.pending,
      });
    });
    app.get("/api/v3/brand-candidates", async (_req, res) => {
      const items = (
        await db.query(
          "SELECT c.*,b.name AS brand_name,EXISTS(SELECT 1 FROM coupon_brand_candidates other WHERE other.platform_brand_id=c.platform_brand_id AND other.brand_id<>c.brand_id) AS conflict,'name_candidate' AS verification FROM coupon_brand_candidates c JOIN brands b ON b.id=c.brand_id ORDER BY b.name,c.platform_brand_id",
        )
      ).rows;
      res.json({ items });
    });
    app.get("/api/v3/opportunities", async (req, res) => {
      const input = z
        .object({
          view: z
            .enum(["all", "changes", "matched", "unresolved", "not_seen"])
            .default("all"),
          brand_id: z.uuid().optional(),
          offset: z.coerce.number().int().min(0).default(0),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .parse(req.query);
      const source =
        input.view === "not_seen"
          ? "(SELECT run_id,brand_id,product_id,old_payload AS payload,observed_at FROM coupon_diffs WHERE kind='NOT_SEEN')"
          : "coupon_items";
      const clauses = ["i.run_id=b.run_id"];
      if (input.view === "changes")
        clauses.push("d.kind NOT IN ('BASELINE','BASELINE_RESET','UNCHANGED')");
      if (input.view === "matched")
        clauses.push("i.payload->>'identity'='name_match'");
      if (input.view === "unresolved")
        clauses.push("i.payload->>'identity'<>'name_match'");
      if (input.brand_id) clauses.push("i.brand_id=$1");
      const values: (string | number)[] = input.brand_id
        ? [input.brand_id]
        : [];
      const total = (
        await db.query<{ total: number }>(
          `SELECT count(*)::int AS total FROM ${source} i JOIN coupon_baselines b ON b.brand_id=i.brand_id LEFT JOIN coupon_diffs d ON d.run_id=i.run_id AND d.brand_id=i.brand_id AND d.product_id=i.product_id WHERE ${clauses.join(" AND ")}`,
          values,
        )
      ).rows[0].total;
      values.push(input.limit, input.offset);
      const conflicts = new Set(
        (
          await db.query<{ platform_brand_id: string }>(
            "SELECT platform_brand_id FROM coupon_brand_candidates GROUP BY platform_brand_id HAVING count(DISTINCT brand_id)>1",
          )
        ).rows.map((x) => x.platform_brand_id),
      );
      res.json({
        total,
        offset: input.offset,
        limit: input.limit,
        items: (
          await db.query<{
            payload: Coupon;
            old_payload: Coupon | null;
            historical_only: boolean;
          }>(
            `SELECT i.*,br.name AS brand_name,d.kind,d.old_payload,t.comparison_status,t.completed_at AS snapshot_completed_at,(d.kind='NOT_SEEN') AS historical_only,NULL AS score,'watch' AS gate_status FROM ${source} i JOIN coupon_baselines b ON b.brand_id=i.brand_id JOIN coupon_tasks t ON t.run_id=i.run_id AND t.brand_id=i.brand_id JOIN brands br ON br.id=i.brand_id LEFT JOIN coupon_diffs d ON d.run_id=i.run_id AND d.brand_id=i.brand_id AND d.product_id=i.product_id WHERE ${clauses.join(" AND ")} ORDER BY i.observed_at DESC,i.brand_id,i.product_id LIMIT $${values.length - 1} OFFSET $${values.length}`,
            values,
          )
        ).rows.map((item) => ({
          ...item,
          opportunity: salesEvidenceAssessment(),
          assessment: assessCoupon(
            item.payload,
            item.historical_only ? null : item.old_payload,
            conflicts.has(item.payload.platform_brand_id),
          ),
        })),
      });
    });
    app.get("/api/v3/coupons/:id/history", async (req, res) => {
      const id = z.string().regex(/^\d+$/).parse(req.params.id);
      const { brand_id } = z
        .object({ brand_id: z.uuid().optional() })
        .parse(req.query);
      res.json({
        items: (
          await db.query(
            `SELECT i.*,t.comparison_status FROM coupon_items i JOIN coupon_tasks t ON t.run_id=i.run_id AND t.brand_id=i.brand_id WHERE i.product_id=$1 AND t.state='complete' ${brand_id ? "AND i.brand_id=$2" : ""} ORDER BY i.observed_at DESC,i.run_id,i.brand_id LIMIT 100`,
            brand_id ? [id, brand_id] : [id],
          )
        ).rows,
      });
    });
  }
  return {
    register,
    enqueueRules: ruleWorker.enqueue,
    start,
    schedule,
    kick,
    drain: async () => {
      await worker;
    },
    stop: async () => {
      stopping = true;
      await worker;
    },
  };
}
