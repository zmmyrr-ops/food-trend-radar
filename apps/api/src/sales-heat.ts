import type { PGlite } from "@electric-sql/pglite";
import type { Express } from "express";
import { z } from "zod";
import { couponDiscount } from "./pick-priority.js";
export function parseSales(raw: string) {
  const s = raw
    .normalize("NFKC")
    .trim()
    .replace(/^月售\s*/, "");
  if (/^\d+$/.test(s) || /^\d{1,3}(,\d{3})+$/.test(s)) {
    const value = Number(s.replaceAll(",", ""));
    if (Number.isSafeInteger(value))
      return { raw, value, precision: "integer_display" as const };
  }
  return { raw, value: null, precision: "unknown_or_abbreviated" as const };
}
export type SalesPoint = {
  run_id: string;
  observed_at: string;
  missing?: boolean;
  query_signature?: string | null;
  rules?: {
    observed_at: string;
    status: string;
    commodity_fingerprint: string;
    rule_fingerprint: string;
  } | null;
  payload: {
    monthly_sales: string;
    platform_brand_id: string;
    identity: string;
    origin_price_fen?: number | null;
    price_min_fen: number | null;
    price_max_fen: number | null;
    name: string;
  };
};
export function contentContinuity(a: SalesPoint, b: SalesPoint, now: number) {
  const ready = (p: SalesPoint, deadline: number) => {
    const at = Date.parse(p.rules?.observed_at ?? ""),
      listed = Date.parse(p.observed_at);
    return (
      p.rules?.status === "received" &&
      !!p.rules.commodity_fingerprint &&
      !!p.rules.rule_fingerprint &&
      Number.isFinite(at) &&
      at >= listed &&
      at - listed <= 36 * 3600000 &&
      at <= deadline
    );
  };
  if (!ready(a, now) || !ready(b, Date.parse(a.observed_at)))
    return "unknown" as const;
  return a.rules!.commodity_fingerprint === b.rules!.commodity_fingerprint &&
    a.rules!.rule_fingerprint === b.rules!.rule_fingerprint
    ? ("same_returned_content" as const)
    : ("changed" as const);
}
export function salesTrend(points: SalesPoint[], now = Date.now()) {
  const samples = points
    .slice(0, 16)
    .map((p) => ({ ...p, sales: parseSales(p.payload.monthly_sales ?? "") }));
  const latestPrice = points[0]?.payload;
  const base = {
    origin_price_fen: latestPrice?.origin_price_fen ?? null,
    discount: couponDiscount(
      latestPrice?.price_min_fen,
      latestPrice?.price_max_fen,
      latestPrice?.origin_price_fen,
    ),
    samples: samples.map((p) => ({
      run_id: p.run_id,
      observed_at: p.observed_at,
      missing: p.missing ?? false,
      query_signature: p.query_signature ?? null,
      monthly_sales: p.missing ? "" : p.sales.raw,
      parsed_value: p.sales.value,
      precision: p.sales.precision,
      rules: p.rules ?? null,
    })),
    content_comparison:
      samples.length > 1
        ? contentContinuity(samples[0], samples[1], now)
        : ("unknown" as const),
    net_change: null as number | null,
    hours: null as number | null,
    speed: null as number | null,
    previous_speed: null as number | null,
    speed_change: null as number | null,
    acceleration: null as number | null,
    price_changed: false,
    baseline_speed: null as number | null,
    lift_ratio: null as number | null,
    baseline_windows: 0,
    baseline_reason:
      "至少需要 4 个连续历史窗口且覆盖 24 小时；当前窗口不计入基准。",
    acceleration_reason: "至少需要三次连续可比快照。",
    status: "insufficient_history",
    reason: "至少需要两次完整快照；加速度需要三次。",
  };
  function interval(a: (typeof samples)[number], b: (typeof samples)[number]) {
    if (a.missing || b.missing)
      return { reason: "中间完整扫描未见此券，不能跨缺失窗口比较。" };
    if ((a.query_signature ?? null) !== (b.query_signature ?? null))
      return { reason: "两次查询口径不同，不能比较月售变化。" };
    if (a.payload.name !== b.payload.name)
      return { reason: "券名或套餐描述已变化，月售统计对象连续性待核验。" };
    if (contentContinuity(a, b, now) === "changed")
      return {
        reason: "已返回套餐或条款发生变化，不能把不同权益版本当作连续热度。",
      };
    const at = Date.parse(a.observed_at),
      bt = Date.parse(b.observed_at),
      hours = (at - bt) / 3600000;
    if (
      !Number.isFinite(at) ||
      !Number.isFinite(bt) ||
      at > now ||
      bt > now ||
      hours < 1 ||
      hours > 36
    )
      return { reason: "采样间隔须为 1—36 小时；过密、倒序或断档不比较。" };
    if (
      !a.payload.platform_brand_id ||
      a.payload.platform_brand_id !== b.payload.platform_brand_id ||
      a.payload.identity !== "name_match" ||
      b.payload.identity !== "name_match"
    )
      return { reason: "两次品牌归属不一致或未确认，不能比较。" };
    if (a.sales.value === null || b.sales.value === null)
      return {
        reason: "销量为万、加号等模糊展示或缺失，无法计算精确净增速度。",
      };
    const delta = a.sales.value - b.sales.value;
    return { hours, delta, speed: delta / hours, midpoint: (at + bt) / 2 };
  }
  if (
    !samples[0] ||
    !Number.isFinite(Date.parse(samples[0].observed_at)) ||
    now - Date.parse(samples[0].observed_at) > 36 * 3600000 ||
    Date.parse(samples[0].observed_at) > now
  )
    return {
      ...base,
      status: "stale",
      reason: "当前快照缺失、过期或时间异常。",
    };
  if (samples.length < 2) return base;
  const current = interval(samples[0], samples[1]);
  base.price_changed =
    samples[0].payload.price_min_fen !== samples[1].payload.price_min_fen ||
    samples[0].payload.price_max_fen !== samples[1].payload.price_max_fen;
  if ("reason" in current)
    return {
      ...base,
      status: "not_comparable",
      reason: current.reason ?? "当前窗口不可比较",
    };
  Object.assign(base, {
    net_change: current.delta,
    hours: current.hours,
    speed: current.speed,
    status: current.delta < 0 ? "declining" : "measured",
    reason:
      current.delta < 0
        ? "月售净下降，可能是滚动窗口移出旧订单或口径变化，不直接等于销量转差。"
        : "按平台整数展示计算月售净变化，不等于期间新增订单。",
  });
  if (samples[2]) {
    const prior = interval(samples[1], samples[2]);
    if (!("reason" in prior)) {
      base.previous_speed = prior.speed;
      base.acceleration_reason =
        "存在负净增窗口，不能将滚动回落后的反弹解释为加速。";
      // A negative window may reflect rolling expiry/reset; do not label rebound as acceleration.
      if (prior.delta >= 0 && current.delta >= 0) {
        base.acceleration_reason = "两段连续窗口可比较。";
        base.speed_change = current.speed - prior.speed;
        base.acceleration =
          base.speed_change / ((current.midpoint - prior.midpoint) / 3600000);
      }
    } else base.acceleration_reason = prior.reason ?? "上段不可比较";
  }
  const historical: { speed: number; hours: number }[] = [];
  for (let i = 1; i < samples.length - 1; i++) {
    const p = interval(samples[i], samples[i + 1]);
    if ("reason" in p || p.delta < 0) {
      base.baseline_reason =
        "历史窗口中断：" +
        ("reason" in p ? p.reason : "出现负净变化") +
        "；仅使用断点之后的连续历史。";
      break;
    }
    historical.push(p);
  }
  base.baseline_windows = historical.length;
  if (
    historical.length >= 4 &&
    historical.reduce((n, p) => n + p.hours, 0) >= 24
  ) {
    const ordered = historical.map((p) => p.speed).sort((a, b) => a - b),
      mid = Math.floor(ordered.length / 2);
    base.baseline_speed =
      ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
    base.baseline_reason =
      "以前序连续非负窗口速度中位数为基准；未校正时段、节假日或券内容变化。";
    if (base.baseline_speed > 0 && current.delta >= 0)
      base.lift_ratio = current.speed / base.baseline_speed;
    else
      base.baseline_reason =
        base.baseline_speed === 0
          ? "历史基准为零，不计算倍数。"
          : "当前月售净下降，不计算提升倍数。";
  }
  return base;
}
type ExportRow = {
  content_comparison?: string;
  brand_name: string;
  product_id: string;
  title: string;
  price_fen: number | null;
  speed: number | null;
  net_change: number | null;
  hours: number | null;
  acceleration: number | null;
  lift_ratio: number | null;
  reason: string;
  samples: { observed_at: string; monthly_sales: string }[];
};
export function salesHeatCsv(items: ExportRow[]) {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[\s]*[=+@-]/.test(s) && typeof v !== "number") s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  const rows: unknown[][] = [
    [
      "品牌",
      "商品ID（文本）",
      "券名",
      "当前价格元",
      "月售净增",
      "间隔小时",
      "净增速度/小时",
      "加速度/小时²",
      "自身历史倍数",
      "权益连续性",
      "最新销量原文",
      "最新采集时间",
      "依据",
    ],
  ];
  for (const x of items)
    rows.push([
      x.brand_name,
      "'" + x.product_id,
      x.title,
      x.price_fen === null ? null : x.price_fen / 100,
      x.net_change,
      x.hours,
      x.speed,
      x.acceleration,
      x.lift_ratio,
      x.content_comparison === "changed"
        ? "已返回套餐或条款变化"
        : x.content_comparison === "same_returned_content"
          ? "已返回内容一致，完整权益未核验"
          : "证据不足，未确认",
      x.samples[0]?.monthly_sales,
      x.samples[0]?.observed_at,
      x.reason,
    ]);
  return (
    "\uFEFF" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n"
  );
}
export function createSalesHeat(db: PGlite) {
  async function read() {
    const rows = (
      await db.query<{
        brand_id: string;
        brand_name: string;
        product_id: string;
        points: SalesPoint[];
      }>(`
 WITH current AS MATERIALIZED (
 SELECT i.*,br.name AS brand_name,coalesce(t.completed_at,i.observed_at) AS task_at FROM coupon_items i JOIN coupon_baselines b ON b.brand_id=i.brand_id AND b.run_id=i.run_id JOIN brands br ON br.id=i.brand_id AND br.active JOIN coupon_tasks t ON t.run_id=i.run_id AND t.brand_id=i.brand_id AND t.state='complete'
 WHERE i.payload->>'identity'='name_match'
 ), conflicts AS MATERIALIZED (SELECT payload->>'platform_brand_id' AS id FROM current WHERE coalesce(payload->>'platform_brand_id','')<>'' GROUP BY 1 HAVING count(DISTINCT brand_id)>1)
 SELECT c.brand_id,c.brand_name,c.product_id,jsonb_agg(jsonb_build_object('run_id',h.run_id,'observed_at',h.observed_at,'missing',h.missing,'query_signature',h.query_signature,'rules',h.rules,'payload',h.payload) ORDER BY (h.run_id=c.run_id) DESC,h.task_at DESC,h.run_id DESC) AS points
 FROM current c JOIN LATERAL (
 SELECT t.run_id,coalesce(i.observed_at,t.completed_at) AS observed_at,
 coalesce(t.completed_at,i.observed_at) AS task_at,t.query_signature,
 i.product_id IS NULL AS missing,coalesce(i.payload,'{}'::jsonb) AS payload,
 CASE WHEN r.product_id IS NOT NULL THEN jsonb_build_object('observed_at',r.observed_at,'status',r.payload->>'status','commodity_fingerprint',r.payload->>'commodity_fingerprint','rule_fingerprint',r.payload->>'rule_fingerprint') ELSE NULL END AS rules
 FROM coupon_tasks t LEFT JOIN coupon_items i ON i.brand_id=t.brand_id AND i.run_id=t.run_id AND i.product_id=c.product_id
 LEFT JOIN coupon_rule_snapshots r ON r.run_id=i.run_id AND r.product_id=i.product_id
 WHERE t.brand_id=c.brand_id AND t.state='complete'
 AND (t.run_id=c.run_id OR coalesce(t.completed_at,i.observed_at)<c.task_at)
 AND coalesce(t.completed_at,i.observed_at)>=c.task_at-interval '7 days'
 ORDER BY (t.run_id=c.run_id) DESC,coalesce(t.completed_at,i.observed_at) DESC,t.run_id DESC LIMIT 16) h ON true
 WHERE NOT EXISTS(SELECT 1 FROM conflicts x WHERE x.id=c.payload->>'platform_brand_id')
 GROUP BY c.brand_id,c.brand_name,c.product_id`)
    ).rows;
    const now = Date.now();
    return rows.map((r) => ({
      brand_id: r.brand_id,
      brand_name: r.brand_name,
      product_id: r.product_id,
      title: r.points[0].payload.name,
      price_fen: r.points[0].payload.price_min_fen,
      ...salesTrend(r.points, now),
    }));
  }
  function register(app: Express) {
    app.get(
      ["/api/v3/sales-heat", "/api/v3/sales-heat.csv"],
      async (req, res) => {
        const q = z
          .object({
            brand_id: z.uuid().optional(),
            search: z.string().max(100).default(""),
            min_speed: z.coerce.number().min(0).max(10000000).default(0),
            min_net: z.coerce.number().int().min(0).max(1000000000).default(0),
            order: z
              .enum(["speed", "acceleration", "lift_ratio", "newest"])
              .default("speed"),
            filter: z
              .enum(["all", "rising", "accelerating", "unknown"])
              .default("all"),
            offset: z.coerce.number().int().min(0).default(0),
            limit: z.coerce.number().int().min(1).max(100).default(20),
          })
          .parse(req.query);
        const all = await read();
        let items = all.filter(
          (x) =>
            (!q.brand_id || x.brand_id === q.brand_id) &&
            `${x.brand_name} ${x.title}`
              .toLowerCase()
              .includes(q.search.toLowerCase()),
        );
        const coverage = {
          total: items.length,
          measured: items.filter((x) => x.speed !== null).length,
          rising: items.filter((x) => (x.speed ?? 0) > 0).length,
          accelerating: items.filter((x) => (x.acceleration ?? 0) > 0).length,
          baseline_ready: items.filter((x) => x.lift_ratio !== null).length,
          unknown_reasons: Object.fromEntries(
            [
              ...new Set(
                items.filter((x) => x.speed === null).map((x) => x.reason),
              ),
            ].map((reason) => [
              reason,
              items.filter((x) => x.speed === null && x.reason === reason)
                .length,
            ]),
          ),
        };
        items = items.filter(
          (x) =>
            q.filter === "all" ||
            (q.filter === "rising"
              ? (x.speed ?? 0) > 0
              : q.filter === "accelerating"
                ? (x.acceleration ?? 0) > 0
                : x.speed === null),
        );
        items = items.filter(
          (x) =>
            (q.min_speed === 0 ||
              (x.speed !== null && x.speed >= q.min_speed)) &&
            (q.min_net === 0 ||
              (x.net_change !== null && x.net_change >= q.min_net)),
        );
        items.sort((a, b) => {
          const av =
              q.order === "newest"
                ? Date.parse(a.samples[0]?.observed_at ?? "")
                : a[q.order],
            bv =
              q.order === "newest"
                ? Date.parse(b.samples[0]?.observed_at ?? "")
                : b[q.order];
          return (
            (bv ?? -Infinity) - (av ?? -Infinity) ||
            `${a.brand_id}:${a.product_id}`.localeCompare(
              `${b.brand_id}:${b.product_id}`,
            )
          );
        });
        if (req.path.endsWith(".csv"))
          return res
            .type("text/csv; charset=utf-8")
            .set(
              "Content-Disposition",
              'attachment; filename="coupon-sales-heat.csv"',
            )
            .send(salesHeatCsv(items));
        res.json({
          generated_at: new Date().toISOString(),
          coverage,
          total: items.length,
          items: items.slice(q.offset, q.offset + q.limit),
          caveat:
            "月售净增速度（展示数量/小时），不是新增订单或内容竞争；平台销量地域范围未核验，不称为上海订单量。加速度为相邻窗口速度差÷窗口中点间隔（数量/小时²）；负净增窗口不计算加速度。万/加号等模糊销量保持未知，不按零处理。",
        });
      },
    );
  }
  return { read, register };
}
