import { useEffect, useState } from "react";
import { appFetch, appUrl } from "./app-url";
import { CouponRules } from "./CouponRules";
import { CouponStores } from "./CouponStores";

type Item = {
  content_comparison?: string;
  brand_id: string;
  product_id: string;
  brand_name: string;
  title: string;
  price_fen: number | null;
  speed: number | null;
  previous_speed: number | null;
  speed_change: number | null;
  acceleration: number | null;
  net_change: number | null;
  hours: number | null;
  price_changed: boolean;
  reason: string;
  baseline_speed: number | null;
  lift_ratio: number | null;
  baseline_windows: number;
  baseline_reason: string;
  acceleration_reason: string;
  samples: {
    run_id: string;
    observed_at: string;
    monthly_sales: string;
    missing?: boolean;
  }[];
};
type Data = {
  generated_at: string;
  total: number;
  coverage: {
    total: number;
    measured: number;
    rising: number;
    accelerating: number;
    baseline_ready: number;
    unknown_reasons: Record<string, number>;
  };
  items: Item[];
  caveat: string;
};
const num = (v: number | null) => (v === null ? "未知" : v.toFixed(2));
export function SalesHeatPanel({ brandId }: { brandId: string }) {
  const [search, setSearch] = useState(""),
    [searchInput, setSearchInput] = useState(""),
    [minSpeed, setMinSpeed] = useState("0"),
    [minNet, setMinNet] = useState("0");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [order, setOrder] = useState("speed"),
    [filter, setFilter] = useState("all"),
    [offset, setOffset] = useState(0);
  useEffect(() => {
    setOffset(0);
  }, [brandId, order, filter, search, minSpeed, minNet]);
  useEffect(() => {
    let cancelled = false,
      loading = false;
    setData(null);
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const r = await appFetch(
          `/api/v3/sales-heat?${new URLSearchParams({ order, filter, search, min_speed: minSpeed || "0", min_net: minNet || "0", offset: String(offset), ...(brandId ? { brand_id: brandId } : {}) })}`,
        );
        if (!r.ok) throw Error();
        const d = await r.json();
        if (!cancelled) {
          setData(d);
          setError("");
          if (offset > 0 && offset >= d.total) setOffset(0);
        }
      } catch {
        if (!cancelled) setError("销量热度更新失败，已有结果可能过期。");
      } finally {
        loading = false;
      }
    }
    void load();
    const timer = setInterval(() => void load(), 60000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [brandId, order, filter, offset, search, minSpeed, minNet]);
  return (
    <section aria-label="优惠券销量热度">
      <h2>优惠券热度提升速度</h2>
      <p>按同一张券的月售净变化观察成交热度；与达人数量、内容竞争无关。</p>
      <div className="actions">
        <label>
          热度排序{" "}
          <select value={order} onChange={(e) => setOrder(e.target.value)}>
            <option value="speed">月售净增速度</option>
            <option value="acceleration">月售净增加速度</option>
            <option value="lift_ratio">相对自身历史倍数</option>
            <option value="newest">最新采集</option>
          </select>
        </label>
        <label>
          热度筛选{" "}
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">全部（未知排后）</option>
            <option value="rising">月售净增长</option>
            <option value="accelerating">净增长加快</option>
            <option value="unknown">暂不能计算</option>
          </select>
        </label>
        <label>
          券名或品牌{" "}
          <input
            maxLength={100}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </label>
        <label>
          最低净增速度{" "}
          <input
            type="number"
            min="0"
            max="10000000"
            step="0.1"
            value={minSpeed}
            onChange={(e) => setMinSpeed(e.target.value)}
          />
        </label>
        <label>
          最低净增数量{" "}
          <input
            type="number"
            min="0"
            max="1000000000"
            value={minNet}
            onChange={(e) => setMinNet(e.target.value)}
          />
        </label>
      </div>
      <a
        href={appUrl(
          `/api/v3/sales-heat.csv?${new URLSearchParams({ order, filter, search, min_speed: minSpeed || "0", min_net: minNet || "0", ...(brandId ? { brand_id: brandId } : {}) })}`,
        )}
        download
      >
        下载当前筛选全部热度记录（CSV）
      </a>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p>正在计算销量快照…</p>}
      {data && (
        <>
          <p>
            {data.coverage.total} 张券 · {data.coverage.measured} 张可计算速度 ·{" "}
            {data.coverage.rising} 张净增长 · {data.coverage.accelerating}{" "}
            张增长加快。
          </p>
          <p>
            {data.coverage.baseline_ready}{" "}
            张具有可计算的自身历史倍数；历史基准排除当前窗口，至少 4
            个连续窗口、覆盖 24 小时。倍数较高不代表已验证爆发。
          </p>
          <details>
            <summary>为什么部分券不能计算速度</summary>
            <ul>
              {Object.entries(data.coverage.unknown_reasons).map(
                ([reason, count]) => (
                  <li key={reason}>
                    {count} 张：{reason}
                  </li>
                ),
              )}
            </ul>
          </details>
          <p>{data.caveat}</p>
          <small>
            计算于 {new Date(data.generated_at).toLocaleString("zh-CN")}
            ，页面每分钟更新；采集仍为每日两次。导出包含当前筛选全部记录，不限本页；未知值为空，商品
            ID 保留文本标记。
          </small>
          <div className="coupon-grid">
            {data.items.map((x) => (
              <article
                className="coupon-card"
                key={`${x.brand_id}:${x.product_id}`}
              >
                <small>{x.brand_name}</small>
                <h3>{x.title}</h3>
                <p>
                  当前票面起价：
                  {x.price_fen === null
                    ? "未知"
                    : `¥${(x.price_fen / 100).toFixed(2)}`}
                  （具体套餐及限制需核验）
                </p>
                <p>
                  净增速度：<strong>{num(x.speed)}</strong> /小时 · 加速度：
                  {num(x.acceleration)} /小时²
                </p>
                <p>
                  月售净变化：{x.net_change ?? "未知"} · 间隔：{num(x.hours)}{" "}
                  小时
                </p>
                <p>
                  {x.reason}
                  {x.price_changed
                    ? " 同期价格发生变化；不能据此断言价格导致热度变化。"
                    : ""}
                </p>
                <p>
                  相对自身历史：{num(x.lift_ratio)} 倍 · 历史中位速度：
                  {num(x.baseline_speed)} /小时
                </p>
                <details>
                  <summary>查看销量原文与计算依据</summary>
                  <p>
                    上段速度 {num(x.previous_speed)} /小时；速度差{" "}
                    {num(x.speed_change)} /小时。
                  </p>
                  <p>
                    权益连续性：
                    {x.content_comparison === "changed"
                      ? "已返回套餐或条款已变化，停止跨版本比较"
                      : x.content_comparison === "same_returned_content"
                        ? "已返回套餐与条款一致，不代表完整权益已核验"
                        : "证据缺失、不完整或时间不合格；不能确认套餐未变化"}
                    。
                  </p>
                  <p>加速度依据：{x.acceleration_reason}</p>
                  <p>
                    历史基准（{x.baseline_windows} 个窗口）：{x.baseline_reason}
                  </p>
                  <ul>
                    {x.samples.map((s) => (
                      <li key={s.run_id}>
                        {new Date(s.observed_at).toLocaleString("zh-CN")}：
                        {s.missing
                          ? "该次完整扫描未见此券（不等于下架）"
                          : s.monthly_sales || "销量缺失"}
                      </li>
                    ))}
                  </ul>
                </details>
                <details>
                  <summary>核验这张券的权益与门店</summary>
                  <CouponRules productId={x.product_id} brandId={x.brand_id} />
                  <CouponStores productId={x.product_id} brandId={x.brand_id} />
                </details>
              </article>
            ))}
          </div>
          {!data.items.length && (
            <p>当前没有符合筛选条件的券，不用零值代替未知。</p>
          )}
          <div className="actions">
            <button
              disabled={!offset}
              onClick={() => setOffset((x) => Math.max(0, x - 20))}
            >
              上一页热度
            </button>
            <span>
              共 {data.total} 条 · 第 {offset / 20 + 1} 页
            </span>
            <button
              disabled={offset + 20 >= data.total}
              onClick={() => setOffset((x) => x + 20)}
            >
              下一页热度
            </button>
          </div>
        </>
      )}
    </section>
  );
}
