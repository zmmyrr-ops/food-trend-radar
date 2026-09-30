import { useRef, useState } from "react";
import { appFetch } from "./app-url";

type Rule = { key: string; name: string; value: { content: string }[] };

/** Show source terms only; scoring and inferred restrictions belong elsewhere. */
export function CouponUsageRules({
  productId,
  brandId,
}: {
  productId: string;
  brandId: string;
}) {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [error, setError] = useState(false);
  const loading = useRef(false);
  async function load() {
    if (loading.current || rules !== null) return;
    loading.current = true;
    setError(false);
    try {
      const response = await appFetch(
        `/api/v3/coupons/${encodeURIComponent(productId)}/rules?brand_id=${encodeURIComponent(brandId)}`,
      );
      if (!response.ok) throw new Error("rules unavailable");
      const data = await response.json();
      const source: Rule[] = data.items?.[0]?.payload?.rules ?? [];
      setRules(
        source
          .map((rule) => ({
            ...rule,
            value: rule.value.filter((entry) => entry.content?.trim()),
          }))
          .filter((rule) => rule.value.length > 0),
      );
    } catch {
      setError(true);
    } finally {
      loading.current = false;
    }
  }
  return (
    <details
      className="card-evidence coupon-usage-rules"
      onToggle={(event) => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary>使用规则</summary>
      {error ? (
        <p role="alert">
          规则读取失败。<button onClick={() => void load()}>重试</button>
        </p>
      ) : rules === null ? (
        <p className="muted">读取中…</p>
      ) : rules.length === 0 ? (
        <p className="muted">暂无附加使用条件</p>
      ) : (
        rules.map((rule, index) => (
          <div key={`${rule.key}-${index}`}>
            {rule.name && <strong>{rule.name}</strong>}
            {rule.value.map((entry, i) => (
              <p key={`${rule.key}-${i}`}>{entry.content}</p>
            ))}
          </div>
        ))
      )}
    </details>
  );
}
