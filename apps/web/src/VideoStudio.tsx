import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "./AccountGate";
import { appFetch, appUrl } from "./app-url";
import { CouponMedia } from "./CouponMedia";
import { StudioCoupon } from "./StudioCoupon";
import { visitRequest } from "./VisitPlans";
import { videoProgress } from "./video-progress";

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
type ProductionOptions = {
  subtitles: boolean;
  narration: boolean;
  music: boolean;
};
const defaultOptions: ProductionOptions = {
  subtitles: false,
  narration: false,
  music: false,
};
type Project = {
  production_options?: ProductionOptions;
  script?: string;
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
  const isAdmin = useAccount().role === "admin";
  const query = new URLSearchParams(location.search),
    brand = query.get("brand_id") || "",
    product = query.get("product_id") || "",
    visitStore = query.get("visit_store_id") || "";
  const [visit, setVisit] = useState<{
    name: string;
    plan_name: string;
    plan_id: string;
    date: string;
    address: string;
  } | null>(null);
  useEffect(() => {
    if (visitStore)
      void visitRequest(`visit-stores/${visitStore}`)
        .then((d) => setVisit(d.item))
        .catch(() => setVisit(null));
  }, [visitStore]);
  const [resources, setResources] = useState<Resource[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [uploads, setUploads] = useState<{ id: string; name: string }[]>([]),
    [options, setOptions] = useState<ProductionOptions>(defaultOptions),
    [seconds, setSeconds] = useState(18),
    [rights, setRights] = useState(false),
    [project, setProject] = useState<Project | null>(null),
    [history, setHistory] = useState<Project[]>([]),
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
  const captionText = project?.script || "";
  useEffect(() => {
    setCopyStatus("");
  }, [captionText]);
  async function copyCaptions() {
    try {
      await navigator.clipboard.writeText(captionText);
      setCopyStatus("已复制视频稿");
    } catch {
      setCopyStatus("复制失败，请允许浏览器访问剪贴板后重试");
    }
  }

  function load(p: Project) {
    setProject(p);
    setHistory((h) => [p, ...h.filter((x) => x.id !== p.id)]);
    setOptions(p.production_options || defaultOptions);
    const u = new URL(location.href);
    u.searchParams.set("project", p.id);
    window.history.replaceState({}, "", u);
  }
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [m, h, c] = await Promise.all([
          brand && product
            ? request(
                `/api/v3/coupon-media?${new URLSearchParams({ brand_id: brand, product_id: product })}`,
              )
            : Promise.resolve({ job: null }),
          request(
            `${prefix}?${new URLSearchParams(visitStore ? { visit_store_id: visitStore } : brand ? { brand_id: brand, product_id: product } : {})}`,
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
  }, [brand, product, visitStore]);
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
  async function upload(files: FileList | null) {
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
        setUploads((v) => [...v, { id: data.id, name: file.name }]);
      }
    });
  }
  async function create() {
    await perform(async () => {
      if (!visitStore) throw Error("请从探店计划选择店铺制作视频");
      const d = await request(prefix, "POST", {
        visit_store_id: visitStore,
        brand_id: brand,
        product_id: product,
        seconds,
        resource_ids: selected,
        upload_ids: uploads.map((u) => u.id),
        production_options: options,
        rights_confirmed: rights,
      });
      load(d.project);
      setHistory((h) => [d.project, ...h.filter((x) => x.id !== d.project.id)]);
    });
  }
  async function action(name: string) {
    if (!project) return;
    await perform(async () => {
      const d = await request(
        `${prefix}/${project.id}/${name}`,
        "POST",
        name === "remake"
          ? { revision: project.revision, production_options: options }
          : {},
      );
      load(d.project);
    });
  }
  const optionsChanged =
    !!project &&
    JSON.stringify(options) !==
      JSON.stringify(project.production_options || defaultOptions);
  const production = project ? videoProgress(project) : null;
  const locked = busy || active(project),
    preview =
      project?.preview_revision === project?.revision &&
      project?.preview_revision !== undefined,
    exported =
      project?.export_revision === project?.revision &&
      project?.export_revision !== undefined;
  return (
    <main
      className={`video-studio creator-workbench ${project ? "has-project" : "is-new"}`}
    >
      <header className="studio-header">
        <div>
          <nav className="studio-navigation" aria-label="视频制作导航">
            <a
              href={appUrl(
                `/?tab=plans${visit?.plan_id ? `&plan=${visit.plan_id}` : ""}`,
              )}
            >
              ← 返回探店计划
            </a>
            <a
              href={appUrl(
                `/?tab=videos&channel=${new URLSearchParams(location.search).get("channel") === "leisure" ? "leisure" : "food"}`,
              )}
            >
              我的视频 →
            </a>
          </nav>
          <h1>
            制作探店视频<span className="studio-format">9:16 竖屏</span>
          </h1>
          <p>
            {project?.brand_name || "挑好素材，自动剪成一条短片"}
            {project ? ` · ${project.title}` : ""}
          </p>
        </div>
        <ol className="studio-steps" aria-label="制作进度">
          <li className={!project ? "current" : ""}>01 选择素材</li>
          <li className={project && !exported ? "current" : ""}>02 智能制作</li>
          <li className={exported ? "current" : ""}>03 导出成片</li>
        </ol>
      </header>
      <div className="studio-context">
        {visit && (
          <section className="studio-visit">
            <strong>
              {visit.plan_name} · {visit.date}
            </strong>
            <h2>{visit.name}</h2>
            <p>{visit.address}</p>
            <a href={appUrl(`/?tab=plans&plan=${visit.plan_id}`)}>
              返回探店计划
            </a>
          </section>
        )}
        {!visitStore && !project && (
          <p role="alert">请先在探店计划中添加店铺，再开始制作。</p>
        )}
        {brand && product && (
          <StudioCoupon brandId={brand} productId={product} />
        )}
      </div>

      {project?.requires_face_screen && (
        <p role="status">
          此项目需按新版人物主体规则检查素材，请点击“重新制作”后再预览或导出。
        </p>
      )}
      {!configured && <p role="alert">百炼密钥尚未配置，请联系管理员。</p>}
      {error && (
        <p role="alert" className="studio-error">
          {error}
        </p>
      )}
      <div className="studio-composer">
        <details className="studio-materials" open={!project}>
          <summary className="studio-section-heading">
            <h2>素材工作区</h2>
            <span>
              {selected.length + uploads.length} / 40 已选 · 展开/收起
            </span>
          </summary>
          {brand && product && (
            <CouponMedia
              brandId={brand}
              productId={product}
              onResources={receiveResources}
            />
          )}
          <details className="studio-source-picker">
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
                    {isAdmin ? r.title : `素材 ${resources.indexOf(r) + 1}`}
                  </span>
                </label>
              ))}
            </div>
            {!resources.length && <p>获取参考素材，或上传自己的图片与视频。</p>}
          </details>
        </details>
        {!project ? (
          <section className="studio-setup">
            <div className="studio-section-heading">
              <h2>成片设置</h2>
              <span>自动混剪</span>
            </div>
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
            </div>
            <ProductionSettings
              options={options}
              setOptions={setOptions}
              disabled={locked}
            />
            <p className="studio-hint">至少选择4个素材，最多40个。</p>
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
                !visitStore ||
                !rights ||
                selected.length + uploads.length < 4 ||
                selected.length + uploads.length > 40
              }
              onClick={() => void create()}
            >
              {busy ? "提交中…" : "开始制作"}
            </button>
            <p className="studio-hint">素材不足时自动缩短，成片不少于12秒。</p>
          </section>
        ) : (
          <>
            <div className="studio-status" aria-live="polite">
              <div className="studio-production-progress">
                <div className="studio-progress-heading">
                  <strong>{production?.title}</strong>
                  <span className="studio-progress-percent">
                    {production?.percent != null
                      ? `${production.percent}%`
                      : project.state === "edited"
                        ? "待更新"
                        : "已暂停"}
                  </span>
                </div>
                {production?.percent != null && (
                  <div
                    className={`studio-progress-track ${active(project) ? "is-running" : ""}`}
                    role="progressbar"
                    aria-label="视频制作进度（按阶段估算）"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={production.percent}
                    aria-valuetext={`${production.percent}%，${production.detail}`}
                  >
                    <span style={{ width: `${production.percent}%` }} />
                  </div>
                )}
                <div className="studio-progress-caption">
                  <span>{production?.detail}</span>
                  {isAdmin && <span>费用估算 ¥{project.cost.toFixed(3)}</span>}
                </div>
              </div>
              {active(project) && (
                <button disabled={busy} onClick={() => void action("cancel")}>
                  停止任务
                </button>
              )}
            </div>
            {project.error && (
              <p role="alert" className="studio-error">
                {project.error}{" "}
                <button disabled={locked} onClick={() => void action("remake")}>
                  {project.error.includes("Arrearage")
                    ? "账户恢复后重试"
                    : "重试"}
                </button>
              </p>
            )}
            <div className="studio-workspace">
              <section className="studio-preview">
                <h2>成片预览</h2>
                {exported || preview ? (
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
                      : "预览完成后在这里播放"}
                  </div>
                )}
                <div className="studio-actions">
                  <button
                    disabled={locked || optionsChanged || !project.plan.length}
                    onClick={() => void action("export")}
                  >
                    导出1080p MP4
                  </button>
                  {exported && (
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
              <section className="studio-script-panel">
                <div className="studio-section-heading">
                  <h2>制作选项</h2>
                  <span>{project.seconds}秒 · 自动剪辑</span>
                </div>
                <ProductionSettings
                  options={options}
                  setOptions={setOptions}
                  disabled={locked}
                />
                <button
                  className="studio-make-button"
                  disabled={locked || !configured}
                  onClick={() => void action("remake")}
                >
                  {active(project) ? "正在制作…" : "重新制作"}
                </button>
                {optionsChanged && (
                  <p className="studio-hint">
                    设置已更改，点击重新制作后生效。
                  </p>
                )}
                <div className="studio-section-heading">
                  <h2>视频稿</h2>
                  <button
                    className="quiet-button"
                    disabled={!captionText}
                    onClick={() => void copyCaptions()}
                  >
                    复制文案
                  </button>
                </div>
                <p className="studio-script-text">
                  {captionText ||
                    (active(project)
                      ? "正在结合画面与店铺信息撰写…"
                      : "点击重新制作，自动生成一份探店视频稿。")}
                </p>
                <small role="status">{copyStatus}</small>
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
                          alt="素材预览"
                        />
                      ) : (
                        <video
                          src={appUrl(`${prefix}/${project.id}/media/${a.id}`)}
                          controls
                          preload="none"
                        />
                      )
                    ) : null}
                    <div className="studio-asset-result">
                      <span
                        className={`studio-asset-status ${a.accepted === true ? "passed" : a.accepted === false || a.reason ? "rejected" : "pending"}`}
                      >
                        {a.accepted === true
                          ? "✓ 已通过"
                          : a.accepted === false || a.reason
                            ? "未通过"
                            : "待分析"}
                      </span>
                      {isAdmin && a.score != null && <span>{a.score}分</span>}
                    </div>
                    {isAdmin && (
                      <>
                        <p>{a.reason || a.title}</p>
                        <small>{a.author}</small>
                      </>
                    )}
                  </article>
                ))}
              </div>
            </details>
            <button
              className="quiet-button studio-new-version"
              disabled={locked}
              onClick={() => {
                setProject(null);

                const u = new URL(location.href);
                u.searchParams.delete("project");
                window.history.replaceState({}, "", u);
              }}
            >
              新建另一个版本
            </button>
          </>
        )}
      </div>
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

function ProductionSettings({
  options,
  setOptions,
  disabled,
}: {
  options: ProductionOptions;
  setOptions: (v: ProductionOptions) => void;
  disabled: boolean;
}) {
  return (
    <div className="studio-production-options">
      {(
        [
          ["subtitles", "画面字幕", "把视频稿配到画面上"],
          ["narration", "语音口播", "自然中文讲述"],
          ["music", "背景音乐", "自动匹配轻音乐"],
        ] as const
      ).map(([key, label, hint]) => (
        <label key={key}>
          <input
            type="checkbox"
            checked={options[key]}
            disabled={disabled}
            onChange={(e) =>
              setOptions({ ...options, [key]: e.target.checked })
            }
          />
          <span>
            <strong>{label}</strong>
            <small>{hint}</small>
          </span>
        </label>
      ))}
    </div>
  );
}
