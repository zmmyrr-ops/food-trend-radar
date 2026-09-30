import { type Channel, categories, inChannel } from "@radar/contracts";
import { useEffect, useState } from "react";
import { useAccount } from "./AccountGate";
import { appFetch, appUrl } from "./app-url";
import { CouponStoreSummary } from "./CouponStoreSummary";
import { CouponUsageRules } from "./CouponUsageRules";
import { PickEvaluation } from "./PickEvaluation";

type Pick = {
  brand_index: {
    keyword: string;
    status: string;
    period_start: string;
    period_end: string;
    daily_average: number | null;
    mom: number | null;
    usable: boolean;
    source_url: string;
    observed_at: string;
  } | null;
  use_outlook: {
    fully_excluded: boolean;
    has_explicit_exclusion: boolean;
    evidence_status: string;
    days: { date: string; status: string; reasons: string[] }[];
  };
  priority: {
    availability_gate?: {
      before_score: number;
      penalty: number;
      reason: string;
      historical: boolean;
      evidence: string[];
    };
    raw_score: number;
    value_gate: { factor: number; eligible: boolean; reason: string };
    score: number;
    coverage: number;
    missing: string[];
    parts: { name: string; weight: number; value: number | null }[];
  };
  brand_id: string;
  product_id: string;
  brand_name: string;
  title: string;
  watching: boolean;
  observed_at: string;
  price_fen: number | null;
  origin_price_fen: number | null;
  discount: { rate: number | null; reason: string };
  previous_price_fen: number | null;
  saving_fen: number | null;
  reduction_rate: number | null;
  kind: string;
  change_reason: string;
  speed: number | null;
  acceleration: number | null;
  net_change: number | null;
  hours: number | null;
  reason: string;
  acceleration_reason: string;
  latest_sales: string;
  previous_sales: string | null;
};
type Result = {
  model?: { note: string };
  context?: {
    source: string;
    outlook: {
      stale: boolean;
      days: {
        date: string;
        name: string | null;
        kind: string;
        temperature_min: number | null;
        temperature_max: number | null;
        rain_probability_max: number | null;
      }[];
    };
  } | null;
  items: Pick[];
  total: number;
  counts: Record<string, number>;
  generated_at: string;
  calculated_at?: string | null;
};
const views = [
  ["recommended", "优先券"],
  ["all", "全部券"],
  ["watching", "已关注"],
  ["value_rising", "降价且升温"],
  ["price_drop", "票面降价"],
  ["accelerating", "增长加快"],
  ["new", "新发现"],
] as const;
const money = (n: number | null) =>
  n === null ? "未知" : `¥${(n / 100).toFixed(2)}`;
export function CouponPicks({
  brandId,
  channel,
  brands,
  onBrandChange,
}: {
  brandId: string;
  channel: Channel;
  brands: { id: string; name: string; category: string }[];
  onBrandChange: (id: string) => void;
}) {
  const isAdmin = useAccount().role === "admin";
  const [view, setView] = useState("recommended"),
    [order, setOrder] = useState("priority"),
    [category, setCategory] = useState(""),
    [searchInput, setSearchInput] = useState(""),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0);
  const [data, setData] = useState<Result | null>(null),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0),
    [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput);
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);
  useEffect(() => {
    setOffset(0);
  }, [brandId]);
  const query = new URLSearchParams({
    view,
    channel,
    order,
    search,
    offset: String(offset),
    limit: "20",
    ...(brandId ? { brand_id: brandId } : {}),
    ...(category ? { category } : {}),
  }).toString();
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    setData(null);
    setError("");
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const r = await appFetch(`/api/v3/coupon-picks?${query}`, {
          signal: controller.signal,
        });
        if (!r.ok) throw Error();
        const d: Result = await r.json();
        if (!controller.signal.aborted) {
          setData(d);
          setError("");
          if (offset > 0 && offset >= d.total) setOffset(0);
        }
      } catch {
        if (!controller.signal.aborted)
          setError("选券结果暂时无法更新，请稍后重试。");
      } finally {
        loading = false;
      }
    }
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 60000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [query, offset, refresh]);
  async function watch(x: Pick) {
    setSaving(true);
    setSaveError("");
    try {
      const r = await appFetch(
        `/api/v3/coupon-picks/${encodeURIComponent(x.product_id)}/watch`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brand_id: x.brand_id, watching: !x.watching }),
        },
      );
      if (!r.ok)
        throw Error(
          r.status === 409
            ? "该券已变化，请刷新页面后重试。"
            : "关注保存失败，请重试。",
        );
      setRefresh((n) => n + 1);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="picks-panel" aria-label="选券工作台">
      <div className="category-rail" role="group" aria-label="业态分类">
        {["", ...categories.filter((c) => inChannel(c, channel))].map((c) => (
          <button
            key={c}
            aria-pressed={category === c}
            onClick={() => {
              setCategory(c);
              setOffset(0);
            }}
          >
            {c || (channel === "food" ? "全部美食" : "全部游玩")}
          </button>
        ))}
      </div>
      <div className="actions filter-chips">
        {views.map(([key, label]) => (
          <button
            key={key}
            aria-pressed={view === key}
            onClick={() => {
              setView(key);
              setOffset(0);
            }}
          >
            {label}
            {data ? ` ${data.counts[key] ?? 0}` : ""}
          </button>
        ))}
      </div>
      <div className="actions">
        <label>
          品牌
          <select
            aria-label="品牌筛选"
            value={brandId}
            onChange={(e) => {
              onBrandChange(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">
              全部{channel === "food" ? "美食" : "游玩"}品牌（{brands.length}）
            </option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          搜索品牌或券{" "}
          <input
            value={searchInput}
            maxLength={100}
            placeholder={
              channel === "food"
                ? "搜索餐厅、茶饮或套餐…"
                : "搜索乐园、场馆或门票…"
            }
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </label>
        <label>
          排序{" "}
          <select
            value={order}
            onChange={(e) => {
              setOrder(e.target.value);
              setOffset(0);
            }}
          >
            <option value="priority">综合优先分</option>
            <option value="speed">热度增速</option>
            <option value="acceleration">升温加速度</option>
            <option value="saving">票面降价金额</option>
            <option value="newest">最新采集</option>
          </select>
        </label>
        <a
          className="admin-only"
          href={appUrl(`/api/v3/coupon-picks.csv?${query}`)}
          download
        >
          导出结果
        </a>
      </div>
      {error && <p role="alert">{error}</p>}
      {saveError && <p role="alert">{saveError}</p>}
      {!data && !error && <p>正在汇总优惠与热度…</p>}
      {data && (
        <>
          <details className="method-note admin-only">
            <summary>查看全站历史选券效果</summary>
            <PickEvaluation />
          </details>
          <details className="method-note">
            <summary>评分口径与天气背景</summary>
            <p>
              优先券最多展示当前频道500张；全部券不受此上限限制。分数为选题参考，并非爆款概率。
            </p>
            <p>{data.model?.note}</p>
            {data.context ? (
              <>
                <p>
                  {data.context.outlook.stale
                    ? "天气记录缺失或过期，不参与判断。"
                    : "上海天气背景（不是销售增益预测）："}
                </p>
                {data.context.outlook.days.map((d) => (
                  <p key={d.date}>
                    {d.date} ·{" "}
                    {d.name ??
                      (d.kind === "weekend"
                        ? "周末"
                        : d.kind === "unknown"
                          ? "日历未知"
                          : "工作日")}{" "}
                    · {d.temperature_min ?? "未知"}—
                    {d.temperature_max ?? "未知"}℃ · 最高小时降雨概率{" "}
                    {d.rain_probability_max ?? "未知"}%
                  </p>
                ))}
                <p>{data.context.source}</p>
              </>
            ) : (
              <p>环境数据暂不可用；不影响已有优惠和销量指标排序。</p>
            )}
          </details>
          <p className="result-meta">
            {channel === "food" ? "美食" : "游玩"} · 共 {data.total} 张 ·{" "}
            {new Date(
              data.calculated_at ?? data.generated_at,
            ).toLocaleTimeString("zh-CN")}{" "}
            更新 · 仅展示36小时内快照
          </p>
          {!data.total && (
            <p>
              当前没有符合条件的券。可以切换“全部券”或清空搜索；没有证据时不会补成推荐结果。
            </p>
          )}
          <div className="coupon-grid">
            {data.items.map((x) => (
              <article
                className="coupon-card"
                key={`${x.brand_id}:${x.product_id}`}
              >
                <small className="brand-line">
                  {x.brand_name} ·{" "}
                  {x.kind === "price_drop"
                    ? "票面降价"
                    : x.kind === "first_observed"
                      ? "首次发现"
                      : x.kind === "quantity_increase"
                        ? "同价列示增量"
                        : x.kind === "terms_changed"
                          ? "规则变化"
                          : "热度观察"}
                </small>
                <h3 title={x.title}>{x.title}</h3>
                <CouponStoreSummary
                  brandId={x.brand_id}
                  productId={x.product_id}
                />
                <div className="coupon-stats">
                  <div>
                    <span>票面起价</span>
                    <strong>{money(x.price_fen)}</strong>
                  </div>
                  <div>
                    <span
                      title={
                        isAdmin ? "月售净增 / 小时" : "热度增速指数，满分100"
                      }
                    >
                      {isAdmin ? "月售增速" : "热度增速"}
                    </span>
                    <strong>
                      {isAdmin
                        ? x.speed === null
                          ? "—"
                          : x.speed.toFixed(1)
                        : (() => {
                            const part = x.priority.parts.find(
                              (p) => p.name === "销量升温",
                            );
                            return part?.value == null ? (
                              "—"
                            ) : (
                              <>
                                {Math.round((part.value / part.weight) * 100)}
                                <em>/100</em>
                              </>
                            );
                          })()}
                    </strong>
                  </div>
                  <div>
                    <span title="选题优先分，非爆款概率">优先分</span>
                    <strong>
                      {x.priority.score.toFixed(1)}
                      <em>/100</em>
                    </strong>
                  </div>
                </div>
                <p className="availability-note">
                  {x.discount.rate === null
                    ? `原价折扣暂缺：${x.discount.reason}`
                    : `平台原价 ${money(x.origin_price_fen)} · ${(10 * (1 - x.discount.rate)).toFixed(1)}折 · 比原价省 ${(100 * x.discount.rate).toFixed(1)}%`}
                </p>
                <div className="signal-tags">
                  {x.kind === "price_drop" && (
                    <span>
                      票面降 {money(x.saving_fen)} · 上次售价{" "}
                      {money(x.previous_price_fen)}
                    </span>
                  )}
                  <span>
                    {!isAdmin
                      ? x.acceleration == null
                        ? "升温趋势待观察"
                        : x.acceleration > 0
                          ? "升温加快"
                          : x.acceleration < 0
                            ? "升温放缓"
                            : "趋势平稳"
                      : x.acceleration === null
                        ? "加速度暂缺"
                        : `加速度 ${x.acceleration.toFixed(2)}/小时²`}
                  </span>
                  <span>{x.priority.coverage}% 指标已具备</span>
                </div>
                {!x.priority.value_gate.eligible && (
                  <p className="availability-note">
                    {x.priority.value_gate.reason}
                  </p>
                )}
                {(x.use_outlook.fully_excluded ||
                  x.use_outlook.has_explicit_exclusion) && (
                  <p className="availability-note">
                    {x.use_outlook.fully_excluded
                      ? "未来72小时明确不可用"
                      : "部分日期不可用，请查看使用规则"}
                  </p>
                )}
                {x.priority.availability_gate &&
                  (x.priority.availability_gate.penalty > 0 ||
                    x.priority.availability_gate.evidence.length > 0) && (
                    <div className="coupon-use-warning">
                      <strong>{x.priority.availability_gate.reason}</strong>
                      <p>
                        使用限制调整：
                        {x.priority.availability_gate.before_score.toFixed(1)} →{" "}
                        {x.priority.score.toFixed(1)} 分
                      </p>
                      <details>
                        <summary>查看限制原文</summary>
                        {x.priority.availability_gate.evidence.map((t) => (
                          <p key={t}>{t}</p>
                        ))}
                      </details>
                    </div>
                  )}
                <div className="card-footer">
                  <button
                    className="quiet-button admin-only"
                    disabled={saving}
                    onClick={() => void watch(x)}
                  >
                    {x.watching ? "取消关注" : "关注"}
                  </button>
                </div>
                <CouponUsageRules
                  productId={x.product_id}
                  brandId={x.brand_id}
                />
                <a
                  className="studio-entry"
                  href={appUrl(
                    `/?studio=1&channel=${channel}&brand_id=${encodeURIComponent(x.brand_id)}&product_id=${encodeURIComponent(x.product_id)}`,
                  )}
                >
                  制作探店视频 →
                </a>
              </article>
            ))}
          </div>
          <div className="actions">
            <button
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              上一页
            </button>
            <span>
              {Math.floor(offset / 20) + 1} /{" "}
              {Math.max(1, Math.ceil(data.total / 20))}
            </span>
            <button
              disabled={offset + 20 >= data.total}
              onClick={() => setOffset(offset + 20)}
            >
              下一页
            </button>
          </div>
        </>
      )}
    </section>
  );
}
