import { useEffect, useState } from "react";
import { appFetch } from "./app-url";

type Operations = {
  current_enrichment?: {
    kind: string;
    state: string;
    error_code: string | null;
    fresh: boolean;
    count: number;
  }[];
  identity_refreshes?: {
    brand_id: string;
    name: string;
    run_id: string;
    state: string;
    error_code: string | null;
  }[];
  stores?: { state: string; count: number }[];
  rules?: { state: string; count: number }[];
  requests: { requests: number; short_gaps: number; non_success: number };
  coverage: { enabled: number; fresh_baselines: number };
  backup: { error: string | null; files: string[] };
  blockers: string[];
};
type Diagnostics = {
  request_recovery?: { interrupted: number; note: string };
  store_coverage?: {
    total: number;
    with_shanghai_evidence: number;
    partial_with_shanghai_evidence: number;
    caveat: string;
    groups: {
      reason: string;
      label: string;
      coupons: number;
      source_id_gap: number;
      lookup_gap: number;
      examples: {
        brand_name: string;
        title: string;
        product_id: string;
        reported_count: number | null;
        returned_count: number | null;
        queried_count: number;
        received_count: number | null;
        shanghai_count?: number | null;
      }[];
    }[];
  };
  sales: {
    provenance_captured: number;
    coupons: number;
    fields: { field: string; coupons: number }[];
    caveat: string;
  };
  queue: {
    kind: string;
    state: string;
    count: number;
    retrying: number;
    waiting_backoff: number;
    error_code: string | null;
  }[];
  caveat: string;
};
type Alert = {
  id: string;
  title: string;
  created_at: string;
  acknowledged_at: string | null;
  payload: { reason?: string };
};
export function OperationsPanel() {
  const [state, setState] = useState<Operations | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    async function refresh() {
      try {
        const responses = await Promise.all([
          appFetch("/api/v3/operations"),
          appFetch("/api/v3/alerts"),
          appFetch("/api/v3/source-diagnostics"),
        ]);
        if (responses.some((r) => !r.ok)) throw new Error("运行状态暂不可用");
        const [ops, notices, diagnosis] = await Promise.all(
          responses.map((r) => r.json()),
        );
        if (!disposed) {
          setState(ops);
          setDiagnostics(diagnosis);
          setAlerts(notices.items);
          setError("");
        }
      } catch {
        if (!disposed) setError("运行状态暂不可用");
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  async function acknowledge(id: string) {
    try {
      const response = await appFetch(`/api/v3/alerts/${id}/ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error("确认失败");
      setAlerts((values) =>
        values.map((a) =>
          a.id === id ? { ...a, acknowledged_at: new Date().toISOString() } : a,
        ),
      );
    } catch {
      setError("提醒确认失败，请稍后重试");
    }
  }
  return (
    <details>
      <summary>运行健康、备份与未完成项</summary>
      {error && <p role="alert">{error}</p>}
      {state && (
        <>
          <p>
            启用 {state.coverage.enabled} 个品牌，36 小时内完整基线{" "}
            {state.coverage.fresh_baselines} 个。近 24 小时请求{" "}
            {state.requests.requests} 次，间隔小于 1 秒{" "}
            {state.requests.short_gaps} 次，失败 {state.requests.non_success}{" "}
            次。
          </p>
          {diagnostics && (
            <details>
              <summary>销量来源与补采诊断</summary>
              <p>
                月售来源：product_info.sold_count_display。统计窗口、地域、更新频率、退款和重置口径均待确认。
              </p>
              <p>
                原始计数字段留证：{diagnostics.sales.provenance_captured}/
                {diagnostics.sales.coupons} 张券。{diagnostics.sales.caveat}
              </p>
              <ul>
                {diagnostics.sales.fields.map((f) => (
                  <li key={f.field}>
                    {f.field}：{f.coupons} 张（尚未确认精确销量口径）
                  </li>
                ))}
              </ul>
              {diagnostics.store_coverage && (
                <details>
                  <summary>
                    门店缺口核验 · {diagnostics.store_coverage.total} 张券
                  </summary>
                  <p>
                    已有上海门店证据：
                    {diagnostics.store_coverage.with_shanghai_evidence}{" "}
                    张券；其中范围仍不完整：
                    {diagnostics.store_coverage.partial_with_shanghai_evidence}{" "}
                    张。来源声明总数的地域口径未验证，不用它计算上海覆盖率。
                  </p>
                  <p>{diagnostics.store_coverage.caveat}</p>
                  {diagnostics.store_coverage.groups.map((g) => (
                    <details key={g.reason}>
                      <summary>
                        {g.label}：{g.coupons} 张券
                      </summary>
                      <p>
                        声明数量与返回 ID 差额合计 {g.source_id_gap}
                        ；已查询后未返回差额合计 {g.lookup_gap}
                      </p>
                      <ul>
                        {g.examples.map((e) => (
                          <li key={e.product_id}>
                            {e.brand_name} · {e.title}（券 ID {e.product_id}
                            ）：平台声明 {e.reported_count ?? "未知"}，返回 ID{" "}
                            {e.returned_count ?? "未知"}，已查询{" "}
                            {e.queried_count}，最终取得{" "}
                            {e.received_count ?? "尚无最终快照"}，其中上海门店{" "}
                            {e.shanghai_count ?? "未知"}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ))}
                </details>
              )}
              {diagnostics.request_recovery && (
                <p>
                  最近 24 小时中断请求：
                  {diagnostics.request_recovery.interrupted}。
                  {diagnostics.request_recovery.note}
                </p>
              )}
              <p>{diagnostics.caveat}</p>
              <ul>
                {diagnostics.queue.map((q) => (
                  <li key={`${q.kind}:${q.state}:${q.error_code}`}>
                    {q.kind === "rules" ? "规则" : "门店"} ·{" "}
                    {(
                      {
                        queued: "等待执行",
                        failed: "本轮终止",
                        incomplete: "来源不完整",
                        complete: "已取得",
                      } as Record<string, string>
                    )[q.state] ?? q.state}
                    ：{q.count}；重试队列 {q.retrying}，退避等待{" "}
                    {q.waiting_backoff}
                    {q.error_code ? `；${q.error_code}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p>
            每日备份：
            {state.backup.error
              ? "失败"
              : state.backup.files.length
                ? "已生成"
                : "等待首次备份"}
            ；保留最近 7 份。备份不包含登录凭据。
          </p>
          <p>
            规则历史累计（含旧轮次）：
            {state.rules
              ?.map(
                (r) =>
                  `${({ complete: "已取得", queued: "等待采集", incomplete: "字段不全", failed: "失败", superseded: "已被新快照替代" } as Record<string, string>)[r.state] ?? r.state} ${r.count}`,
              )
              .join("；") || "暂无任务"}
          </p>
          <p>
            门店历史累计（含旧轮次）：
            {state.stores
              ?.map(
                (r) =>
                  `${({ complete: "已核对门店ID", queued: "等待采集", incomplete: "范围不完整", failed: "失败", superseded: "已被新快照替代" } as Record<string, string>)[r.state] ?? r.state} ${r.count}`,
              )
              .join("；") || "暂无任务"}
          </p>
          <p>
            当前新鲜基线补采：
            {state.current_enrichment
              ?.filter((x) => x.fresh)
              .map(
                (x) =>
                  `${x.kind === "rules" ? "规则" : "门店"} ${x.state} ${x.count}${x.error_code ? `（${x.error_code}）` : ""}`,
              )
              .join("；") || "尚无新鲜基线补采记录"}
          </p>
          <p>
            名称修正自动复查：
            {state.identity_refreshes
              ?.map(
                (x) =>
                  `${x.name} ${x.state}${x.error_code ? `（${x.error_code}）` : ""}`,
              )
              .join("；") || "当前扫描结束后检查配置变化"}
            。每个配置版本自动复查一次，失败不无限重试。
          </p>
          <ul>
            {state.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </>
      )}
      <h3>站内提醒</h3>
      {!alerts.length && <p>暂无提醒。证据不足的优惠券不会触发推荐通知。</p>}
      {alerts.map((a) => (
        <article key={a.id}>
          <strong>{a.title}</strong>
          <p>
            {new Date(a.created_at).toLocaleString()} {a.payload.reason}
          </p>
          {a.acknowledged_at ? (
            <span>已读</span>
          ) : (
            <button onClick={() => void acknowledge(a.id)}>标记已读</button>
          )}
        </article>
      ))}
    </details>
  );
}
