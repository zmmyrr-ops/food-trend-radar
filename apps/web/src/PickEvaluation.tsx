import { useState } from "react";
import { appFetch } from "./app-url";

type Report = {
  note: string;
  batches: {
    slot: string;
    captured_at: string;
    version: string;
    finished: boolean;
    summary: {
      group: string;
      total: number;
      measured: number;
      pending: number;
      unavailable: number;
      mean_speed: number | null;
      positive_speed_share: number | null;
    }[];
  }[];
};
export function PickEvaluation() {
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    setError("");
    try {
      const r = await appFetch("/api/v3/pick-evaluation");
      if (!r.ok) throw new Error("效果记录读取失败");
      setData(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open && !data && !busy) void load();
      }}
    >
      <summary>查看排序效果验证</summary>
      <p>
        自动冻结当时的优先榜单，观察72小时后销售增速是否仍为正。结果用于后续校准，不是爆款概率。
      </p>
      <button type="button" disabled={busy} onClick={() => void load()}>
        {busy ? "读取中…" : "刷新验证结果"}
      </button>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <p>{data.note}</p>
          {!data.batches.length && (
            <p>尚无榜单留样，后台会在每半日首次有结果时自动保存。</p>
          )}
          {data.batches.map((b) => (
            <article key={b.slot}>
              <h4>
                {new Date(b.captured_at).toLocaleString("zh-CN")} ·{" "}
                {b.finished ? "观察结束" : "观察中"}
              </h4>
              <p>评分版本：{b.version}。观察结束也可能存在无法核对的券。</p>
              {b.summary.map((s) => (
                <p key={s.group}>
                  {s.group === "top20" ? "前20张券" : "其余优先券"}：留样
                  {s.total}，待观察{s.pending}，可核对{s.measured}，缺失/不可比
                  {s.unavailable}。
                  {s.mean_speed !== null && (
                    <>
                      {" "}
                      后续平均速度{s.mean_speed.toFixed(2)}/小时；速度为正占比
                      {(s.positive_speed_share! * 100).toFixed(1)}
                      %（仅可核对样本）。
                    </>
                  )}
                </p>
              ))}
            </article>
          ))}
        </>
      )}
    </details>
  );
}
