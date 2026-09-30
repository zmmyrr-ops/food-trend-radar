import { useEffect, useRef, useState } from "react";
import { appFetch } from "./app-url";

type Store = {
  poi_id: string;
  poi_name: string;
  address?: string;
  city_name?: string;
  shanghai: boolean;
};
type Result = {
  context: { status: string };
  source_shop: { name: string; address: string; observed_at: string } | null;
  items: {
    payload: {
      reported_count: number;
      matched_count: number;
      shanghai_count: number;
      complete: boolean;
      stores: Store[];
    };
  }[];
};
const cache = new Map<string, { at: number; value: Promise<Result> }>();
function read(key: string) {
  const saved = cache.get(key);
  if (saved && Date.now() - saved.at < 60000) return saved.value;
  const value = appFetch(key)
    .then(async (r) => {
      if (!r.ok) throw Error("门店信息暂时读取失败");
      return (await r.json()) as Result;
    })
    .catch((e) => {
      cache.delete(key);
      throw e;
    });
  if (cache.size > 300) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}
export function CouponStoreSummary({
  brandId,
  productId,
}: {
  brandId: string;
  productId: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError("");
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        void read(
          `/api/v3/coupons/${encodeURIComponent(productId)}/stores?brand_id=${encodeURIComponent(brandId)}`,
        )
          .then((d) => {
            if (!cancelled) setData(d);
          })
          .catch((e) => {
            if (!cancelled) setError(e.message);
          });
      },
      { rootMargin: "150px" },
    );
    if (ref.current) observer.observe(ref.current);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [brandId, productId, retry]);
  const snapshot = data?.items[0]?.payload;
  const stores = [...(snapshot?.stores || [])].sort(
    (a, b) => Number(b.shanghai) - Number(a.shanghai),
  );
  return (
    <div ref={ref} className="coupon-store-summary" aria-label="券的门店信息">
      {error ? (
        <p>
          {error}{" "}
          <button type="button" onClick={() => setRetry((n) => n + 1)}>
            重试
          </button>
        </p>
      ) : (
        <>
          <p>
            <strong>采集关联店家：</strong>
            {data ? data.source_shop?.name || "平台未返回店名" : "读取中…"}
          </p>
          {data?.source_shop && (
            <p className="coupon-store-note">
              {data.source_shop.address || "地址未返回"} ·
              平台就近门店信息，不代表全部适用门店
              {data.context.status === "stale" ? "（采集记录已过期）" : ""}
            </p>
          )}
          <p>
            <strong>适用门店：</strong>
            {!data
              ? "读取中…"
              : !snapshot
                ? data.context.status === "stale"
                  ? "当前证据已过期，待更新"
                  : "尚未取得当前门店清单"
                : `已采集 ${snapshot.matched_count} / 平台声明 ${snapshot.reported_count} 家，其中上海 ${snapshot.shanghai_count} 家${snapshot.complete ? "" : "（尚未采全）"}`}
          </p>
          {!!stores.length && (
            <ul>
              {stores.slice(0, 3).map((s) => (
                <li key={s.poi_id}>
                  <span>
                    {s.poi_name}
                    {s.shanghai ? "" : ` · ${s.city_name || "城市待核验"}`}
                  </span>
                  {s.address && <small>{s.address}</small>}
                </li>
              ))}
            </ul>
          )}
          {stores.length > 3 && (
            <details>
              <summary>展开其余 {stores.length - 3} 家已采集门店</summary>
              <ul>
                {stores.slice(3).map((s) => (
                  <li key={s.poi_id}>
                    {s.poi_name} · {s.city_name || "城市待核验"}
                    {s.address && <small>{s.address}</small>}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!!snapshot && (
            <p className="coupon-store-note">
              适用情况还需结合日期及券的使用条件。
            </p>
          )}
        </>
      )}
    </div>
  );
}
