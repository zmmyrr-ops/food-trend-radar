import { useEffect, useState } from "react";
import { appFetch } from "./app-url";

export function StudioCopy({
  visitStore,
  projectId,
}: {
  visitStore: string;
  projectId?: string;
}) {
  const [titles, setTitles] = useState<string[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [plays, setPlays] = useState<
    Record<
      string,
      { display: string | null; url?: string | null; checked_at?: string }
    >
  >({});
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      for (const topic of topics) {
        if (plays[topic]) continue;
        try {
          const response = await appFetch(
            `/api/v3/topic-plays?topic=${encodeURIComponent(topic)}`,
            { signal: controller.signal },
          );
          if (!response.ok) throw Error("查询失败");
          const data = await response.json();
          if (!controller.signal.aborted)
            setPlays((previous) => ({ ...previous, [topic]: data }));
        } catch {
          if (controller.signal.aborted) return;
          setPlays((previous) => ({ ...previous, [topic]: { display: null } }));
        }
      }
    })();
    return () => controller.abort();
  }, [topics]);
  const [locked, setLocked] = useState<string[]>([]);
  const [busy, setBusy] = useState<"titles" | "topics" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState("");
  async function generate(kind: "titles" | "topics") {
    setBusy(kind);
    setError("");
    setCopied("");
    try {
      const response = await appFetch("/api/v3/studio-copy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: crypto.randomUUID(),
          visit_store_id: visitStore,
          project_id: projectId,
          kind,
          locked: kind === "topics" ? locked : [],
          previous: kind === "titles" ? titles : topics,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error?.message || "生成失败，请重试");
      if (kind === "titles") setTitles(data.items);
      else {
        setPlays((previous) => ({ ...previous, ...data.metrics }));
        setTopics(data.items);
        setNotice(data.notice || "");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成失败，请重试");
    } finally {
      setBusy(null);
    }
  }
  async function copy(text: string, message: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(message);
    } catch {
      setError("复制失败，请允许浏览器访问剪贴板后重试");
    }
  }
  return (
    <section className="studio-publish-copy">
      <div className="studio-section-heading">
        <h2>发布灵感</h2>
        <span>DeepSeek</span>
      </div>
      <div className="studio-copy-columns">
        <section>
          <div className="studio-section-heading">
            <h3>爆款标题灵感</h3>
            <button disabled={!!busy} onClick={() => void generate("titles")}>
              {busy === "titles"
                ? "生成中…"
                : titles.length
                  ? "换一批 · 5积分"
                  : "生成3个标题 · 5积分"}
            </button>
          </div>
          {titles.length ? (
            <ol className="studio-title-list">
              {titles.map((title, i) => (
                <li key={title}>
                  <span className="studio-title-number">0{i + 1}</span>
                  <p>{title}</p>
                  <button
                    onClick={() => void copy(title, `标题${i + 1}已复制`)}
                  >
                    复制
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="studio-copy-empty">为这次探店找一个吸引人的开场。</p>
          )}
        </section>
        <section>
          <div className="studio-section-heading">
            <h3>抖音热门话题</h3>
            <button
              disabled={!!busy || locked.length === 10}
              onClick={() => void generate("topics")}
            >
              {busy === "topics"
                ? "正在搜索热门话题…"
                : topics.length
                  ? "换一批 · 5积分"
                  : "查找热门话题"}
            </button>
          </div>
          {topics.length ? (
            <>
              <div className="studio-topic-list">
                {topics.map((topic) => (
                  <label
                    className={locked.includes(topic) ? "is-locked" : ""}
                    key={topic}
                  >
                    <input
                      type="checkbox"
                      disabled={busy === "topics"}
                      checked={locked.includes(topic)}
                      onChange={(e) => {
                        setCopied("");
                        setLocked((previous) =>
                          e.target.checked
                            ? [...previous, topic]
                            : previous.filter((v) => v !== topic),
                        );
                      }}
                    />
                    <span>#{topic}</span>
                    <small
                      title={
                        plays[topic]?.checked_at
                          ? `抖音话题累计播放量 · ${new Date(plays[topic].checked_at!).toLocaleString("zh-CN")}`
                          : undefined
                      }
                    >
                      {!plays[topic]
                        ? "查询播放量…"
                        : plays[topic].display
                          ? `${plays[topic].display}次播放`
                          : "暂无播放数据"}
                    </small>
                    {locked.includes(topic) && <small>已锁定</small>}
                  </label>
                ))}
              </div>
              {notice && <p className="studio-copy-empty">{notice}</p>}
              <div className="studio-copy-footer">
                <span>
                  {locked.length === 10
                    ? "全部已锁定，取消勾选后可换一批"
                    : "勾选即锁定，换一批时保留"}
                </span>
                <button
                  disabled={!locked.length}
                  onClick={() =>
                    void copy(
                      locked.map((v) => `#${v}`).join(" "),
                      "已复制选中话题",
                    )
                  }
                >
                  复制已选（{locked.length}）
                </button>
              </div>
            </>
          ) : (
            <p className="studio-copy-empty">
              根据店铺与视频提取关键词，从抖音查找相关热门话题。
            </p>
          )}
        </section>
      </div>
      {error && (
        <p role="alert" className="studio-error">
          {error}
        </p>
      )}
      <span role="status">{copied}</span>
    </section>
  );
}
