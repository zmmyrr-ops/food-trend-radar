import { useState } from "react";
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
  const [locked, setLocked] = useState<string[]>([]);
  const [busy, setBusy] = useState<"titles" | "topics" | null>(null);
  const [error, setError] = useState("");
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
      else setTopics(data.items);
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
                  ? "换一批"
                  : "生成3个标题"}
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
            <h3>话题标签</h3>
            <button
              disabled={!!busy || locked.length === 10}
              onClick={() => void generate("topics")}
            >
              {busy === "topics"
                ? "生成中…"
                : topics.length
                  ? "换一批"
                  : "生成10个话题"}
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
                    {locked.includes(topic) && <small>已锁定</small>}
                  </label>
                ))}
              </div>
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
            <p className="studio-copy-empty">生成相关话题，勾选后组合复制。</p>
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
