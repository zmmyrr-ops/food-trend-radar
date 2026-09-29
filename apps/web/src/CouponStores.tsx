import { useState } from "react";
import { appFetch } from "./app-url";

type Result = {
  context?: { status: string; price_observed_at: string | null };
  items: {
    observed_at: string;
    payload: {
      reported_count: number;
      matched_count: number;
      returned_id_count?: number;
      queried_id_count?: number;
      missing_ids?: string[];
      unverified_count?: number;
      complete: boolean;
      shanghai_count: number;
      stores: {
        poi_id: string;
        poi_name: string;
        city_name?: string;
        address?: string;
        shanghai: boolean;
      }[];
    };
  }[];
  tasks: {
    state: string;
    error_code?: string;
    scope?: { count: number };
    cursor: number;
  }[];
};
export function CouponStores({
  productId,
  brandId,
}: {
  productId: string;
  brandId: string;
}) {
  const [data, setData] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    setBusy(true);
    setError("");
    try {
      const response = await appFetch(
        `/api/v3/coupons/${encodeURIComponent(productId)}/stores?brand_id=${encodeURIComponent(brandId)}`,
      );
      if (!response.ok) throw new Error();
      setData(await response.json());
    } catch {
      setError("门店查询失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }
  const snapshot = data?.items[0];
  return (
    <div>
      <button disabled={busy} onClick={() => void load()}>
        {busy ? "读取中…" : "查看适用门店采集结果"}
      </button>
      {error && <p role="alert">{error}</p>}
      {data && (
        <section aria-label="适用门店证据">
          <button onClick={() => setData(null)}>收起门店</button>
          <p>
            本轮任务：{data.tasks[0]?.state ?? "尚未入队"}
            {data.tasks[0]?.error_code ? `（${data.tasks[0].error_code}）` : ""}
            。此处读取本地记录，不会触发额外采集。
          </p>
          <p>
            仅查询该品牌当前完整轮次；旧快照不会替代本轮缺失证据。
            {data.context?.status === "stale" ? "当前价格快照已过期。" : ""}
          </p>
          {snapshot ? (
            <>
              <p>
                快照采集于 {new Date(snapshot.observed_at).toLocaleString()}
                。平台声明 {snapshot.payload.reported_count} 家，已取得{" "}
                {snapshot.payload.matched_count} 家；
                {snapshot.payload.complete
                  ? "门店 ID 已全部核对"
                  : "门店范围不完整"}
                。其中城市与行政区划码均指向上海的{" "}
                {snapshot.payload.shanghai_count} 家。
              </p>
              {!snapshot.payload.complete && (
                <p>
                  接口返回 {snapshot.payload.returned_id_count ?? "未知"} 个门店
                  ID；按声明数量仍有{" "}
                  {snapshot.payload.unverified_count ??
                    Math.max(
                      0,
                      snapshot.payload.reported_count -
                        snapshot.payload.matched_count,
                    )}{" "}
                  家未核验。已展示门店只是部分范围，不推断剩余门店所在城市。
                </p>
              )}
              {snapshot.payload.queried_id_count != null && (
                <p>
                  已查询 {snapshot.payload.queried_id_count} 个已知门店 ID，
                  其中 {snapshot.payload.missing_ids?.length ?? "未知"}{" "}
                  个未返回。
                  单批缺失不会阻止后续已知门店查询；未返回不等于门店关闭或不可用。
                </p>
              )}
              <p>
                门店信息仍需结合使用日期、资格及费用规则；此结果不表示已确认性价比。只展示当前完整轮次证据，不用上轮门店替代。
              </p>
              <ul>
                {snapshot.payload.stores.map((s) => (
                  <li key={s.poi_id}>
                    {s.poi_name} · {s.city_name ?? "城市未知"} ·{" "}
                    {s.shanghai ? "上海证据已取得" : "未确认上海"}
                    <p>{s.address ?? "地址未返回"}</p>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>尚无门店快照，待串行采集。缺失数据不会视作全上海适用。</p>
          )}
        </section>
      )}
    </div>
  );
}
