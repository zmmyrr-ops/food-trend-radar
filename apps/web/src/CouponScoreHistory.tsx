import { useState } from "react";
import { appFetch } from "./app-url";

type Row = {
  scored_at: string;
  evidence_revision: string;
  payload: {
    features?: {
      sales_heat?: {
        speed: number | null;
        acceleration: number | null;
        lift_ratio: number | null;
      } | null;
    };
    score: {
      version?: string;
      range: { low: number; high: number };
      gate: string;
    };
    evidence: {
      blockers: string[];
      current_evidence: {
        fresh: boolean;
        rules_ready: boolean;
        stores_ready: boolean;
      };
    };
  };
};
export function CouponScoreHistory({
  productId,
  brandId,
}: {
  productId: string;
  brandId: string;
}) {
  const [rows, setRows] = useState<Row[] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    setBusy(true);
    setError("");
    try {
      const r = await appFetch(
        `/api/v3/coupons/${encodeURIComponent(productId)}/scores?brand_id=${encodeURIComponent(brandId)}`,
      );
      if (!r.ok) throw new Error("评分记录读取失败");
      setRows((await r.json()).items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <button disabled={busy} onClick={() => void load()}>
        {busy ? "读取中…" : "查看评分记录与依据"}
      </button>
      {error && <p role="alert">{error}</p>}
      {rows && (
        <section aria-label="评分历史">
          <button onClick={() => setRows(null)}>收起评分记录</button>
          <p>
            证据变化时保存新版本。V4 保存真实月售指标，综合分尚未校准；旧 V3
            仅供历史追溯，已退出当前排序。
          </p>
          {!rows.length && <p>该券尚在等待后台评估，暂无持久化评分。</p>}
          {rows.map((row, i) => (
            <article key={`${row.evidence_revision}-${i}`}>
              <strong>
                {row.payload.score.version?.includes("sales-evidence")
                  ? "V4 · 月售热度与权益证据（综合分未校准）"
                  : `历史旧口径 ${row.payload.score.version ?? "V3"} · ${row.payload.score.range.low}—${row.payload.score.range.high} / 100（不参与当前排序）`}
              </strong>
              {row.payload.score.version?.includes("sales-evidence") && (
                <p>
                  月售净增速度：
                  {row.payload.features?.sales_heat?.speed?.toFixed(2) ??
                    "未知"}{" "}
                  /小时； 加速度：
                  {row.payload.features?.sales_heat?.acceleration?.toFixed(2) ??
                    "未知"}{" "}
                  /小时²； 自身历史倍数：
                  {row.payload.features?.sales_heat?.lift_ratio?.toFixed(2) ??
                    "未知"}
                  。 月售展示净变化不等于新增订单。
                </p>
              )}
              <p>
                {new Date(row.scored_at).toLocaleString()} · 当时规则证据
                {row.payload.evidence.current_evidence.rules_ready
                  ? "已取得"
                  : "不足"}
                ，完整门店
                {row.payload.evidence.current_evidence.stores_ready
                  ? "已取得"
                  : "不足"}
              </p>
              <ul>
                {row.payload.evidence.blockers.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
