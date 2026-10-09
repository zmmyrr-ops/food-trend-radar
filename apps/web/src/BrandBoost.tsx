import "./brand-boost.css";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
export function BrandBoost({
  brands,
}: {
  brands: { id: string; name: string; category: string; active?: boolean }[];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("");

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
    if (!open) return;
    dialog.current?.showModal();
    void refresh().catch(() => {});
    const timer = setInterval(() => void refresh().catch(() => {}), 15000);
    return () => clearInterval(timer);
  }, [open]);
  async function accelerate(id: string, name: string) {
    if (busy) return;
    if (
      !(await confirmPointSpend(
        `加速刷新 · ${name}`,
        20,
        `今日剩余${remaining}次，确认后消耗20积分。`,
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
  const selectedBrand = brands.find((b) => b.id === selected);
  const job = jobs.find((j) => j.brand_id === selected);
  const results = search.trim()
    ? brands
        .filter(
          (b) =>
            b.active !== false &&
            b.name.toLowerCase().includes(search.trim().toLowerCase()),
        )
        .slice(0, 30)
    : [];
  function close() {
    dialog.current?.close();
    setOpen(false);
  }
  return (
    <>
      <button
        className="brand-boost-entry"
        onClick={() => {
          setSearch("");
          setSelected("");
          setMessage("");
          setOpen(true);
        }}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="m13 3-8 11h6l-1 7 9-12h-6l1-6Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
        加速刷新品牌
      </button>
      {open &&
        createPortal(
          <dialog
            ref={dialog}
            className="brand-boost-dialog"
            aria-labelledby="brand-boost-title"
            onCancel={(e) => {
              e.preventDefault();
              if (!busy) close();
            }}
          >
            <div className="brand-boost-heading">
              <div>
                <h2 id="brand-boost-title">加速刷新品牌</h2>
                <p>今日剩余 {remaining} 次</p>
              </div>
              <button
                aria-label="关闭加速窗口"
                disabled={!!busy}
                onClick={close}
              >
                ×
              </button>
            </div>
            <label className="brand-boost-search">
              搜索品牌
              <input
                autoFocus
                placeholder="输入品牌名称，如肯德基"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setSelected("");
                  setMessage("");
                }}
              />
            </label>
            <div
              className="brand-boost-results"
              role="radiogroup"
              aria-label="选择要刷新的品牌"
            >
              {!search.trim() && <p>输入名称，选择需要提前刷新的品牌</p>}
              {search.trim() && !results.length && (
                <p>没有找到匹配品牌，请换个关键词</p>
              )}
              {results.map((b) => (
                <label
                  className={selected === b.id ? "is-selected" : ""}
                  key={b.id}
                >
                  <input
                    type="radio"
                    name="boost-brand"
                    value={b.id}
                    checked={selected === b.id}
                    disabled={!!busy}
                    onChange={() => {
                      setSelected(b.id);
                      setMessage("");
                    }}
                  />
                  <span>
                    {b.name}
                    <small>{b.category}</small>
                  </span>
                </label>
              ))}
            </div>
            {message && (
              <p className="brand-boost-feedback" role="status">
                {message}
              </p>
            )}
            <div className="brand-boost-footer">
              <button onClick={close} disabled={!!busy}>
                关闭
              </button>
              <button
                className="brand-boost-submit"
                disabled={
                  !selectedBrand ||
                  !!busy ||
                  job?.mine ||
                  job?.state === "running" ||
                  remaining === 0
                }
                onClick={() =>
                  selectedBrand &&
                  void accelerate(selectedBrand.id, selectedBrand.name)
                }
              >
                {busy ? (
                  "提交中…"
                ) : job?.state === "running" ? (
                  "正在刷新"
                ) : job?.mine ? (
                  `已加速 · 第${job.position}位`
                ) : (
                  <>
                    确认加速 <Points amount={20} cost />
                  </>
                )}
              </button>
            </div>
          </dialog>,
          document.body,
        )}
    </>
  );
}
