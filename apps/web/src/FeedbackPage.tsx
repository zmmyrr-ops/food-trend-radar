import { useEffect, useState } from "react";
import { useAccount } from "./AccountGate";
import { ShopReports } from "./ShopReports";
import { visitRequest } from "./VisitPlans";
import "./feedback.css";

type Feedback = {
  id: string;
  content: string;
  status: string;
  reply: string;
  created_at: string;
};
export function FeedbackPage() {
  const [tab, setTab] = useState("shops");
  return (
    <section className="feedback-page">
      <div className="feedback-heading">
        <h1>我要反馈</h1>
        <p>补充想找的店铺，或告诉我们使用中遇到的问题。</p>
      </div>
      <nav className="feedback-tabs" aria-label="反馈类型">
        <button
          type="button"
          aria-pressed={tab === "shops"}
          onClick={() => setTab("shops")}
        >
          店铺上报
        </button>
        <button
          type="button"
          aria-pressed={tab === "other"}
          onClick={() => setTab("other")}
        >
          其他问题反馈
        </button>
      </nav>
      {tab === "shops" ? <ShopReports /> : <OtherFeedback />}
    </section>
  );
}
function OtherFeedback() {
  const admin = useAccount().role === "admin";
  const [items, setItems] = useState<Feedback[]>([]),
    [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0);
  const [content, setContent] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  useEffect(() => {
    let live = true;
    setError("");
    void visitRequest(`feedback?offset=${offset}`)
      .then((d) => {
        if (live) {
          setItems(d.items);
          setTotal(d.total);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [offset, revision]);
  return (
    <section className="feedback-other">
      <h2>其他问题反馈</h2>
      <p>功能异常、数据问题或改进建议，都可以在这里告诉我们。</p>
      <form
        className="feedback-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          setMessage("");
          try {
            const d = await visitRequest("feedback", "POST", { content });
            setMessage(
              d.duplicate
                ? "这条问题已经提交，请等待处理"
                : "反馈已提交，可在下方查看处理结果",
            );
            setContent("");
            setOffset(0);
            setRevision((v) => v + 1);
          } catch (e) {
            setError(e instanceof Error ? e.message : "提交失败");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="feedback-content">问题描述</label>
        <textarea
          id="feedback-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          minLength={5}
          maxLength={2000}
          required
          rows={5}
          placeholder="请描述遇到的问题、操作步骤或你的建议；如涉及某张券，可附上品牌名称。"
        />
        <div className="feedback-form-footer">
          <small>{content.length}/2000</small>
          <button disabled={busy || content.trim().length < 5} type="submit">
            {busy ? "提交中…" : "提交反馈"}
          </button>
        </div>
      </form>
      {error && (
        <p role="alert" className="feedback-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <h2>
        {admin ? "用户问题反馈" : "我的问题反馈"} <small>（{total}）</small>
      </h2>
      {items.length === 0 ? (
        <p>暂无问题反馈</p>
      ) : (
        items.map((item) => (
          <article className="feedback-item" key={item.id}>
            <div className="feedback-meta">
              <span>{item.status === "resolved" ? "已处理" : "待处理"}</span>
              <time>{new Date(item.created_at).toLocaleString("zh-CN")}</time>
            </div>
            <p className="feedback-content">{item.content}</p>
            {item.reply && (
              <div className="feedback-reply">
                <strong>处理回复</strong>
                <p>{item.reply}</p>
              </div>
            )}
            {admin && (
              <FeedbackReply
                item={item}
                done={() => setRevision((v) => v + 1)}
              />
            )}
          </article>
        ))
      )}
      {total > 20 && (
        <div className="feedback-pagination">
          <button
            disabled={offset === 0}
            onClick={() => setOffset((v) => v - 20)}
          >
            上一页
          </button>
          <span>
            {Math.floor(offset / 20) + 1} / {Math.ceil(total / 20)}
          </span>
          <button
            disabled={offset + 20 >= total}
            onClick={() => setOffset((v) => v + 20)}
          >
            下一页
          </button>
        </div>
      )}
    </section>
  );
}
function FeedbackReply({ item, done }: { item: Feedback; done: () => void }) {
  const [reply, setReply] = useState(item.reply),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="feedback-admin"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError("");
        try {
          await visitRequest(`feedback/${item.id}/reply`, "POST", {
            reply,
            status: "resolved",
          });
          done();
        } catch (e) {
          setError(e instanceof Error ? e.message : "处理失败");
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor={`reply-${item.id}`}>回复用户</label>
      <textarea
        id={`reply-${item.id}`}
        value={reply}
        maxLength={2000}
        required
        rows={2}
        onChange={(e) => setReply(e.target.value)}
      />
      <button disabled={busy || !reply.trim()}>
        {busy ? "保存中…" : "保存回复并标记已处理"}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
