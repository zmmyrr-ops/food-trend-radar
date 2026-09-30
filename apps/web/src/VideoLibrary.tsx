import { type Brand, type Channel, inChannel } from "@radar/contracts";
import { useEffect, useState } from "react";
import { appFetch, appUrl } from "./app-url";

type Video = {
  id: string;
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
  channel: Channel;
  brands: Brand[];
}) {
  const [items, setItems] = useState<Video[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
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
  const scoped = items.filter((p) =>
    brands.some((b) => b.id === p.brand_id && inChannel(b.category, channel)),
  );
  return (
    <section aria-label="我的视频">
      <p>
        {channel === "food" ? "美食" : "游玩"}频道 · {scoped.length}{" "}
        个视频项目，按最近更新排序。
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
          还没有制作记录。在券下方获取素材后，点击“制作12–20秒短视频”即可开始。
        </p>
      )}
      <div className="video-library-grid">
        {scoped.map((p) => {
          const exported = p.export_revision === p.revision;
          const preview = p.preview_revision === p.revision;
          const kind = exported ? "export" : "preview";
          const endpoint = `/api/v3/video-projects/${p.id}/download?kind=${kind}`;
          const studio = appUrl(
            `/?${new URLSearchParams({
              studio: "1",
              channel,
              brand_id: p.brand_id,
              product_id: p.product_id,
              project: p.id,
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
                  {labels[p.state] || "待处理"}
                </div>
              )}
              <div className="video-library-body">
                <h2>
                  {p.brand_name} <small>· {p.seconds}秒</small>
                </h2>
                <p>{p.title}</p>
                <p className="studio-hint">
                  {labels[p.state] || p.state} ·{" "}
                  {new Date(p.updated_at).toLocaleString("zh-CN")}
                </p>
                {p.error ? (
                  <p className="studio-error">{p.error}</p>
                ) : (
                  <p className="studio-hint">{p.progress}</p>
                )}
                <div className="studio-actions">
                  <a href={studio}>打开工作室</a>
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
