import { useEffect, useState } from "react";
import { appFetch } from "./app-url";
import "./account-management.css";

type Account = {
  id: string;
  phone: string;
  role: string;
  has_invitation: boolean;
  invitation_code: string | null;
};
export function AccountManagement() {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<Account[]>([]);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issued, setIssued] = useState<{ phone: string; code: string } | null>(
    null,
  );
  const [copiedAccount, setCopiedAccount] = useState("");
  const [copied, setCopied] = useState(false);
  async function refresh() {
    const r = await appFetch("/api/v3/accounts");
    if (!r.ok) throw Error("账号列表加载失败");
    setItems((await r.json()).items);
  }
  useEffect(() => {
    void refresh()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  async function issue(account?: Account) {
    if (
      account &&
      !window.confirm(
        `重置 ${account.phone} 的邀请码？旧邀请码及登录状态将立即失效。`,
      )
    )
      return;
    setBusy(true);
    setError("");
    setCopied(false);
    setCopiedAccount("");
    try {
      const r = await appFetch(
        account
          ? `/api/v3/accounts/${account.id}/invitation`
          : "/api/v3/accounts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(account ? {} : { phone: phone.trim() }),
        },
      );
      const result = await r.json();
      if (!r.ok) throw Error(result.error?.message || "操作失败");
      setIssued({ phone: result.account.phone, code: result.invitation_code });
      setPhone("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="account-management"
      aria-labelledby="account-management-title"
    >
      <header>
        <div>
          <h1 id="account-management-title">账号管理</h1>
          <p>按手机号开通访问权限</p>
        </div>
        <span className="account-management-count">
          {loading ? "加载中…" : `${items.length} 个账号`}
        </span>
      </header>
      <div className="account-management-body">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void issue();
          }}
        >
          <input
            aria-label="新增手机号"
            placeholder="输入手机号"
            type="tel"
            pattern="1[3-9][0-9]{9}"
            maxLength={11}
            required
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <button disabled={busy}>新增并生成邀请码</button>
        </form>
        {error && <p role="alert">{error}</p>}
        {issued && (
          <section className="invitation-result">
            <strong>手机号：{issued.phone}</strong>
            <code>{issued.code}</code>
            <p>8 位数字邀请码，可随时在账号列表中查看和复制。</p>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    `手机号：${issued.phone}\n专属邀请码：${issued.code}`,
                  );
                  setCopied(true);
                } catch {
                  setError("复制失败，请手动选择邀请码复制");
                }
              }}
            >
              {copied ? "已复制" : "复制登录信息"}
            </button>
          </section>
        )}
        {loading && <p role="status">正在加载账号…</p>}
        <ul aria-label="账号列表">
          {items.map((account) => (
            <li key={account.id}>
              <div>
                <strong>{account.phone}</strong>
                <small>
                  {account.role === "admin" ? "管理员" : "普通用户"}
                </small>
              </div>
              <div className="account-invitation-cell">
                {account.role === "admin" ? (
                  <span>密码登录</span>
                ) : (
                  <>
                    <code>{account.invitation_code || "待生成"}</code>
                    {account.invitation_code && (
                      <button
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(
                              account.invitation_code!,
                            );
                            setCopiedAccount(account.id);
                          } catch {
                            setError("复制失败，请手动复制邀请码");
                          }
                        }}
                      >
                        {copiedAccount === account.id ? "已复制" : "复制"}
                      </button>
                    )}
                  </>
                )}
              </div>
              {account.role !== "admin" && (
                <button disabled={busy} onClick={() => void issue(account)}>
                  重置邀请码
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
