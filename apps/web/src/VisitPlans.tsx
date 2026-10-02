import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { appFetch, appUrl } from "./app-url";
import { ShopLocation, searchPlaces, VisitMap } from "./ShopMap";
export type VisitStore = {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  brand_id: string | null;
  product_id: string | null;
};
export type VisitPlan = {
  id: string;
  name: string;
  date: string;
  stores: VisitStore[];
};
export async function visitRequest(
  path: string,
  method = "GET",
  body?: unknown,
) {
  const r = await appFetch(`/api/v3/${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error?.message || "操作失败");
  return d;
}
const today = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(
    new Date(),
  );
type Draft = Partial<VisitStore>;
export function StoreEditor({
  initial,
  onSave,
  onClose,
  children,
}: {
  children?: ReactNode;
  initial: Draft;
  onSave: (s: Draft) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial.name || ""),
    [address, setAddress] = useState(initial.address || ""),
    [point, setPoint] = useState<{ lat: number; lng: number } | null>(
      initial.lat !== undefined && initial.lng !== undefined
        ? { lat: initial.lat, lng: initial.lng }
        : null,
    ),
    [results, setResults] = useState<
      { name: string; address?: string; lat: number; lng: number }[]
    >([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function search() {
    setBusy(true);
    setError("");
    try {
      const items = await searchPlaces(name || address);
      setResults(items);
      if (!items.length)
        setError("没有找到准确位置，请缩放地图并点击店铺位置。");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return createPortal(
    <div className="visit-modal-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="店铺位置"
        className="visit-modal"
      >
        <div className="visit-title">
          <h2>{initial.id ? "编辑店铺" : "添加探店店铺"}</h2>
          <button onClick={onClose} disabled={busy} aria-label="关闭">
            ×
          </button>
        </div>
        {children}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!point) {
              setError("请先搜索位置或点击地图选点");
              return;
            }
            setBusy(true);
            setError("");
            try {
              await onSave({ ...initial, name, address, ...point });
            } catch (e) {
              setError(String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            店铺名称
            <input
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            详细地址
            <input
              required
              maxLength={300}
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setPoint(null);
              }}
              placeholder="上海市 · 区 · 街道门牌号"
            />
          </label>
          <div className="visit-actions">
            <button
              type="button"
              disabled={busy || (!name && !address)}
              onClick={() => void search()}
            >
              搜索地图位置
            </button>
            <span className="muted">选择搜索结果，或直接点击地图选点</span>
          </div>
          {results.map((r, i) => (
            <button
              className="place-result"
              type="button"
              key={`${r.lat}-${r.lng}-${i}`}
              onClick={() => {
                setPoint({ lat: r.lat, lng: r.lng });
                setName(r.name);
                if (r.address) setAddress(r.address);
                setResults([]);
              }}
            >
              {r.name} · {r.address}
            </button>
          ))}
          <VisitMap
            stores={point ? [{ name: name || "选定店铺", ...point }] : []}
            onPick={(lat, lng) => setPoint({ lat, lng })}
          />
          <p className="muted">
            {point
              ? `已选位置 · ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`
              : "尚未选定位置"}
          </p>
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={busy} className="visit-primary">
            {busy ? "处理中…" : "保存店铺"}
          </button>
        </form>
      </section>
    </div>,
    document.body,
  );
}
export function AddToVisitPlan({
  brandId,
  productId,
}: {
  brandId: string;
  productId: string;
}) {
  const [plans, setPlans] = useState<VisitPlan[] | null>(null),
    [selected, setSelected] = useState(""),
    [draft, setDraft] = useState<Draft | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [name, setName] = useState("我的探店计划"),
    [date, setDate] = useState(today()),
    [message, setMessage] = useState("");
  async function start() {
    setBusy(true);
    setError("");
    try {
      const [p, r] = await Promise.all([
        visitRequest("visit-plans"),
        appFetch(
          `/api/v3/coupons/${encodeURIComponent(productId)}/stores?brand_id=${encodeURIComponent(brandId)}`,
        ).then(async (r) => {
          if (!r.ok) throw Error("门店信息读取失败");
          return r.json();
        }),
      ]);
      setPlans(p.items);
      setSelected(p.items[0]?.id || "");
      setDraft({
        name: r.source_shop?.name || "",
        address: r.source_shop?.address || "",
        brand_id: brandId,
        product_id: productId,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="studio-entry"
        disabled={busy}
        onClick={() => void start()}
      >
        ＋ 加入探店计划
      </button>
      {message && <small role="status">{message}</small>}
      {error && <small role="alert">{error}</small>}
      {plans && draft && (
        <div className="visit-add-flow">
          <StoreEditor
            initial={draft}
            onClose={() => {
              setPlans(null);
              setDraft(null);
            }}
            onSave={async (s) => {
              if (!selected && (!name.trim() || !date))
                throw Error("请填写计划名称和日期");
              let id = selected;
              if (!id) {
                id = (await visitRequest("visit-plans", "POST", { name, date }))
                  .id;
                setSelected(id);
              }
              const result = await visitRequest(
                `visit-plans/${id}/stores`,
                "POST",
                s,
              );
              setMessage(
                result.duplicate ? "该店铺已在计划中" : "已加入探店计划",
              );
              setDraft(null);
              setPlans(null);
            }}
          >
            <div className="visit-plan-choice">
              <label>
                加入计划
                <select
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.date} · {p.name}
                    </option>
                  ))}
                  <option value="">新建计划</option>
                </select>
              </label>
              {!selected && (
                <>
                  <label>
                    计划名称
                    <input
                      value={name}
                      maxLength={80}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <label>
                    探店日期
                    <input
                      type="date"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                    />
                  </label>
                </>
              )}
            </div>
          </StoreEditor>
        </div>
      )}
    </>
  );
}
export function VisitPlans() {
  const [plans, setPlans] = useState<VisitPlan[]>([]),
    [selected, setSelected] = useState(
      new URLSearchParams(location.search).get("plan") || "",
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<Draft | null>(null),
    [form, setForm] = useState<{
      id?: string;
      name: string;
      date: string;
    } | null>(null);
  const current = plans.find((p) => p.id === selected) || plans[0];
  async function refresh() {
    const d = await visitRequest("visit-plans");
    setPlans(d.items);
  }
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, []);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="visit-workspace">
      <div className="visit-title">
        <div>
          <h1>我的探店计划</h1>
          <p>安排店铺与日期，按计划完成探店创作。</p>
        </div>
        <button
          className="visit-primary"
          onClick={() => setForm({ name: "我的探店计划", date: today() })}
        >
          ＋ 新建计划
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {form && (
        <form
          className="visit-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              const d = await visitRequest(
                form.id ? `visit-plans/${form.id}` : "visit-plans",
                form.id ? "PATCH" : "POST",
                { name: form.name, date: form.date },
              );
              if (d.id) setSelected(d.id);
              setForm(null);
            });
          }}
        >
          <label>
            计划名称
            <input
              required
              value={form.name}
              maxLength={80}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            日期
            <input
              required
              type="date"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
            />
          </label>
          <button disabled={busy}>保存计划</button>
          <button type="button" onClick={() => setForm(null)}>
            取消
          </button>
        </form>
      )}
      {!plans.length && !form && (
        <div className="visit-empty">
          还没有计划。新建计划，或从券上加入一家店铺。
        </div>
      )}
      {!!plans.length && (
        <div className="visit-layout">
          <aside className="visit-plan-list">
            {plans.map((p) => (
              <button
                key={p.id}
                aria-pressed={current?.id === p.id}
                onClick={() => setSelected(p.id)}
              >
                <strong>{p.name}</strong>
                <span>
                  {p.date} · {p.stores.length} 家店
                </span>
              </button>
            ))}
          </aside>
          {current && (
            <div className="visit-detail">
              <div className="visit-title">
                <div>
                  <h2>{current.name}</h2>
                  <span>
                    {current.date} · {current.stores.length} 家店铺
                  </span>
                </div>
                <div className="visit-actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      setForm({
                        id: current.id,
                        name: current.name,
                        date: current.date,
                      })
                    }
                  >
                    编辑计划
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (confirm("删除此计划？已有视频会保留。"))
                        void action(() =>
                          visitRequest(`visit-plans/${current.id}`, "DELETE"),
                        );
                    }}
                  >
                    删除
                  </button>
                  <button onClick={() => setEditing({})}>＋ 自定义店铺</button>
                </div>
              </div>
              <VisitMap stores={current.stores} />
              <div className="visit-stores">
                {current.stores.map((s, i) => (
                  <article className="visit-store" key={s.id}>
                    <span className="visit-number">{i + 1}</span>
                    <div>
                      <h3>{s.name}</h3>
                      <ShopLocation
                        name={s.name}
                        address={s.address}
                        lat={s.lat}
                        lng={s.lng}
                      />
                      <p>{s.address}</p>
                      <div className="visit-actions">
                        <button disabled={busy} onClick={() => setEditing(s)}>
                          编辑
                        </button>
                        {["上移", "下移"].map((label, n) => (
                          <button
                            key={label}
                            disabled={
                              busy ||
                              (n === 0
                                ? i === 0
                                : i === current.stores.length - 1)
                            }
                            onClick={() =>
                              void action(() => {
                                const ids = current.stores.map((s) => s.id),
                                  j = i + (n === 0 ? -1 : 1);
                                [ids[i], ids[j]] = [ids[j], ids[i]];
                                return visitRequest(
                                  `visit-plans/${current.id}/order`,
                                  "PUT",
                                  { ids },
                                );
                              })
                            }
                          >
                            {label}
                          </button>
                        ))}
                        <button
                          disabled={busy}
                          onClick={() => {
                            if (confirm("从计划中移除这家店？已有视频会保留。"))
                              void action(() =>
                                visitRequest(
                                  `visit-plans/${current.id}/stores/${s.id}`,
                                  "DELETE",
                                ),
                              );
                          }}
                        >
                          移除
                        </button>
                      </div>
                    </div>
                    <a
                      className="visit-primary"
                      target="_blank"
                      rel="noopener noreferrer"
                      href={appUrl(
                        `/?${new URLSearchParams({ studio: "1", visit_store_id: s.id, brand_id: s.brand_id || "", product_id: s.product_id || "" })}`,
                      )}
                    >
                      制作探店视频 →
                    </a>
                  </article>
                ))}
              </div>
              {!current.stores.length && (
                <p className="visit-empty">
                  从选券页加入店铺，也可以自定义店铺名称和位置。
                </p>
              )}
              {editing && (
                <StoreEditor
                  key={editing.id || "new"}
                  initial={editing}
                  onClose={() => setEditing(null)}
                  onSave={async (s) => {
                    await visitRequest(
                      `visit-plans/${current.id}/stores${s.id ? `/${s.id}` : ""}`,
                      s.id ? "PATCH" : "POST",
                      s,
                    );
                    setEditing(null);
                    await refresh();
                  }}
                />
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
