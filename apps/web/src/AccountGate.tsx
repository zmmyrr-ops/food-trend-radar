import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { appFetch, appUrl } from "./app-url";
import "./membership.css";

const AccountContext = createContext<{ role: string }>({ role: "user" });
export const useAccount = () => useContext(AccountContext);
export function AccountGate({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<{
    id: string;
    phone: string;
    role: string;
  } | null>(null);
  const [loading, setLoading] = useState(true),
    [register, setRegister] = useState(false);
  const [phone, setPhone] = useState(""),
    [password, setPassword] = useState(""),
    [invite, setInvite] = useState(""),
    [code, setCode] = useState("");
  const [busy, setBusy] = useState(false),
    [sending, setSending] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [until, setUntil] = useState(0),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    void appFetch("/api/auth/me")
      .then(async (r) => {
        if (r.ok) setAccount((await r.json()).account);
      })
      .catch(() => setError("无法连接服务器，请刷新重试"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    const expired = () => {
      setAccount(null);
      setPassword("");
    };
    window.addEventListener("account-expired", expired);
    return () => window.removeEventListener("account-expired", expired);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  async function request(path: string, body: unknown) {
    const r = await appFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw Error(d.error?.message || "操作失败，请重试");
    return d;
  }
  const cooldown = Math.max(0, Math.ceil((until - now) / 1000));
  if (loading) return <main className="auth-loading">正在加载探好店…</main>;
  if (!account)
    return (
      <main className="auth-page">
        <section className="auth-showcase">
          <a className="auth-brand" href={appUrl("/")}>
            <img src={appUrl("/branding/tanhaodian-icon.png")} alt="" />
            探好店<span>创作者的发现空间</span>
          </a>
          <div className="auth-story">
            <span className="auth-eyebrow">发现 · 计划 · 创作</span>
            <h1>
              好店灵感，
              <br />
              从这里出发。
            </h1>
            <p>
              帮你探好每一家店。
              <br />
              从发现一张好券，到完成一次探店创作。
            </p>
            <div className="auth-preview">
              <div className="auth-preview-title">
                <span>你的下一次探店</span>
                <span>SHANGHAI</span>
              </div>
              <div className="auth-preview-grid">
                <div>
                  <i>01</i>
                  <strong>发现好券</strong>
                  <small>美食与游玩，随时找灵感</small>
                </div>
                <div>
                  <i>02</i>
                  <strong>安排路线</strong>
                  <small>把心动的店放进计划</small>
                </div>
                <div>
                  <i>03</i>
                  <strong>轻松创作</strong>
                  <small>素材、标题与视频，一处完成</small>
                </div>
              </div>
            </div>
          </div>
          <small className="auth-footer">让每次探店，都有好发现。</small>
        </section>
        <section className="auth-panel">
          <form
            className="auth-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              setMessage("");
              try {
                if (register) {
                  const d = await request("/api/auth/register", {
                    phone,
                    code,
                    invitation_code: invite,
                    password,
                  });
                  setMessage(d.message);
                  setRegister(false);
                  setCode("");
                } else {
                  const d = await request("/api/auth/login", {
                    phone,
                    password,
                  });
                  setAccount(d.account);
                }
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="auth-mode">
              <button
                type="button"
                aria-pressed={!register}
                onClick={() => {
                  setRegister(false);
                  setError("");
                }}
              >
                登录
              </button>
              <button
                type="button"
                aria-pressed={register}
                onClick={() => {
                  setRegister(true);
                  setError("");
                }}
              >
                邀请注册
              </button>
            </div>
            <h2>{register ? "开启你的创作空间" : "欢迎回来"}</h2>
            <p className="auth-description">
              {register
                ? "完成手机验证，注册即获100积分。"
                : "登录探好店，继续发现与创作。"}
            </p>
            <label>
              手机号码
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                required
                pattern="1[3-9][0-9]{9}"
                maxLength={11}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="请输入手机号码"
              />
            </label>
            {register && (
              <>
                <label>
                  邀请码
                  <input
                    required
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={invite}
                    onChange={(e) =>
                      setInvite(e.target.value.replace(/\D/g, ""))
                    }
                    placeholder="请输入好友提供的6位邀请码"
                  />
                </label>
                <label>
                  短信验证码
                  <div className="auth-sms">
                    <input
                      required
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      value={code}
                      onChange={(e) =>
                        setCode(e.target.value.replace(/\D/g, ""))
                      }
                      placeholder="6位验证码"
                    />
                    <button
                      type="button"
                      disabled={
                        busy ||
                        sending ||
                        cooldown > 0 ||
                        !/^1[3-9]\d{9}$/.test(phone) ||
                        !/^\d{6}$/.test(invite)
                      }
                      onClick={async () => {
                        setSending(true);
                        setError("");
                        try {
                          await request("/api/auth/sms", {
                            phone,
                            invitation_code: invite,
                          });
                          setUntil(Date.now() + 60000);
                          setMessage("验证码已发送，5分钟内有效");
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setSending(false);
                        }
                      }}
                    >
                      {sending
                        ? "发送中…"
                        : cooldown
                          ? `${cooldown}秒后重发`
                          : "获取验证码"}
                    </button>
                  </div>
                </label>
                <small className="auth-hint">
                  同一手机号每分钟1次，每天最多5次。
                </small>
              </>
            )}
            <label>
              登录密码
              <input
                type="password"
                required
                minLength={register ? 8 : 1}
                maxLength={72}
                autoComplete={register ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={register ? "设置8–72位密码" : "请输入登录密码"}
              />
            </label>
            {error && (
              <p className="member-error" role="alert">
                {error}
              </p>
            )}
            {message && (
              <p className="member-success" role="status">
                {message}
              </p>
            )}
            <button className="auth-submit" disabled={busy || sending}>
              {busy ? "请稍候…" : register ? "注册并领取100积分" : "登录"}
            </button>
            <p className="auth-hint">
              {register
                ? "需要有效邀请码才能注册。"
                : "原邀请码用户：首次请使用原8位专属邀请码作为密码。"}
            </p>
          </form>
        </section>
      </main>
    );
  return (
    <AccountContext.Provider value={account}>
      <div className={`account-scope role-${account.role}`}>
        <div className="account-bar">
          {new URLSearchParams(location.search).get("studio") === "1" && (
            <a className="studio-home-link" href={appUrl("/")}>
              ← 返回首页
            </a>
          )}
          <a href={appUrl("/?tab=workspace&section=member")}>
            {account.phone.slice(0, 3)}****{account.phone.slice(-4)} ·{" "}
            {account.role === "admin" ? "管理员" : "我的账号"} · 积分与邀请
          </a>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await request("/api/auth/logout", {});
                location.reload();
              } catch (e) {
                setError((e as Error).message);
                setBusy(false);
              }
            }}
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
