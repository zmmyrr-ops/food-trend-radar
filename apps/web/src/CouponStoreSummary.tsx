import { useEffect, useRef, useState } from "react";
import { appFetch } from "./app-url";

type Result = {
  context: { status: string };
  source_shop: { name: string; address: string; observed_at: string } | null;
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
          <p
            title={
              data?.source_shop
                ? `${data.source_shop.address || "地址未返回"} · 平台就近门店信息，不代表全部适用门店`
                : undefined
            }
          >
            <span className="coupon-store-label">关联店家：</span>
            {data ? data.source_shop?.name || "平台未返回店名" : "读取中…"}
          </p>
          {data?.source_shop && (
            <p className="coupon-store-note">
              非全部适用门店
              {data.context.status === "stale" ? "（采集记录已过期）" : ""}
            </p>
          )}
        </>
      )}
    </div>
  );
}
