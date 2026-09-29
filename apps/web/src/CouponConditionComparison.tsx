import { useState } from "react";
import { appFetch } from "./app-url";

type Comparison = {
  current_observed_at: string;
  previous_observed_at: string | null;
  current_evidence: {
    fresh: boolean;
    rules_ready: boolean;
    rule_text_ready?: boolean;
    stores_ready: boolean;
    shanghai_count: number | null;
  };
  rules: { status: string; changes: string[]; scope?: string };
  stores: { status: string; added_ids: string[]; removed_ids: string[] };
  price: { direction: string; delta_fen: number | null };
  signal: string;
  coupon_differences?: {
    field: string;
    label: string;
    before: string | null;
    after: string | null;
  }[];
  rule_differences?: {
    field: string;
    label: string;
    before: string[];
    after: string[];
  }[];
  quantity_changes?: {
    name: string;
    unit: string;
    before: number;
    after: number;
  }[];
  condition_risks?: {
    kind: string;
    message: string;
    before: string[];
    after: string[];
  }[];
  blockers: string[];
};
export function CouponConditionComparison({
  productId,
  brandId,
}: {
  productId: string;
  brandId: string;
}) {
  const [data, setData] = useState<Comparison | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    setBusy(true);
    setError("");
    try {
      const r = await appFetch(
        `/api/v3/coupons/${encodeURIComponent(productId)}/condition-comparison?brand_id=${encodeURIComponent(brandId)}`,
      );
      if (!r.ok)
        throw new Error(
          r.status === 404
            ? "该券本轮未命中，没有当前条件可比较"
            : "条件比较读取失败",
        );
      setData(await r.json());
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "读取失败");
    } finally {
      setBusy(false);
    }
  }
  const labels: Record<string, string> = {
    price_drop_same_returned_conditions:
      "票面降价，已返回条件一致（仍待完整核验）",
    price_drop_conditions_unverified: "票面降价，但条件尚未确认一致",
    listed_quantity_increase_same_price:
      "同价，已返回套餐项数量增加（完整价值仍待核验）",
    no_confirmed_improvement: "尚无确认的优惠提升",
  };
  return (
    <div>
      <button disabled={busy} onClick={() => void load()}>
        {busy ? "比较中…" : "查看同券条件比较"}
      </button>
      {error && <p role="alert">{error}</p>}
      {data && (
        <section aria-label="同券条件比较">
          <button onClick={() => setData(null)}>收起比较</button>
          <strong>{labels[data.signal]}</strong>
          <p>
            本轮 {new Date(data.current_observed_at).toLocaleString()}；上轮{" "}
            {data.previous_observed_at
              ? new Date(data.previous_observed_at).toLocaleString()
              : "无记录"}
            。
            {data.current_evidence.fresh
              ? "当前快照未超过36小时"
              : "当前快照过期或时间异常"}
            。
          </p>
          <p>
            本轮规则：
            {data.current_evidence.rules_ready
              ? "已取得套餐与规则字段"
              : data.current_evidence.rule_text_ready
                ? "已取得条款文字，完整权益仍缺失"
                : "证据不足"}
            ；门店：
            {data.current_evidence.stores_ready
              ? `完整 ID 范围，其中上海 ${data.current_evidence.shanghai_count} 家`
              : "证据不足"}
            。
          </p>
          <p>
            套餐与规则：
            {data.rules.status === "unknown"
              ? "无法比较"
              : data.rules.changes.join("、") ||
                (data.rules.scope === "text_only"
                  ? "返回条款文字相同，套餐权益无法比较"
                  : "返回条件一致")}
            。门店范围：
            {data.stores.status === "unknown"
              ? "无法比较"
              : data.stores.status === "same"
                ? "相同"
                : `新增 ${data.stores.added_ids.length} 家、减少 ${data.stores.removed_ids.length} 家`}
            。
          </p>
          <p>
            票面价差：
            {data.price.delta_fen === null
              ? "未知或不能直接比较"
              : `${(data.price.delta_fen / 100).toFixed(2)} 元（本轮减上轮）`}
            。返回条件一致不代表完整资格与费用一致，不据此提高机会分。
          </p>
          {data.condition_risks?.map((risk, index) => (
            <section key={`${risk.kind}:${index}`} aria-label="优惠条件风险">
              <strong>{risk.message}</strong>
              <p>
                上次：
                {risk.before.join("；") ||
                  "未识别到明确条款，不代表没有限制或费用"}
              </p>
              <p>本次：{risk.after.join("；")}</p>
            </section>
          ))}
          {data.coupon_differences?.map((d) => (
            <section key={d.field} aria-label={`${d.label}前后对比`}>
              <h4>{d.label}</h4>
              <p>上次：{d.before ?? "来源未返回"}</p>
              <p>本次：{d.after ?? "来源未返回"}</p>
            </section>
          ))}
          {data.rule_differences?.map((d) => (
            <section key={d.field} aria-label={`${d.label}前后对比`}>
              <h4>{d.label}</h4>
              <p>上次：{d.before.join("；") || "来源未返回，不代表无限制"}</p>
              <p>本次：{d.after.join("；") || "来源未返回，不代表取消限制"}</p>
            </section>
          ))}
          {data.quantity_changes?.map((x, i) => (
            <p key={`${x.name}:${i}`}>
              {x.name}：{x.before}
              {x.unit} → {x.after}
              {x.unit}
            </p>
          ))}
          <ul>
            {data.blockers.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
