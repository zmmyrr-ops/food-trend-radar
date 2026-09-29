import { useEffect, useState } from "react";
import { appFetch } from "./app-url";

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
  error: string | null;
  stale: boolean;
  model: string;
  report: null | {
    summary: string;
    generated_at: string;
    input_at: string;
    candidate_count: number;
    recommendations: {
      id: string;
      reason: string;
      angle: string;
      risks: string[];
      evidence: Evidence;
    }[];
    limitations: string[];
  };
};
export function AiRecommendations() {
  const [data, setData] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const response = await appFetch("/api/v3/ai-recommendations");
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
  }, []);
  async function generate() {
    setSending(true);
    setError("");
    try {
      const response = await appFetch("/api/v3/ai-recommendations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok)
        throw new Error(
          response.status === 429
            ? "请求太频繁，请一分钟后再试"
            : "启动 AI 分析失败",
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
      <h2>AI 综合推荐</h2>
      <p className="muted">综合优惠、销量与环境信号，为下一条内容寻找方向。</p>
      <p className="ai-consent">
        点击生成将向 DeepSeek 发送最多40张券的业务摘要和天气背景，并产生 API
        用量。AI 建议不等于事实核验。
      </p>
      <button
        type="button"
        disabled={!data?.configured || data.running || sending}
        onClick={() => void generate()}
      >
        {sending || data?.running
          ? "AI 正在综合分析…"
          : data?.report
            ? "根据最新数据重新推荐"
            : "生成 AI 推荐"}
      </button>
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
                  · 月售净增速度：
                  {r.evidence.sales_speed_per_hour === null
                    ? "未知"
                    : `${r.evidence.sales_speed_per_hour.toFixed(2)}/小时`}
                </p>
                <p>
                  <strong>推荐理由：</strong>
                  {r.reason}
                </p>
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
