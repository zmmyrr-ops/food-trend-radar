import type { PGlite } from "@electric-sql/pglite";
import type { Express } from "express";
import { z } from "zod";
import { type BrandIndex, indexAvailable } from "./brand-index.js";
import { couponUseOutlook } from "./coupon-use-outlook.js";
import type { createEnvironment } from "./environment.js";
import type { BoardCandidate } from "./opportunity-board.js";
import { pickPriority } from "./pick-priority.js";
import type { RuleText } from "./rule-structure.js";
import type { createSalesHeat } from "./sales-heat.js";

type Heat = Awaited<
  ReturnType<ReturnType<typeof createSalesHeat>["read"]>
>[number];
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
) {
  const byIndex = new Map(indices.map((x) => [x.brand_id, x]));
  const byRules = new Map(rules.map((x) => [`${x.run_id}:${x.product_id}`, x]));
  const watching = new Set(watched.map((x) => `${x.brand_id}:${x.product_id}`));
  const byKey = new Map(
    signals.map((x) => [`${x.brand_id}:${x.product_id}`, x]),
  );
  return heat.flatMap((x) => {
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
    return [
      {
        use_outlook: couponUseOutlook(
          {
            price_observed_at: latest.observed_at,
            rules_observed_at: evidence?.observed_at ?? null,
            rules: evidence?.rules ?? null,
          },
          now,
        ),
        brand_index: brandIndex ? { ...brandIndex, usable: usableIndex } : null,
        priority: pickPriority({
          discount_rate: x.discount.rate,
          brand_growth: usableIndex ? brandIndex!.mom : null,
          speed: x.speed,
          acceleration: x.acceleration,
          reduction_rate: signal?.reduction_rate ?? null,
        }),
        query_signature: latest.query_signature,
        brand_id: x.brand_id,
        brand_name: x.brand_name,
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
    .default("priority"),
  search: z.string().max(100).default(""),
  brand_id: z.uuid().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export function selectPicks(
  items: ReturnType<typeof combinePicks>,
  q: z.infer<typeof inputSchema>,
) {
  const scoped = items.filter(
    (x) =>
      (!q.brand_id || x.brand_id === q.brand_id) &&
      `${x.brand_name} ${x.title}`
        .toLowerCase()
        .includes(q.search.trim().toLowerCase()),
  );
  const matches = (x: (typeof items)[number], v: string) =>
    v === "recommended"
      ? !x.use_outlook.fully_excluded && x.priority.score > 0
      : v === "watching"
        ? x.watching
        : v === "value_rising"
          ? x.kind === "price_drop" && (x.speed ?? 0) > 0
          : v === "price_drop"
            ? x.kind === "price_drop"
            : v === "accelerating"
              ? (x.speed ?? 0) > 0 && (x.acceleration ?? 0) > 0
              : v === "new"
                ? x.kind === "first_observed"
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
  const value = (x: (typeof items)[number]) =>
    q.order === "priority"
      ? x.priority.score
      : q.order === "acceleration"
        ? x.acceleration
        : q.order === "saving"
          ? x.saving_fen
          : q.order === "newest"
            ? Date.parse(x.observed_at)
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
        "月售净增速度/小时",
        "加速度/小时²",
        "最新月售原文",
        "采集时间",
        "变化依据",
        "热度依据",
      ],
      ...items.map((x) => [
        x.priority.score,
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
) {
  return async () => {
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
            `SELECT r.run_id,r.product_id,r.observed_at,r.payload->'rules' AS rules FROM coupon_rule_snapshots r WHERE EXISTS (SELECT 1 FROM coupon_baselines b WHERE b.run_id=r.run_id)`,
          )
        ).rows
      : [];
    const indices = readIndices ? await readIndices() : [];
    return combinePicks(heat, signals, Date.now(), watched, rules, indices);
  };
}

export function registerCouponPicks(
  app: Express,
  readHeat: () => Promise<Heat[]>,
  readSignals: () => Promise<Signal[]>,
  db?: PGlite,
  readEnvironment?: Awaited<ReturnType<typeof createEnvironment>>["status"],
  readIndices?: () => Promise<BrandIndex[]>,
) {
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
      const { counts, filtered } = selectPicks(
        await createPickReader(db, readHeat, readSignals, readIndices)(),
        q,
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
          version: "priority-v3",
          note: "初始规则排序，非爆款概率。销量速度30、加速度15、原价折扣25、较上次降价10、品牌指数10、环境适配10。原价折扣以平台原价为参考，优惠比例达到50%得25分，线性封顶；仅在单一明确售价且原价不低于售价时计算，平台原价不等于历史成交价；缺失项不计分、不重新分配权重。品牌指数使用上海7日搜索指数环比，-25%计0分、持平5分、+25%计10分，线性封顶，超过72小时不计分。天气与节假日目前仅作背景，不推断销量增益。",
        },
        counts,
        total: filtered.length,
        items: filtered.slice(q.offset, q.offset + q.limit),
        generated_at: new Date().toISOString(),
      });
    },
  );
}
