import { useState } from "react";
import { appFetch } from "./app-url";

type Coverage = {
  counts: Record<string, number>;
  review_counts: Record<string, number>;
  caveat: string;
  items: {
    brand_id: string;
    name: string;
    recalled: number;
    matched: number;
    coverage: string;
    completed_at: string | null;
    query_name: string | null;
    review: {
      status: string;
      config_pending: boolean;
      baseline_fresh: boolean;
    };
    platform_names: { name: string; count: number }[];
  }[];
};
const labels: Record<string, string> = {
  config_pending: "名称已修正，待复查",
  stale_baseline: "快照过期",
  no_baseline: "尚无完整基线",
  no_recall: "无召回",
  name_candidates: "有名称候选",
  different_platform_names: "平台名称不匹配",
  missing_platform_identity: "平台品牌字段缺失",
};
export function BrandCoverage() {
  const [data, setData] = useState<Coverage | null>(null),
    [filter, setFilter] = useState("different_platform_names"),
    [error, setError] = useState("");
  async function load() {
    try {
      const r = await appFetch("/api/v3/brand-coverage");
      if (!r.ok) throw new Error();
      setData(await r.json());
      setError("");
    } catch {
      setError("覆盖诊断暂不可用");
    }
  }
  return (
    <details>
      <summary
        onClick={() => {
          if (!data) void load();
        }}
      >
        品牌归属与召回诊断
      </summary>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <p>
            {Object.entries(data.review_counts)
              .map(([k, v]) => `${labels[k] ?? k}：${v} 个`)
              .join("；")}
          </p>
          <p>{data.caveat}</p>
          <label>
            诊断类型{" "}
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              {Object.entries(labels).map(([k, v]) => (
                <option value={k} key={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <button onClick={() => void load()}>刷新诊断</button>
          <ul>
            {data.items
              .filter((r) => r.review.status === filter)
              .map((r) => (
                <li key={r.brand_id}>
                  <strong>{r.name}</strong>：召回 {r.recalled}，名称匹配{" "}
                  {r.matched}。
                  <p>
                    上次检索词：{r.query_name ?? "无"}；采集时间：
                    {r.completed_at
                      ? new Date(r.completed_at).toLocaleString()
                      : "无"}
                    。
                    {r.review.config_pending
                      ? "当前名称/别名尚未经过复查轮次。"
                      : ""}
                    {!r.review.baseline_fresh
                      ? "历史结果，不能代表当前覆盖。"
                      : ""}
                  </p>
                  {r.platform_names.length
                    ? `平台返回：${r.platform_names.map((n) => `${n.name}（${n.count}）`).join("、")}`
                    : "未返回可用平台品牌名称"}
                </li>
              ))}
          </ul>
        </>
      )}
    </details>
  );
}
