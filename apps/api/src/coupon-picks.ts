import type { PGlite } from "@electric-sql/pglite";
import { categories, inChannel } from "@radar/contracts";
import type { Express } from "express";
import { z } from "zod";
import { ownerOf } from "./accounts.js";
import { readBrandBlacklist } from "./brand-blacklist.js";
import { type BrandIndex, indexAvailable } from "./brand-index.js";
import { couponUseOutlook } from "./coupon-use-outlook.js";
import type { createEnvironment } from "./environment.js";
import type { BoardCandidate } from "./opportunity-board.js";
import { pickPriority } from "./pick-priority.js";
import { readModel } from "./read-model-cache.js";
import type { RuleText } from "./rule-structure.js";
import type { createSalesHeat } from "./sales-heat.js";
import { applyUsePenalty } from "./use-priority.js";

type HeatRow = Awaited<
  ReturnType<ReturnType<typeof createSalesHeat>["read"]>
>[number];
type Heat = Omit<HeatRow, "sale_end"> & {
  sale_end?: unknown;
  category?: string;
};
type Signal = Pick<
  BoardCandidate,
  | "brand_id"
  | "product_id"
  | "run_id"
  | "observed_at"
  | "kind"
  | "disposition"
  | "previous_price_fen"
  | "saving_fen"
  | "reduction_rate"
  | "reason"
>;
export type PickRules = {
  run_id: string;
  product_id: string;
  observed_at: string;
  rules: RuleText[];
};
export function combinePicks(
  heat: Heat[],
  signals: Signal[],
  now = Date.now(),
  watched: { brand_id: string; product_id: string }[] = [],
  rules: PickRules[] = [],
  indices: BrandIndex[] = [],
  historicalRules: (PickRules & {
    brand_id: string;
    price_observed_at: string;
  })[] = [],
  discoveries: {
    brand_id: string;
    product_id: string;
    discovered_at: string;
  }[] = [],
) {
  const fresh = new Map(
    discoveries.map((d) => [`${d.brand_id}:${d.product_id}`, d.discovered_at]),
  );
  const historical = new Map(
    historicalRules.map((r) => [`${r.brand_id}:${r.product_id}`, r]),
  );
  const byIndex = new Map(indices.map((x) => [x.brand_id, x]));
  const byRules = new Map(rules.map((x) => [`${x.run_id}:${x.product_id}`, x]));
  const watching = new Set(watched.map((x) => `${x.brand_id}:${x.product_id}`));
  const byKey = new Map(
    signals.map((x) => [`${x.brand_id}:${x.product_id}`, x]),
  );
  return heat.flatMap((x) => {
    const discoveredAt = fresh.get(`${x.brand_id}:${x.product_id}`) ?? null;
    const isNew =
      discoveredAt !== null &&
      now >= Date.parse(discoveredAt) &&
      now < Date.parse(discoveredAt) + 24 * 3600000;
    const brandIndex = byIndex.get(x.brand_id);
    const usableIndex = brandIndex ? indexAvailable(brandIndex, now) : false;
    const latest = x.samples[0];
    const age = now - Date.parse(latest?.observed_at ?? "");
    if (!Number.isFinite(age) || age < 0 || age > 36 * 3600000) return [];
    const candidate = byKey.get(`${x.brand_id}:${x.product_id}`);
    // Readers can straddle a baseline commit; never join evidence from different scans.
    const signal =
      candidate?.run_id === latest.run_id &&
      Date.parse(candidate.observed_at) === Date.parse(latest.observed_at)
        ? candidate
        : undefined;
    if (signal?.disposition === "dismissed") return [];
    const evidence = byRules.get(`${latest.run_id}:${x.product_id}`);
    const outlook = couponUseOutlook(
      {
        price_observed_at: latest.observed_at,
        rules_observed_at: evidence?.observed_at ?? null,
        rules: evidence?.rules ?? null,
      },
      now,
    );
    const previousRule = historical.get(`${x.brand_id}:${x.product_id}`);
    const previousOutlook =
      outlook.evidence_status !== "current" &&
      previousRule &&
      previousRule.run_id !== latest.run_id
        ? couponUseOutlook(
            {
              price_observed_at: previousRule.price_observed_at,
              rules_observed_at: previousRule.observed_at,
              rules: previousRule.rules,
            },
            now,
          )
        : null;
    return [
      {
        discovered_at: discoveredAt,
        is_new: isNew,
        run_id: latest.run_id,
        sale_end: x.sale_end ?? null,
        usage_inputs: {
          current: {
            price_observed_at: latest.observed_at,
            rules_observed_at: evidence?.observed_at ?? null,
            rules: evidence?.rules ?? null,
          },
          historical: previousRule
            ? {
                price_observed_at: previousRule.price_observed_at,
                rules_observed_at: previousRule.observed_at,
                rules: previousRule.rules,
              }
            : null,
        },
        use_outlook: outlook,
        brand_index: brandIndex ? { ...brandIndex, usable: usableIndex } : null,
        priority: applyUsePenalty(
          pickPriority({
            is_new: isNew,
            discount_rate: x.discount.rate,
            brand_growth: usableIndex ? brandIndex!.mom : null,
            speed: x.speed,
            acceleration: x.acceleration,
            reduction_rate: signal?.reduction_rate ?? null,
          }),
          outlook,
          previousOutlook,
        ),
        query_signature: latest.query_signature,
        brand_id: x.brand_id,
        brand_name: x.brand_name,
        category: x.category ?? "其他餐饮",
        product_id: x.product_id,
        title: x.title,
        watching:
          watching.has(`${x.brand_id}:${x.product_id}`) ||
          signal?.disposition === "watching",
        observed_at: latest.observed_at,
        price_fen: x.price_fen,
        origin_price_fen: x.origin_price_fen,
        discount: x.discount,
        previous_price_fen: signal?.previous_price_fen ?? null,
        saving_fen: signal?.saving_fen ?? null,
        reduction_rate: signal?.reduction_rate ?? null,
        kind: signal?.kind ?? "no_verified_change",
        change_reason: signal?.reason ?? "当前没有可关联的优惠变化证据",
        speed: x.speed,
        acceleration: x.acceleration,
        previous_speed: x.previous_speed,
        net_change: x.net_change,
        hours: x.hours,
        reason: x.reason,
        acceleration_reason: x.acceleration_reason,
        content_comparison: x.content_comparison,
        latest_sales: latest.monthly_sales,
        previous_sales: x.samples[1]?.monthly_sales ?? null,
      },
    ];
  });
}
const inputSchema = z.object({
  view: z
    .enum([
      "all",
      "recommended",
      "value_rising",
      "price_drop",
      "accelerating",
      "new",
      "watching",
    ])
    .default("all"),
  order: z
    .enum(["priority", "speed", "acceleration", "saving", "newest"])
    .optional(),
  search: z.string().max(100).default(""),
  brand_id: z.uuid().optional(),
  category: z.enum(categories).optional(),
  channel: z.enum(["food", "leisure", "all"]).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export function priorityAdmission(x: ReturnType<typeof combinePicks>[number]) {
  const rate = x.priority.value_gate.rate;
  if (
    x.use_outlook.fully_excluded ||
    !x.priority.value_gate.eligible ||
    rate == null ||
    rate < 0.2
  )
    return false;
  // A new coupon may lack comparable sales; only a substantial discount earns entry.
  if (x.is_new && rate >= 0.4 && x.priority.score >= 30) return true;
  const growing =
    x.speed != null &&
    x.speed >= 1 &&
    x.net_change != null &&
    x.net_change >= 5 &&
    x.hours != null &&
    x.hours >= 0.5;
  const cheaper =
    x.kind === "price_drop" &&
    (x.reduction_rate ?? 0) >= 0.1 &&
    (x.saving_fen ?? 0) >= 1000;
  return x.priority.score >= 40 && (growing || cheaper);
}
export function isHotPick(x: ReturnType<typeof combinePicks>[number]) {
  const speed = x.speed;
  const previous = x.previous_speed;
  if (
    speed == null ||
    previous == null ||
    !Number.isFinite(speed) ||
    !Number.isFinite(previous) ||
    previous < 0
  )
    return false;
  return (
    !x.use_outlook.fully_excluded &&
    speed >= 5 &&
    (x.acceleration ?? 0) > 0 &&
    (x.net_change ?? 0) >= 10 &&
    (x.hours ?? 0) >= 1 &&
    speed - previous >= 2 &&
    (previous === 0 ? speed >= 10 : speed >= previous * 1.3)
  );
}
export function selectPicks(
  items: ReturnType<typeof combinePicks>,
  q: z.infer<typeof inputSchema>,
  blockedBrands: ReadonlySet<string> = new Set(),
  excludeBlockedFromAll = false,
) {
  items = items.filter(
    (x) =>
      inChannel(x.category, q.channel) &&
      (!excludeBlockedFromAll || !blockedBrands.has(x.brand_id)),
  );
  const brandCounts = new Map<string, number>();
  const ranked = items
    .filter((x) => !blockedBrands.has(x.brand_id) && priorityAdmission(x))
    .sort(
      (a, b) =>
        b.priority.score - a.priority.score ||
        `${a.brand_id}:${a.product_id}`.localeCompare(
          `${b.brand_id}:${b.product_id}`,
        ),
    )
    .filter((x) => {
      const count = brandCounts.get(x.brand_id) ?? 0;
      if (count >= 3) return false;
      brandCounts.set(x.brand_id, count + 1);
      return true;
    })
    .slice(0, 500);
  const top = new Set(ranked.map((x) => `${x.brand_id}:${x.product_id}`));
  const scoped = items.filter(
    (x) =>
      (!q.brand_id || x.brand_id === q.brand_id) &&
      (!q.category || x.category === q.category) &&
      `${x.brand_name} ${x.title}`
        .toLowerCase()
        .includes(q.search.trim().toLowerCase()),
  );
  const matches = (x: (typeof items)[number], v: string) =>
    v === "recommended"
      ? top.has(`${x.brand_id}:${x.product_id}`)
      : v === "watching"
        ? x.watching
        : v === "value_rising"
          ? x.kind === "price_drop" && (x.speed ?? 0) > 0
          : v === "price_drop"
            ? x.kind === "price_drop"
            : v === "accelerating"
              ? isHotPick(x)
              : v === "new"
                ? x.is_new === true
                : true;
  const counts = Object.fromEntries(
    [
      "all",
      "recommended",
      "value_rising",
      "price_drop",
      "accelerating",
      "new",
      "watching",
    ].map((v) => [v, scoped.filter((x) => matches(x, v)).length]),
  );
  const order = q.order ?? (q.view === "new" ? "newest" : "priority");
  const value = (x: (typeof items)[number]) =>
    order === "priority"
      ? x.priority.score
      : order === "acceleration"
        ? x.acceleration
        : order === "saving"
          ? x.saving_fen
          : order === "newest"
            ? Date.parse(
                q.view === "new" ? (x.discovered_at ?? "") : x.observed_at,
              ) || 0
            : x.speed;
  const filtered = scoped
    .filter((x) => matches(x, q.view))
    .sort((a, b) => {
      const av = value(a),
        bv = value(b);
      return av === bv
        ? `${a.brand_id}:${a.product_id}`.localeCompare(
            `${b.brand_id}:${b.product_id}`,
          )
        : av === null
          ? 1
          : bv === null
            ? -1
            : bv - av;
    });
  return { counts, filtered };
}
export function picksCsv(items: ReturnType<typeof combinePicks>) {
  const cell = (v: unknown) => {
    let s = v == null ? "" : String(v);
    if (typeof v !== "number" && /^[\s]*[=+@-]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return (
    "\uFEFF" +
    [
      [
        "优先分（非概率）",
        "基础分",
        "优惠系数",
        "优惠门槛依据",
        "使用限制降分依据",
        "已具备指标权重",
        "缺失指标",
        "72小时可用判断",
        "禁用日期与依据",
        "品牌指数关键词",
        "品牌指数统计截止",
        "品牌指数日均值",
        "品牌指数环比",
        "品牌指数状态",
        "关注状态",
        "品牌",
        "券ID（文本）",
        "券名",
        "当前起价元",
        "平台原价元",
        "相对原价优惠比例",
        "折扣口径",
        "上次起价元",
        "票面降价元",
        "销售增速/小时",
        "加速度/小时²",
        "最新月售原文",
        "采集时间",
        "变化依据",
        "热度依据",
      ],
      ...items.map((x) => [
        x.priority.score,
        x.priority.raw_score,
        x.priority.value_gate.factor,
        x.priority.value_gate.reason,
        x.priority.availability_gate.reason,
        x.priority.coverage,
        x.priority.missing.join("、"),
        x.use_outlook.fully_excluded
          ? "明确全部不可用"
          : x.use_outlook.has_explicit_exclusion
            ? "部分日期不可用"
            : "未确认",
        x.use_outlook.days
          .filter((d) => d.status === "explicitly_excluded")
          .map((d) => `${d.date}: ${d.reasons.join("；")}`)
          .join(" | "),
        x.brand_index?.keyword,
        x.brand_index?.period_end,
        x.brand_index?.daily_average,
        x.brand_index?.mom,
        !x.brand_index
          ? "缺失"
          : x.brand_index.status === "not_indexed"
            ? "未收录"
            : x.brand_index.usable
              ? "有效"
              : "过期",
        x.watching ? "已关注" : "未关注",
        x.brand_name,
        "'" + x.product_id,
        x.title,
        x.price_fen === null ? null : x.price_fen / 100,
        x.origin_price_fen === null ? null : x.origin_price_fen / 100,
        x.discount.rate,
        x.discount.reason,
        x.previous_price_fen === null ? null : x.previous_price_fen / 100,
        x.saving_fen === null ? null : x.saving_fen / 100,
        x.speed,
        x.acceleration,
        x.latest_sales,
        x.observed_at,
        x.change_reason,
        x.reason,
      ]),
    ]
      .map((r) => r.map(cell).join(","))
      .join("\r\n")
  );
}
export function createPickReader(
  db: PGlite | undefined,
  readHeat: () => Promise<Heat[]>,
  readSignals: () => Promise<Signal[]>,
  readIndices?: () => Promise<BrandIndex[]>,
  brand?: string,
) {
  type Historical = (PickRules & {
    brand_id: string;
    price_observed_at: string;
  })[];
  let pending: Promise<Historical> | undefined;
  async function queryHistorical(): Promise<Historical> {
    return db
      ? (
          await db.query<
            PickRules & { brand_id: string; price_observed_at: string }
          >(
            `WITH latest AS (SELECT DISTINCT ON(r.product_id) r.* FROM coupon_rule_snapshots r WHERE r.observed_at > now()-interval '36 hours' AND ($1::uuid IS NULL OR EXISTS(SELECT 1 FROM coupon_history_items ci WHERE ci.brand_id=$1 AND ci.run_id=r.run_id AND ci.product_id=r.product_id)) ORDER BY r.product_id,r.observed_at DESC)
       SELECT DISTINCT ON(i.brand_id,r.product_id) i.brand_id,r.run_id,r.product_id,r.observed_at,i.observed_at AS price_observed_at,r.payload->'rules' AS rules
       FROM latest r JOIN coupon_history_items i ON i.run_id=r.run_id AND i.product_id=r.product_id
       JOIN brands b ON b.id=i.brand_id AND b.active
       WHERE ($1::uuid IS NULL OR i.brand_id=$1) AND r.observed_at > now()-interval '36 hours' AND i.payload->>'identity'='name_match'
       ORDER BY i.brand_id,r.product_id,r.observed_at DESC`,
            [brand ?? null],
          )
        ).rows
      : [];
  }
  async function readHistoricalRules() {
    if (!pending)
      pending = queryHistorical().finally(() => {
        pending = undefined;
      });
    return pending;
  }
  const build = async () => {
    const heat = await readHeat();
    const signals = await readSignals();
    const watched = db
      ? (
          await db.query<{ brand_id: string; product_id: string }>(
            "SELECT brand_id,product_id FROM coupon_dispositions WHERE state='watching'",
          )
        ).rows
      : [];
    const rules = db
      ? (
          await db.query<PickRules>(
            `SELECT r.run_id,r.product_id,r.observed_at,r.payload->'rules' AS rules FROM coupon_rule_snapshots r WHERE EXISTS (SELECT 1 FROM coupon_baselines b JOIN coupon_items i ON i.brand_id=b.brand_id AND i.run_id=b.run_id WHERE b.run_id=r.run_id AND i.product_id=r.product_id AND ($1::uuid IS NULL OR b.brand_id=$1))`,
            [brand ?? null],
          )
        ).rows
      : [];
    const historicalRules = await readHistoricalRules();
    const indices = readIndices ? await readIndices() : [];
    const discoveries = db
      ? (
          await db.query<{
            brand_id: string;
            product_id: string;
            discovered_at: string;
          }>(
            "SELECT brand_id,product_id,discovered_at FROM coupon_discoveries WHERE discovered_at>now()-interval '24 hours' AND ($1::uuid IS NULL OR brand_id=$1)",
            [brand ?? null],
          )
        ).rows
      : [];
    return combinePicks(
      heat,
      signals,
      Date.now(),
      watched,
      rules,
      indices,
      historicalRules,
      discoveries,
    );
  };
  return db && !brand ? readModel(db, "coupon-picks-v5", build) : build;
}

export function registerCouponPicks(
  app: Express,
  readHeat: () => Promise<Heat[]>,
  readSignals: () => Promise<Signal[]>,
  db?: PGlite,
  readEnvironment?: Awaited<ReturnType<typeof createEnvironment>>["status"],
  readIndices?: () => Promise<BrandIndex[]>,
  readPool?: () => Promise<ReturnType<typeof combinePicks>>,
) {
  const readPicks =
    readPool ?? createPickReader(db, readHeat, readSignals, readIndices);
  if (db)
    app.put("/api/v3/coupon-picks/:product/watch", async (req, res) => {
      const product = z.string().regex(/^\d+$/).parse(req.params.product);
      const body = z
        .object({ brand_id: z.uuid(), watching: z.boolean() })
        .strict()
        .parse(req.body);
      if (body.watching) {
        const found = combinePicks(await readHeat(), []).some(
          (x) => x.brand_id === body.brand_id && x.product_id === product,
        );
        if (!found)
          return res.status(409).json({
            error: { message: "该券已离开当前有效快照，请刷新后重试" },
          });
        await db.query(
          "INSERT INTO coupon_dispositions(brand_id,product_id,revision,state) VALUES($1,$2,'watch','watching') ON CONFLICT(brand_id,product_id) DO UPDATE SET state='watching',updated_at=now()",
          [body.brand_id, product],
        );
      } else {
        await db.query(
          "DELETE FROM coupon_dispositions WHERE brand_id=$1 AND product_id=$2 AND state='watching'",
          [body.brand_id, product],
        );
      }
      res.json({ ok: true });
    });
  app.get(
    ["/api/v3/coupon-picks", "/api/v3/coupon-picks.csv"],
    async (req, res) => {
      const q = inputSchema.parse(req.query);
      const blocked = db
        ? await readBrandBlacklist(db, ownerOf(req))
        : new Set<string>();
      const { counts, filtered } = selectPicks(
        await readPicks(),
        q,
        blocked,
        res.locals.miniCouponList === true,
      );
      if (req.path.endsWith(".csv")) {
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="shanghai-coupon-picks.csv"',
        );
        res.type("text/csv").send(picksCsv(filtered));
        return;
      }
      const environment = readEnvironment
        ? await readEnvironment().catch(() => null)
        : null;
      res.json({
        context: environment
          ? { outlook: environment.outlook, source: environment.attribution }
          : null,
        model: {
          version: "priority-v6",
          note: "初始规则排序，非爆款概率。先计算基础分，再乘优惠系数min(1,优惠比例/20%)；优先券要求优惠至少20%、总分至少40分，且有有效销量增长或较上次降价至少10%并节省10元；新券优惠至少40%且总分至少30分可独立入选。每品牌最多3张，不凑满500张。优先使用原价折扣，缺失时用历史降价替代，已知低折扣不能被历史降价抵消。销量速度30、加速度15、原价折扣25、较上次降价10、品牌指数10、新上券10。首次有效发现后24小时内新上券得10分，到期撤销，不随采集刷新延长；首次建库及历史券重新出现不算新上。原价折扣以平台原价为参考，优惠比例达到50%得25分，线性封顶；仅在单一明确售价且原价不低于售价时计算，平台原价不等于历史成交价；缺失项不计分、不重新分配权重。品牌指数使用上海7日搜索指数环比，-25%计0分、持平5分、+25%计10分，线性封顶，超过72小时不计分。天气仅作背景，不推断销量增益。明确禁用日期按未来72小时受限时长降低优先分，节假日禁用最高20分，全窗口禁用为0分。近36小时历史禁用证据在本轮缺失时仅作待复核提醒并暂限20分，不当作当前确认。",
        },
        counts,
        total: filtered.length,
        pool_limit: 500,
        items: filtered
          .slice(q.offset, q.offset + q.limit)
          .map((x) => ({ ...x, is_hot: isHotPick(x) })),
        calculated_at: filtered[0]?.use_outlook.generated_at ?? null,
        generated_at: new Date().toISOString(),
      });
    },
  );
}
