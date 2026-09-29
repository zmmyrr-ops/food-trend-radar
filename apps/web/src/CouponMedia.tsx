import { useCallback, useEffect, useState } from "react";
import { appFetch, appUrl } from "./app-url";

type Resource = {
  id: string;
  title: string;
  author: string;
  note_url: string;
  poster: string;
  video_url: string;
  match: string;
};
type Job = {
  id: string;
  state: string;
  keyword: string;
  resources: Resource[];
  inspected: number;
  error_code: string | null;
  expires_at: string;
};
const errors: Record<string, string> = {
  AUTH_MISSING: "尚未配置小红书登录请求",
  AUTH_EXPIRED: "登录或请求签名已失效，请更新小红书请求凭据",
  RATE_LIMITED: "小红书限制了访问，已停止获取，请稍后再试",
  NETWORK_ERROR: "网络请求失败，已保留获取到的素材",
  UPSTREAM_ERROR: "小红书服务暂不可用",
  INVALID_RESPONSE: "响应无法识别，已停止获取",
  INTERRUPTED: "服务重启中断了任务，可重新获取",
  INTERNAL_ERROR: "获取失败，请稍后重试",
};
function MediaTile({ item }: { item: Resource }) {
  const [play, setPlay] = useState(false),
    [failed, setFailed] = useState(false);
  return (
    <figure className="live-media-tile">
      <div className="live-media-visual">
        {play && !failed ? (
          <video
            src={item.video_url}
            poster={item.poster || undefined}
            controls
            playsInline
            muted
            autoPlay
            preload="none"
            onError={() => setFailed(true)}
          />
        ) : (
          <button
            className="live-media-preview"
            onClick={() => setPlay(true)}
            disabled={failed}
            aria-label={`播放实况：${item.title}`}
          >
            {item.poster ? (
              <img
                src={item.poster}
                loading="lazy"
                referrerPolicy="no-referrer"
                alt={item.title}
              />
            ) : (
              <span>实况预览</span>
            )}
            <span className="live-media-play">
              {failed ? "链接已失效，请查看原文" : "▶ 实况"}
            </span>
          </button>
        )}
      </div>
      <figcaption>
        <a
          href={item.note_url}
          target="_blank"
          rel="noreferrer"
          title={item.title}
        >
          {item.title}
        </a>
        <span>
          {item.author} ·{" "}
          <a href={item.note_url} target="_blank" rel="noreferrer">
            查看原文
          </a>
        </span>
      </figcaption>
    </figure>
  );
}
export function CouponMedia({
  brandId,
  productId,
}: {
  brandId: string;
  productId: string;
}) {
  const [open, setOpen] = useState(false),
    [job, setJob] = useState<Job | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const query = new URLSearchParams({
    brand_id: brandId,
    product_id: productId,
  }).toString();
  const read = useCallback(
    async (signal?: AbortSignal) => {
      const r = await appFetch(`/api/v3/coupon-media?${query}`, { signal });
      if (!r.ok) throw Error("无法读取素材任务");
      const data = await r.json();
      if (!signal?.aborted) setJob(data.job);
    },
    [query],
  );
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        await read(controller.signal);
      } catch (e) {
        if (!controller.signal.aborted) setError(String(e));
      } finally {
        pending = false;
      }
    };
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => {
      controller.abort();
      clearInterval(t);
    };
  }, [open, read]);
  async function acquire() {
    setBusy(true);
    setError("");
    try {
      const r = await appFetch("/api/v3/coupon-media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand_id: brandId, product_id: productId }),
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error?.message || "创建任务失败");
      setJob(data.job);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!job) return;
    try {
      const r = await appFetch(`/api/v3/coupon-media/${job.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!r.ok) throw Error("停止失败");
      await read();
    } catch (e) {
      setError(String(e));
    }
  }
  const running = job && ["queued", "running"].includes(job.state);
  const fresh =
    job?.state === "complete" && Date.parse(job.expires_at) > Date.now();
  return (
    <section className="coupon-media">
      <button
        className="coupon-media-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>小红书实况素材</span>
        <span>
          {job?.resources.length ? `${job.resources.length} 个 · ` : ""}
          {open ? "收起 −" : "展开 +"}
        </span>
      </button>
      <a className="studio-entry" href={appUrl(`/?studio=1&${query}`)}>
        制作12–20秒短视频 →
      </a>
      {open && (
        <div className="coupon-media-body">
          <div className="coupon-media-toolbar">
            <div>
              <strong>相关探店 · 实况片段</strong>
              <p>按品牌与券名搜索，最多 40 个；同品牌内容不代表同一张券。</p>
            </div>
            <button
              disabled={busy || !!running || !!fresh}
              onClick={() => void acquire()}
            >
              {busy
                ? "提交中…"
                : running
                  ? "获取中…"
                  : fresh
                    ? "已获取 · 缓存中"
                    : "获取资源"}
            </button>
            {running && <button onClick={() => void cancel()}>停止</button>}
          </div>
          <p className="coupon-media-status" aria-live="polite">
            {running
              ? `${job.state === "queued" ? "排队等待" : "串行获取"} · 已检查 ${job.inspected} 篇 · 已找到 ${job.resources.length}/40 个`
              : job?.state === "complete"
                ? `已找到 ${job.resources.length} 个${job.resources.length < 30 ? "，本次结果不足 30 个，不补入无关素材" : ""}`
                : job?.state === "cancelled"
                  ? "已停止，已获取素材保留"
                  : job
                    ? errors[job.error_code || ""] || "任务未完成"
                    : "点击后开始获取；请求间隔 3–5 秒，不影响优惠券采集。"}
          </p>
          {job && (
            <small className="coupon-media-query">
              搜索：{job.keyword} · 结果缓存 4 小时，媒体链接可能提前失效。
            </small>
          )}
          {error && <p role="alert">{error}</p>}
          {!!job?.resources.length && (
            <div className="live-media-grid">
              {job.resources.map((item) => (
                <MediaTile key={item.id} item={item} />
              ))}
            </div>
          )}
          {job?.state === "complete" && !job.resources.length && (
            <p className="coupon-media-empty">
              本次没有找到可用的相关实况素材。普通图片、无动态资源或归属不明的内容未列入。
            </p>
          )}
        </div>
      )}
    </section>
  );
}
