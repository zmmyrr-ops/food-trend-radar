import { useEffect, useState } from "react";
import { appFetch } from "./app-url";
import { BrandIcon } from "./BrandIcon";
import { CouponUsageRules } from "./CouponUsageRules";

type Coupon = {
  brand_name: string;
  icon_url: string | null;
  title: string;
  price_fen: number | null;
  origin_price_fen: number | null;
  shop_name: string;
  address: string;
  availability?: string;
  availability_message?: string;
};
const money = (n: number) => `¥${(n / 100).toFixed(2)}`;
export function StudioCoupon({
  brandId,
  productId,
}: {
  brandId: string;
  productId: string;
}) {
  const [item, setItem] = useState<Coupon | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setItem(null);
    setError(null);
    void appFetch(
      `/api/v3/coupons/${encodeURIComponent(productId)}/summary?brand_id=${encodeURIComponent(brandId)}`,
      { signal: controller.signal },
    )
      .then(async (r) => {
        if (r.status === 404)
          throw Error("暂无该券历史信息，无法确认是否下架。");
        if (!r.ok) throw Error("券信息暂时无法读取。");
        return r.json();
      })
      .then((d) => {
        if (!controller.signal.aborted) setItem(d.item);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e.message || "券信息暂时无法读取。");
      });
    return () => controller.abort();
  }, [brandId, productId, retry]);
  return (
    <section className="studio-coupon" aria-label="当前制作的券">
      {!item ? (
        <p>
          {error ? (
            <>
              {error}
              <button onClick={() => setRetry(retry + 1)}>重试</button>
            </>
          ) : (
            "正在读取券信息…"
          )}
        </p>
      ) : (
        <>
          {item.availability_message && (
            <p role="status">{item.availability_message}</p>
          )}
          <div className="studio-coupon-heading">
            <BrandIcon name={item.brand_name} url={item.icon_url} />
            <div>
              <small>{item.brand_name}</small>
              <h2>{item.title}</h2>
            </div>
            <div className="studio-coupon-price">
              <strong>
                {item.price_fen == null ? "价格暂无" : money(item.price_fen)}
              </strong>
              {item.origin_price_fen != null &&
                item.origin_price_fen > 0 &&
                item.price_fen != null && (
                  <span>
                    原价 {money(item.origin_price_fen)} ·{" "}
                    {((item.price_fen / item.origin_price_fen) * 10).toFixed(1)}
                    折
                  </span>
                )}
            </div>
          </div>
          {item.shop_name && (
            <p className="muted">
              关联店家：{item.shop_name}
              {item.address ? ` · ${item.address}` : ""}
            </p>
          )}
          {item.availability === "available" && (
            <CouponUsageRules brandId={brandId} productId={productId} />
          )}
        </>
      )}
    </section>
  );
}
