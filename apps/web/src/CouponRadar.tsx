import { type Channel, inChannel } from "@radar/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { AiRecommendations } from "./AiRecommendations";
import { appFetch } from "./app-url";
import { BrandCoverage } from "./BrandCoverage";
import { CouponConditionComparison } from "./CouponConditionComparison";
import { CouponMedia } from "./CouponMedia";
import { CouponPicks } from "./CouponPicks";
import { CouponRules } from "./CouponRules";
import { CouponScoreHistory } from "./CouponScoreHistory";
import { CouponStoreSummary } from "./CouponStoreSummary";
import { CouponStores } from "./CouponStores";
import { OperationsPanel } from "./OperationsPanel";
import { SalesHeatPanel } from "./SalesHeatPanel";
import { SelectionBoard } from "./SelectionBoard";
import { SelectionBriefPanel } from "./SelectionBriefPanel";

type Coupon = {
  product_id: string;
  name: string;
  price_min_fen: number | null;
  price_max_fen: number | null;
  platform_brand_name: string;
  poi_name: string;
  monthly_sales: string;
  identity: string;
  sale_end: string;
};
type Item = {
  run_id: string;
  brand_id: string;
  brand_name: string;
  payload: Coupon;
  old_payload: Coupon | null;
  kind: string;
  historical_only: boolean;
  comparison_status: string;
  snapshot_completed_at: string | null;
  observed_at: string;
  opportunity?: {
    version: string;
    range: { low: number; high: number };
    gate: string;
  };
  assessment: {
    price_direction: string;
    delta_fen: number | null;
    changed_fields: string[];
    reasons: string[];
    city_status: string;
    identity_conflict: boolean;
  };
};
type Run = {
  id: string;
  status: string;
  total: number;
  completed: number;
  partial: number;
  pages: number;
  round_number?: number;
  duration_seconds?: number;
  finished_at?: string | null;
  current_brand: { name: string; pages: number } | null;
  started_at: string;
};
type Status = {
  query_scope: string;
  enabled: boolean;
  pause_reason: string | null;
  worker_active: boolean;
  request_pending: boolean;
  missing_sources: string[];
};
async function request<T>(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const r = await appFetch(
    `/api/v3${path}`,
    body === undefined
      ? undefined
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message ?? "请求失败");
  return d;
}
const comparisonLabels: Record<string, string> = {
  FIRST_BASELINE: "首次基线",
  COMPARABLE: "同口径比较",
  QUERY_CHANGED: "查询口径变化，重建基线",
  STALE_BASELINE: "基线过旧，重新建立",
  LEGACY_BASELINE: "旧记录口径不完整",
};
const price = (n: number | null | undefined) =>
  n == null ? "未知" : `¥${(n / 100).toFixed(2)}`;
const labels: Record<string, string> = {
  PRICE_DATA_CHANGED: "价格字段补全或缺失 · 非降价证据",
  BASELINE_RESET: "重建基线 · 暂不比较",
  NOT_SEEN: "本轮未见 · 不代表下架",
  BASELINE: "首次基线",
  NEW_OBSERVED: "首次发现",
  UNCHANGED: "无变化",
  PRICE_CHANGED_UNVERIFIED: "价格变化 · 待核验",
  TERMS_CHANGED_UNVERIFIED: "商品信息变化 · 待核验",
};
export function CouponRadar({ channel }: { channel: Channel }) {
  const [status, setStatus] = useState<Status | null>(null),
    [runs, setRuns] = useState<Run[]>([]),
    [items, setItems] = useState<Item[]>([]),
    [view, setView] = useState("matched"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [brands, setBrands] = useState<
    {
      id: string;
      name: string;
      category: string;
      active: boolean;
      last_collected_at?: string | null;
    }[]
  >([]);
  const [brandId, setBrandId] = useState("");
  const [environment, setEnvironment] = useState<{
    stale: boolean;
    outlook?: {
      covered_hours: number;
      note: string;
      days: {
        date: string;
        kind: string;
        name: string | null;
        hours: number;
        temperature_min: number | null;
        temperature_max: number | null;
        rain_probability_max: number | null;
      }[];
    };
    forecast: {
      observed_at: string;
      hours: {
        temperature: number | null;
        precipitation_probability: number | null;
      }[];
    } | null;
    calendar: { kind: string; name: string | null };
    scoring_status: string;
  } | null>(null);
  useEffect(() => {
    const refresh = () =>
      void request<typeof environment>("/environment")
        .then(setEnvironment)
        .catch(() => setEnvironment(null));
    refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  const refreshSequence = useRef(0);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void request<{ items: typeof brands }>("/brands")
        .then((d) => {
          if (!cancelled) setBrands(d.items);
        })
        .catch((e) => {
          if (!cancelled) setError(String(e));
        });
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 60000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  const [bindings, setBindings] = useState<
    | {
        brand_id: string;
        brand_name: string;
        platform_brand_id: string;
        platform_brand_name: string;
        product_count: number;
        conflict: boolean;
      }[]
    | null
  >(null);
  const [history, setHistory] = useState<{
    title: string;
    items: {
      payload: Coupon;
      observed_at: string;
      comparison_status: string | null;
    }[];
  } | null>(null);
  const historySequence = useRef(0);
  async function showHistory(item: Item) {
    const sequence = ++historySequence.current;
    try {
      const result = await request<{
        items: {
          payload: Coupon;
          observed_at: string;
          comparison_status: string | null;
          brand_id: string;
        }[];
      }>(
        `/coupons/${item.payload.product_id}/history?brand_id=${item.brand_id}`,
      );
      if (sequence === historySequence.current)
        setHistory({
          title: `${item.brand_name} · ${item.payload.name}`,
          items: result.items.filter((row) => row.brand_id === item.brand_id),
        });
    } catch (e) {
      if (sequence === historySequence.current) setError(String(e));
    }
  }
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [pane, setPane] = useState("picks");
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [audit, setAudit] = useState<{
    total: number;
    min_gap_ms: number | null;
    short_gaps: number;
    non_success: number;
  } | null>(null);
  const [tasks, setTasks] = useState<
    {
      name: string;
      state: string;
      pages: number;
      recalled: number;
      matched: number;
      retries: number;
      error_code: string | null;
    }[]
  >([]);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const [s, r, i] = await Promise.all([
        request<Status>("/status"),
        request<{ items: Run[] }>("/runs"),
        pane === "snapshots"
          ? request<{ items: Item[]; total: number }>(
              `/opportunities?view=${view}&offset=${offset}&limit=50${brandId ? `&brand_id=${brandId}` : ""}`,
            )
          : Promise.resolve(null),
      ]);
      if (sequence !== refreshSequence.current) return;
      setStatus(s);
      setRuns(r.items);
      if (i) {
        setItems(i.items);
        setTotal(i.total);
      }
      setError("");
    } catch (e) {
      if (sequence === refreshSequence.current) setError(String(e));
    }
  }, [view, offset, brandId, pane]);
  useEffect(() => {
    let loading = false;
    const poll = async () => {
      if (loading) return;
      loading = true;
      try {
        await refresh();
      } finally {
        loading = false;
      }
    };
    void poll();
    const t = setInterval(
      () => {
        if (document.visibilityState === "visible") void poll();
      },
      pane === "snapshots" ? 30000 : 10000,
    );
    return () => {
      clearInterval(t);
      refreshSequence.current++;
    };
  }, [refresh]);
  async function action(path: string, body: unknown, method = "POST") {
    setBusy(true);
    try {
      await request(path, body, method);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const scopedBrands = brands.filter(
    (b) => b.active && inChannel(b.category, channel),
  );
  return (
    <section className="coupon-radar">
      {error && <p role="alert">{error}</p>}
      <section className="overview-metrics" aria-label="工作台概览">
        <article>
          <span>{channel === "food" ? "美食" : "游玩"}品牌监测</span>
          <strong>
            {brands.length ? scopedBrands.length : "—"}
            <small> 个启用品牌</small>
          </strong>
        </article>
        <article>
          <span>全站采集 · 第 {runs[0]?.round_number ?? "—"} 轮</span>
          <strong>
            {runs[0]
              ? `${runs[0].completed + runs[0].partial} / ${runs[0].total} 已处理`
              : "—"}
          </strong>
          <progress
            aria-label="本轮品牌处理进度"
            max={runs[0]?.total || 1}
            value={(runs[0]?.completed || 0) + (runs[0]?.partial || 0)}
          />
          <small className="collection-progress-detail">
            <span className="collection-progress-summary">
              完整采集 {runs[0]?.completed ?? 0} · 待核验/未完整{" "}
              {runs[0]?.partial ?? 0} · 已查 {runs[0]?.pages ?? 0} 页
            </span>
            <span
              className="collection-current-brand"
              title={runs[0]?.current_brand?.name}
            >
              {runs[0]?.current_brand
                ? `当前：${runs[0].current_brand.name} · 已查 ${runs[0].current_brand.pages} 页`
                : "当前：等待下一品牌"}
            </span>
          </small>
        </article>
        <article>
          <span>采集状态</span>
          <strong className="status-value">
            {!status
              ? "读取中"
              : status.pause_reason
                ? "已暂停"
                : status.worker_active
                  ? "正在采集"
                  : status.enabled
                    ? "等待下一轮"
                    : "循环未开启"}
          </strong>
          <small>全天自动循环 · 请求间隔 3–5 秒</small>
          <small>
            最近一轮用时：
            {runs.find((r) => r.finished_at)?.duration_seconds != null
              ? `${Math.round(runs.find((r) => r.finished_at)!.duration_seconds! / 60)} 分钟`
              : "待首轮完成"}
          </small>
        </article>
        <article>
          <span>上海 · 未来72小时</span>
          <strong className="status-value">
            {environment?.calendar.name ||
              (environment?.calendar.kind === "weekend"
                ? "周末"
                : environment?.calendar.kind === "workday"
                  ? "工作日"
                  : "天气与日历")}
          </strong>
          <small>
            {environment?.forecast
              ? environment.stale
                ? "天气记录已过期"
                : "天气背景已更新"
              : "等待天气数据"}
          </small>
        </article>
      </section>
      {status?.pause_reason && (
        <p className="message" role="status">
          采集已暂停：{status.pause_reason}
          。已有结果仍可查看，请在采集管理中检查来源。
        </p>
      )}
      <div className="workspace-tabs" role="group" aria-label="雷达视图">
        {[
          ["picks", "优先选券"],
          ["ai", "AI 精选"],
          ["manage", "全站采集管理"],
          ["snapshots", "全站原始快照"],
        ].map(([key, label]) => (
          <button
            key={key}
            aria-pressed={pane === key}
            onClick={() => setPane(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {pane !== "ai" && pane !== "picks" && (
        <div className="brand-toolbar">
          {" "}
          <label>
            品牌筛选{" "}
            <select
              value={brandId}
              onChange={(e) => {
                setBrandId(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">
                全部{channel === "food" ? "美食" : "游玩"}品牌（
                {scopedBrands.length}）
              </option>
              {scopedBrands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} · {b.category}
                </option>
              ))}
            </select>
          </label>
          {brandId && (
            <small>
              上次完整采集：
              {brands.find((b) => b.id === brandId)?.last_collected_at
                ? new Date(
                    brands.find((b) => b.id === brandId)!.last_collected_at!,
                  ).toLocaleString("zh-CN")
                : "暂无完整快照"}
            </small>
          )}
        </div>
      )}
      {pane === "picks" && (
        <CouponPicks
          brandId={brandId}
          channel={channel}
          brands={scopedBrands}
          onBrandChange={setBrandId}
        />
      )}
      {pane === "ai" && <AiRecommendations channel={channel} />}
      {pane === "manage" && (
        <div className="management-panel">
          <h2>采集管理</h2>
          <p className="muted">管理采集任务、查看覆盖情况和运行记录。</p>{" "}
          <div className="actions">
            {brandId && (
              <button
                disabled={
                  busy ||
                  !!status?.pause_reason ||
                  runs.some((r) => r.status === "running") ||
                  !brands.find((b) => b.id === brandId)?.active
                }
                onClick={() => void action("/runs", { brand_ids: [brandId] })}
              >
                扫描所选品牌
              </button>
            )}
            <button
              disabled={
                busy ||
                !!status?.pause_reason ||
                runs.some((r) => r.status === "running")
              }
              onClick={() => void action("/runs", {})}
            >
              扫描所有启用品牌
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void action("/settings", { enabled: !status?.enabled }, "PATCH")
              }
            >
              {status?.enabled ? "关闭自动循环" : "开启全天自动循环"}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void action(
                  "/settings",
                  { paused: !status?.pause_reason },
                  "PATCH",
                )
              }
            >
              {status?.pause_reason ? "已检查来源，恢复采集" : "暂停采集"}
            </button>
          </div>
          <h2>品牌扫描记录</h2>
          {runs.length === 0 ? (
            <p>尚未扫描。首次完整采集用于建立基线，不会作为上新提醒。</p>
          ) : (
            runs.slice(0, 5).map((r) => (
              <div key={r.id} className="coupon-run">
                <span>
                  {new Date(r.started_at).toLocaleString("zh-CN")} ·{" "}
                  {r.status === "complete"
                    ? "分页完成"
                    : r.status === "running"
                      ? "采集中"
                      : "部分完成"}{" "}
                  · 完成 {r.completed}/{r.total} 品牌
                </span>
                <button
                  onClick={() =>
                    void request<{ items: typeof tasks }>(`/runs/${r.id}`)
                      .then((d) => setTasks(d.items))
                      .catch((e) => setError(String(e)))
                  }
                >
                  查看覆盖
                </button>
                <button
                  onClick={() =>
                    void request<{ summary: NonNullable<typeof audit> }>(
                      `/runs/${r.id}/requests`,
                    )
                      .then((d) => setAudit(d.summary))
                      .catch((e) => setError(String(e)))
                  }
                >
                  请求间隔审计
                </button>
              </div>
            ))
          )}
          {audit && (
            <p role="status">
              请求记录 {audit.total} 次 · 最短间隔{" "}
              {audit.min_gap_ms == null
                ? "暂无可比记录"
                : `${audit.min_gap_ms}ms`}{" "}
              · 小于 1 秒 {audit.short_gaps} 次 · 非成功 {audit.non_success}{" "}
              次。旧轮次没有审计记录。
            </p>
          )}
          {tasks.length > 0 && (
            <details open>
              <summary>品牌任务明细</summary>
              {tasks.map((t) => (
                <p key={t.name}>
                  {t.name} ·{" "}
                  {t.state === "complete"
                    ? t.recalled === 0
                      ? "本轮空结果"
                      : t.matched === 0
                        ? "分页完成，归属未确认"
                        : "分页完成，有名称匹配线索"
                    : t.state}{" "}
                  · {t.pages} 页 · 召回 {t.recalled} 条 · 名称匹配 {t.matched}{" "}
                  条 · 当前页重试 {t.retries} 次{" "}
                  {t.error_code === "NO_BRAND_MATCH"
                    ? "前三页未匹配品牌，已停止无效翻页；待核验，不代表无券或完整采集"
                    : (t.error_code ?? "")}
                </p>
              ))}
            </details>
          )}
          <button
            onClick={() =>
              void request<{ items: NonNullable<typeof bindings> }>(
                "/brand-candidates",
              )
                .then((d) => setBindings(d.items))
                .catch((e) => setError(String(e)))
            }
          >
            查看自动品牌映射候选
          </button>
          {bindings && (
            <details open>
              <summary>品牌映射线索（未核验）</summary>
              {!bindings.length && <p>暂无完整快照中的品牌 ID 候选。</p>}
              {bindings.map((b) => (
                <p key={`${b.brand_id}-${b.platform_brand_id}`}>
                  {b.brand_name} → {b.platform_brand_name} · ID{" "}
                  {b.platform_brand_id} · {b.product_count} 条商品 ·{" "}
                  {b.conflict
                    ? "归属冲突，不能认定"
                    : "名称匹配候选，非已核验映射"}
                </p>
              ))}
            </details>
          )}
          <details onToggle={(e) => setShowAdvanced(e.currentTarget.open)}>
            <summary>更多筛选、关注记录与运行管理</summary>
            {showAdvanced && (
              <>
                <SelectionBoard brandId={brandId} />
                <SelectionBriefPanel brandId={brandId} />
                <SalesHeatPanel brandId={brandId} />
                <OperationsPanel />
                <BrandCoverage />
              </>
            )}
          </details>
          <section aria-label="上海天气与日历">
            <h3>上海未来 72 小时环境</h3>
            {environment?.forecast ? (
              <p>
                天气记录：
                {new Date(environment.forecast.observed_at).toLocaleString()} ·{" "}
                {environment.stale ? "已过期" : "有效"} ·{" "}
                {environment.forecast.hours.length} 个小时预报；日历：
                {environment.calendar.name ??
                  {
                    workday: "工作日",
                    makeup_workday: "调休工作日",
                    weekend: "周末",
                    unknown: "未知",
                  }[environment.calendar.kind] ??
                  "节假日"}
                。
              </p>
            ) : (
              <p>天气数据暂不可用，环境项保留未知。</p>
            )}
            {environment?.outlook && (
              <div className="metrics">
                {environment.outlook.days.map((d) => (
                  <article key={d.date}>
                    <strong>{d.date}</strong>
                    <p>
                      {d.name ??
                        (
                          {
                            makeup_workday: "调休工作日",
                            weekend: "周末",
                            workday: "工作日",
                          } as Record<string, string>
                        )[d.kind] ??
                        "日历未知"}
                    </p>
                    <p>
                      {d.hours
                        ? `${d.temperature_min ?? "未知"}—${d.temperature_max ?? "未知"}℃ · 最高小时降雨概率 ${d.rain_probability_max ?? "未知"}%`
                        : "天气预报未覆盖或已过期"}
                    </p>
                    <small>覆盖 {d.hours} 小时</small>
                  </article>
                ))}
              </div>
            )}
            <p>{environment?.outlook?.note}</p>
            <p>{environment?.scoring_status}</p>
            <small>
              天气来源：
              <a
                href="https://open-meteo.com/"
                target="_blank"
                rel="noreferrer"
              >
                Open-Meteo
              </a>
              （CC BY 4.0，本地非商业验证）。
            </small>
          </section>
        </div>
      )}
      {pane === "snapshots" && (
        <div className="snapshot-panel">
          {" "}
          <h2>优惠券观察</h2>
          <p>
            展示各品牌最近完整快照，共 {total} 条，每页 50
            条。名称匹配只是归属线索；全部门店与核销条件未核验，暂不产生强推荐。
          </p>
          <label>
            筛选{" "}
            <select
              value={view}
              onChange={(e) => {
                setView(e.target.value);
                setOffset(0);
              }}
            >
              <option value="matched">品牌名称匹配</option>
              <option value="not_seen">本轮未见（历史记录）</option>
              <option value="changes">有变化</option>
              <option value="unresolved">归属待确认</option>
              <option value="all">全部召回（含待核验）</option>
            </select>
          </label>
          <div className="actions">
            <button
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              上一页
            </button>
            <span>
              第 {Math.floor(offset / 50) + 1} /{" "}
              {Math.max(1, Math.ceil(total / 50))} 页
            </span>
            <button
              disabled={offset + 50 >= total}
              onClick={() => setOffset(offset + 50)}
            >
              下一页
            </button>
          </div>
          {!items.length && (
            <p>
              当前筛选下没有完整快照中的商品。可查看任务状态，区分未采集、无命中与采集异常。
            </p>
          )}
          {history && (
            <section aria-label="优惠券历史记录">
              <h3>{history.title} · 历史记录</h3>
              <p>
                最多展示最近 100 次完整采集记录；历史票面价不是当前核销承诺。
              </p>
              <button
                onClick={() => {
                  historySequence.current++;
                  setHistory(null);
                }}
              >
                关闭历史记录
              </button>
              {!history.items.length && <p>暂无该品牌的完整历史记录。</p>}
              {history.items.map((row, index) => (
                <p key={`${row.observed_at}-${index}`}>
                  {new Date(row.observed_at).toLocaleString("zh-CN")} ·{" "}
                  {price(row.payload.price_min_fen)}
                  {row.payload.price_max_fen !== row.payload.price_min_fen
                    ? `—${price(row.payload.price_max_fen)}`
                    : ""}{" "}
                  · {row.payload.name} · {row.payload.poi_name} ·{" "}
                  {comparisonLabels[row.comparison_status ?? ""] ??
                    "旧口径记录"}
                </p>
              ))}
            </section>
          )}
          <div className="coupon-grid">
            {items.map((x) => (
              <article
                className="coupon-card"
                key={`${x.brand_id}-${x.payload.product_id}-${x.run_id}`}
              >
                <small>
                  {x.brand_name} · {labels[x.kind] ?? x.kind}
                </small>
                <h3>{x.payload.name}</h3>
                <CouponStoreSummary
                  brandId={x.brand_id}
                  productId={x.payload.product_id}
                />
                {x.opportunity && (
                  <p>
                    可在销量热度榜查看月售变化；完整价值与综合评分仍待核验。
                  </p>
                )}
                <button onClick={() => void showHistory(x)}>
                  查看该券历史
                </button>
                <CouponScoreHistory
                  productId={x.payload.product_id}
                  brandId={x.brand_id}
                />
                <CouponRules
                  productId={x.payload.product_id}
                  brandId={x.brand_id}
                />
                <CouponStores
                  productId={x.payload.product_id}
                  brandId={x.brand_id}
                />
                <CouponConditionComparison
                  productId={x.payload.product_id}
                  brandId={x.brand_id}
                />
                {x.historical_only && (
                  <p>
                    以下是上次记录的商品信息，本轮未命中，当前价格与可售状态未知。
                  </p>
                )}
                {x.kind === "BASELINE_RESET" && (
                  <p>
                    比较已跳过：
                    {(
                      {
                        LEGACY_BASELINE: "旧基线缺少口径记录",
                        QUERY_CHANGED: "查询条件或匹配口径变化",
                        STALE_BASELINE: "距上次完整采集超过36小时",
                      } as Record<string, string>
                    )[x.comparison_status] ?? x.comparison_status}
                    。
                  </p>
                )}
                <strong>
                  {x.historical_only ? "历史票面价 " : ""}
                  {price(x.payload.price_min_fen)}
                  {x.payload.price_max_fen !== x.payload.price_min_fen
                    ? ` — ${price(x.payload.price_max_fen)}`
                    : ""}
                </strong>
                {x.old_payload && (
                  <p>
                    上次价格：{price(x.old_payload.price_min_fen)} ·{" "}
                    {x.old_payload.name}
                  </p>
                )}
                {x.assessment?.delta_fen != null &&
                  x.assessment.delta_fen !== 0 && (
                    <p>
                      票面价格{x.assessment.delta_fen < 0 ? "降低" : "提高"}{" "}
                      {price(Math.abs(x.assessment.delta_fen))}，性价比待核验
                    </p>
                  )}
                <details>
                  <summary>核验依据与缺口</summary>
                  <p>
                    {x.assessment?.city_status === "associated_poi_shanghai"
                      ? "来源显示关联门店位于上海，不代表全部适用门店"
                      : "上海适用范围尚未证实"}
                  </p>
                  <ul>
                    {x.assessment?.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </details>
                <p>
                  {x.payload.poi_name} · {x.payload.monthly_sales}
                </p>
                <p>
                  {x.payload.identity === "name_match"
                    ? "平台品牌名称匹配，店域待核验"
                    : "品牌归属未确认，请勿直接采用"}
                </p>
                <small>
                  {x.historical_only ? "未见记录生成于" : "采集于"}{" "}
                  {new Date(x.observed_at).toLocaleString("zh-CN")} · 商品{" "}
                  {x.payload.product_id}
                </small>
                {x.payload.identity === "name_match" &&
                  !x.historical_only &&
                  brands.some((b) => b.id === x.brand_id && b.active) && (
                    <CouponMedia
                      brandId={x.brand_id}
                      productId={x.payload.product_id}
                    />
                  )}
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
