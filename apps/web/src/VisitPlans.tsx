import { type ReactNode, useEffect, useState } from "react";
import "./visit-editor.css";
import { createPortal } from "react-dom";
import { appFetch, appUrl } from "./app-url";
import { ShopLocation, searchStorePlaces, VisitMap } from "./ShopMap";
export type VisitStore = {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  brand_id: string | null;
  product_id: string | null;
  coupon_refs?: { brand_id: string; product_id: string }[];
};
export type VisitPlan = {
  id: string;
  name: string;
  date: string;
  stores: VisitStore[];
  completed_at?: string | null;
};
export async function visitRequest(
  path: string,
  method = "GET",
  body?: unknown,
) {
  const r = await appFetch(`/api/v3/${path}`, {
    method,
    ...(body === undefined && ["GET", "HEAD"].includes(method)
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
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
      {
        name: string;
        address?: string;
        lat: number;
        lng: number;
        approximate?: boolean;
      }[]
    >([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function search() {
    setBusy(true);
    setError("");
    try {
      const items = await searchStorePlaces(name, address);
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
        className="visit-modal visit-store-editor"
      >
        <div className="visit-title">
          <h2>{initial.id ? "编辑店铺" : "添加探店店铺"}</h2>
          <button onClick={onClose} disabled={busy} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="visit-editor-body">
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
            <div className="visit-editor-actions">
              <button
                type="button"
                disabled={busy || (!name && !address)}
                onClick={() => void search()}
              >
                搜索地图位置
              </button>
              <button
                type="submit"
                disabled={busy || !point || !name.trim() || !address.trim()}
                className="visit-primary"
              >
                保存店铺
              </button>
            </div>
            <p
              className={`visit-location-status${point ? " is-selected" : ""}`}
              aria-live="polite"
            >
              {point
                ? "✓ 已选定位置，确认店铺名称和地址后即可保存。"
                : "先搜索并选择下方结果，或点击地图选点，再保存店铺。"}
            </p>
            {results.map((r, i) => (
              <button
                className="place-result"
                type="button"
                key={`${r.lat}-${r.lng}-${i}`}
                onClick={() => {
                  setPoint({ lat: r.lat, lng: r.lng });
                  if (!r.approximate) {
                    // 地图命中可能是店铺所在商场，不能覆盖用户确认的店名。
                    if (!name.trim()) setName(r.name);
                    if (!address.trim() && r.address) setAddress(r.address);
                  }

                  setResults([]);
                }}
              >
                {r.name} · {r.address}
                {r.approximate ? "（候选位置，请核对后选择）" : ""}
              </button>
            ))}
            <VisitMap
              stores={point ? [{ name: name || "选定店铺", ...point }] : []}
              onPick={(lat, lng) => setPoint({ lat, lng })}
            />
            {error && <p role="alert">{error}</p>}
          </form>
        </div>
      </section>
    </div>,
    document.body,
  );
}
export function AddToVisitPlan({
  brandId,
  productId,
  existingPlan,
  onAdded,
}: {
  brandId: string;
  productId: string;
  existingPlan?: { id: string; name: string };
  onAdded: (plan: { id: string; name: string }) => void;
}) {
  const [plans, setPlans] = useState<VisitPlan[] | null>(null),
    [selected, setSelected] = useState(""),
    [draft, setDraft] = useState<Draft | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [name, setName] = useState("我的探店计划"),
    [date, setDate] = useState(today()),
    [success, setSuccess] = useState<{ id: string; name: string } | null>(null);
  async function start() {
    setBusy(true);
    setError("");
    try {
      const [p, r] = await Promise.all([
        visitRequest("visit-plans?active=true"),
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
      {existingPlan ? (
        <a
          className="studio-entry"
          href={appUrl(`/?tab=workspace&section=plans&plan=${existingPlan.id}`)}
        >
          前去查看计划 →
        </a>
      ) : (
        <button
          className="studio-entry"
          disabled={busy}
          onClick={() => void start()}
        >
          ＋ 加入探店计划
        </button>
      )}
      {success &&
        createPortal(
          <div
            className="visit-modal-backdrop"
            onKeyDown={(e) => {
              if (e.key === "Escape") setSuccess(null);
            }}
          >
            <section
              role="dialog"
              aria-modal="true"
              aria-labelledby="visit-added-title"
              className="visit-modal visit-success-modal"
            >
              <div className="visit-success-icon" aria-hidden="true">
                ✓
              </div>
              <h2 id="visit-added-title">加入计划成功</h2>
              <p>店铺已加入「{success.name}」，是否前去查看？</p>
              <div className="visit-success-actions">
                <button onClick={() => setSuccess(null)} autoFocus>
                  继续选券
                </button>
                <a
                  href={appUrl(
                    `/?tab=workspace&section=plans&plan=${success.id}`,
                  )}
                >
                  前去查看计划 →
                </a>
              </div>
            </section>
          </div>,
          document.body,
        )}
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
              await visitRequest(`visit-plans/${id}/stores`, "POST", s);
              const destination = {
                id,
                name: plans.find((p) => p.id === id)?.name || name,
              };
              onAdded(destination);
              setSuccess(destination);
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
  const [completing, setCompleting] = useState<string | null>(null);
  const [removal, setRemoval] = useState<{
    planId: string;
    storeId?: string;
    name: string;
  } | null>(null);
  const [removalError, setRemovalError] = useState("");
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
      window.dispatchEvent(new Event("visit-plans-changed"));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="visit-workspace">
      {removal &&
        createPortal(
          <div
            className="visit-modal-backdrop"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !busy) setRemoval(null);
            }}
          >
            <section
              className="visit-modal visit-success-modal"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="visit-removal-title"
              aria-describedby="visit-removal-description"
            >
              <h2 id="visit-removal-title">
                {removal.storeId ? "移除店铺" : "删除计划"}
              </h2>
              <p id="visit-removal-description">
                确定{removal.storeId ? "从计划中移除" : "删除"}「{removal.name}
                」？已有视频会保留。
              </p>
              {removalError && <p role="alert">{removalError}</p>}
              <div className="visit-success-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setRemoval(null)}
                  autoFocus
                >
                  取消
                </button>
                <button
                  type="button"
                  className="visit-confirm-remove"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setRemovalError("");
                    try {
                      await visitRequest(
                        `visit-plans/${removal.planId}${removal.storeId ? `/stores/${removal.storeId}` : ""}`,
                        "DELETE",
                      );
                      setPlans((previous) =>
                        removal.storeId
                          ? previous.map((p) =>
                              p.id === removal.planId
                                ? {
                                    ...p,
                                    stores: p.stores.filter(
                                      (store) => store.id !== removal.storeId,
                                    ),
                                  }
                                : p,
                            )
                          : previous.filter((p) => p.id !== removal.planId),
                      );
                      setRemoval(null);
                    } catch (e) {
                      setRemovalError(
                        e instanceof Error ? e.message : "移除失败，请重试",
                      );
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "处理中…" : removal.storeId ? "确认移除" : "确认删除"}
                </button>
              </div>
            </section>
          </div>,
          document.body,
        )}
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
                <strong>
                  {p.name}
                  {p.completed_at && (
                    <small className="visit-complete-badge">已完结</small>
                  )}
                </strong>
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
                  <h2>
                    {current.name}
                    {current.completed_at && (
                      <small className="visit-complete-badge">已完结</small>
                    )}
                  </h2>
                  <span>
                    {current.date} · {current.stores.length} 家店铺
                  </span>
                </div>
                <div className="visit-actions">
                  {!current.completed_at && (
                    <button
                      disabled={busy}
                      onClick={() => setCompleting(current.id)}
                    >
                      完结计划
                    </button>
                  )}
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
                      setRemovalError("");
                      setRemoval({ planId: current.id, name: current.name });
                    }}
                  >
                    删除
                  </button>
                  {!current.completed_at && (
                    <button onClick={() => setEditing({})}>
                      ＋ 自定义店铺
                    </button>
                  )}
                </div>
              </div>
              {completing === current.id && !current.completed_at && (
                <div className="visit-complete-confirm">
                  <div>
                    <strong>确认完结这个计划？</strong>
                    <p>
                      历史店铺和视频会保留，关联券恢复“加入探店计划”，可以再次探店。
                    </p>
                  </div>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await visitRequest(
                          `visit-plans/${current.id}/complete`,
                          "POST",
                          {},
                        );
                        setCompleting(null);
                      })
                    }
                  >
                    确认完结
                  </button>
                  <button disabled={busy} onClick={() => setCompleting(null)}>
                    取消
                  </button>
                </div>
              )}
              {current.completed_at && (
                <p className="visit-complete-note">
                  计划已完结，历史店铺与视频已保留。相关店铺可再次加入新计划。
                </p>
              )}
              <VisitMap stores={current.stores} />
              <div className="visit-stores">
                {current.stores.map((s, i) => (
                  <article className="visit-store" key={s.id}>
                    <span className="visit-number">{i + 1}</span>
                    <div>
                      <h3>
                        <ShopLocation
                          name={s.name}
                          address={s.address}
                          lat={s.lat}
                          lng={s.lng}
                        />
                      </h3>
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
                            setRemovalError("");
                            setRemoval({
                              planId: current.id,
                              storeId: s.id,
                              name: s.name,
                            });
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
