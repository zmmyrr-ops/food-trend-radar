import "./brand-boost.css";
import { useEffect, useState } from "react";
import { appFetch } from "./app-url";
import { confirmPointSpend } from "./PointSpendConfirm";
import { Points } from "./Points";

type Job = {
  brand_id: string;
  state: string;
  position: number;
  mine: boolean;
  votes: number;
};
export function useBrandBoost() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [remaining, setRemaining] = useState(2);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  async function refresh() {
    const r = await appFetch("/api/v3/brand-boost");
    if (r.ok) {
      const d = await r.json();
      setJobs(d.jobs);
      setRemaining(d.remaining);
    }
  }
  useEffect(() => {
    void refresh().catch(() => {});
    const timer = setInterval(() => void refresh().catch(() => {}), 15000);
    return () => clearInterval(timer);
  }, []);
  async function accelerate(id: string, name: string) {
    if (busy) return;
    if (
      !(await confirmPointSpend(
        `加速刷新 · ${name}`,
        20,
        `今日还可使用${remaining}次。优先刷新品牌券信息，不保证出现新券；30分钟内已刷新不扣分，失败退分。多人加速可提升顺位。`,
      ))
    )
      return;
    setBusy(id);
    setMessage("");
    try {
      const r = await appFetch("/api/v3/brand-boost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand_id: id, request_id: crypto.randomUUID() }),
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error?.message || "暂时无法加速");
      setMessage(
        `${name}已加入优先刷新队列，今日剩余${d.remaining ?? remaining}次`,
      );
      window.dispatchEvent(new Event("points-changed"));
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "暂时无法加速");
    } finally {
      setBusy("");
    }
  }
  return {
    message,
    dismiss: () => setMessage(""),
    button: (id: string, name: string) => {
      const job = jobs.find((j) => j.brand_id === id);
      return (
        <button
          className="brand-boost-button"
          disabled={
            !!busy || job?.mine || job?.state === "running" || remaining === 0
          }
          title={
            remaining === 0
              ? "今日加速次数已用完"
              : `每天最多2次，今日剩余${remaining}次`
          }
          onClick={() => void accelerate(id, name)}
        >
          {busy === id ? (
            "提交中…"
          ) : job?.state === "running" ? (
            "正在刷新"
          ) : job?.mine ? (
            `已加速 · 第${job.position}位`
          ) : (
            <>
              {job ? `助力加速 · 第${job.position}位` : "加速刷新"}{" "}
              <Points amount={20} cost />
            </>
          )}
        </button>
      );
    },
  };
}
