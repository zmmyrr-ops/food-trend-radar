export type VoucherTermsData = {
  facts: {
    dimension: string;
    values: string[];
    evidence: string;
    key: string;
  }[];
  conflicts: string[];
  unparsed: { evidence: string; key: string }[];
};

const labels: Record<string, string> = {
  eligible_scope: "列示适用范围",
  excluded_items: "明确排除商品",
  redemption_channels: "核销渠道",
  mini_program_excluded_costs: "小程序不可抵扣费用",
  excluded_costs: "不可抵扣费用",
  cash_exchange: "兑现",
  change_return: "找零",
  transfer: "转赠",
  stacking_promotions: "其他优惠同享",
  excess_payment: "超过券面金额补差价",
  settlement_basis: "结算依据",
};
const values: Record<string, string> = {
  forbidden: "不支持",
  allowed: "支持",
  required: "需要，具体金额取决于实际消费",
};

export function VoucherTerms({ data }: { data: VoucherTermsData }) {
  if (!data.facts.length && !data.unparsed.length) return null;
  return (
    <section aria-label="代金券抵扣与补差价">
      <strong>代金券抵扣与补差价</strong>
      {[...new Set(data.facts.map((f) => f.dimension))].map((dimension) => (
        <div key={dimension}>
          <p>
            {labels[dimension] ?? dimension}：
            {data.conflicts.includes(dimension)
              ? "条款存在不同声明，待核验"
              : data.facts
                  .find((f) => f.dimension === dimension)
                  ?.values.map((v) => values[v] ?? v)
                  .join("、")}
          </p>
          <details>
            <summary>查看此项原文</summary>
            {[
              ...new Set(
                data.facts
                  .filter((f) => f.dimension === dimension)
                  .map((f) => f.evidence),
              ),
            ].map((text) => (
              <p key={text}>{text}</p>
            ))}
          </details>
        </div>
      ))}
      <p>
        不可抵扣不代表已知收费金额；未消费的券面余额是否有损失需结合实际订单判断。
        另有 {data.unparsed.length}{" "}
        条相关原文尚未解释，不推断面额、完整店域或实际应付。
      </p>
    </section>
  );
}
