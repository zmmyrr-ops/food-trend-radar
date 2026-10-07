import { useEffect, useState } from "react";
import { memberRequest } from "./Membership";
import "./membership.css";
export function AccountManagement() {
  const [items, setItems] = useState<any[]>([]),
    [error, setError] = useState(""),
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
    setLedger([]);
    if (selected)
      void memberRequest(
        `/api/admin/members/${selected}/points?offset=${ledgerOffset}`,
      )
        .then((d) => setLedger(d.items))
        .catch((e) => setError(e.message));
  }, [selected, ledgerOffset]);
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
                    onClick={() => {
                      setSelected(a.id);
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
      {current && (
        <section className="member-card">
          <h3>{current.phone} · 积分管理</h3>
          <form
            className="member-password"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                await memberRequest(`/api/admin/members/${selected}/points`, {
                  amount,
                  note,
                  request_id: requestId,
                });
                setRequestId(crypto.randomUUID());
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
            <button disabled={busy}>确认赠送</button>
          </form>
          <small>赠送会增加用户余额，该条记录仅管理员可见。</small>
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
    </section>
  );
}
