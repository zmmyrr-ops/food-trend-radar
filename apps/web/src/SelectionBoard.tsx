import { useCallback, useEffect, useState } from "react";
import { appFetch } from "./app-url";
import { CouponConditionComparison } from "./CouponConditionComparison";
import { CouponRules } from "./CouponRules";
import { CouponStoreSummary } from "./CouponStoreSummary";
import { CouponStores } from "./CouponStores";
import { CouponUseOutlook, type UseOutlook } from "./CouponUseOutlook";

type Candidate = {
  use_outlook: UseOutlook;
  run_id: string;
  brand_id: string;
  brand_name: string;
  product_id: string;
  title: string;
  revision: string;
  kind: string;
  reason: string;
  observed_at: string;
  first_seen_at: string;
  disposition: string;
  current_price_fen: number | null;
  current_price_max_fen: number | null;
  previous_price_fen: number | null;
  previous_price_max_fen: number | null;
  saving_fen: number | null;
  reduction_rate: number | null;
  changed_fields: string[];
  missing_sources: string[];
  blockers: string[];
};
type Board = {
  items: Candidate[];
  total: number;
  baseline: { enabled: number; fresh: number; comparable: number };
  summary: Record<string, number>;
  caveat: string;
  generated_at: string;
};
const money = (n: number | null) =>
  n === null ? "未知" : `¥${(n / 100).toFixed(2)}`;
const range = (a: number | null, b: number | null) =>
  a === b ? money(a) : `${money(a)}—${money(b)}`;
const labels: Record<string, string> = {
  price_drop: "票面降价",
  quantity_increase: "同价列示增量",
  watched: "关注中 · 无新变化",
  first_observed: "首次发现",
  reappeared: "历史券再次出现",
  terms_changed: "套餐/规则变化",
};
export function SelectionBoard({ brandId }: { brandId: string }) {
  const [filter, setFilter] = useState("all"),
    [offset, setOffset] = useState(0),
    [data, setData] = useState<Board | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState(""),
    [minSaving, setMinSaving] = useState("0"),
    [minDrop, setMinDrop] = useState("0"),
    [order, setOrder] = useState("priority"),
    [usage, setUsage] = useState("any");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);
  const [alerts, setAlerts] = useState<
    {
      id: string;
      title: string;
      acknowledged_at: string | null;
      created_at: string;
      payload: {
        count?: number;
        caveat?: string;
        top?: { brand: string; title: string; reason: string }[];
      };
    }[]
  >([]);
  useEffect(() => {
    setOffset(0);
  }, [brandId, search, minSaving, minDrop, order, usage]);
  useEffect(() => {
    let cancelled = false;
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const response = await appFetch(
          `/api/v3/selection-board?${new URLSearchParams({ filter, offset: String(offset), limit: "20", search, min_saving_fen: String(Math.round(Number(minSaving || 0) * 100)), min_drop_percent: minDrop || "0", order, usage, ...(brandId ? { brand_id: brandId } : {}) })}`,
        );
        if (!response.ok) throw Error("读取机会榜失败");
        const next = await response.json();
        if (!cancelled) {
          setData(next);
          if (next.total > 0 && offset >= next.total) setOffset(0);
          setError("");
        }
      } catch {
        if (!cancelled) setError("机会榜暂时无法更新，已有内容可能过期。");
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 60000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    brandId,
    filter,
    offset,
    refresh,
    search,
    minSaving,
    minDrop,
    order,
    usage,
  ]);
  const loadAlerts = useCallback(async () => {
    try {
      const response = await appFetch("/api/v3/alerts");
      if (!response.ok) return;
      const d = await response.json();
      setAlerts(
        d.items
          .filter((x: { kind: string }) => x.kind === "scan_digest")
          .slice(0, 5),
      );
    } catch {
      /* Next refresh retries. */
    }
  }, []);
  useEffect(() => {
    void loadAlerts();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void loadAlerts();
    }, 60000);
    return () => clearInterval(timer);
  }, [loadAlerts]);
  async function disposition(item: Candidate, state: string) {
    setBusy(true);
    try {
      const r = await appFetch(
        `/api/v3/selection-board/${item.product_id}/disposition`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brand_id: item.brand_id,
            revision: item.revision,
            state,
          }),
        },
      );
      if (!r.ok)
        throw Error(r.status === 409 ? "券已变化，请刷新后重试" : "保存失败");
      setRefresh((x) => x + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="选题机会榜" className="selection-board">
      <h2>今天先看哪些优惠</h2>
      <p>
        自动筛出降价、首次发现和内容变化；下方销量热度榜按月售净增速度与加速度排序，不衡量内容竞争。
      </p>
      {data && (
        <p>
          {data.baseline.enabled} 个启用品牌 · {data.baseline.fresh}{" "}
          个有新鲜基线 · {data.baseline.comparable} 个可与上次比较。票面降价{" "}
          {data.summary.price_drop} 条 · 首次发现 {data.summary.first_observed}{" "}
          条 · 同价列示增量 {data.summary.quantity_increase ?? 0} 条 · 内容变化{" "}
          {data.summary.terms_changed} 条。另有 {data.summary.reappeared ?? 0}{" "}
          条历史券再次出现，默认不计入新机会。
        </p>
      )}
      <div className="actions">
        <label>
          机会类型{" "}
          <select
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setOffset(0);
            }}
          >
            <option value="all">全部待看</option>
            <option value="price_drop">票面降价</option>
            <option value="quantity_increase">同价列示增量</option>
            <option value="first_observed">首次发现</option>
            <option value="reappeared">历史券再次出现（不计新机会）</option>
            <option value="terms_changed">套餐/规则变化</option>
            <option value="watching">已关注</option>
            <option value="dismissed">暂不考虑</option>
          </select>
        </label>
        <label>
          品牌或券名{" "}
          <input
            value={searchInput}
            maxLength={100}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </label>
        <label>
          至少降价（元）{" "}
          <input
            type="number"
            min="0"
            max="1000000"
            step="0.01"
            value={minSaving}
            onChange={(e) => setMinSaving(e.target.value)}
          />
        </label>
        <label>
          至少降幅（%）{" "}
          <input
            type="number"
            min="0"
            max="100"
            value={minDrop}
            onChange={(e) => setMinDrop(e.target.value)}
          />
        </label>
        <label>
          排序{" "}
          <select value={order} onChange={(e) => setOrder(e.target.value)}>
            <option value="priority">默认优先级</option>
            <option value="saving">少付金额</option>
            <option value="reduction">降价比例</option>
            <option value="newest">最新采集</option>
          </select>
        </label>
        <label>
          使用限制{" "}
          <select value={usage} onChange={(e) => setUsage(e.target.value)}>
            <option value="any">全部限制情况</option>
            <option value="has_exclusions">存在明确禁用日期</option>
            <option value="not_fully_excluded">
              排除整窗明确禁用（其余未确认）
            </option>
          </select>
        </label>
        <button onClick={() => setRefresh((x) => x + 1)}>刷新机会榜</button>
      </div>
      {data && (
        <small>
          榜单更新：{new Date(data.generated_at).toLocaleString("zh-CN")}
          ；每分钟自动更新。降价门槛大于 0 时仅展示可计算价差的券。
        </small>
      )}
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p>正在汇总真实变化…</p>}
      {data && !data.items.length && (
        <p role="status">
          {data.baseline.comparable === 0
            ? "目前正在建立可比较基线，尚不能判断哪些券新上架或变得更优惠。后续完整扫描会自动进入比较。"
            : "当前筛选没有可展示的变化线索。首次建库、过期基线及归属冲突不会冒充新优惠。"}
        </p>
      )}
      <div className="coupon-grid">
        {data?.items.map((x) => (
          <article
            className="coupon-card"
            key={`${x.brand_id}:${x.product_id}:${x.run_id}`}
          >
            <small>
              {x.brand_name} · {labels[x.kind]}
              {x.disposition === "watching" ? " · 已关注" : ""}
            </small>
            <h3>{x.title}</h3>
            <CouponStoreSummary brandId={x.brand_id} productId={x.product_id} />
            <p>
              {x.kind === "first_observed" || x.previous_price_fen === null ? (
                "当前价格 "
              ) : x.previous_price_fen === x.current_price_fen &&
                x.previous_price_max_fen === x.current_price_max_fen ? (
                "价格未变 "
              ) : (
                <>{range(x.previous_price_fen, x.previous_price_max_fen)} → </>
              )}
              <strong>
                {range(x.current_price_fen, x.current_price_max_fen)}
              </strong>
            </p>
            {x.kind === "price_drop" && (
              <p>
                票面少付 {money(x.saving_fen)}
                {x.reduction_rate !== null
                  ? `（下降 ${(x.reduction_rate * 100).toFixed(1)}%）`
                  : ""}
                ；实际性价比待核验。
              </p>
            )}
            <p>{x.reason}</p>
            <CouponUseOutlook data={x.use_outlook} />
            {x.kind === "reappeared" && (
              <p>
                最早完整记录：
                {new Date(x.first_seen_at).toLocaleString("zh-CN")}
              </p>
            )}
            {x.changed_fields.length > 0 && (
              <p>同时变化：{x.changed_fields.join("、")}</p>
            )}
            <p>采集于 {new Date(x.observed_at).toLocaleString("zh-CN")}</p>
            <div className="actions">
              <button
                disabled={busy}
                onClick={() =>
                  void disposition(
                    x,
                    x.disposition === "watching" ? "new" : "watching",
                  )
                }
              >
                {x.disposition === "watching" ? "取消关注" : "关注这张券"}
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void disposition(
                    x,
                    x.disposition === "dismissed" ? "new" : "dismissed",
                  )
                }
              >
                {x.disposition === "dismissed" ? "恢复待看" : "暂不考虑"}
              </button>
            </div>
            <details>
              <summary>查看判断依据与缺口</summary>
              <ul>
                {[...x.blockers, ...x.missing_sources].map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
              <CouponConditionComparison
                productId={x.product_id}
                brandId={x.brand_id}
              />
              <CouponRules productId={x.product_id} brandId={x.brand_id} />
              <CouponStores productId={x.product_id} brandId={x.brand_id} />
            </details>
          </article>
        ))}
      </div>
      {data && data.total > 0 && (
        <div className="actions">
          <button
            disabled={offset === 0}
            onClick={() => setOffset((x) => Math.max(0, x - 20))}
          >
            上一组机会
          </button>
          <span>
            共 {data.total} 条 · 第 {Math.floor(offset / 20) + 1} 页
          </span>
          <button
            disabled={offset + 20 >= data.total}
            onClick={() => setOffset((x) => x + 20)}
          >
            下一组机会
          </button>
        </div>
      )}
      <small>
        {data?.caveat}
        。关注只影响个人筛选，不会改变算法分数；新变化会让暂不考虑的券重新进入待看。
      </small>
      <details>
        <summary>每轮扫描摘要（最近 5 条）</summary>
        {!alerts.length && <p>本轮完成后自动生成摘要，无须保持聊天在线。</p>}
        {alerts.map((a) => (
          <article key={a.id}>
            <h3>{a.title}</h3>
            <small>{new Date(a.created_at).toLocaleString("zh-CN")}</small>
            <p>{a.payload.caveat}</p>
            <ul>
              {a.payload.top?.map((x, i) => (
                <li key={`${x.brand}:${i}`}>
                  {x.brand} · {x.title}：{x.reason}
                </li>
              ))}
            </ul>
            <button
              disabled={!!a.acknowledged_at}
              onClick={async () => {
                try {
                  const r = await appFetch(`/api/v3/alerts/${a.id}/ack`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: "{}",
                  });
                  if (!r.ok) throw Error();
                  await loadAlerts();
                } catch {
                  setError("标记已读失败，请重试");
                }
              }}
            >
              {a.acknowledged_at ? "已读" : "标记已读"}
            </button>
          </article>
        ))}
      </details>
    </section>
  );
}
