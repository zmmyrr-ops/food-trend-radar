import type { Channel } from "@radar/contracts";
import { useEffect, useState } from "react";
import { useAccount } from "./AccountGate";
import { appFetch } from "./app-url";
import { confirmPointSpend } from "./PointSpendConfirm";
import { Points } from "./Points";

type Evidence = {
  brand: string;
  title: string;
  price_fen: number | null;
  sales_speed_per_hour: number | null;
  sales_acceleration: number | null;
  observed_at: string;
  missing: string[];
};
type State = {
  configured: boolean;
  running: boolean;
  progress?: string;
  other_channel_running?: boolean;
  error: string | null;
  stale: boolean;
  model: string;
  report: null | {
    summary: string;
    generated_at: string;
    input_at: string;
    candidate_count: number;
    research?: {
      brand: string;
      summary: string;
      researched_at: string;
      sources: { title: string; url: string; index?: number }[];
    }[];
    coverage?: string;
    research_failures?: string[];
    recommendations: {
      id: string;
      reason: string;
      angle: string;
      brand_value?: string;
      historical_performance?: string;
      environment_fit?: string;
      timing?: string;
      risks: string[];
      evidence: Evidence;
    }[];
    limitations: string[];
  };
};
export function AiRecommendations({ channel }: { channel: Channel }) {
  const isAdmin = useAccount().role === "admin";
  const [data, setData] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const response = await appFetch(
          `/api/v3/ai-recommendations?channel=${channel}`,
        );
        if (!response.ok) throw new Error("AI 模块读取失败");
        const result: State = await response.json();
        if (!disposed) {
          setData(result);
          setError("");
        }
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : "读取失败");
      }
      if (!disposed) timer = setTimeout(read, 4000);
    }
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [channel]);
  async function generate() {
    if (
      !(await confirmPointSpend(
        "生成 AI 精选",
        30,
        "结合联网品牌调研、历史与天气综合推荐。已有报告免费查看；本次生成失败自动退分。",
      ))
    )
      return;
    setSending(true);
    setError("");
    try {
      const response = await appFetch("/api/v3/ai-recommendations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? "另一个频道正在分析，请完成后再试"
            : response.status === 429
              ? "请求太频繁，请一分钟后再试"
              : body.error?.message || "启动 AI 分析失败",
        );
      setData((d) => (d ? { ...d, running: true, error: null } : d));
    } catch (e) {
      setError(e instanceof Error ? e.message : "启动失败");
    } finally {
      setSending(false);
    }
  }
  return (
    <section className="ai-panel" aria-label="AI 综合推荐">
      <h2>{channel === "food" ? "美食" : "游玩"} · AI 精选</h2>
      <p className="muted">
        联网研究品牌内容与价值，结合历史表现、天气和节假日，寻找值得拍摄的机会。
      </p>
      <p className="muted">
        每次研究最多12个候选品牌，可能需要数分钟；报告仅本人可见。失败自动退分，已有报告可免费查看。
      </p>
      <button
        type="button"
        disabled={
          !data?.configured ||
          data.running ||
          data.other_channel_running ||
          sending
        }
        onClick={() => void generate()}
      >
        {sending || data?.running
          ? "AI 正在综合分析…"
          : data?.report
            ? "根据最新数据重新推荐"
            : "生成 AI 推荐"}{" "}
        <Points amount={30} cost />
      </button>
      {data?.running && <p role="status">{data.progress || "正在准备调研…"}</p>}
      {data?.other_channel_running && (
        <p role="status">当前有分析任务正在执行，完成后可生成本次推荐。</p>
      )}
      {data && !data.configured && <p>后端尚未配置 DeepSeek 密钥。</p>}
      {(error || data?.error) && (
        <p role="alert">{error || data?.error}。原有选券榜单仍可使用。</p>
      )}
      {data?.report && (
        <>
          <p>
            分析于 {new Date(data.report.generated_at).toLocaleString("zh-CN")}{" "}
            · 本次评估{data.report.candidate_count}张候选券 · {data.model}
          </p>
          {data.stale && (
            <p role="status">这份建议已超过12小时，请重新生成后再参考。</p>
          )}
          {(data.running || data.error) && <p>下方保留的是上次成功的建议。</p>}
          <p className="muted">
            {data.report.coverage}
            {!!data.report.research_failures?.length &&
              ` 本次未取得有效资料：${data.report.research_failures.join("、")}。`}
          </p>
          <details className="ai-summary">
            <summary>本次整体判断</summary>
            <p>{data.report.summary}</p>
          </details>
          {!data.report.recommendations.length && (
            <p>AI 本次未选出值得推荐的券，请查看数据局限。</p>
          )}
          <div className="ai-grid">
            {data.report.recommendations.map((r, i) => (
              <article className="ai-card" key={r.id}>
                <div className="ai-card-label">
                  <span>精选 0{i + 1}</span>
                  <span>{r.evidence.brand}</span>
                </div>
                <h3>{r.evidence.title}</h3>
                <p>
                  当时票面价格：
                  {r.evidence.price_fen === null
                    ? "未知"
                    : `¥${(r.evidence.price_fen / 100).toFixed(2)}`}{" "}
                  {isAdmin && (
                    <>
                      {" "}
                      · 月售净增速度：
                      {r.evidence.sales_speed_per_hour === null
                        ? "未知"
                        : `${r.evidence.sales_speed_per_hour.toFixed(2)}/小时`}
                    </>
                  )}
                </p>
                <p>
                  <strong>推荐理由：</strong>
                  {r.reason}
                </p>
                {r.brand_value && (
                  <p>
                    <strong>品牌与客群：</strong>
                    {r.brand_value}
                  </p>
                )}
                {r.historical_performance && (
                  <p>
                    <strong>往期表现：</strong>
                    {r.historical_performance}
                  </p>
                )}
                {r.environment_fit && (
                  <p>
                    <strong>天气与环境：</strong>
                    {r.environment_fit}
                  </p>
                )}
                {r.timing && (
                  <p>
                    <strong>为什么是现在：</strong>
                    {r.timing}
                  </p>
                )}
                {data.report?.research
                  ?.filter((d) => d.brand === r.evidence.brand)
                  .map((d) => (
                    <details key={d.brand} className="ai-caveats">
                      <summary>品牌调研与来源（{d.sources.length}）</summary>
                      <p style={{ whiteSpace: "pre-wrap" }}>{d.summary}</p>
                      <small>
                        调研于{" "}
                        {new Date(d.researched_at).toLocaleString("zh-CN")}
                      </small>
                      <ul>
                        {d.sources.map((source, j) => (
                          <li key={j}>
                            <a
                              href={source.url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              [{source.index ?? j + 1}] {source.title}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ))}
                <p>
                  <strong>选题角度：</strong>
                  {r.angle}
                </p>
                <details className="ai-caveats">
                  <summary>待核验事项与数据依据</summary>
                  <p>
                    <strong>待核验：</strong>
                    {r.risks.join("；")}
                  </p>
                  <p>
                    原始观测：
                    {new Date(r.evidence.observed_at).toLocaleString("zh-CN")}
                    ；缺失指标：{r.evidence.missing.join("、") || "无"}
                  </p>
                </details>
              </article>
            ))}
          </div>
          <details className="ai-summary">
            <summary>本次分析的数据局限</summary>
            <ul>
              {data.report.limitations.map((v, i) => (
                <li key={`${i}:${v}`}>{v}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
