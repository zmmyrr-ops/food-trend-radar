import {
  type Brand,
  brandInput,
  type Channel,
  categories,
  type DataSource,
  eventInput,
  type FoodEvent,
  type ImportPreview,
  type ImportResult,
  inChannel,
  type ResearchEvidence,
} from "@radar/contracts";
import {
  type FormEvent,
  StrictMode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { AccountGate, useAccount } from "./AccountGate";
import { Admission } from "./Admission";
import { appFetch, appUrl } from "./app-url";
import { BrandIcon } from "./BrandIcon";
import { BrandSubscriptions } from "./BrandSubscriptions";
import { CouponRadar } from "./CouponRadar";
import { MyWorkspace } from "./MyWorkspace";
import { ShopReports } from "./ShopReports";
import { Sources } from "./Sources";
import { VideoStudio } from "./VideoStudio";

import "./style.css";
import "./design.css";
import "./studio.css";

async function api<T>(
  path: string,
  body?: unknown,
  method = "POST",
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await appFetch(
    `/v1${path}`,
    body === undefined
      ? undefined
      : {
          method,
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? "请求失败");
  return data;
}
const text = (form: HTMLFormElement, key: string) =>
  String(new FormData(form).get(key) ?? "");
const datetime = (v: string) => new Date(v).toISOString();
const localTime = (v: string) => {
  const date = new Date(v);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
const timestamp = (v: string) =>
  new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
function App() {
  const account = useAccount();
  const [channel, setChannel] = useState<Channel>(
    new URLSearchParams(location.search).get("channel") === "leisure"
      ? "leisure"
      : "food",
  );
  const channelLabel = channel === "food" ? "美食" : "游玩";
  function navigate(next: string, scope: Channel = channel) {
    setTab(next);
    setChannel(scope);
    setCategory("");
    setSearch("");
    setBrandEdit(null);
    setReviewBrand(null);
    setBrandEvidence(null);
    setError("");
    setNotice("");
    const u = new URL(location.href);
    u.searchParams.set("tab", next);
    u.searchParams.set("channel", scope);
    window.history.replaceState({}, "", u);
  }
  const [brandEvidence, setBrandEvidence] = useState<{
    name: string;
    items: { evidence: ResearchEvidence }[];
  } | null>(null);
  const [sources, setSources] = useState<DataSource[]>([]);
  const [reviewBrand, setReviewBrand] = useState<Brand | null>(null);
  const [tab, setTab] = useState(() => {
      const requested =
        new URLSearchParams(location.search).get("tab") || "radar";
      const value = ["videos", "plans"].includes(requested)
        ? "workspace"
        : requested;
      return [
        "radar",
        "workspace",
        "reports",
        "brands",
        "events",
        "import",
        "sources",
        "admission",
      ]
        .filter(
          (v) =>
            account.role === "admin" ||
            ["radar", "workspace", "reports"].includes(v),
        )
        .includes(value)
        ? value
        : "radar";
    }),
    [brands, setBrands] = useState<Brand[]>([]),
    [events, setEvents] = useState<FoodEvent[]>([]);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [brandEdit, setBrandEdit] = useState<Brand | null>(null),
    [eventEdit, setEventEdit] = useState<FoodEvent | null>(null),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState("");
  const [brandScope, setBrandScope] = useState("active");
  const [brandPage, setBrandPage] = useState(1);
  const [brandPageSize, setBrandPageSize] = useState(12);
  const [showBrandEditor, setShowBrandEditor] = useState(false);
  useEffect(() => {
    setBrandPage(1);
  }, [search, category, brandScope, channel, brandPageSize]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importHistory, setImportHistory] = useState<
    { id: string; result: ImportResult; created_at: string }[]
  >([]);
  const [csv, setCsv] = useState(""),
    [report, setReport] = useState<ImportResult | null>(null),
    [history, setHistory] = useState<string>("");
  const refresh = useCallback(async () => {
    const b = await api<{ items: Brand[] }>("/brands");
    setBrands(b.items);
    setLoaded(true);
    if (tab === "events" || tab === "import") {
      const [e, sources, imports] = await Promise.all([
        api<{ items: FoodEvent[] }>("/events"),
        api<{ items: DataSource[] }>("/sources"),
        api<{
          items: { id: string; result: ImportResult; created_at: string }[];
        }>("/imports"),
      ]);
      setEvents(e.items);
      setSources(sources.items);
      setImportHistory(imports.items);
    }
  }, [tab]);
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, [refresh]);
  async function action(fn: () => Promise<void>) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  async function submitBrand(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    await action(async () => {
      const value = brandInput.parse({
        name: text(form, "name"),
        category: text(form, "category"),
        aliases: text(form, "aliases")
          .split(/[,，]/)
          .map((x) => x.trim())
          .filter(Boolean),
        shanghai_evidence_url: text(form, "url"),
        active: text(form, "active") === "true",
        keywords: text(form, "keywords")
          .split(/[,，]/)
          .map((x) => x.trim())
          .filter(Boolean),
      });
      await api(
        brandEdit ? `/brands/${brandEdit.id}` : "/brands",
        value,
        brandEdit ? "PUT" : "POST",
      );
      setBrandEdit(null);
      form.reset();
      setNotice("品牌已保存，证据链接仍需运营核验。");
    });
  }
  async function submitEvent(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    await action(async () => {
      const price = text(form, "price");
      const value = eventInput.parse({
        brand_id: text(form, "brand_id"),
        title: text(form, "title"),
        type: text(form, "type"),
        starts_at: datetime(text(form, "starts_at")),
        ends_at: datetime(text(form, "ends_at")),
        source_url: text(form, "source_url"),
        source_id: text(form, "source_id") || null,
        evidence_note: text(form, "note"),
        effective_price: price === "" ? null : Number(price),
        original_price:
          text(form, "original_price") === ""
            ? null
            : Number(text(form, "original_price")),
        promotion_terms: text(form, "promotion_terms"),
        collaboration: text(form, "collaboration"),
        store_scope: text(form, "store_scope"),
        applicable_stores: text(form, "applicable_stores")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        eligibility: text(form, "eligibility"),
        status: text(form, "status"),
      });
      await api(
        eventEdit ? `/events/${eventEdit.id}` : "/events",
        value,
        eventEdit ? "PUT" : "POST",
      );
      setEventEdit(null);
      form.reset();
      setNotice("事件已保存，未生成预测。");
    });
  }
  const shown = brands.filter(
    (b) =>
      (brandScope === "all" || b.active === (brandScope === "active")) &&
      inChannel(b.category, channel) &&
      (!category || b.category === category) &&
      [b.name, ...b.aliases]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const brandPages = Math.max(1, Math.ceil(shown.length / brandPageSize));
  const currentBrandPage = Math.min(brandPage, brandPages);
  const pageBrands = shown.slice(
    (currentBrandPage - 1) * brandPageSize,
    currentBrandPage * brandPageSize,
  );
  const template =
    "brand_id,title,type,starts_at,ends_at,source_url,evidence_note,effective_price,eligibility,status,source_id,original_price,promotion_terms,collaboration,store_scope,applicable_stores\n";
  function downloadErrors(errors: ImportResult["errors"]) {
    const escape = (v: string) =>
      '"' + (/^[=+@\-\t\r]/.test(v) ? "'" : "") + v.replaceAll('"', '""') + '"';
    const content =
      "记录序号,错误说明\r\n" +
      errors.map((e) => `${e.row},${escape(e.message)}`).join("\r\n");
    const url = URL.createObjectURL(
      new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "导入错误明细.csv";
    a.click();
    URL.revokeObjectURL(url);
  }
  function downloadTemplate() {
    const a = document.createElement("a");
    const url = URL.createObjectURL(
      new Blob(["\uFEFF" + template], { type: "text/csv;charset=utf-8" }),
    );
    a.href = url;
    a.download = "上海事件导入模板.csv";
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <main className={`app-shell channel-${channel}`}>
      <aside className="app-sidebar">
        <a className="app-logo" href={appUrl("/")}>
          <img
            className="logo-mark"
            src={appUrl("/branding/tanhaodian-icon.png")}
            alt="探好店"
          />
          <span>
            探好店<small>帮你探好每一家店</small>
          </span>
        </a>
        <div className="sidebar-label">探店达人的创作助手</div>
        <nav className="primary-nav" aria-label="主导航">
          <button
            aria-pressed={tab === "radar" && channel === "food"}
            onClick={() => navigate("radar", "food")}
          >
            <span>食</span>
            <div>
              美食发现<small>餐饮 · 茶咖 · 甜品</small>
            </div>
          </button>
          <button
            aria-pressed={tab === "radar" && channel === "leisure"}
            onClick={() => navigate("radar", "leisure")}
          >
            <span>游</span>
            <div>
              游玩灵感<small>亲子 · 乐园 · 城市体验</small>
            </div>
          </button>
          <button
            aria-pressed={tab === "workspace"}
            onClick={() => navigate("workspace")}
          >
            <span>我</span>
            <div>
              我的工作台<small>计划 · 视频 · 订阅</small>
            </div>
          </button>
          <button
            aria-pressed={tab === "brands"}
            className="admin-only"
            onClick={() => navigate("brands")}
          >
            <span>店</span>
            <div>
              品牌名录<small>分类查看与管理</small>
            </div>
          </button>
          <button
            aria-pressed={tab === "reports"}
            onClick={() => navigate("reports")}
          >
            <span>报</span>
            <div>
              店铺上报
              <small>
                {account.role === "admin"
                  ? "审核与补充收录"
                  : "告诉我们你想找的店"}
              </small>
            </div>
          </button>
        </nav>
        <details className="sidebar-tools admin-only">
          <summary>数据与设置</summary>
          {[
            ["events", "事件管理"],
            ["import", "数据导入"],
            ["sources", "数据源核验"],
            ["admission", "产品与准入"],
          ].map(([key, label]) => (
            <button
              key={key}
              aria-pressed={tab === key}
              onClick={() => navigate(key)}
            >
              {label}
            </button>
          ))}
        </details>
        <div className="sidebar-foot">
          <span className="location-dot" />
          上海限定<small>选好店 · 拍好片</small>
        </div>
      </aside>
      <div className="app-content">
        <header className="app-topbar">
          <span>
            探好店 /{" "}
            {tab === "radar"
              ? `${channelLabel}发现`
              : tab === "reports"
                ? "店铺上报"
                : tab === "workspace"
                  ? "我的工作台"
                  : "数据工作台"}
          </span>
          {tab !== "workspace" && (
            <div className="channel-switch" aria-label="切换业务频道">
              {(["food", "leisure"] as const).map((c) => (
                <button
                  key={c}
                  aria-pressed={channel === c}
                  onClick={() => navigate(tab, c)}
                >
                  {c === "food" ? "美食" : "游玩"}
                </button>
              ))}
            </div>
          )}
          <small>
            上海 ·{" "}
            {new Date().toLocaleDateString("zh-CN", {
              month: "long",
              day: "numeric",
              weekday: "long",
            })}
          </small>
        </header>
        {tab !== "radar" && tab !== "workspace" && tab !== "reports" && (
          <section className="page-heading">
            <div>
              <p className="eyebrow">
                {channel === "food" ? "FOOD & FLAVOUR" : "PLAY & EXPLORE"} /
                SHANGHAI
              </p>
              <h1>
                {tab === "radar"
                  ? channel === "food"
                    ? "下一站，去吃点好的。"
                    : "把周末，交给新鲜感。"
                  : tab === "videos"
                    ? "灵感，已经成为作品。"
                    : tab === "brands"
                      ? `${channelLabel}品牌名录`
                      : "把数据整理得井井有条。"}
              </h1>
              <p>
                {tab === "radar"
                  ? channel === "food"
                    ? "从一张好券开始，发现值得探的餐厅与正在升温的美味。"
                    : "发现亲子乐园、城市展馆与户外体验，让下一条内容有新去处。"
                  : `当前查看${channelLabel}频道，随时切换另一种灵感。`}
              </p>
            </div>
            <div className="heading-index">
              <span>{channelLabel}频道</span>
              <strong>
                {loaded
                  ? brands.filter(
                      (b) => b.active && inChannel(b.category, channel),
                    ).length
                  : "—"}
              </strong>
              <small>启用品牌 / 上海</small>
            </div>
          </section>
        )}
        {error && (
          <div role="alert" className="message error">
            {error}
            <button
              type="button"
              disabled={busy}
              onClick={() => action(refresh)}
            >
              重新连接
            </button>
          </div>
        )}
        {notice && (
          <p role="status" className="message">
            {notice}
          </p>
        )}
        {!loaded && !error && <p role="status">正在加载工作台…</p>}
        {tab === "radar" && (
          <>
            <BrandSubscriptions mode="messages" />
            <CouponRadar key={channel} channel={channel} />
          </>
        )}
        {tab === "workspace" && <MyWorkspace brands={brands} />}
        {tab === "reports" && <ShopReports />}
        {tab === "brands" && (
          <div
            className={`brand-workspace ${showBrandEditor ? "with-editor" : ""}`}
          >
            {showBrandEditor && (
              <section className="panel brand-editor">
                <h2>{brandEdit ? "编辑品牌" : "新增品牌"}</h2>
                <form key={brandEdit?.id ?? "new"} onSubmit={submitBrand}>
                  <label>
                    品牌名称
                    <input
                      name="name"
                      required
                      maxLength={80}
                      defaultValue={brandEdit?.name}
                    />
                  </label>
                  <label>
                    品类
                    <select
                      name="category"
                      defaultValue={
                        brandEdit?.category ??
                        categories.find((c) => inChannel(c, channel))
                      }
                    >
                      {categories
                        .filter((c) => inChannel(c, channel))
                        .map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                    </select>
                  </label>
                  <label>
                    别名（逗号分隔）
                    <input
                      name="aliases"
                      defaultValue={brandEdit?.aliases.join("，")}
                    />
                  </label>
                  <label>
                    监测关键词（逗号分隔）
                    <input
                      name="keywords"
                      defaultValue={brandEdit?.keywords.join("，")}
                      placeholder="品牌名、新品名；最多30项"
                    />
                  </label>
                  <label>
                    上海经营或购买证据链接
                    <input
                      type="url"
                      name="url"
                      required
                      defaultValue={brandEdit?.shanghai_evidence_url}
                      placeholder="https://…"
                    />
                  </label>
                  <label>
                    监测状态
                    <select
                      name="active"
                      defaultValue={String(brandEdit?.active ?? true)}
                    >
                      <option value="true">启用</option>
                      <option value="false">停用</option>
                    </select>
                  </label>
                  <button disabled={busy} type="submit">
                    {busy ? "保存中…" : "保存品牌"}
                  </button>
                  {brandEdit && (
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => setBrandEdit(null)}
                    >
                      取消编辑
                    </button>
                  )}
                </form>
              </section>
            )}
            <section className="panel brand-directory">
              {reviewBrand && (
                <form
                  key={reviewBrand.id}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const form = e.currentTarget;
                    action(async () => {
                      await api(`/brands/${reviewBrand.id}/review`, {
                        revision: reviewBrand.revision,
                        decision: text(form, "decision"),
                        reviewer: text(form, "reviewer"),
                        note: text(form, "note"),
                      });
                      setReviewBrand(null);
                      setNotice(
                        "核验结果已记录；后续编辑品牌将重新进入待核验。",
                      );
                    });
                  }}
                >
                  <h3>核验：{reviewBrand.name}</h3>
                  <p>
                    请检查上海经营证据、独立品牌身份及关键词。核验人由本地操作人填写。
                  </p>
                  <a
                    href={reviewBrand.shanghai_evidence_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    打开上海经营证据 ↗
                  </a>
                  <label>
                    核验人
                    <input name="reviewer" required maxLength={80} />
                  </label>
                  <label>
                    核验结论与上海适用依据
                    <textarea name="note" required maxLength={2000} />
                  </label>
                  <label>
                    结论
                    <select name="decision">
                      <option value="verified">通过</option>
                      <option value="rejected">未通过</option>
                    </select>
                  </label>
                  <button disabled={busy} type="submit">
                    记录核验结果
                  </button>
                  <button type="button" onClick={() => setReviewBrand(null)}>
                    取消
                  </button>
                </form>
              )}
              {history && (
                <details>
                  <summary>历史记录</summary>
                  <pre>{history}</pre>
                </details>
              )}
              {brandEvidence && (
                <div className="message">
                  <h3>{brandEvidence.name} · 公开资料证据</h3>
                  {!brandEvidence.items.length && <p>尚未收集详细证据。</p>}
                  {brandEvidence.items.map(({ evidence: e }, i) => (
                    <article className="record" key={e.url + i}>
                      <p>
                        {e.source_title} · {e.source_name}
                      </p>
                      <p>
                        {e.location} {e.position}
                      </p>
                      <p>
                        {
                          {
                            directory_checked: "已核对官网目录",
                            historical_evidence_only: "仅历史资料，待复核",
                            conflicting_directory: "目录信息冲突，待复核",
                          }[e.research_status]
                        }
                      </p>
                      <p>
                        资料日期：{e.published_at ?? "来源未注明"}；采集：
                        {timestamp(e.observed_at)}
                      </p>
                      <p>{e.note}</p>
                      <a href={e.url} target="_blank" rel="noreferrer">
                        打开原始来源 ↗
                      </a>
                    </article>
                  ))}
                  <button type="button" onClick={() => setBrandEvidence(null)}>
                    收起证据
                  </button>
                </div>
              )}
              <div className="section-title">
                <h2>上海品牌库</h2>
                <span>
                  {shown.length} 个品牌 ·{" "}
                  {shown.filter((b) => b.icon_url).length} 个头像
                </span>
                <button
                  onClick={() => {
                    setBrandEdit(null);
                    setShowBrandEditor(!showBrandEditor);
                  }}
                >
                  {showBrandEditor ? "收起编辑" : "+ 新增品牌"}
                </button>
              </div>
              <div className="filters">
                <input
                  aria-label="搜索品牌"
                  placeholder="搜索品牌或别名"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <select
                  aria-label="按品类筛选"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  <option value="">全部品类</option>
                  {categories
                    .filter((c) => inChannel(c, channel))
                    .map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                </select>
                <select
                  aria-label="品牌启用范围"
                  value={brandScope}
                  onChange={(e) => setBrandScope(e.target.value)}
                >
                  <option value="active">当前采集品牌</option>
                  <option value="inactive">已停用历史记录</option>
                  <option value="all">全部记录</option>
                </select>
              </div>
              {!shown.length ? (
                <p className="empty">
                  尚无匹配品牌。添加第一条有来源的品牌记录。
                </p>
              ) : (
                <div className="brand-directory-grid">
                  {pageBrands.map((b) => (
                    <article className="brand-record" key={b.id}>
                      <div className="brand-record-heading">
                        <BrandIcon name={b.name} url={b.icon_url} />
                        <div>
                          <h3>{b.name}</h3>
                          <small>
                            {b.category} · {b.active ? "启用" : "已停用"}
                          </small>
                        </div>
                      </div>
                      <p className="brand-alias" title={b.aliases.join("、")}>
                        {b.aliases.join(" · ") || "—"}
                      </p>
                      <div className="brand-record-actions">
                        <button
                          className="secondary"
                          onClick={() => {
                            setBrandEdit(b);
                            setShowBrandEditor(true);
                          }}
                        >
                          编辑品牌
                        </button>
                      </div>
                      <details className="brand-record-details">
                        <summary>资料与管理</summary>
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            action(async () =>
                              setBrandEvidence({
                                name: b.name,
                                items: (
                                  await api<{
                                    items: { evidence: ResearchEvidence }[];
                                  }>(`/brands/${b.id}/evidence`)
                                ).items,
                              }),
                            )
                          }
                        >
                          查看采集证据
                        </button>
                        <p>别名：{b.aliases.join("、") || "—"}</p>
                        <p>关键词：{b.keywords.join("、") || "未配置"}</p>
                        <p>
                          核验：
                          {
                            {
                              pending: "待核验",
                              verified: "已资料核验",
                              rejected: "未通过",
                            }[b.review_status]
                          }{" "}
                          · 版本 {b.revision}
                        </p>
                        {b.review_note && (
                          <p>
                            {b.reviewed_by}：{b.review_note}
                          </p>
                        )}
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setReviewBrand(b)}
                        >
                          核验上海经营证据
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() =>
                            action(async () =>
                              setHistory(
                                JSON.stringify(
                                  (
                                    await api<{ items: unknown[] }>(
                                      `/brands/${b.id}/history`,
                                    )
                                  ).items,
                                  null,
                                  2,
                                ),
                              ),
                            )
                          }
                        >
                          品牌更正历史
                        </button>
                        <a
                          target="_blank"
                          rel="noreferrer"
                          href={b.shanghai_evidence_url}
                        >
                          查看上海证据 ↗
                        </a>
                        <details>
                          <summary>导入使用的品牌ID</summary>
                          <code>{b.id}</code>
                        </details>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => {
                            setBrandEdit(b);
                            setShowBrandEditor(true);
                          }}
                        >
                          编辑品牌
                        </button>
                      </details>
                    </article>
                  ))}
                </div>
              )}
              <nav className="brand-pagination" aria-label="品牌名录分页">
                <span>
                  共 {shown.length} 个 · 第 {currentBrandPage} / {brandPages} 页
                </span>
                <label>
                  每页
                  <select
                    aria-label="每页品牌数"
                    value={brandPageSize}
                    onChange={(e) => setBrandPageSize(Number(e.target.value))}
                  >
                    {[12, 24, 48].map((n) => (
                      <option value={n} key={n}>
                        {n} 个
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  disabled={currentBrandPage === 1}
                  onClick={() => setBrandPage(1)}
                >
                  首页
                </button>
                <button
                  disabled={currentBrandPage === 1}
                  onClick={() => setBrandPage(currentBrandPage - 1)}
                >
                  上一页
                </button>
                <button
                  disabled={currentBrandPage === brandPages}
                  onClick={() => setBrandPage(currentBrandPage + 1)}
                >
                  下一页
                </button>
                <button
                  disabled={currentBrandPage === brandPages}
                  onClick={() => setBrandPage(brandPages)}
                >
                  末页
                </button>
              </nav>
            </section>
          </div>
        )}
        {tab === "events" && (
          <div className="workspace">
            <section className="panel">
              <h2>{eventEdit ? "编辑事件" : "新增事件"}</h2>
              <form key={eventEdit?.id ?? "new"} onSubmit={submitEvent}>
                <label>
                  所属品牌
                  <select
                    name="brand_id"
                    required
                    defaultValue={eventEdit?.brand_id ?? ""}
                  >
                    <option value="" disabled>
                      请选择已建档品牌
                    </option>
                    {brands.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                        {!b.active ? "（停用）" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  事件名称
                  <input
                    name="title"
                    required
                    maxLength={160}
                    defaultValue={eventEdit?.title}
                  />
                </label>
                <label>
                  事件类型
                  <select name="type" defaultValue={eventEdit?.type ?? "新品"}>
                    {["新品", "联名", "优惠", "开店", "节日限定"].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label>
                  开始时间（本机时区）
                  <input
                    type="datetime-local"
                    name="starts_at"
                    required
                    defaultValue={
                      eventEdit ? localTime(eventEdit.starts_at) : ""
                    }
                  />
                </label>
                <label>
                  结束时间（本机时区）
                  <input
                    type="datetime-local"
                    name="ends_at"
                    required
                    defaultValue={eventEdit ? localTime(eventEdit.ends_at) : ""}
                  />
                </label>
                <label>
                  登记数据源（可暂不关联）
                  <select
                    name="source_id"
                    defaultValue={eventEdit?.source_id ?? ""}
                  >
                    <option value="">未关联来源</option>
                    {sources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ·{" "}
                        {s.geography === "national" ? "全国" : "上海"}
                        {!s.gate.eligible ? "（许可待处理）" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  公开证据链接
                  <input
                    type="url"
                    name="source_url"
                    required
                    defaultValue={eventEdit?.source_url}
                  />
                </label>
                <label>
                  证据摘要与优惠限制
                  <textarea
                    name="note"
                    required
                    maxLength={2000}
                    defaultValue={eventEdit?.evidence_note}
                  />
                </label>
                <label>
                  普遍可得价格（元，未知留空）
                  <input
                    type="number"
                    name="price"
                    step="0.01"
                    min="0"
                    max="100000"
                    defaultValue={eventEdit?.effective_price ?? ""}
                  />
                </label>
                <p className="hint">
                  价格单位为人民币。普遍可得价格不填写仅限新客、抽奖或极少量名额的最低宣传价；不清楚时留空，免费活动填0。
                </p>
                <label>
                  原价（元，须有证据，未知留空）
                  <input
                    type="number"
                    name="original_price"
                    step="0.01"
                    min="0"
                    max="100000"
                    defaultValue={eventEdit?.original_price ?? ""}
                  />
                </label>
                <label>
                  优惠门槛与参与限制
                  <textarea
                    name="promotion_terms"
                    maxLength={2000}
                    placeholder="例如：会员可用、满30减10、每人限1次；未知可留空"
                    defaultValue={eventEdit?.promotion_terms ?? ""}
                  />
                </label>
                <label>
                  联名对象
                  <input
                    name="collaboration"
                    maxLength={200}
                    placeholder="品牌、IP或人物；非联名可留空"
                    defaultValue={eventEdit?.collaboration ?? ""}
                  />
                </label>
                <label>
                  适用门店范围
                  <select
                    name="store_scope"
                    defaultValue={eventEdit?.store_scope ?? "unknown"}
                  >
                    <option value="unknown">待核验</option>
                    <option value="all_shanghai">
                      上海全部门店（须有证据）
                    </option>
                    <option value="selected">指定上海门店</option>
                  </select>
                </label>
                <label>
                  指定上海门店（每行一家，建议写明店名与地址）
                  <textarea
                    name="applicable_stores"
                    defaultValue={
                      eventEdit?.applicable_stores?.join("\n") ?? ""
                    }
                    placeholder="选择指定门店时必填；其他范围请留空"
                  />
                </label>
                <label>
                  上海参与情况
                  <select
                    name="eligibility"
                    defaultValue={eventEdit?.eligibility ?? "unknown"}
                  >
                    <option value="unknown">待确认</option>
                    <option value="available">可以参与</option>
                    <option value="unavailable">不可参与</option>
                  </select>
                </label>
                <label>
                  证据核验状态
                  <select
                    name="status"
                    defaultValue={eventEdit?.status ?? "pending"}
                  >
                    <option value="pending">待核验</option>
                    <option value="verified">已资料核验</option>
                    <option value="cancelled">已取消</option>
                  </select>
                </label>
                <button type="submit" disabled={busy || !brands.length}>
                  保存事件
                </button>
                {eventEdit && (
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => setEventEdit(null)}
                  >
                    取消编辑
                  </button>
                )}
              </form>
            </section>
            <section className="panel">
              <h2>活动与证据</h2>
              {!events.length ? (
                <p className="empty">先建立品牌，再录入新品、联名或优惠。</p>
              ) : (
                events.map((e) => (
                  <article className="record" key={e.id}>
                    <small>
                      {e.brand_name} · {e.type}
                    </small>
                    <h3>{e.title}</h3>
                    <p>
                      {timestamp(e.starts_at)} 至 {timestamp(e.ends_at)}
                    </p>
                    <p>{e.evidence_note}</p>
                    <p>
                      登记来源：
                      {sources.find((s) => s.id === e.source_id)?.name ??
                        "未关联"}
                      ；关联仅用于追溯，不代表通过数据准入。
                    </p>
                    <p>
                      上海：
                      {
                        {
                          unknown: "待确认",
                          available: "可参与",
                          unavailable: "不可参与",
                        }[e.eligibility]
                      }{" "}
                      ·{" "}
                      {
                        {
                          pending: "待核验",
                          verified: "已资料核验",
                          cancelled: "已取消",
                        }[e.status]
                      }
                      {Date.parse(e.ends_at) < Date.now() ? " · 已过期" : ""}
                    </p>
                    <p>
                      普遍可得价格：
                      {e.effective_price === null
                        ? "待核验"
                        : `${e.effective_price}元`}
                    </p>
                    <p>
                      原价：
                      {e.original_price == null
                        ? "待核验"
                        : `${e.original_price}元`}
                    </p>
                    <p>优惠门槛：{e.promotion_terms || "未提供，待核验"}</p>
                    <p>联名对象：{e.collaboration || "未提供"}</p>
                    <p>
                      适用门店：
                      {
                        {
                          unknown: "待核验",
                          all_shanghai: "上海全部门店（按录入证据）",
                          selected: "指定上海门店",
                        }[e.store_scope ?? "unknown"]
                      }
                    </p>
                    {!!e.applicable_stores?.length && (
                      <ul>
                        {e.applicable_stores.map((store) => (
                          <li key={store}>{store}</li>
                        ))}
                      </ul>
                    )}
                    <a href={e.source_url} target="_blank" rel="noreferrer">
                      查看原始证据 ↗
                    </a>
                    <div className="buttons">
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setEventEdit(e)}
                      >
                        编辑事件
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          action(async () => {
                            const h = await api<{ items: unknown[] }>(
                              `/events/${e.id}/history`,
                            );
                            setHistory(JSON.stringify(h.items, null, 2));
                          })
                        }
                      >
                        更正历史
                      </button>
                    </div>
                  </article>
                ))
              )}
              {history && (
                <details open>
                  <summary>更正前的记录</summary>
                  <pre>{history}</pre>
                </details>
              )}
            </section>
          </div>
        )}
        {tab === "import" && (
          <section className="panel">
            <h2>批量导入事件</h2>
            <details>
              <summary>CSV字段说明</summary>
              <p>
                必需：brand_id（品牌ID）、title（名称）、type（新品/联名/优惠/开店/节日限定）、starts_at和ends_at（带时区时间，结束晚于开始）、source_url（HTTP或HTTPS链接）、evidence_note（证据摘要）。
              </p>
              <p>
                可选：effective_price（0至100000元，空表示未知）、eligibility（unknown/available/unavailable）、status（pending/verified/cancelled）、source_id（登记来源ID，空表示未关联）。省略eligibility或status列时分别使用unknown、pending；保留列时须填有效值。
              </p>
              <p>
                最多500条、500KB。包含逗号或换行的单元格用双引号包裹，内部双引号写成两个双引号。重复、未知或缺失必需表头会被拒绝。数据仅针对上海；不要将全国活动直接认定为上海可参与。
              </p>
            </details>
            <p>
              先在品牌库建立品牌并取得ID。每次最多500行，时间须带时区，例如2026-09-20T08:00:00+08:00。错误行不入库；重复事件跳过。
            </p>
            <p>
              可选扩展列：original_price为原价，effective_price为普遍可得价格（均为元，最多两位小数，留空表示未知）；promotion_terms为优惠门槛；collaboration为联名对象；store_scope填unknown、all_shanghai或selected；applicable_stores以竖线
              | 分隔门店，仅selected时填写。老模板仍可导入。
            </p>
            <button
              className="secondary"
              type="button"
              onClick={downloadTemplate}
            >
              下载CSV表头模板
            </button>
            <label>
              选择CSV文件
              <input
                type="file"
                disabled={busy}
                accept=".csv,text/csv"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (file.size > 500000) {
                    setError("文件超过500KB");
                    return;
                  }
                  setCsv(await file.text());
                  setPreview(null);
                  setReport(null);
                }}
              />
            </label>
            <label>
              CSV内容
              <textarea
                className="csv"
                value={csv}
                disabled={busy}
                onChange={(e) => {
                  setCsv(e.target.value);
                  setPreview(null);
                  setReport(null);
                }}
                placeholder={template}
              />
            </label>
            <button
              type="button"
              disabled={busy || !csv.trim()}
              onClick={() =>
                action(async () => {
                  setPreview(null);
                  setReport(null);
                  setPreview(
                    await api<ImportPreview>("/imports/preview", { csv }),
                  );
                  setNotice("预校验完成，尚未写入事件；正式导入时会重新校验。");
                })
              }
            >
              预校验（不入库）
            </button>
            {preview && (
              <div className="message">
                <p>
                  预计新增{preview.valid}条，重复{preview.duplicates}条，错误
                  {preview.errors.length}条。
                </p>
                {preview.errors.length > 0 && (
                  <button
                    type="button"
                    onClick={() => downloadErrors(preview.errors)}
                  >
                    下载预校验错误明细
                  </button>
                )}
                <p>
                  仅导入有效记录。序号含表头，按CSV记录计数；单元格换行不额外计数。
                </p>
              </div>
            )}
            <button
              type="button"
              disabled={busy || !preview || preview.valid === 0}
              onClick={() =>
                action(async () => {
                  const bytes = await crypto.subtle.digest(
                    "SHA-256",
                    new TextEncoder().encode(csv),
                  );
                  const key = Array.from(new Uint8Array(bytes))
                    .map((x) => x.toString(16).padStart(2, "0"))
                    .join("");
                  setReport(
                    await api<ImportResult>("/imports", { csv }, "POST", {
                      "Idempotency-Key": key,
                    }),
                  );
                  setNotice("导入完成，同一文件重复提交返回原结果。");
                })
              }
            >
              导入有效记录
            </button>
            {report && (
              <div className="message" role="status">
                <p>
                  新增{report.created}条，重复{report.duplicates}条，错误
                  {report.errors.length}行。
                </p>
                {report.errors.length > 0 && (
                  <button
                    type="button"
                    onClick={() => downloadErrors(report.errors)}
                  >
                    下载导入错误明细
                  </button>
                )}
                {report.errors.map((e) => (
                  <p key={e.row}>
                    第{e.row}条记录：{e.message}
                  </p>
                ))}
              </div>
            )}
          </section>
        )}
        {tab === "import" && (
          <section className="panel">
            <h2>最近50次导入</h2>
            {!importHistory.length && <p>暂无导入记录。</p>}
            {importHistory.map((h) => (
              <article className="record" key={h.id}>
                <p>
                  {timestamp(h.created_at)} · 新增{h.result.created}条 / 重复
                  {h.result.duplicates}条 / 错误{h.result.errors.length}条
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    action(async () =>
                      setReport(
                        (
                          await api<{ result: ImportResult }>(
                            `/imports/${h.id}`,
                          )
                        ).result,
                      ),
                    )
                  }
                >
                  查看结果
                </button>
                {h.result.errors.length > 0 && (
                  <button
                    type="button"
                    onClick={() => downloadErrors(h.result.errors)}
                  >
                    下载错误明细
                  </button>
                )}
              </article>
            ))}
          </section>
        )}
        {tab === "sources" && <Sources />}
        {tab === "admission" && <Admission />}
        <footer>
          探好店 ·
          上海吃喝玩乐创作工作台。优先分用于选题参考，价格及使用条件以平台实时信息为准。
        </footer>
      </div>
    </main>
  );
}
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <AccountGate>
        {new URLSearchParams(location.search).get("studio") === "1" ? (
          <VideoStudio />
        ) : (
          <App />
        )}
      </AccountGate>
    </StrictMode>,
  );
