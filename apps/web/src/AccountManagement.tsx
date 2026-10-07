import { useEffect, useRef, useState } from "react";
import { memberRequest } from "./Membership";
import "./membership.css";
export function AccountManagement() {
  const panelRef = useRef<HTMLElement>(null);
  const [items, setItems] = useState<any[]>([]),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(""),
    [ledgerLoading, setLedgerLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState(""),
    [amount, setAmount] = useState(100),
    [note, setNote] = useState("管理员赠送"),
    [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0),
    [ledger, setLedger] = useState<any[]>([]),
    [ledgerOffset, setLedgerOffset] = useState(0),
    [requestId, setRequestId] = useState(crypto.randomUUID());
  async function load() {
    setItems((await memberRequest("/api/admin/members")).items);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    let active = true;
    setLedger([]);
    if (!selected) return;
    setLedgerLoading(true);
    void memberRequest(
      `/api/admin/members/${selected}/points?offset=${ledgerOffset}`,
    )
      .then((d) => {
        if (active) setLedger(d.items);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLedgerLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selected, ledgerOffset]);
  useEffect(() => {
    if (selected)
      panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selected]);
  const filtered = items.filter((i) => i.phone.includes(query)),
    current = items.find((i) => i.id === selected);
  return (
    <section className="member-page">
      <header>
        <div>
          <h1>账号与积分</h1>
          <p>{items.length}个账号 · 查看邀请关系和积分余额</p>
        </div>
        <button onClick={() => void load().catch((e) => setError(e.message))}>
          刷新
        </button>
      </header>
      {error && (
        <p role="alert" className="member-error">
          {error}
        </p>
      )}
      {current && (
        <section
          ref={panelRef}
          className="member-card member-admin-detail"
          aria-label="用户积分管理"
        >
          <div className="member-detail-heading">
            <h3>
              {current.phone} · 积分管理{" "}
              <small>余额 {current.balance} 积分</small>
            </h3>
            <button
              type="button"
              disabled={busy}
              onClick={() => setSelected("")}
            >
              收起
            </button>
          </div>
          {success && (
            <p role="status" className="member-success">
              {success}
            </p>
          )}
          <form
            className="member-password"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              setSuccess("");
              try {
                await memberRequest(`/api/admin/members/${selected}/points`, {
                  amount,
                  note,
                  request_id: requestId,
                });
                setRequestId(crypto.randomUUID());
                setSuccess(`已成功赠送 ${amount} 积分`);
                await load();
                setLedger(
                  (await memberRequest(`/api/admin/members/${selected}/points`))
                    .items,
                );
                setLedgerOffset(0);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              赠送积分
              <input
                required
                type="number"
                min={1}
                max={1000000}
                value={amount}
                onChange={(e) => {
                  setAmount(Number(e.target.value));
                  setRequestId(crypto.randomUUID());
                }}
              />
            </label>
            <label>
              内部备注
              <input
                maxLength={200}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <button disabled={busy}>{busy ? "正在赠送…" : "确认赠送"}</button>
          </form>
          <small>赠送会增加用户余额，该条记录仅管理员可见。</small>
          {ledgerLoading ? (
            <p role="status">正在加载积分明细…</p>
          ) : (
            !ledger.length && <p className="member-muted">暂无积分记录</p>
          )}
          <ul className="member-records">
            {ledger.map((e) => (
              <li key={e.id}>
                <div>
                  <strong>{e.reason}</strong>
                  <small>
                    {new Date(e.created_at).toLocaleString("zh-CN")}
                    {e.hidden ? " · 仅管理员可见" : ""}
                  </small>
                </div>
                <b>
                  {e.amount > 0 ? "+" : ""}
                  {e.amount}
                </b>
              </li>
            ))}
          </ul>
          <div className="member-pagination">
            <button
              disabled={!ledgerOffset}
              onClick={() => setLedgerOffset((x) => Math.max(0, x - 30))}
            >
              上一页
            </button>
            <button
              disabled={ledger.length < 30}
              onClick={() => setLedgerOffset((x) => x + 30)}
            >
              下一页
            </button>
          </div>
        </section>
      )}
      <input
        className="member-search"
        placeholder="搜索手机号"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOffset(0);
        }}
      />
      <div className="member-table">
        <table>
          <thead>
            <tr>
              <th>用户</th>
              <th>可用积分</th>
              <th>邀请码</th>
              <th>成功邀请</th>
              <th>邀请人</th>
              <th>管理</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(offset, offset + 20).map((a) => (
              <tr key={a.id}>
                <td>
                  {a.phone.startsWith("wx:")
                    ? "微信用户 · " + a.id.slice(0, 8)
                    : a.phone}
                  {a.role === "admin" && <small> 管理员</small>}
                </td>
                <td>
                  <strong>{a.balance}</strong>
                </td>
                <td>{a.referral_code || "未生成"}</td>
                <td>{a.invited_count}人</td>
                <td>{a.inviter_phone || "—"}</td>
                <td>
                  <button
                    type="button"
                    disabled={busy}
                    aria-pressed={selected === a.id}
                    onClick={() => {
                      setError("");
                      setSuccess("");
                      setSelected(a.id);
                      panelRef.current?.scrollIntoView({
                        behavior: "smooth",
                        block: "start",
                      });
                      setLedgerOffset(0);
                      setRequestId(crypto.randomUUID());
                    }}
                  >
                    积分明细 / 赠送
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="member-pagination">
        <button disabled={!offset} onClick={() => setOffset((x) => x - 20)}>
          上一页
        </button>
        <span>
          {Math.floor(offset / 20) + 1} /{" "}
          {Math.max(1, Math.ceil(filtered.length / 20))}
        </span>
        <button
          disabled={offset + 20 >= filtered.length}
          onClick={() => setOffset((x) => x + 20)}
        >
          下一页
        </button>
      </div>
    </section>
  );
}
