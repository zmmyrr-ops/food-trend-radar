import "./media-text.css";
import { useCallback, useEffect, useState } from "react";
import { useAccount } from "./AccountGate";
import { appFetch } from "./app-url";
import { confirmPointSpend } from "./PointSpendConfirm";
import { Points } from "./Points";

type Resource = {
  id: string;
  title: string;
  author: string;
  note_url: string;
  poster: string;
  video_url: string;
  match: string;
  relevance?: "coupon" | "brand";
};
export type TextMaterial = {
  text_state?: string;
  text_error?: string;
  text_summary?: {
    overview: string;
    highlights: string[];
    snippets?: { subject: string; copy: string }[];
  } | null;
};
type Job = TextMaterial & {
  id: string;
  state: string;
  keyword: string;
  resources: Resource[];
  inspected: number;
  error_code: string | null;
  expires_at: string;
  exhausted?: boolean;
  target_count?: number;
};
const errors: Record<string, string> = {
  AUTH_MISSING: "尚未配置素材平台登录请求",
  AUTH_EXPIRED: "登录或请求签名已失效，请更新素材平台请求凭据",
  RATE_LIMITED: "素材平台限制了访问，已停止获取，请稍后再试",
  NETWORK_ERROR: "网络请求失败，已保留获取到的素材",
  UPSTREAM_ERROR: "素材平台服务暂不可用",
  INVALID_RESPONSE: "响应无法识别，已停止获取",
  INTERRUPTED: "服务重启中断了任务，可重新获取",
  INTERNAL_ERROR: "获取失败，请稍后重试",
};
function MediaTile({ item }: { item: Resource }) {
  const isAdmin = useAccount().role === "admin";
  const [play, setPlay] = useState(false),
    [failed, setFailed] = useState("");
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
            onError={(event) => {
              const code = event.currentTarget.error?.code;
              setFailed(
                code === 3 || code === 4
                  ? "播放失败或格式不兼容，点击重试"
                  : "视频加载失败，点击重试",
              );
            }}
          />
        ) : (
          <button
            className="live-media-preview"
            onClick={() => {
              setFailed("");
              setPlay(true);
            }}
            aria-label={isAdmin ? `播放实况：${item.title}` : "播放素材"}
          >
            {item.poster ? (
              <img
                src={item.poster}
                loading="lazy"
                referrerPolicy="no-referrer"
                alt={isAdmin ? item.title : "素材预览"}
              />
            ) : (
              <span>实况预览</span>
            )}
            <span className="live-media-play">{failed || "▶ 实况"}</span>
          </button>
        )}
      </div>
      {isAdmin && (
        <figcaption>
          <span
            className={`media-relevance ${item.relevance || "brand"}`}
            title={item.match}
          >
            {item.relevance === "coupon"
              ? "券相关线索"
              : item.relevance === "brand"
                ? "品牌通用素材"
                : "同品牌素材 · 待匹配"}
          </span>
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
      )}
    </figure>
  );
}
export function CouponMedia({
  brandId,
  productId,
  onResources,
  controlsOnly = false,
  onTextMaterial,
}: {
  onTextMaterial?: (value: TextMaterial | null) => void;
  controlsOnly?: boolean;
  brandId: string;
  productId: string;
  onResources?: (resources: Resource[]) => void;
}) {
  const isAdmin = useAccount().role === "admin";
  const [open, setOpen] = useState(true),
    [job, setJob] = useState<Job | null>(null),
    [busy, setBusy] = useState(false),
    [acquiring, setAcquiring] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (job) onResources?.(job.resources);
    onTextMaterial?.(job);
  }, [job, onResources, onTextMaterial]);
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
  async function acquire(more = false, reset = false) {
    if (
      !(await confirmPointSpend(
        reset ? "重置并重新获取素材" : more ? "再获取一些素材" : "获取网络素材",
        more && !reset ? 5 : 10,
        "本人已有可用缓存免费查看；首次复用他人缓存仍计费。未获取到新增素材自动退分。文章同步暂存，不额外扣分。",
      ))
    )
      return;
    setAcquiring(true);
    setBusy(true);
    setError("");
    try {
      const r = await appFetch("/api/v3/coupon-media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand_id: brandId,
          product_id: productId,
          more,
          reset,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error?.message || "创建任务失败");
      setJob(data.job);
    } catch (e) {
      setError(String(e));
    } finally {
      setAcquiring(false);
      setBusy(false);
    }
  }
  async function generateCopy() {
    if (!job?.resources.length) {
      setError("请先获取视频素材");
      return;
    }
    if (
      !(await confirmPointSpend(
        "智能生成视频文案",
        5,
        "根据已获取素材的暂存文章提取口播句子，失败自动退分。",
      ))
    )
      return;
    setBusy(true);
    setError("");
    try {
      const response = await appFetch("/api/v3/coupon-media/text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand_id: brandId, product_id: productId }),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error?.message || "生成失败");
      setJob(data.job);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
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
  const running =
    job &&
    (["queued", "running"].includes(job.state) ||
      ["queued", "running"].includes(job.text_state || ""));
  const fresh =
    job?.state === "complete" && Date.parse(job.expires_at) > Date.now();
  return (
    <section
      className="coupon-media"
      data-searching={
        acquiring || (job && ["queued", "running"].includes(job.state))
          ? "true"
          : undefined
      }
    >
      <button
        className="coupon-media-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>获取网络参考素材</span>
        <span>
          {job?.resources.length ? `${job.resources.length} 个 · ` : ""}
          {open ? "收起 −" : "展开 +"}
        </span>
      </button>
      {open && (
        <div className="coupon-media-body">
          <div className="coupon-media-toolbar">
            <div>
              <strong>网络参考素材</strong>
              <p>
                网络视频仅供参考，未经授权不得用于创作或传播，不得侵权使用。
              </p>
            </div>
            <button
              disabled={busy || !!running || !!fresh}
              onClick={() => void acquire()}
            >
              {busy ? (
                "提交中…"
              ) : running ? (
                "搜索中…"
              ) : fresh ? (
                "已获取 · 缓存中"
              ) : (
                <>
                  获取资源 <Points amount={10} cost />
                </>
              )}
            </button>
            {!!job?.resources.length && (
              <button
                disabled={
                  busy ||
                  !!running ||
                  !!job.exhausted ||
                  job.resources.length >= 200
                }
                onClick={() => void acquire(true)}
              >
                {job.exhausted ? (
                  "暂无更多素材"
                ) : job.resources.length >= 200 ? (
                  "已达200个上限"
                ) : (
                  <>
                    再获取一些 <Points amount={5} cost />
                  </>
                )}
              </button>
            )}
            {job && (
              <button
                disabled={busy || !!running}
                onClick={() => void acquire(false, true)}
                title="清空本券素材和搜索进度，重新获取最新链接；已制作的视频保留"
              >
                重置并重新获取 <Points amount={10} cost />
              </button>
            )}
            <button
              className="media-generate-copy"
              disabled={busy || !!running || !job?.resources.length}
              title={!job?.resources.length ? "请先获取视频素材" : undefined}
              onClick={() => void generateCopy()}
            >
              {job && ["queued", "running"].includes(job.text_state || "") ? (
                "正在生成文案…"
              ) : (
                <>
                  智能生成视频文案 <Points amount={5} cost />
                </>
              )}
            </button>
            {job && ["queued", "running"].includes(job.state) && (
              <button onClick={() => void cancel()}>停止</button>
            )}
          </div>
          <p className="coupon-media-status" aria-live="polite">
            {job && ["queued", "running"].includes(job.text_state || "")
              ? "正在生成视频文案，请稍候…"
              : running
                ? "正在搜索素材，请稍候…"
                : job?.state === "complete"
                  ? job.resources.length
                    ? "素材已准备好"
                    : "暂未找到合适素材，请稍后再试"
                  : job?.state === "cancelled"
                    ? "已停止，已获取素材保留"
                    : job
                      ? errors[job.error_code || ""] || "任务未完成"
                      : "选择获取资源，开始准备素材。"}
          </p>
          {error && <p role="alert">{error}</p>}
          {!controlsOnly && !!job?.resources.length && (
            <div className="live-media-grid">
              {job.resources.map((item) => (
                <MediaTile
                  key={`${job.id}:${item.id}:${item.video_url}`}
                  item={item}
                />
              ))}
            </div>
          )}
          {!controlsOnly && <TextMaterialSummary value={job} />}
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

export function TextMaterialSummary({ value }: { value: TextMaterial | null }) {
  const [copied, setCopied] = useState(false);
  if (!value?.text_state) return null;
  const summary = value.text_summary;
  return (
    <section className="media-text-summary" aria-live="polite">
      <header>
        <strong>口播文案素材</strong>
        {summary && (
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(
                  summary.highlights.join("\n"),
                );
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "已复制" : "复制内容"}
          </button>
        )}
      </header>
      {value.text_state === "queued" || value.text_state === "running" ? (
        <p>正在提取适合口播的句子…</p>
      ) : value.text_state === "failed" ? (
        <p>
          {value.text_error === "NO_COPY"
            ? "本次文章中没有提取到具体可用的口播句子。"
            : value.text_error === "NO_TEXT"
              ? "本次素材没有可提炼的文章正文。"
              : value.text_error === "INCOMPLETE"
                ? "素材搜索未完成，文字整理已停止。"
                : value.text_error === "INTERRUPTED"
                  ? "服务更新中断了文字整理。"
                  : "文字整理暂未成功。"}
          本次文案生成的5积分已退回，可点击“智能生成视频文案”重试。
        </p>
      ) : summary ? (
        <>
          {summary.overview && <p>{summary.overview}</p>}
          <ul>
            {summary.highlights.map((text, i) => (
              <li key={i} className="media-copy-line">
                <div>
                  {summary.snippets?.[i] && (
                    <strong>{summary.snippets[i].subject}</strong>
                  )}
                  <p>{text}</p>
                </div>
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(text);
                      setCopied(true);
                    } catch {
                      setCopied(false);
                    }
                  }}
                >
                  复制
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
