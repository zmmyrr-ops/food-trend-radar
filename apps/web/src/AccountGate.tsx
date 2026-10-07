import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { AccountManagement } from "./AccountManagement";
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
  const [managing, setManaging] = useState(false);
  const [phone, setPhone] = useState("");
  const [loginMode, setLoginMode] = useState("invitation");
  const [checkingMode, setCheckingMode] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void Promise.all([
      appFetch("/api/auth/me").then(async (r) => {
        if (r.ok) setAccount((await r.json()).account);
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
  useEffect(() => {
    const controller = new AbortController();
    setCode("");
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      setLoginMode("invitation");
      setCheckingMode(false);
      return;
    }
    setCheckingMode(true);
    void appFetch(`/api/auth/config?phone=${encodeURIComponent(phone)}`, {
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw Error();
        const result = await r.json();
        if (!controller.signal.aborted) setLoginMode(result.login_mode);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("暂时无法识别登录方式，请重新输入手机号");
      })
      .finally(() => {
        if (!controller.signal.aborted) setCheckingMode(false);
      });
    return () => controller.abort();
  }, [phone]);
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
                body: JSON.stringify(
                  loginMode === "password"
                    ? { phone, password: code }
                    : { phone, code },
                ),
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
          <p>普通账号使用专属邀请码，管理员使用密码登录。</p>
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
            {loginMode === "password" ? "管理员密码" : "专属邀请码"}
            <input
              type="password"
              autoComplete="current-password"
              maxLength={loginMode === "password" ? 128 : 8}
              inputMode={loginMode === "password" ? "text" : "numeric"}
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={
                checkingMode
                  ? "正在识别登录方式…"
                  : loginMode === "password"
                    ? "请输入管理员密码"
                    : "请输入8位数字邀请码"
              }
              disabled={checkingMode}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <button disabled={busy || checkingMode}>
            {busy ? "登录中…" : "登录"}
          </button>
          <small>未获得邀请码？请联系管理员开通账号。</small>
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
          {account.role === "admin" && (
            <button onClick={() => setManaging(true)}>账号管理</button>
          )}
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
        {managing && account.role === "admin" && (
          <AccountManagement onClose={() => setManaging(false)} />
        )}
      </div>
    </AccountContext.Provider>
  );
}
