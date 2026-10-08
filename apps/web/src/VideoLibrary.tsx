import { type Brand, type Channel, inChannel } from "@radar/contracts";
import { useEffect, useState } from "react";
import { appFetch, appUrl } from "./app-url";
import { type VisitPlan, visitRequest } from "./VisitPlans";
import { videoProgress } from "./video-progress";

type Video = {
  id: string;
  visit_store_id?: string;
  visit_plan_id?: string;
  visit_store_name?: string;
  visit_plan_name?: string;
  visit_date?: string;
  brand_id: string;
  product_id: string;
  brand_name: string;
  title: string;
  seconds: number;
  state: string;
  progress: string;
  error: string | null;
  revision: number;
  preview_revision?: number;
  export_revision?: number;
  updated_at: string;
  expired?: boolean;
  expires_at?: string;
};
const labels: Record<string, string> = {
  draft: "待制作",
  queued: "排队中",
  preparing: "准备素材",
  analyzing: "筛选素材",
  planning: "编排镜头",
  rendering_preview: "生成预览",
  rendering_export: "导出中",
  preview_ready: "预览已完成",
  completed: "成片已完成",
  edited: "待更新预览",
  failed: "制作失败",
  interrupted: "制作中断",
  cancelled: "已取消",
};
export function VideoLibrary({
  channel,
  brands,
}: {
  channel: Channel | "all";
  brands: Brand[];
}) {
  const [plans, setPlans] = useState<VisitPlan[]>([]);
  useEffect(() => {
    void visitRequest("visit-plans")
      .then((d) => setPlans(d.items))
      .catch((e) => setError(String(e)));
  }, []);
  const [items, setItems] = useState<Video[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [deleting, setDeleting] = useState<string | null>(null);
  async function remove(p: Video) {
    if (!window.confirm(`删除“${p.title}”及其成片？删除后无法恢复。`)) return;
    setDeleting(p.id);
    try {
      await visitRequest(`video-projects/${p.id}`, "DELETE");
      setItems((items) => items.filter((x) => x.id !== p.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setDeleting(null);
    }
  }
  useEffect(() => {
    let cancelled = false,
      pending = false;
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const response = await appFetch("/api/v3/video-projects");
        const data = await response.json();
        if (!response.ok)
          throw Error(data.error?.message || "视频列表加载失败");
        if (!cancelled) {
          setItems(data.items);
          setLoaded(true);
          setError("");
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "加载失败");
      } finally {
        pending = false;
      }
    }
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refresh]);
  const scoped = items.filter(
    (p) =>
      channel === "all" ||
      !p.brand_id ||
      brands.some((b) => b.id === p.brand_id && inChannel(b.category, channel)),
  );
  return (
    <section aria-label="我的视频">
      <p>
        {channel === "all" ? "全部" : channel === "food" ? "美食" : "游玩"} ·{" "}
        {scoped.length} 个视频项目，按最近更新排序。
      </p>
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => setRefresh((n) => n + 1)}>
            重新加载
          </button>
        </p>
      )}
      {!loaded && !error && <p role="status">正在加载视频…</p>}
      {loaded && !scoped.length && (
        <p>
          还没有制作记录。在“探店计划”中选择店铺，点击“制作探店视频”即可开始。
        </p>
      )}
      <div className="video-library-grid">
        {scoped.map((p) => {
          const expired =
            !!p.expired ||
            (!!p.expires_at && Date.parse(p.expires_at) <= Date.now());
          const working = [
            "queued",
            "preparing",
            "analyzing",
            "planning",
            "rendering_preview",
            "rendering_export",
          ].includes(p.state);
          const exported = !expired && p.export_revision === p.revision;
          const preview = !expired && p.preview_revision === p.revision;
          const kind = exported ? "export" : "preview";
          const endpoint = `/api/v3/video-projects/${p.id}/download?kind=${kind}`;
          const studio = appUrl(
            `/?${new URLSearchParams({
              studio: "1",
              channel: brands.some(
                (b) => b.id === p.brand_id && inChannel(b.category, "leisure"),
              )
                ? "leisure"
                : "food",
              brand_id: p.brand_id,
              product_id: p.product_id,
              project: p.id,
              ...(p.visit_store_id ? { visit_store_id: p.visit_store_id } : {}),
            })}`,
          );
          return (
            <article className="video-library-card" key={p.id}>
              {exported || preview ? (
                <video
                  controls
                  playsInline
                  preload="none"
                  src={appUrl(`${endpoint}&inline=1`)}
                  aria-label={`${p.brand_name}视频预览`}
                />
              ) : (
                <div className="video-library-placeholder">
                  {expired ? "已过期" : labels[p.state] || "待处理"}
                </div>
              )}
              <div className="video-library-body">
                <h2>
                  {p.brand_name} <small>· {Math.round(p.seconds)}秒</small>
                </h2>
                <p>{p.title}</p>
                <p className="studio-hint">
                  {p.visit_store_id
                    ? `${p.visit_plan_name} · ${p.visit_date} · ${p.visit_store_name}`
                    : "历史视频 · 尚未关联计划"}
                </p>
                <label>
                  关联计划店铺
                  <select
                    aria-label={`关联计划店铺 ${p.title}`}
                    value={
                      plans.some((plan) =>
                        plan.stores.some((s) => s.id === p.visit_store_id),
                      )
                        ? p.visit_store_id
                        : ""
                    }
                    onChange={(e) => {
                      const id = e.target.value;
                      if (id)
                        void visitRequest(
                          `video-projects/${p.id}/visit`,
                          "PATCH",
                          { visit_store_id: id },
                        )
                          .then(() => setRefresh((n) => n + 1))
                          .catch((e) => setError(String(e)));
                    }}
                  >
                    <option value="">选择计划中的店铺</option>
                    {plans.flatMap((plan) =>
                      plan.stores.map((s) => (
                        <option value={s.id} key={s.id}>
                          {plan.date} · {plan.name} · {s.name}
                        </option>
                      )),
                    )}
                  </select>
                </label>
                <p className="studio-hint">
                  {expired ? "已过期" : labels[p.state] || p.state} ·{" "}
                  {new Date(p.updated_at).toLocaleString("zh-CN")}
                </p>
                {p.expires_at && (
                  <p className="studio-hint">
                    {expired ? "已于" : "保留至"}{" "}
                    {new Date(p.expires_at).toLocaleString("zh-CN")}
                    {expired ? "过期，请新建制作项目" : "，请及时下载"}
                  </p>
                )}
                {expired ? null : p.error ? (
                  <p className="studio-error">{p.error}</p>
                ) : (
                  <p className="studio-hint">{videoProgress(p).detail}</p>
                )}
                <div className="studio-actions">
                  {!expired && (
                    <a href={studio} target="_blank" rel="noopener noreferrer">
                      打开工作室
                    </a>
                  )}
                  <button
                    type="button"
                    disabled={!!deleting || working}
                    title={
                      working ? "请先在工作室停止制作任务" : "删除项目及成片"
                    }
                    onClick={() => void remove(p)}
                  >
                    {deleting === p.id ? "删除中…" : "删除视频"}
                  </button>
                  {exported && <a href={appUrl(endpoint)}>下载成片</a>}
                  {!exported && preview && (
                    <a href={appUrl(endpoint)}>下载预览</a>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
