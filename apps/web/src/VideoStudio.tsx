import { useCallback, useEffect, useRef, useState } from "react";
import { appFetch, appUrl } from "./app-url";
import { CouponMedia } from "./CouponMedia";
import { StudioCoupon } from "./StudioCoupon";

type Asset = {
  id: string;
  title: string;
  author: string;
  kind: string;
  duration?: number;
  accepted?: boolean;
  score?: number;
  reason?: string;
};
type Clip = {
  asset_id: string;
  start: number;
  duration: number;
  caption: string;
};
type Project = {
  id: string;
  requires_face_screen?: boolean;
  brand_name: string;
  title: string;
  seconds: number;
  assets: Asset[];
  plan: Clip[];
  revision: number;
  preview_revision?: number;
  export_revision?: number;
  state: string;
  progress: string;
  error: string | null;
  cost: number;
  created_at: string;
};
type Resource = { id: string; title: string; poster: string };
const active = (p: Project | null) =>
  !!p &&
  [
    "queued",
    "preparing",
    "analyzing",
    "planning",
    "rendering_preview",
    "rendering_export",
  ].includes(p.state);
async function request(path: string, method = "GET", body?: unknown) {
  const r = await appFetch(path, {
    method,
    ...(body !== undefined
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error?.message || "请求失败");
  return data;
}
export function VideoStudio() {
  const query = new URLSearchParams(location.search),
    brand = query.get("brand_id") || "",
    product = query.get("product_id") || "";
  const [resources, setResources] = useState<Resource[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [uploads, setUploads] = useState<{ id: string; name: string }[]>([]),
    [music, setMusic] = useState<{ id: string; name: string } | null>(null),
    [seconds, setSeconds] = useState(18),
    [rights, setRights] = useState(false),
    [project, setProject] = useState<Project | null>(null),
    [history, setHistory] = useState<Project[]>([]),
    [plan, setPlan] = useState<Clip[]>([]),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [copyStatus, setCopyStatus] = useState(""),
    [configured, setConfigured] = useState(true);
  const resourceSignature = useRef("");
  const receiveResources = useCallback((next: Resource[]) => {
    const signature = JSON.stringify(next);
    if (signature === resourceSignature.current) return;
    resourceSignature.current = signature;
    setResources((previous) => {
      if (JSON.stringify(previous) === JSON.stringify(next)) return previous;
      return next;
    });
    setSelected((previous) => {
      const valid = previous.filter((id) => next.some((r) => r.id === id));
      return valid.length ? valid : next.slice(-40).map((r) => r.id);
    });
  }, []);
  const prefix = "/api/v3/video-projects";
  const captionText = plan
    .map((clip) => clip.caption.trim())
    .filter(Boolean)
    .join("\n");
  useEffect(() => {
    setCopyStatus("");
  }, [captionText]);
  async function copyCaptions() {
    try {
      await navigator.clipboard.writeText(captionText);
      setCopyStatus("已复制全部字幕");
    } catch {
      setCopyStatus("复制失败，请允许浏览器访问剪贴板后重试");
    }
  }

  function load(p: Project) {
    setProject(p);
    setHistory((h) => [p, ...h.filter((x) => x.id !== p.id)]);
    setPlan(p.plan);
    setDirty(false);
    const u = new URL(location.href);
    u.searchParams.set("project", p.id);
    window.history.replaceState({}, "", u);
  }
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [m, h, c] = await Promise.all([
          request(
            `/api/v3/coupon-media?${new URLSearchParams({ brand_id: brand, product_id: product })}`,
          ),
          request(
            `${prefix}?${new URLSearchParams({ brand_id: brand, product_id: product })}`,
          ),
          request(`${prefix}/config`),
        ]);
        if (cancelled) return;
        setResources(m.job?.resources || []);
        setSelected(
          (m.job?.resources || []).slice(-40).map((r: Resource) => r.id),
        );
        setHistory(h.items);
        setConfigured(c.configured);
        const id = new URLSearchParams(location.search).get("project");
        if (id) {
          const d = await request(`${prefix}/${id}`);
          if (!cancelled) load(d.project);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [brand, product]);
  useEffect(() => {
    if (!active(project)) return;
    let cancelled = false,
      pending = false;
    const t = setInterval(async () => {
      if (pending) return;
      pending = true;
      try {
        const d = await request(`${prefix}/${project!.id}`);
        if (!cancelled) load(d.project);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        pending = false;
      }
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [project?.id, project?.state]);
  async function perform(f: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await f();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function upload(files: FileList | null, audio = false) {
    if (!files) return;
    await perform(async () => {
      for (const file of Array.from(files)) {
        if (file.size > 50 * 1024 * 1024) throw Error("每个文件最大50MB");
        const r = await appFetch("/api/v3/video-assets", {
          method: "POST",
          headers: { "Content-Type": file.type },
          body: file,
        });
        const data = await r.json();
        if (!r.ok) throw Error(data.error?.message || "上传失败");
        if (audio) setMusic({ id: data.id, name: file.name });
        else setUploads((v) => [...v, { id: data.id, name: file.name }]);
      }
    });
  }
  async function create() {
    await perform(async () => {
      const d = await request(prefix, "POST", {
        brand_id: brand,
        product_id: product,
        seconds,
        resource_ids: selected,
        upload_ids: uploads.map((u) => u.id),
        music_id: music?.id,
        rights_confirmed: rights,
      });
      load(d.project);
      setHistory((h) => [d.project, ...h.filter((x) => x.id !== d.project.id)]);
    });
  }
  async function action(name: string) {
    if (!project) return;
    await perform(async () => {
      let p = project;
      if (dirty) {
        const d = await request(`${prefix}/${p.id}/timeline`, "PATCH", {
          revision: p.revision,
          plan,
        });
        p = d.project;
        load(p);
      }
      const d = await request(`${prefix}/${p.id}/${name}`, "POST", {});
      load(d.project);
    });
  }
  function edit(index: number, patch: Partial<Clip>) {
    setPlan((v) => v.map((c, i) => (i === index ? { ...c, ...patch } : c)));
    setDirty(true);
  }
  function move(index: number, delta: number) {
    setPlan((v) => {
      const copy = [...v];
      [copy[index], copy[index + delta]] = [copy[index + delta], copy[index]];
      return copy;
    });
    setDirty(true);
  }
  const locked = busy || active(project),
    preview =
      project?.preview_revision === project?.revision &&
      project?.preview_revision !== undefined,
    exported =
      project?.export_revision === project?.revision &&
      project?.export_revision !== undefined;
  return (
    <main className="video-studio">
      <header className="studio-header">
        <div>
          <nav className="studio-navigation" aria-label="视频制作导航">
            <a
              href={appUrl(
                `/?channel=${new URLSearchParams(location.search).get("channel") === "leisure" ? "leisure" : "food"}`,
              )}
            >
              ← 返回选券工作台
            </a>
            <a
              href={appUrl(
                `/?tab=videos&channel=${new URLSearchParams(location.search).get("channel") === "leisure" ? "leisure" : "food"}`,
              )}
            >
              我的视频 →
            </a>
          </nav>
          <h1>制作探店视频</h1>
          <p>
            {project?.brand_name || "挑好素材，自动剪成一条短片"}
            {project ? ` · ${project.title}` : ""}
          </p>
        </div>
        <span>12–20秒 · 竖屏 · 实况混剪 · 素材不足时自动缩短，最低12秒</span>
      </header>
      {brand && product && <StudioCoupon brandId={brand} productId={product} />}
      <p className="muted">
        网络参考素材会排除真人正面出镜；无法确认时不入选。自己上传的素材不受此限制。旧项目需重新分析后生成。
      </p>
      {project?.requires_face_screen && (
        <p role="status">
          此项目的网络素材需要重新检查真人出镜，请点击重新分析，再生成预览或导出。
        </p>
      )}
      {!configured && <p role="alert">百炼密钥尚未配置，请联系管理员。</p>}
      {error && (
        <p role="alert" className="studio-error">
          {error}
        </p>
      )}
      {brand && product && (
        <CouponMedia
          brandId={brand}
          productId={product}
          onResources={receiveResources}
        />
      )}
      {!project ? (
        <section className="studio-setup">
          <h2>制作设置</h2>
          <div className="studio-settings">
            <label>
              成片时长
              <select
                value={seconds}
                onChange={(e) => setSeconds(Number(e.target.value))}
              >
                {[12, 15, 18, 20].map((n) => (
                  <option key={n} value={n}>
                    {n}秒
                  </option>
                ))}
              </select>
            </label>
            <label>
              上传自有图片/视频
              <input
                type="file"
                multiple
                accept="video/mp4,video/quicktime,image/jpeg,image/png,image/webp"
                disabled={busy}
                onChange={(e) => void upload(e.target.files)}
              />
            </label>
            <label>
              配乐（可选，默认静音）
              <input
                type="file"
                accept="audio/*"
                disabled={busy}
                onChange={(e) => void upload(e.target.files, true)}
              />
            </label>
          </div>
          <p>
            已选择 {selected.length + uploads.length}{" "}
            个素材（单次最多40个，默认选最近获取的40个）；AI自动筛选、截取并生成预览。配乐：
            {music?.name || "无"}。
          </p>
          {uploads.map((u) => (
            <p key={u.id}>
              {u.name}{" "}
              <button
                className="quiet-button"
                onClick={() =>
                  void perform(async () => {
                    await request(`/api/v3/video-assets/${u.id}`, "DELETE");
                    setUploads((v) => v.filter((x) => x.id !== u.id));
                  })
                }
              >
                移除
              </button>
            </p>
          ))}
          <label className="studio-rights">
            <input
              type="checkbox"
              checked={rights}
              onChange={(e) => setRights(e.target.checked)}
            />
            我确认所选素材和配乐已获得制作、导出的使用权限
          </label>
          <button
            disabled={
              busy ||
              !configured ||
              !rights ||
              selected.length + uploads.length < 4 ||
              selected.length + uploads.length > 40
            }
            onClick={() => void create()}
          >
            {busy ? "提交中…" : "智能筛片并生成预览"}
          </button>
          <p className="studio-hint">
            品牌展示版：不自动声称画面中的菜品属于这张券。模型费用按保守费率估算，任务上限1元。
          </p>
          <details>
            <summary>查看或调整来源素材（{resources.length}）</summary>
            <div className="studio-resource-grid">
              {resources.map((r) => (
                <label key={r.id}>
                  <img
                    src={r.poster}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                  <span>
                    <input
                      type="checkbox"
                      checked={selected.includes(r.id)}
                      onChange={(e) =>
                        setSelected((v) =>
                          e.target.checked
                            ? [...v, r.id]
                            : v.filter((id) => id !== r.id),
                        )
                      }
                    />
                    {r.title}
                  </span>
                </label>
              ))}
            </div>
            {!resources.length && (
              <p>可以上传自己的素材，或返回券下先获取小红书资源。</p>
            )}
          </details>
        </section>
      ) : (
        <>
          <div className="studio-status" aria-live="polite">
            <strong>{project.progress}</strong>
            <span>模型费用估算 ¥{project.cost.toFixed(3)}</span>
            {active(project) && (
              <button disabled={busy} onClick={() => void action("cancel")}>
                停止任务
              </button>
            )}
          </div>
          {project.error && (
            <p role="alert" className="studio-error">
              {project.error}{" "}
              <button
                disabled={locked}
                onClick={() =>
                  void action(project.plan.length ? "preview" : "analyze")
                }
              >
                {project.error.includes("Arrearage")
                  ? "账户恢复后重试"
                  : "重试"}
              </button>
            </p>
          )}
          <div className="studio-workspace">
            <section className="studio-preview">
              <h2>成片预览</h2>
              {(exported || preview) && !dirty ? (
                <video
                  key={`${project.id}-${project.revision}-${exported}`}
                  controls
                  playsInline
                  src={appUrl(
                    `${prefix}/${project.id}/download?kind=${exported ? "export" : "preview"}&inline=1`,
                  )}
                />
              ) : (
                <div className="studio-preview-placeholder">
                  {active(project)
                    ? "正在准备你的短片…"
                    : dirty
                      ? "时间线已修改，请重新生成预览"
                      : "预览完成后在这里播放"}
                </div>
              )}
              <div className="studio-actions">
                <button
                  disabled={locked || !plan.length}
                  onClick={() => void action("preview")}
                >
                  {dirty ? "保存并更新预览" : "生成720p预览"}
                </button>
                <button
                  disabled={locked || !plan.length}
                  onClick={() => void action("export")}
                >
                  导出1080p MP4
                </button>
                {exported && !dirty && (
                  <a
                    className="studio-download"
                    href={appUrl(`${prefix}/${project.id}/download`)}
                  >
                    下载成片
                  </a>
                )}
              </div>
              <p className="studio-hint">
                保留原画面比例；低分辨率素材不会因导出1080p获得真实细节。原素材声音默认静音。
              </p>
            </section>
            <section className="studio-timeline">
              <h2>镜头与字幕</h2>
              <div className="studio-actions">
                <button
                  type="button"
                  disabled={!captionText}
                  title="按镜头顺序复制当前字幕，包含尚未保存的修改"
                  onClick={() => void copyCaptions()}
                >
                  一键复制字幕
                </button>
                <button
                  type="button"
                  disabled={locked || !captionText}
                  onClick={() => {
                    setPlan((v) => v.map((c) => ({ ...c, caption: "" })));
                    setDirty(true);
                  }}
                >
                  清空全部字幕
                </button>
                <span role="status" className="studio-hint">
                  {copyStatus ||
                    (!captionText
                      ? "填写字幕后即可复制"
                      : "按镜头顺序复制，每条字幕一行")}
                </span>
              </div>
              <p>
                目标{project.seconds}秒 · 当前
                {plan.reduce((n, c) => n + c.duration, 0).toFixed(1)}
                秒。调序、换片或修改字幕后更新预览。
              </p>
              {plan.map((c, i) => (
                <article key={`${i}-${c.asset_id}`} className="studio-shot">
                  <div className="studio-shot-title">
                    <strong>镜头 {i + 1}</strong>
                    <button
                      className="quiet-button"
                      disabled={locked || i === 0}
                      onClick={() => move(i, -1)}
                    >
                      上移
                    </button>
                    <button
                      className="quiet-button"
                      disabled={locked || i === plan.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      下移
                    </button>
                  </div>
                  <select
                    aria-label={`镜头${i + 1}素材`}
                    disabled={locked}
                    value={c.asset_id}
                    onChange={(e) =>
                      edit(i, { asset_id: e.target.value, start: 0 })
                    }
                  >
                    {project.assets
                      .filter((a) => a.accepted)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.score}分 · {a.title.slice(0, 20)} ·{" "}
                          {a.reason?.slice(0, 35)}
                        </option>
                      ))}
                  </select>
                  <div className="studio-shot-times">
                    <label>
                      起点（秒）
                      <input
                        type="number"
                        min="0"
                        max="120"
                        step="0.1"
                        disabled={locked}
                        value={Number(c.start.toFixed(2))}
                        onChange={(e) =>
                          edit(i, { start: Number(e.target.value) })
                        }
                      />
                    </label>
                    <label>
                      长度（秒）
                      <input
                        type="number"
                        min="1"
                        max="5"
                        step="0.1"
                        disabled={locked}
                        value={Number(c.duration.toFixed(2))}
                        onChange={(e) =>
                          edit(i, { duration: Number(e.target.value) })
                        }
                      />
                    </label>
                  </div>
                  <input
                    aria-label={`镜头${i + 1}字幕`}
                    placeholder="可选短字幕，价格和权益请核实后填写"
                    maxLength={40}
                    value={c.caption}
                    disabled={locked}
                    onChange={(e) => edit(i, { caption: e.target.value })}
                  />
                </article>
              ))}
              {!plan.length && (
                <p>AI正在挑选镜头；结果会自动保留，离开页面不影响任务。</p>
              )}
            </section>
          </div>
          <details className="studio-analysis">
            <summary>
              素材筛选结果（{project.assets.filter((a) => a.accepted).length}/
              {project.assets.length}通过）
            </summary>
            <div className="studio-analysis-grid">
              {project.assets.map((a) => (
                <article key={a.id}>
                  {a.duration || a.kind === "image" ? (
                    a.kind === "image" ? (
                      <img
                        src={appUrl(`${prefix}/${project.id}/media/${a.id}`)}
                        alt={a.title}
                      />
                    ) : (
                      <video
                        src={appUrl(`${prefix}/${project.id}/media/${a.id}`)}
                        controls
                        preload="none"
                      />
                    )
                  ) : null}
                  <strong>
                    {a.accepted ? "入围" : a.reason ? "未选用" : "等待分析"}{" "}
                    {a.score ?? ""}
                  </strong>
                  <p>{a.reason || a.title}</p>
                  <small>{a.author}</small>
                </article>
              ))}
            </div>
          </details>
          <button
            className="quiet-button"
            disabled={locked}
            onClick={() => {
              setProject(null);
              setDirty(false);
              const u = new URL(location.href);
              u.searchParams.delete("project");
              window.history.replaceState({}, "", u);
            }}
          >
            新建另一个版本
          </button>
        </>
      )}
      {!!history.length && (
        <details className="studio-history">
          <summary>制作记录</summary>
          {history.map((p) => (
            <div key={p.id}>
              <button
                className="quiet-button"
                disabled={busy}
                onClick={() =>
                  void perform(async () =>
                    load((await request(`${prefix}/${p.id}`)).project),
                  )
                }
              >
                {new Date(p.created_at).toLocaleString("zh-CN")} · {p.seconds}秒
              </button>
              <button
                className="quiet-button"
                disabled={busy || active(p)}
                onClick={() => {
                  if (window.confirm("删除该制作项目及其成片？"))
                    void perform(async () => {
                      await request(`${prefix}/${p.id}`, "DELETE");
                      setHistory((h) => h.filter((x) => x.id !== p.id));
                      if (project?.id === p.id) setProject(null);
                    });
                }}
              >
                删除项目
              </button>
            </div>
          ))}
        </details>
      )}
    </main>
  );
}
