import { useEffect, useRef, useState } from "react";
import { appUrl } from "./app-url";
import { visitRequest } from "./VisitPlans";

type Message = {
  channel: string;
  id: string;
  brand_id: string;
  product_id: string;
  kind: string;
  brand_name: string;
  title: string;
  created_at: string;
  read_at: string | null;
};
export function BrandSubscriptions({
  mode = "messages",
}: {
  mode?: "messages" | "manage";
}) {
  const manage = mode === "manage";
  const [open, setOpen] = useState(false),
    [q, setQ] = useState(""),
    [results, setResults] = useState<{ id: string; name: string }[]>([]),
    [subscriptions, setSubscriptions] = useState<
      { brand_id: string; name: string }[]
    >([]),
    [messages, setMessages] = useState<Message[]>([]),
    [unread, setUnread] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [permission, setPermission] = useState(
      typeof Notification === "undefined"
        ? "unsupported"
        : Notification.permission,
    );
  const seen = useRef(new Set<string>());
  async function refreshSubscriptions() {
    const r = await visitRequest("brand-subscriptions");
    setSubscriptions(r.items);
  }
  useEffect(() => {
    if (manage) return;
    let alive = true;
    const poll = async () => {
      try {
        const r = await visitRequest("brand-subscriptions/messages");
        if (!alive) return;
        setMessages(r.items);
        setUnread(r.unread);
        const fresh = (r.items as Message[]).filter(
          (m) =>
            !m.read_at &&
            !seen.current.has(m.id) &&
            !localStorage.getItem(`subscription-notified:${m.id}`),
        );
        if (
          fresh.length &&
          typeof Notification !== "undefined" &&
          Notification.permission === "granted"
        ) {
          try {
            const m = fresh[0];
            const n = new Notification(
              fresh.length > 1
                ? `探好店 · ${fresh.length} 条订阅动态`
                : `${m.brand_name} · ${m.kind === "new" ? "新上券" : "热度飙升"}`,
              {
                body:
                  fresh.length > 1
                    ? `${m.brand_name}等品牌有新动态，点击查看`
                    : m.title,
                tag: "brand-subscriptions",
              },
            );
            n.onclick = () => {
              window.focus();
              setOpen(true);
              n.close();
            };
            for (const item of fresh)
              localStorage.setItem(`subscription-notified:${item.id}`, "1");
          } catch {
            /* 部分手机浏览器仅支持站内提醒。 */
          }
        }
        for (const m of r.items as Message[]) seen.current.add(m.id);
      } catch (e) {
        if (alive) setError(String(e));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 60000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [manage]);
  useEffect(() => {
    if (!manage) return;
    void refreshSubscriptions().catch((e) => setError(String(e)));
  }, [manage]);
  useEffect(() => {
    let alive = true;
    if (!q.trim()) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      void visitRequest(
        `brand-subscriptions/search?q=${encodeURIComponent(q.trim())}`,
      )
        .then((r) => {
          if (alive) setResults(r.items);
        })
        .catch((e) => {
          if (alive) setError(String(e));
        });
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q]);
  async function toggle(brand_id: string, subscribed: boolean) {
    setBusy(true);
    setError("");
    try {
      await visitRequest("brand-subscriptions", "POST", {
        brand_id,
        subscribed,
      });
      await refreshSubscriptions();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="brand-subscriptions">
      {!manage && (
        <button
          className="subscription-entry"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          订阅消息 <span>{unread ? `${unread} 条未读` : "消息提醒"}</span>
          <span>{open ? "收起" : "展开"}</span>
        </button>
      )}
      {(manage || open) && (
        <div className="subscription-body">
          {manage && (
            <>
              <div className="subscription-tools">
                <h3>我的品牌订阅</h3>
                <button
                  disabled={
                    permission === "unsupported" || permission === "granted"
                  }
                  onClick={async () => {
                    try {
                      setPermission(await Notification.requestPermission());
                      seen.current.clear();
                    } catch {
                      setPermission("unsupported");
                    }
                  }}
                >
                  {permission === "granted"
                    ? "系统通知已开启"
                    : permission === "unsupported"
                      ? "此浏览器使用站内提醒"
                      : permission === "denied"
                        ? "请在浏览器设置允许通知"
                        : "开启系统通知"}
                </button>
              </div>
              <p className="muted">
                订阅品牌的新上券与热度飙升，消息在首页查看。首页打开期间可接收系统通知。
              </p>
              <input
                aria-label="搜索订阅品牌"
                placeholder="输入品牌名，搜索并订阅"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                maxLength={80}
              />
              {q.trim() && (
                <div className="subscription-results">
                  {results.map((b) => (
                    <div key={b.id}>
                      <span>{b.name}</span>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void toggle(
                            b.id,
                            !subscriptions.some((s) => s.brand_id === b.id),
                          )
                        }
                      >
                        {subscriptions.some((s) => s.brand_id === b.id)
                          ? "取消订阅"
                          : "订阅"}
                      </button>
                    </div>
                  ))}
                  {!results.length && <p className="muted">暂无匹配品牌</p>}
                </div>
              )}
              <div className="subscription-chips">
                {subscriptions.map((s) => (
                  <button
                    key={s.brand_id}
                    disabled={busy}
                    onClick={() => void toggle(s.brand_id, false)}
                    title="取消订阅"
                  >
                    {s.name} ×
                  </button>
                ))}
              </div>
              {!subscriptions.length && (
                <p className="muted">尚未订阅品牌，搜索后即可添加。</p>
              )}
            </>
          )}
          {!manage && (
            <>
              <div className="subscription-tools">
                <h3>订阅消息</h3>
                <a href={appUrl("/?tab=workspace&section=subscriptions")}>
                  管理品牌订阅 →
                </a>
                <button
                  disabled={!messages.some((m) => !m.read_at) || busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const ids = messages
                        .filter((m) => !m.read_at)
                        .map((m) => m.id);
                      await visitRequest("brand-subscriptions/read", "POST", {
                        ids,
                      });
                      setMessages((items) =>
                        items.map((m) => ({
                          ...m,
                          read_at: m.read_at || new Date().toISOString(),
                        })),
                      );
                      setUnread((n) => Math.max(0, n - ids.length));
                    } catch (e) {
                      setError(String(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  本页标为已读
                </button>
              </div>
              <div className="subscription-messages">
                {messages.map((m) => (
                  <a
                    key={m.id}
                    className={m.read_at ? "" : "unread"}
                    href={appUrl(
                      `/?tab=radar&subscription_brand=${m.brand_id}&channel=${m.channel}`,
                    )}
                    onClick={() => {
                      void visitRequest("brand-subscriptions/read", "POST", {
                        ids: [m.id],
                      });
                    }}
                  >
                    <strong>
                      {m.brand_name} · {m.kind === "new" ? "新上" : "热度飙升"}
                    </strong>
                    <span>{m.title}</span>
                    <small>
                      {new Date(m.created_at).toLocaleString("zh-CN")}
                    </small>
                  </a>
                ))}
                {!messages.length && (
                  <p className="muted">
                    暂无消息，订阅品牌后有新的变化会在这里提醒。
                  </p>
                )}
              </div>
            </>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </section>
  );
}
