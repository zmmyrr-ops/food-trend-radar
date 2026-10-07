import { useEffect, useState } from "react";
import { appFetch } from "./app-url";
import { Points } from "./Points";
export async function memberRequest(path: string, body?: unknown) {
  const r = await appFetch(
    path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const d = await r.json();
  if (!r.ok) throw Error(d.error?.message || "操作失败");
  return d;
}
export function Membership() {
  const [data, setData] = useState<any>(null),
    [entries, setEntries] = useState<any[]>([]),
    [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [old, setOld] = useState(""),
    [password, setPassword] = useState("");
  async function load() {
    const [d, l] = await Promise.all([
      memberRequest("/api/member"),
      memberRequest(`/api/member/points?offset=${offset}`),
    ]);
    setData(d);
    setEntries(l.items);
    setTotal(l.total);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [offset]);
  return (
    <section className="member-page">
      <header>
        <div>
          <h2>我的积分与邀请</h2>
          <p>积攒创作灵感，也积攒下一次创作的积分。</p>
        </div>
        <button onClick={() => void load().catch((e) => setError(e.message))}>
          刷新
        </button>
      </header>
      {error && (
        <p className="member-error" role="alert">
          {error}
        </p>
      )}
      {message && <p className="member-success">{message}</p>}
      <div className="member-overview">
        <section className="member-balance">
          <span>可用积分</span>
          <strong>
            <Points amount={data?.balance ?? "—"} />
          </strong>
          <small>素材10分 · 追加5分 · 标题5分 · 热门话题5分 · 视频50分</small>
        </section>
        <section className="member-invite">
          <span>邀请好友，共享创作灵感</span>
          <h3>每成功邀请1人，获得100积分</h3>
          {data?.referral_code ? (
            <div className="member-code">
              <strong>{data.referral_code}</strong>
              <button
                onClick={() =>
                  void navigator.clipboard
                    .writeText(data.referral_code)
                    .then(() => setMessage("邀请码已复制"))
                    .catch(() => setError("复制失败，请手动复制"))
                }
              >
                复制邀请码
              </button>
            </div>
          ) : (
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await memberRequest("/api/member/invitation", {});
                  await load();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              生成我的6位邀请码
            </button>
          )}
          <small>好友完成手机验证并注册后，双方各获得100积分。</small>
        </section>
      </div>
      <section className="member-card">
        <h3>成功邀请 · {data?.invited.length ?? 0}人</h3>
        {data?.invited.length ? (
          <ul className="member-records">
            {data.invited.map((u: any) => (
              <li key={u.phone}>
                <strong>{u.phone}</strong>
                <span>{new Date(u.created_at).toLocaleString("zh-CN")}</span>
                <b>
                  <Points amount="+100" />
                </b>
              </li>
            ))}
          </ul>
        ) : (
          <p className="member-muted">分享邀请码，邀请第一位好友。</p>
        )}
      </section>
      <section className="member-card">
        <h3>积分明细</h3>
        <ul className="member-records">
          {entries.map((e) => (
            <li key={e.id}>
              <div>
                <strong>{e.reason}</strong>
                <small>{new Date(e.created_at).toLocaleString("zh-CN")}</small>
              </div>
              <b className={e.amount > 0 ? "member-positive" : ""}>
                <Points amount={`${e.amount > 0 ? "+" : ""}${e.amount}`} />
              </b>
            </li>
          ))}
        </ul>
        {!entries.length && <p className="member-muted">暂无积分记录</p>}
        <div className="member-pagination">
          <button
            disabled={!offset}
            onClick={() => setOffset((x) => Math.max(0, x - 30))}
          >
            上一页
          </button>
          <span>
            {Math.floor(offset / 30) + 1} / {Math.max(1, Math.ceil(total / 30))}
          </span>
          <button
            disabled={offset + 30 >= total}
            onClick={() => setOffset((x) => x + 30)}
          >
            下一页
          </button>
        </div>
      </section>
      <section className="member-card">
        <h3>修改登录密码</h3>
        <form
          className="member-password"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await memberRequest("/api/member/password", {
                old_password: old,
                password,
              });
              window.location.reload();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            原密码
            <input
              required
              type="password"
              autoComplete="current-password"
              value={old}
              onChange={(e) => setOld(e.target.value)}
            />
          </label>
          <label>
            新密码
            <input
              required
              minLength={8}
              maxLength={72}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="8–72位"
            />
          </label>
          <button disabled={busy}>保存并重新登录</button>
        </form>
      </section>
    </section>
  );
}
