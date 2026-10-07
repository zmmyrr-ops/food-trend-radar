import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { appFetch } from "./app-url";
import "./account-management.css";

type Account = {
  id: string;
  phone: string;
  role: string;
  has_invitation: boolean;
};
export function AccountManagement({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<Account[]>([]);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issued, setIssued] = useState<{ phone: string; code: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  async function refresh() {
    const r = await appFetch("/api/v3/accounts");
    if (!r.ok) throw Error("账号列表加载失败");
    setItems((await r.json()).items);
  }
  useEffect(() => {
    dialog.current?.showModal();
    void refresh().catch((e) => setError(e.message));
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
  return createPortal(
    <dialog ref={dialog} className="account-management" onCancel={onClose}>
      <header>
        <div>
          <h2>账号管理</h2>
          <p>按手机号开通访问权限</p>
        </div>
        <button onClick={onClose} aria-label="关闭账号管理">
          ×
        </button>
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
            <p>邀请码仅展示这一次，请复制后单独发给对应用户。</p>
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
        <ul>
          {items.map((account) => (
            <li key={account.id}>
              <div>
                <strong>{account.phone}</strong>
                <small>
                  {account.role === "admin" ? "管理员" : "普通用户"}
                </small>
              </div>
              <button
                disabled={busy || account.role === "admin"}
                onClick={() => void issue(account)}
              >
                {account.role === "admin" ? "密码登录" : "重置邀请码"}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </dialog>,
    document.body,
  );
}
