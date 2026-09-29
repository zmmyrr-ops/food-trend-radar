import { useCallback, useEffect, useState } from "react";
import { appFetch } from "./app-url";

type ScoredSignal = {
  observation_score: number;
  signal: {
    title: string;
    url: string;
    published_at: string;
    kind: string;
    facts?: {
      status: string;
      error: string | null;
      promotion_mentions: string[];
      restrictions: string[];
      dated_mentions: {
        date: string;
        evidence: string;
        year_inferred: boolean;
      }[];
    };
  };
  contributions: { name: string; points: number }[];
};
type Board = {
  items: (ScoredSignal & {
    brand_id: string;
    brand_name: string;
    as_of: string;
    signals: ScoredSignal[];
  })[];
  data_as_of: string | null;
  quality_status: string;
  message: string;
  source: {
    name: string;
    url: string;
    coverage: string;
    interval_hours: number;
  };
  counts: {
    active_brands: number;
    configured_brands: number;
    monitored_brands: number;
    scored_brands: number;
  };
  runs: {
    id: string;
    status: string;
    started_at: string;
    error: string | null;
    result: {
      fetched: number;
      created: number;
      changed: number;
      details_extracted?: number;
      detail_failures?: number;
    } | null;
  }[];
};
const time = (s: string) =>
  new Date(s).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
export function Radar() {
  const [data, setData] = useState<Board | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const r = await appFetch("/v1/opportunities");
    if (!r.ok) throw Error("榜单读取失败");
    setData(await r.json());
  }, []);
  useEffect(() => {
    let active = true;
    const load = () => {
      if (active)
        void refresh().catch((e) => {
          if (active) setError(e.message);
        });
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh]);
  async function update() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await appFetch("/v1/auto/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const v = await r.json();
      if (!r.ok) throw Error(v.reason ?? v.error?.message ?? "更新失败");
      setNotice("自动采集已启动，完成后榜单会自动更新。");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>上海品牌自动观察榜</h2>
      <p>
        系统定时读取真实公告并计算，不需要录入活动。当前是单品牌链路验证，尚未覆盖150—200个品牌。
      </p>
      <button
        type="button"
        disabled={busy || data?.runs[0]?.status === "running"}
        onClick={update}
      >
        立即更新
      </button>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!data ? (
        <p>正在读取榜单…</p>
      ) : (
        <>
          <p>
            启用候选 {data.counts.active_brands} · 已配置动态来源{" "}
            {data.counts.configured_brands} · 当前有效监测{" "}
            {data.counts.monitored_brands} · 可评分 {data.counts.scored_brands}
          </p>
          <p>
            最近成功采集：{data.data_as_of ? time(data.data_as_of) : "尚未成功"}
            ；自动采集间隔 {data.source.interval_hours}{" "}
            小时，超过12小时未成功即停止展示当前分数。
          </p>
          <p>{data.message}</p>
          {!data.items.length && (
            <p className="empty">
              {data.quality_status === "stale"
                ? "来源已过期，旧榜单已下线。"
                : data.data_as_of
                  ? "本轮没有满足14天内公告规则的品牌；不代表品牌没有热度。"
                  : "尚无可计算数据，请查看下方采集状态。"}
            </p>
          )}
          {data.items.map((b, index) => (
            <article className="record" key={b.brand_id}>
              <h3>
                {index + 1}. {b.brand_name}
              </h3>
              <p>
                公告观察分：
                <strong>{b.observation_score.toFixed(1)} / 100</strong> ·
                爆款率：待校准 · 抢跑指数：数据不足
              </p>
              <p>代表信号：{b.signal.title}</p>
              <p>算法版本：OBS-announcement-v1 · 计算时间：{time(b.as_of)}</p>
              <p>
                标题命中：{b.signal.kind}
                ；上海适用、活动起止时间与普遍价格待核验。早期信号分暂不可计算。
              </p>
              <p>
                {b.contributions
                  .map((c) => `${c.name}：${c.points.toFixed(1)}分`)
                  .join("；")}
              </p>
              <details>
                <summary>查看 {b.signals.length} 条近期公告与原文</summary>
                {b.signals.map((s) => (
                  <div key={s.signal.url}>
                    <a href={s.signal.url} target="_blank" rel="noreferrer">
                      {s.signal.title} ↗
                    </a>
                    <br />
                    发布日期：{time(s.signal.published_at).split(" ")[0]}
                    （原文仅提供日期） · {s.observation_score.toFixed(1)}分
                    {s.signal.facts?.status === "extracted" ? (
                      <>
                        <p>
                          官方正文提取：价格与日期仅为原文线索，不表示当前有效或上海适用。
                        </p>
                        {s.signal.facts.promotion_mentions.map((x) => (
                          <p key={x}>优惠线索：{x}</p>
                        ))}
                        {s.signal.facts.restrictions.map((x) => (
                          <p key={x}>使用条件：{x}</p>
                        ))}
                        {s.signal.facts.dated_mentions.map((x, i) => (
                          <p key={`${x.date}-${i}`}>
                            日期线索：{x.date}
                            {x.year_inferred ? "（年份根据发布日期推定）" : ""}{" "}
                            · {x.evidence}
                          </p>
                        ))}
                      </>
                    ) : (
                      <p>
                        正文事实暂不可用：
                        {s.signal.facts?.error ?? "等待下一轮采集"}
                      </p>
                    )}
                  </div>
                ))}
              </details>
            </article>
          ))}
          <h3>自动采集状态</h3>
          <p>
            <a href={data.source.url} target="_blank" rel="noreferrer">
              {data.source.name} ↗
            </a>{" "}
            · {data.source.coverage} · 全国公告，非上海需求统计
          </p>
          {!data.runs.length ? (
            <p>等待首次采集</p>
          ) : (
            data.runs.map((r) => (
              <p key={r.id}>
                {time(r.started_at)} ·{" "}
                {{
                  running: "采集中",
                  succeeded: "成功",
                  failed: "失败",
                  interrupted: "重启中断",
                }[r.status] ?? r.status}
                {r.result
                  ? ` · 读取${r.result.fetched}条，首次收录${r.result.created}条（含历史公告），修订${r.result.changed}条；正文成功${r.result.details_extracted ?? 0}条，失败${r.result.detail_failures ?? 0}条`
                  : ""}
                {r.error ? ` · ${r.error}` : ""}
              </p>
            ))
          )}
        </>
      )}
    </section>
  );
}
