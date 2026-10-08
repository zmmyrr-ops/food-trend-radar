import { useEffect, useState } from "react";
import { appFetch, appUrl } from "./app-url";
import { CouponRules } from "./CouponRules";
import { CouponStores } from "./CouponStores";
import { CouponUseOutlook, type UseOutlook } from "./CouponUseOutlook";

type Brief = {
  generated_at: string;
  sales_summary: { total: number; measured: number; rising: number };
  sales_top: {
    brand_id: string;
    product_id: string;
    brand_name: string;
    title: string;
    speed: number | null;
  }[];
  coverage: { enabled: number; fresh: number; comparable: number };
  items: unknown[];
  cross: {
    use_outlook: UseOutlook;
    brand_id: string;
    brand_name: string;
    product_id: string;
    previous_product_id: string;
    title: string;
    previous_title: string;
    current_price_fen: number;
    previous_price_fen: number;
    saving_fen: number;
    reason: string;
    caveat: string;
    store_status: string;
    reference_count: number;
    observed_at: string;
    evidence_times: { current_rules: string; previous_rules: string };
    groups: {
      group_name?: string;
      item_list: { name: string; count?: number; unit?: string }[];
    }[];
  }[];
  missing_sources: string[];
  caveat: string;
};
type Stability = {
  passed: number;
  required: number;
  complete: boolean;
  current_slot: string;
  caveat: string;
  slots: {
    slot: string;
    status: string;
    completed: number;
    tasks: number;
    failures: number;
  }[];
};
const states: Record<string, string> = {
  passed: "通过",
  missing: "未发现定时轮次",
  duplicate: "轮次重复",
  late_or_incomplete: "未在时段内完成",
  interval_violation: "请求间隔不合格",
  incomplete: "任务未完成",
};
const money = (n: number) => `¥${(n / 100).toFixed(2)}`;
export function SelectionBriefPanel({ brandId }: { brandId: string }) {
  const [brief, setBrief] = useState<Brief | null>(null),
    [stability, setStability] = useState<Stability | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let disposed = false,
      loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const responses = await Promise.all([
          appFetch("/api/v3/selection-brief"),
          appFetch("/api/v3/stability"),
        ]);
        if (responses.some((r) => !r.ok)) throw Error();
        const [b, s] = await Promise.all(responses.map((r) => r.json()));
        if (!disposed) {
          setBrief(b);
          setStability(s);
          setError("");
        }
      } catch {
        if (!disposed) setError("简报更新失败，已有结果可能过期。");
      } finally {
        loading = false;
      }
    }
    void load();
    const timer = setInterval(() => void load(), 60000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  const cross =
    brief?.cross.filter((x) => !brandId || x.brand_id === brandId) ?? [];
  return (
    <section aria-label="动态简报与跨券比价">
      <h2>选题简报与跨券比价</h2>
      {error && <p role="alert">{error}</p>}
      {brief ? (
        <>
          <p>
            全品牌当前 {brief.items.length} 条变化线索、{brief.cross.length}{" "}
            条跨券比价线索。更新于{" "}
            {new Date(brief.generated_at).toLocaleString("zh-CN")}。
          </p>
          <p>{brief.caveat}</p>
          <p>
            月售速度可计算 {brief.sales_summary.measured}/
            {brief.sales_summary.total} 张，净增长 {brief.sales_summary.rising}{" "}
            张。热度衡量月售展示净变化，优惠变化衡量价格与权益，两者分别呈现，综合分尚未校准。
          </p>
          <details>
            <summary>全品牌销售增速 Top 10</summary>
            <ol>
              {brief.sales_top.map((x) => (
                <li key={`${x.brand_id}:${x.product_id}`}>
                  {x.brand_name} · {x.title}：{x.speed?.toFixed(2)} /小时
                </li>
              ))}
            </ol>
            <p>
              完整样本、加速度及历史基准请查看月售热度榜；月售净变化不等于新增订单。
            </p>
          </details>
          <a href={appUrl("/api/v3/selection-brief.md")} download>
            下载最新全品牌选题简报（可编辑 Markdown）
          </a>
          <details>
            <summary>数据与核验缺口</summary>
            <ul>
              {brief.missing_sources.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </details>
          <h3>跨券 ID 的同列示套餐比价</h3>
          <p>
            相同品牌平台
            ID、相同列示套餐数量与单位、相同已返回条款，才进入比较；以各新券采集前取得的上轮同组最低价作参照。标题相似不作为依据。
          </p>
          {!cross.length && (
            <p>
              当前{brandId ? "品牌" : "全池"}
              尚无证据充分的跨券降价线索。历史或规则缺失、任选套餐、数量不明不会强行匹配。
            </p>
          )}
          <div className="coupon-grid">
            {cross.map((x) => (
              <article
                className="coupon-card"
                key={`${x.brand_id}:${x.product_id}`}
              >
                <small>{x.brand_name} · 跨券比价线索</small>
                <h3>{x.title}</h3>
                <p>
                  上轮同组最低价 {money(x.previous_price_fen)} → 当前{" "}
                  {money(x.current_price_fen)}；少付 {money(x.saving_fen)}。
                </p>
                <p>
                  参照券：{x.previous_title}（{x.previous_product_id}）；当前券
                  ID：{x.product_id}。
                </p>
                <p>
                  {x.reason}。共 {x.reference_count} 张可比较旧券。门店范围：
                  {x.store_status === "same_returned_stores"
                    ? "已返回完整门店一致"
                    : "尚未确认一致"}
                  。
                </p>
                <p>{x.caveat}</p>
                <CouponUseOutlook data={x.use_outlook} />
                <details>
                  <summary>查看匹配套餐及证据时间</summary>
                  {x.groups.map((g, i) => (
                    <div key={`${g.group_name}:${i}`}>
                      <strong>{g.group_name || "列示套餐"}</strong>
                      <ul>
                        {g.item_list.map((it, j) => (
                          <li key={`${it.name}:${j}`}>
                            {it.name} × {it.count}
                            {it.unit}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  <p>
                    上轮规则：
                    {new Date(x.evidence_times.previous_rules).toLocaleString(
                      "zh-CN",
                    )}
                    ；本轮规则：
                    {new Date(x.evidence_times.current_rules).toLocaleString(
                      "zh-CN",
                    )}
                    。
                  </p>
                  <CouponRules productId={x.product_id} brandId={x.brand_id} />
                  <CouponStores productId={x.product_id} brandId={x.brand_id} />
                </details>
              </article>
            ))}
          </div>
        </>
      ) : (
        <p>正在生成当前简报…</p>
      )}
      {stability && (
        <details>
          <summary>
            连续 7 天定时扫描验收：{stability.passed}/{stability.required}{" "}
            个时段通过
          </summary>
          <p>
            {stability.complete
              ? "最近 14 个已结束时段达到扫描验收条件。"
              : "尚未达到连续 7 天要求。"}
          </p>
          <p>{stability.caveat}</p>
          <p>当前时段：{stability.current_slot}（尚未计入结束时段验收）。</p>
          <ul>
            {stability.slots.map((s) => (
              <li key={s.slot}>
                {s.slot.slice(0, 16).replace("T", " ")}：
                {states[s.status] ?? s.status}，完成 {s.completed}/{s.tasks}{" "}
                个任务，失败请求 {s.failures} 次。
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
