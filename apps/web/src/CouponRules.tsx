import { useState } from "react";
import { appFetch } from "./app-url";
import { CouponUseOutlook, type UseOutlook } from "./CouponUseOutlook";
import { VoucherTerms, type VoucherTermsData } from "./VoucherTerms";

type Snapshot = {
  observed_at: string;
  comparison?: { status: string; changes: string[]; value_verdict: string };
  payload: {
    status: string;
    structured?: {
      voucher?: VoucherTermsData;
      usage?: {
        facts: {
          dimension: string;
          value: string;
          evidence: string;
          key: string;
        }[];
        conflicts: string[];
        unparsed: { key: string; evidence: string }[];
      };
      restrictions?: {
        eligibility: {
          facts: { kind: string; evidence: string }[];
          conflicting: boolean;
          unparsed: string[];
        };
        fees: {
          charges: {
            name: string;
            amount_fen: number;
            basis: string;
            evidence: string;
          }[];
          conflicting: boolean;
          explicit_no_extra_fees: boolean;
          unparsed: string[];
        };
        purchase_limits: {
          facts: { quantity: number; period: string; evidence: string }[];
          conflicting: boolean;
          unparsed: string[];
        };
      };
      validity: { purchase_relative_days: number | null; conflicting: boolean };
      availability: {
        windows: { start: string; end: string; overnight: boolean }[];
        excluded_weekdays: string[];
        excluded_holidays: string[];
        unparsed_times: string[];
      };
      eligibility: { status: string; evidence: string[] };
      fees: { amount_fen: number | null; evidence: string[] };
      missing: string[];
    };
    rule_fingerprint: string;
    commodity_fingerprint: string;
    groups: {
      group_name?: string;
      option_count?: number;
      total_count?: number;
      item_list: { name: string; count?: number | null; unit?: string }[];
    }[];
    rules: { key: string; name: string; value: { content: string }[] }[];
    limitations: string[];
  };
};
export function CouponRules({
  productId,
  brandId,
}: {
  productId: string;
  brandId: string;
}) {
  const [outlook, setOutlook] = useState<UseOutlook>();
  const [context, setContext] = useState<{
    status: string;
    price_observed_at: string | null;
  } | null>(null);
  const [items, setItems] = useState<Snapshot[] | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    setError("");
    try {
      const r = await appFetch(
        `/api/v3/coupons/${encodeURIComponent(productId)}/rules?brand_id=${encodeURIComponent(brandId)}`,
      );
      if (!r.ok) throw new Error("规则查询失败");
      const result = await r.json();
      setItems(result.items);
      setContext(result.context);
      setOutlook(result.use_outlook);
    } catch {
      setError("规则查询失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <button disabled={busy} onClick={() => void load()}>
        {busy ? "读取中…" : "查看套餐权益与购买须知"}
      </button>
      {error && <p role="alert">{error}</p>}
      {items && (
        <div>
          <button onClick={() => setItems(null)}>收起规则</button>
          <CouponUseOutlook data={outlook} />
          <p>
            仅展示该品牌当前完整轮次的规则，不使用旧轮次补位。
            {context?.price_observed_at
              ? `价格采集于 ${new Date(context.price_observed_at).toLocaleString()}`
              : ""}
          </p>
          {!items.length ? (
            <p>
              本轮尚无可用规则证据（未采齐、快照过期或本轮未见），不能用旧规则解释当前价格。
            </p>
          ) : (
            <>
              <p>
                规则采集于 {new Date(items[0].observed_at).toLocaleString()}
                ；以此时平台返回为准，与票面价可能有采集时间差。
                {items[0].payload.status === "incomplete" ? "字段不完整。" : ""}
              </p>
              <p>
                规则前后变化请查看“同券条件比较”；缺少上轮记录不视为券上新。
              </p>
              {items[0].payload.structured && (
                <section aria-label="规则自动识别摘要">
                  <strong>规则自动识别摘要</strong>
                  <p>
                    有效期：
                    {items[0].payload.structured.validity
                      .purchase_relative_days != null
                      ? `购买后 ${items[0].payload.structured.validity.purchase_relative_days} 天内`
                      : items[0].payload.structured.validity.conflicting
                        ? "存在冲突，待核验"
                        : "待核验"}
                    。
                  </p>
                  <p>
                    明确禁用日：
                    {[
                      ...items[0].payload.structured.availability
                        .excluded_weekdays,
                      ...items[0].payload.structured.availability
                        .excluded_holidays,
                    ].join("、") || "未识别，不代表每天可用"}
                    ；具体日期与例外以原文为准。
                  </p>
                  <p>
                    识别时段：
                    {items[0].payload.structured.availability.windows
                      .map(
                        (w) =>
                          `${w.start}—${w.end}${w.overnight ? "（跨日）" : ""}`,
                      )
                      .join("、") || "待核验"}
                    。另有{" "}
                    {
                      items[0].payload.structured.availability.unparsed_times
                        .length
                    }{" "}
                    条时段文字需核验。
                  </p>
                  <p>
                    资格相关文字：
                    {items[0].payload.structured.eligibility.evidence.join(
                      "；",
                    ) || "未知，不假设所有人适用"}
                  </p>
                  <p>
                    附加费用：
                    {items[0].payload.structured.fees.evidence.join("；") ||
                      "未知，不假设为零"}
                  </p>
                  {items[0].comparison && (
                    <p>
                      本次条件变化：
                      {items[0].comparison.status === "first_baseline"
                        ? "首次规则基线"
                        : items[0].comparison.changes.join("、") ||
                          "已返回条件相同"}
                      。仍需核验店域与其他限制后才能确认性价比。
                    </p>
                  )}
                </section>
              )}
              {items[0].payload.structured?.restrictions &&
                (() => {
                  const r = items[0].payload.structured.restrictions;
                  return (
                    <section aria-label="资格费用识别">
                      <strong>明确资格、费用与限购条款</strong>
                      <p>
                        资格：
                        {r.eligibility.facts
                          .map((x) => x.evidence)
                          .join("；") || "未识别到完整明确条款"}
                        {r.eligibility.conflicting ? "（声明冲突）" : ""}
                      </p>
                      <p>
                        费用分项：
                        {r.fees.charges
                          .map(
                            (x) =>
                              `${x.name} ${(x.amount_fen / 100).toFixed(2)}元/${x.basis}`,
                          )
                          .join("；") || "无已识别分项"}
                        。
                        {r.fees.explicit_no_extra_fees
                          ? "来源有无附加费用声明。"
                          : ""}
                        {r.fees.conflicting ? "费用声明冲突。" : ""}
                        人数、桌数及其他费用未核验，不合计为实际应付。
                      </p>
                      <p>
                        限购：
                        {r.purchase_limits.facts
                          .map((x) => x.evidence)
                          .join("；") || "未知"}
                        {r.purchase_limits.conflicting ? "（声明冲突）" : ""}
                      </p>
                      <p>
                        仍待解释：资格 {r.eligibility.unparsed.length} 条、费用{" "}
                        {r.fees.unparsed.length} 条、限购{" "}
                        {r.purchase_limits.unparsed.length} 条。完整原文见下方。
                      </p>
                    </section>
                  );
                })()}
              {items[0].payload.structured?.usage &&
                (() => {
                  const usage = items[0].payload.structured.usage;
                  const labels: Record<string, string> = {
                    consumption: "堂食/外带",
                    reservation: "预约",
                    stacking_store_promotions: "店内优惠同享",
                    stacking_other_vouchers: "其他代金券叠加",
                    private_room: "包间",
                    redemption_per_visit: "每次消费限用",
                    redemption_per_table: "每桌限用",
                    refund_fully_unused: "全部未核销退款",
                    refund_expired_fully_unused: "全部未核销过期退款",
                  };
                  const dimensions = [
                    ...new Set(usage.facts.map((f) => f.dimension)),
                  ];
                  return (
                    <section aria-label="使用和退款条款识别">
                      <strong>使用和退款条款识别</strong>
                      {!dimensions.length && <p>尚无可明确识别的条款。</p>}
                      {dimensions.map((dimension) => (
                        <p key={dimension}>
                          {labels[dimension] ?? dimension}：
                          {usage.conflicts.includes(dimension)
                            ? "声明冲突，不能据此判断；"
                            : ""}
                          {[
                            ...new Set(
                              usage.facts
                                .filter((f) => f.dimension === dimension)
                                .map((f) => f.evidence),
                            ),
                          ].join("；")}
                        </p>
                      ))}
                      <p>
                        另有 {usage.unparsed.length}{" "}
                        条原文未归入上述使用/退款分类，代金券结算识别及完整原文见下方。单店例外不推广到全部门店；部分核销退款不按整单退款处理。
                      </p>
                    </section>
                  );
                })()}
              {items[0].payload.structured?.voucher && (
                <VoucherTerms data={items[0].payload.structured.voucher} />
              )}
              {items[0].payload.groups.map((group, i) => (
                <div key={`${group.group_name}-${i}`}>
                  <strong>{group.group_name || "套餐内容"}</strong>
                  <p>
                    {group.option_count != null && group.total_count != null
                      ? `${group.total_count} 选 ${group.option_count}`
                      : ""}
                  </p>
                  <ul>
                    {group.item_list.map((item, j) => (
                      <li key={`${item.name}-${j}`}>
                        {item.name} · {item.count ?? "数量未知"}
                        {item.unit ?? ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {items[0].payload.rules.map((rule, i) => (
                <div key={`${rule.key}-${i}`}>
                  <strong>{rule.name}</strong>
                  {rule.value.map((v, j) => (
                    <p key={`${rule.key}-${j}`}>{v.content}</p>
                  ))}
                </div>
              ))}
              <p>{items[0].payload.limitations.join("；")}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
