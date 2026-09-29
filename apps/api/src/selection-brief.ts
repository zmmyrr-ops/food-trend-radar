import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { Express } from "express";
import { z } from "zod";
import { crossCouponOpportunities } from "./cross-coupon.js";
import type { BoardCandidate } from "./opportunity-board.js";
import { createSalesHeat } from "./sales-heat.js";
import { readStability } from "./stability.js";

export function createSelectionBrief(
  db: PGlite,
  candidates: () => Promise<BoardCandidate[]>,
) {
  async function build() {
    const all = await candidates();
    const heat = await createSalesHeat(db).read();
    const sales_summary = {
      total: heat.length,
      measured: heat.filter((x) => x.speed !== null).length,
      rising: heat.filter((x) => (x.speed ?? 0) > 0).length,
    };
    const sales_top = heat
      .filter((x) => (x.speed ?? 0) > 0)
      .sort(
        (a, b) =>
          (b.speed ?? 0) - (a.speed ?? 0) ||
          `${a.brand_id}:${a.product_id}`.localeCompare(
            `${b.brand_id}:${b.product_id}`,
          ),
      )
      .slice(0, 10);
    const cross = await crossCouponOpportunities(db);
    const dismissed = new Set(
      all
        .filter((x) => x.disposition === "dismissed")
        .map((x) => `${x.brand_id}:${x.product_id}`),
    );
    const comparisons = cross.filter(
      (x) => !dismissed.has(`${x.brand_id}:${x.product_id}`),
    );
    const crossKeys = new Set(
      comparisons.map((x) => `${x.brand_id}:${x.product_id}`),
    );
    const items = all.filter(
      (x) =>
        x.disposition !== "dismissed" &&
        !["reappeared", "watched"].includes(x.kind) &&
        !(
          x.kind === "first_observed" &&
          crossKeys.has(`${x.brand_id}:${x.product_id}`)
        ),
    );
    const queue = (
      await db.query<{ kind: string; state: string; count: number }>(
        `SELECT 'rules' AS kind,t.state,count(*)::int AS count FROM coupon_rule_tasks t JOIN coupon_baselines b ON b.brand_id=t.brand_id AND b.run_id=t.run_id JOIN brands br ON br.id=b.brand_id AND br.active GROUP BY t.state UNION ALL SELECT 'stores' AS kind,t.state,count(*)::int AS count FROM coupon_store_tasks t JOIN coupon_baselines b ON b.brand_id=t.brand_id AND b.run_id=t.run_id JOIN brands br ON br.id=b.brand_id AND br.active GROUP BY t.state`,
      )
    ).rows;
    const coverage = (
      await db.query<{ enabled: number; fresh: number; comparable: number }>(
        `SELECT count(*)::int AS enabled,count(*) FILTER(WHERE t.state='complete' AND t.completed_at BETWEEN now()-interval '36 hours' AND now())::int AS fresh,count(*) FILTER(WHERE t.state='complete' AND t.comparison_status='COMPARABLE' AND t.completed_at BETWEEN now()-interval '36 hours' AND now())::int AS comparable FROM brands br LEFT JOIN coupon_baselines b ON b.brand_id=br.id LEFT JOIN coupon_tasks t ON t.run_id=b.run_id AND t.brand_id=b.brand_id WHERE br.active`,
      )
    ).rows[0];
    const generated_at = new Date().toISOString();
    const revision = createHash("sha256")
      .update(
        JSON.stringify([
          items.map((x) => [
            x.revision,
            x.use_outlook.days.map((d) => [d.date, d.status]),
            x.use_outlook.evidence_status,
          ]),
          comparisons.map((x) => [
            x.brand_id,
            x.product_id,
            x.previous_product_id,
            x.signature,
            x.current_price_fen,
            x.previous_price_fen,
            x.store_status,
            x.use_outlook.days.map((d) => [d.date, d.status]),
          ]),
          queue,
          coverage,
          sales_summary,
          sales_top,
        ]),
      )
      .digest("hex");
    return {
      generated_at,
      revision,
      coverage,
      queue,
      sales_summary,
      sales_top,
      items,
      cross: comparisons,
      missing_sources: [
        "月售统计窗口、地域口径及长期历史待核验",
        "品牌指数及可比历史序列未接通",
        "完整品牌身份、店域与自然语言权益尚未核验",
      ],
      caveat:
        "随当前基线与补采证据更新；扫描结束时的提醒是历史摘要。本简报为选题线索，不是爆款概率或已核验推荐。",
    };
  }
  let active: ReturnType<typeof build> | undefined;
  let cached: Awaited<ReturnType<typeof build>> | undefined;
  let expires = 0;
  function read(force = true) {
    if (!force && cached && Date.now() < expires)
      return Promise.resolve(cached);
    if (!active)
      active = build()
        .then((result) => {
          cached = result;
          expires = Date.now() + 10000;
          return result;
        })
        .finally(() => {
          active = undefined;
        });
    return active;
  }
  function register(app: Express) {
    app.get("/api/v3/selection-brief", async (_req, res) =>
      res.json(await read(false)),
    );
    app.get("/api/v3/selection-brief.md", async (_req, res) => {
      const brief = await read(false);
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="food-radar-brief.md"',
      );
      res.send(briefMarkdown(brief));
    });
    app.get("/api/v3/cross-coupon-opportunities", async (req, res) => {
      const brand = z.uuid().optional().parse(req.query.brand_id);
      const all = await crossCouponOpportunities(db);
      const items = all.filter((x) => !brand || x.brand_id === brand);
      res.json({
        items,
        total: items.length,
        generated_at: new Date().toISOString(),
      });
    });
    app.get("/api/v3/stability", async (_req, res) =>
      res.json(await readStability(db)),
    );
  }
  return { read, register };
}
export type SelectionBrief = Awaited<
  ReturnType<ReturnType<typeof createSelectionBrief>["read"]>
>;
const escape = (s: string) =>
  s.replace(/[\r\n]+/g, " ").replace(/[\\`*{}_\[\]<>#|]/g, "\\$&");
const money = (n: number | null) =>
  n == null ? "未知" : `¥${(n / 100).toFixed(2)}`;
export function briefMarkdown(b: SelectionBrief) {
  const lines = [
    "# 上海美食选题简报",
    "",
    `生成时间：${b.generated_at}`,
    `覆盖：${b.coverage.enabled} 个启用品牌，${b.coverage.fresh} 个新鲜基线，${b.coverage.comparable} 个可比较。`,
    "",
    b.caveat,
    "",
    "",
  ];
  lines.push(
    "",
    "## 券月售净增速度 Top 10",
    "",
    `可计算 ${b.sales_summary.measured}/${b.sales_summary.total} 张，净增长 ${b.sales_summary.rising} 张。月售展示净变化不是新增订单；不衡量内容竞争，也不生成未校准综合分。`,
  );
  for (const x of b.sales_top)
    lines.push(
      `- ${escape(x.brand_name)} · ${escape(x.title)}：净增 ${x.net_change}，${x.speed?.toFixed(2)}/小时；加速度 ${x.acceleration === null ? "未知" : x.acceleration.toFixed(2)} /小时²。样本 ${escape(x.samples[1]?.observed_at ?? "未知")} → ${escape(x.samples[0]?.observed_at ?? "未知")}。`,
    );
  lines.push("", "## 优惠变化线索", "");
  if (!b.items.length) lines.push("当前没有符合条件的变化线索。");
  for (const x of b.items) {
    lines.push(
      `- **${escape(x.brand_name)} · ${escape(x.title)}**`,
      `  当前价 ${money(x.current_price_fen)}；上轮价 ${money(x.previous_price_fen)}。${escape(x.reason)}`,
      `  采集于 ${x.observed_at}；券 ID ${x.product_id}。`,
      `  未来72小时明确禁用：${
        x.use_outlook.days
          .filter((d) => d.status === "explicitly_excluded")
          .map((d) => d.date)
          .join("、") || "未识别，其他日期可用性未知"
      }。`,
      `  待核验：${x.blockers.map(escape).join("；")}`,
    );
  }
  lines.push("", "## 跨券同列示套餐比价", "");
  if (!b.cross.length)
    lines.push("暂无足够证据支持的跨券比价线索；不使用标题相似度猜测。");
  for (const x of b.cross)
    lines.push(
      `- **${escape(x.brand_name)} · ${escape(x.title)}**`,
      `  上轮 ${escape(x.previous_title)}（${x.previous_product_id}）${money(x.previous_price_fen)} → 当前券（${x.product_id}）${money(x.current_price_fen)}；少付 ${money(x.saving_fen)}。`,
      `  ${x.reason}。${x.caveat}`,
      `  未来72小时明确禁用：${
        x.use_outlook.days
          .filter((d) => d.status === "explicitly_excluded")
          .map((d) => d.date)
          .join("、") || "未识别，其他日期可用性未知"
      }。`,
    );
  lines.push(
    "",
    "## 数据缺口",
    "",
    ...b.missing_sources.map((x) => `- ${x}`),
    "",
    "## 当前补采队列",
    "",
    ...b.queue.map((x) => `- ${x.kind} / ${x.state}：${x.count}`),
    "",
  );
  return lines.join("\n");
}
