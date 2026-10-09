import { categories } from "@radar/contracts";
import { useEffect, useState } from "react";
import { useAccount } from "./AccountGate";
import { appFetch } from "./app-url";
import { visitRequest } from "./VisitPlans";

type Report = {
  id: string;
  name: string;
  address: string;
  category: string;
  url: string;
  note: string;
  status: string;
  brand_name?: string;
  review_note?: string;
  created_at: string;
  reward_points?: number;
};
const statuses: Record<string, string> = {
  pending: "待审核",
  approved: "已录入",
  rejected: "未采纳",
};
export function ShopReports() {
  const admin = useAccount().role === "admin";
  const [items, setItems] = useState<Report[]>([]),
    [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0),
    [status, setStatus] = useState("all"),
    [revision, setRevision] = useState(0);
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const [name, setName] = useState(""),
    [address, setAddress] = useState(""),
    [category, setCategory] = useState<string>("其他餐饮"),
    [url, setUrl] = useState(""),
    [note, setNote] = useState("");
  const [selected, setSelected] = useState<Report | null>(null);
  useEffect(() => {
    let live = true;
    void visitRequest(`shop-reports?offset=${offset}&status=${status}`)
      .then((d) => {
        if (live) {
          setItems(d.items);
          setTotal(d.total);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [offset, status, revision]);
  return (
    <section className="shop-reports">
      <div className="section-title">
        <div>
          <h1>{admin ? "店铺上报与审核" : "上报想找的店铺"}</h1>
          <p>没找到想要的店铺或券？告诉我们，审核后补充收录。</p>
          <p>
            <strong>收录奖励 · 20 积分</strong>
            ：上报缺失品牌，经审核通过并收录后自动到账，可在积分明细查看。
            同一用户、同一品牌仅奖励一次；待审核或未采纳不发放。本规则自上线起审核通过的记录生效。
          </p>
        </div>
      </div>
      <form
        className="report-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          setMessage("");
          try {
            const d = await visitRequest("shop-reports", "POST", {
              name,
              address,
              category,
              url,
              note,
            });
            setMessage(
              d.duplicate
                ? "这家店已在待审核列表中，请勿重复提交"
                : "上报成功，可在下方查看处理状态",
            );
            setName("");
            setAddress("");
            setUrl("");
            setNote("");
            setOffset(0);
            setStatus("all");
            setRevision((x) => x + 1);
          } catch (e) {
            setError(e instanceof Error ? e.message : "提交失败");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          店铺/品牌名称
          <input
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：湘辣辣（虹桥店）"
          />
        </label>
        <label>
          上海门店地址
          <input
            required
            maxLength={300}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="所在区、商场或详细地址"
          />
        </label>
        <label>
          分类
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          店铺或团购链接（选填）
          <input
            type="url"
            maxLength={2000}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
          />
        </label>
        <label className="report-wide">
          补充说明（选填）
          <textarea
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="想找什么券、门店别名等"
          />
        </label>
        <button className="visit-primary" disabled={busy}>
          {busy ? "提交中…" : "提交上报"}
        </button>
      </form>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="section-title">
        <h2>{admin ? "用户上报" : "我的上报"}</h2>
        <select
          aria-label="审核状态"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setOffset(0);
          }}
        >
          <option value="all">全部状态</option>
          {Object.entries(statuses).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      {!items.length && <p className="muted">暂无上报记录</p>}
      <div className="report-list">
        {items.map((r) => (
          <article key={r.id}>
            <div>
              <strong>{r.name}</strong>
              <span className={`report-status ${r.status}`}>
                {statuses[r.status]}
              </span>
            </div>
            <p>
              {r.address} · {r.category}
            </p>
            {r.note && <p>{r.note}</p>}
            {r.url && (
              <a href={r.url} target="_blank" rel="noopener noreferrer">
                查看提交链接 ↗
              </a>
            )}
            {!!r.reward_points && (
              <p>收录奖励 +{r.reward_points} 积分 · 已到账</p>
            )}
            {r.review_note && <p>审核回复：{r.review_note}</p>}
            {r.status === "approved" && (
              <p>
                已关联「{r.brand_name}
                」，已启用采集；是否有券以平台实际返回为准。
              </p>
            )}
            <small>{new Date(r.created_at).toLocaleString("zh-CN")}</small>
            {admin && r.status === "pending" && (
              <button onClick={() => setSelected(r)}>审核并收录</button>
            )}
          </article>
        ))}
      </div>
      <div className="report-pagination">
        <button
          disabled={!offset}
          onClick={() => setOffset((x) => Math.max(0, x - 20))}
        >
          上一页
        </button>
        <span>
          {Math.floor(offset / 20) + 1} / {Math.max(1, Math.ceil(total / 20))} ·{" "}
          {total}条
        </span>
        <button
          disabled={offset + 20 >= total}
          onClick={() => setOffset((x) => x + 20)}
        >
          下一页
        </button>
      </div>
      {selected && (
        <ReviewReport
          key={selected.id}
          report={selected}
          close={() => setSelected(null)}
          done={() => {
            setSelected(null);
            setRevision((x) => x + 1);
          }}
        />
      )}
    </section>
  );
}
function ReviewReport({
  report,
  close,
  done,
}: {
  report: Report;
  close: () => void;
  done: () => void;
}) {
  const [query, setQuery] = useState(report.name),
    [found, setFound] = useState<
      { id: string; name: string; active: boolean }[]
    >([]),
    [brandId, setBrandId] = useState("");
  const [name, setName] = useState(report.name),
    [category, setCategory] = useState(report.category),
    [url, setUrl] = useState(report.url),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function search() {
    setBusy(true);
    setError("");
    try {
      const r = await appFetch(`/v1/brands?q=${encodeURIComponent(query)}`);
      if (!r.ok) throw Error("名录查询失败");
      const d = await r.json();
      setFound(d.items);
      setBrandId("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function review(decision: "approve" | "reject") {
    setBusy(true);
    setError("");
    try {
      if (decision === "reject" && !note.trim())
        throw Error("请填写未采纳原因");
      if (
        decision === "approve" &&
        !brandId &&
        (!name.trim() || !/^https?:\/\//.test(url))
      )
        throw Error("请填写品牌名称及上海门店核实链接");
      await visitRequest(
        `shop-reports/${report.id}/review`,
        "POST",
        decision === "reject"
          ? { decision, note }
          : {
              decision,
              note,
              ...(brandId
                ? { brand_id: brandId }
                : {
                    brand: {
                      name,
                      category,
                      shanghai_evidence_url: url,
                      active: true,
                      aliases: [],
                      keywords: [name],
                    },
                  }),
            },
      );
      done();
    } catch (e) {
      setError(e instanceof Error ? e.message : "审核失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="visit-modal-backdrop">
      <section
        className="visit-modal visit-store-editor"
        role="dialog"
        aria-modal="true"
        aria-label="审核店铺上报"
      >
        <div className="visit-title">
          <h2>审核「{report.name}」</h2>
          <button disabled={busy} onClick={close} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="visit-editor-body report-review">
          <p>{report.address}</p>
          <label>
            搜索已有品牌
            <input value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="visit-actions">
            <button
              disabled={busy || !query.trim()}
              onClick={() => void search()}
            >
              搜索名录
            </button>
            <a
              href={`https://www.douyin.com/search/${encodeURIComponent(query)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              去平台核实 ↗
            </a>
          </div>
          <label>
            录入方式
            <select
              value={brandId}
              onChange={(e) => setBrandId(e.target.value)}
            >
              <option value="">新建品牌并启用采集</option>
              {found.map((b) => (
                <option key={b.id} value={b.id}>
                  关联：{b.name}
                  {b.active ? "" : "（将启用）"}
                </option>
              ))}
            </select>
          </label>
          <small>
            先搜索名录避免重复；平台搜索在新页面打开，核实后再录入。
          </small>
          {!brandId && (
            <>
              <label>
                品牌名称
                <input
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                分类
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  {categories.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label>
                上海门店核实链接
                <input
                  type="url"
                  value={url}
                  maxLength={2000}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="经核实的店铺或团购页面链接"
                />
              </label>
            </>
          )}
          <label>
            审核回复
            <textarea
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <div className="visit-actions">
            <button disabled={busy} onClick={() => void review("reject")}>
              不予采纳
            </button>
            <button
              className="visit-primary"
              disabled={busy}
              onClick={() => void review("approve")}
            >
              {busy ? "处理中…" : "确认收录"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
