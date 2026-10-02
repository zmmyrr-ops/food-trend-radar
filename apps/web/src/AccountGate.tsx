import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { appFetch, appUrl } from "./app-url";

const AccountContext = createContext<{ role: string }>({ role: "user" });
export const useAccount = () => useContext(AccountContext);
export function AccountGate({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<{
    id: string;
    phone: string;
    role: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [testMode, setTestMode] = useState(false);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void Promise.all([
      appFetch("/api/auth/me").then(async (r) => {
        if (r.ok) setAccount((await r.json()).account);
      }),
      appFetch("/api/auth/config").then(async (r) => {
        if (r.ok) setTestMode((await r.json()).test_mode);
      }),
    ])
      .catch(() => setError("无法连接服务器，请刷新重试"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    const expired = () => {
      setAccount(null);
      setCode("");
    };
    window.addEventListener("account-expired", expired);
    return () => window.removeEventListener("account-expired", expired);
  }, []);
  if (loading)
    return (
      <main className="account-login">
        <p>正在检查登录状态…</p>
      </main>
    );
  if (!account)
    return (
      <main className="account-login">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              const r = await appFetch("/api/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone, code }),
              });
              const v = await r.json();
              if (!r.ok) throw Error(v.error?.message || "登录失败");
              setAccount(v.account);
            } catch (e) {
              setError(e instanceof Error ? e.message : "登录失败");
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="account-logo">
            <img src={appUrl("/branding/tanhaodian-icon.png")} alt="" />
            探好店
          </div>
          <p className="account-slogan">帮你探好每一家店</p>
          <h1>登录你的创作空间</h1>
          <p>素材与制作的视频，按账号独立保存。</p>
          {testMode ? (
            <p className="account-test">
              内部测试模式 · 暂未验证手机号归属
              <br />
              验证码固定为 666666，请勿对外开放使用。
            </p>
          ) : (
            <p>短信登录尚未开通，请联系管理员。</p>
          )}
          <label>
            手机号码
            <input
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              maxLength={11}
              pattern="1[3-9][0-9]{9}"
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="请输入手机号码"
            />
          </label>
          <label>
            验证码
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]{6}"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="请输入六位验证码"
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <button disabled={busy || !testMode}>
            {busy ? "登录中…" : "登录 / 注册"}
          </button>
          <small>首次登录自动建立账号</small>
        </form>
      </main>
    );
  return (
    <AccountContext.Provider value={account}>
      <div className={`account-scope role-${account.role}`}>
        <div className="account-bar">
          {new URLSearchParams(location.search).get("studio") === "1" && (
            <a className="studio-home-link" href={appUrl("/")}>
              <span aria-hidden="true">←</span> 返回首页
            </a>
          )}
          <span>
            {account.phone.slice(0, 3)}****{account.phone.slice(-4)} ·{" "}
            {account.role === "admin" ? "管理员" : "我的账号"}
          </span>
          {testMode && <small>内部测试</small>}
          <button
            onClick={async () => {
              setBusy(true);
              try {
                const r = await appFetch("/api/auth/logout", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: "{}",
                });
                if (!r.ok) throw Error();
                window.location.reload();
              } catch {
                setError("退出失败，请重试");
                setBusy(false);
              }
            }}
            disabled={busy}
          >
            退出登录
          </button>
          {error && <small role="alert">{error}</small>}
        </div>
        <div key={account.id}>{children}</div>
      </div>
    </AccountContext.Provider>
  );
}
