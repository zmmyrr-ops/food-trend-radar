import {
  type Brand,
  type DataSource,
  type FoodEvent,
  policy,
} from "@radar/contracts";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { appFetch } from "./app-url";

type Report = {
  policy_hash: string;
  policy_reviewed: boolean;
  brands: {
    total: number;
    verified: number;
    categories: { name: string; target: number; verified: number }[];
    duplicate_candidates: { a: string; b: string; names: string[] }[];
  };
  sources: {
    id: string;
    name: string;
    audit_id: string | null;
    passed: boolean;
    reasons: string[];
    projected_daily_calls: number | null;
    projected_monthly_cost: number | null;
  }[];
  publication: { reasons: string[] };
};
type Audit = {
  id: string;
  config: { source_id: string; observed_at: string; note: string };
};
async function request<T>(path: string, body?: unknown): Promise<T> {
  const r = await appFetch(
    "/v1" + path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message ?? "请求失败");
  return d;
}
function Fields({
  items,
}: {
  items: readonly (readonly [string, string, string])[];
}) {
  return (
    <>
      {items.map(([name, label, type]) => (
        <label key={name}>
          {label}
          <input
            name={name}
            type={type}
            required
            min={type === "number" ? 0 : undefined}
            step={type === "number" ? "any" : undefined}
          />
        </label>
      ))}
    </>
  );
}
const common = [
  ["reviewer", "核验人", "text"],
  ["note", "结论与证据说明", "text"],
] as const;
const proof = [
  ["evidence_url", "脱敏证据链接", "url"],
  ["evidence_sha256", "证据文件SHA-256摘要（64位）", "text"],
] as const;
export function Admission() {
  const [report, setReport] = useState<Report | null>(null),
    [brands, setBrands] = useState<Brand[]>([]),
    [sources, setSources] = useState<DataSource[]>([]),
    [events, setEvents] = useState<FoodEvent[]>([]),
    [audits, setAudits] = useState<Audit[]>([]);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [eventId, setEventId] = useState(""),
    [eventState, setEventState] = useState<{
      event_fingerprint: string;
      local_review_valid: boolean;
      local_candidate: boolean;
      history: unknown[];
    } | null>(null);
  const refresh = useCallback(async () => {
    const [r, b, s, e, a] = await Promise.all([
      request<Report>("/admission"),
      request<{ items: Brand[] }>("/brands"),
      request<{ items: DataSource[] }>("/sources"),
      request<{ items: FoodEvent[] }>("/events"),
      request<{ items: Audit[] }>("/admission/audits"),
    ]);
    setReport(r);
    setBrands(b.items);
    setSources(s.items);
    setEvents(e.items);
    setAudits(a.items);
  }, []);
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, [refresh]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await refresh();
      setNotice("已记录。登记不等于真实数据已验证，预测发布仍受门禁限制。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  function submit(
    e: FormEvent<HTMLFormElement>,
    kind: "audit" | "trial" | "review" | "event",
  ) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const v: Record<string, unknown> = Object.fromEntries(f);
    void run(async () => {
      if (kind === "review") {
        v.policy_hash = report?.policy_hash;
        await request("/admission/review", v);
      }
      if (kind === "audit") {
        for (const k of [
          "keywords_per_brand",
          "pages_per_keyword",
          "runs_per_day",
          "monthly_budget",
        ])
          v[k] = Number(f.get(k));
        for (const k of ["storage_allowed", "automated_access_allowed"])
          v[k] = f.get(k) === "on";
        v.metrics = f.getAll("metrics");
        await request("/admission/audits", v);
      }
      if (kind === "trial") {
        for (const k of [
          "requests",
          "successes",
          "completeness",
          "duplicate_rate",
          "max_delay_minutes",
          "cost_yuan",
        ])
          v[k] = Number(f.get(k));
        v.brand_ids = f.getAll("brand_ids");
        await request("/admission/trials", v);
      }
      if (kind === "event") {
        if (!eventId || !eventState) throw new Error("请先读取当前事件");
        v.event_fingerprint = eventState.event_fingerprint;
        v.price_yuan =
          f.get("price_yuan") === "" ? null : Number(f.get("price_yuan"));
        v.stores = f.get("store_name")
          ? [
              {
                name: f.get("store_name"),
                address: f.get("store_address"),
                region_code: "310000",
                evidence_url: f.get("evidence_url"),
              },
            ]
          : [];
        delete v.store_name;
        delete v.store_address;
        await request(`/events/${eventId}/admission`, v);
        setEventState(await request(`/events/${eventId}/admission`));
      }
    });
  }
  if (!report)
    return (
      <section className="panel">
        <p role={error ? "alert" : "status"}>{error || "正在检查准入条件…"}</p>
        <button type="button" onClick={() => run(refresh)}>
          重新读取
        </button>
      </section>
    );
  return (
    <section className="panel">
      <h2>产品口径与数据准入</h2>
      <p>仅上海 · 品牌 × 事件 × 地域 × 预测时点 · 未来72小时</p>
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="message">
          {notice}
        </p>
      )}
      <article className="record">
        <h3>正式概率：未开放</h3>
        {report.publication.reasons.map((r) => (
          <p key={r}>{r}</p>
        ))}
        <p>72小时爆款率和抢跑指数保持未知，不将观察分换成百分比。</p>
      </article>
      <article className="record">
        <h3>品牌库验收：{report.brands.verified} / 最低150，目标200</h3>
        <p>
          已录入 {report.brands.total}{" "}
          个；只有启用、已核验且有关键词的独立品牌参与统计。
        </p>
        {report.brands.categories.map((c) => (
          <p key={c.name}>
            {c.name}：{c.verified} / 建议{c.target}，建议缺口
            {Math.max(0, c.target - c.verified)}
          </p>
        ))}
        <p>
          疑似同名或别名冲突：{report.brands.duplicate_candidates.length}
          组（人工确认，不自动合并）。
        </p>
        {report.brands.duplicate_candidates.map((c) => (
          <p key={c.a + c.b}>{c.names.join(" / ")}</p>
        ))}
      </article>
      <h3>关键来源准入</h3>
      <p>
        要求同来源口径包含需求、内容数和独立作者数。当前版本采用上海全量小时数据；样本数据可保存，但须另行验证模型口径。下方通过仅表示人工证据登记满足规则，须对照真实响应验收。
      </p>
      {!report.sources.length && <p>尚未登记数据源。</p>}
      {report.sources.map((s) => (
        <article key={s.id} className="record">
          <h3>
            {s.name} · {s.passed ? "登记证据符合准入规则" : "未通过"}
          </h3>
          {s.reasons.map((r) => (
            <p key={r}>{r}</p>
          ))}
          <p>
            200品牌预估日调用：{s.projected_daily_calls ?? "未知"}；预估月成本：
            {s.projected_monthly_cost?.toFixed(2) ?? "未知"}元。
          </p>
        </article>
      ))}
      <details>
        <summary>查看固定口径与初版配置</summary>
        <p>
          版本：{policy.version}；配置摘要：{report.policy_hash}；
          {report.policy_reviewed ? "已有人工评审记录" : "尚未人工评审"}。
        </p>
        <p>
          事件分类：{policy.event_types.join("、")}
          。全国活动必须提供上海门店、地址、价格条件与有效期。食品安全、负面舆情、虚假优惠、缺货或风险未知均退出自动推荐；证据过期或事件更正后重新核验。
        </p>
        <p>
          L1标签：28天基线至少14个有效日，滚动24小时需求达到max(3倍基线,训练期90分位)，内容至少20、作者至少10，连续两个6小时网格满足，确认点位于未来72小时内。缺测为unknown；迟到宽限24小时。
        </p>
        <p>
          八因子权重：
          {Object.entries(policy.features.weights)
            .map(([k, v]) => `${k} ${v}%`)
            .join("，")}
          。不重分配缺失权重；日级数据不插值为小时；仅使用预测时点已可用信息。
        </p>
        <p>
          饱和度取内容供给百分位与头部内容占比的均值。头部阈值和参考分布尚无真实训练样本，当前不计算。规则分减20×饱和度；抢跑指数=100×校准概率×(1−饱和度)。
        </p>
        <p>
          规则告警≥70分；正式告警概率≥0.65、抢跑≥45、覆盖≥90%，相隔1小时确认两次，24小时去重、每日最多5条，22—08点免打扰。外部通知默认关闭。
        </p>
        <p>
          独立轻量观察分：官方72小时新品35、核实公开优惠30、上海参与20、视觉新鲜度15。每项须有证据；未知不评分；不触发告警，未经效果验证。
        </p>
      </details>
      <details>
        <summary>评审并确认当前口径版本</summary>
        <form onSubmit={(e) => submit(e, "review")}>
          <p>记录人工评审，不会启用概率发布；训练阈值仍需真实数据冻结。</p>
          <Fields items={common} />
          <button disabled={busy}>记录评审</button>
        </form>
      </details>
      <details>
        <summary>登记真实账户实测证据</summary>
        <form onSubmit={(e) => submit(e, "audit")}>
          <label>
            来源
            <select name="source_id" required>
              <option value="">请选择</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <Fields
            items={[
              ["account_reference", "脱敏账户标识（不填密钥）", "text"],
              ["endpoint", "接口文档或端点链接", "url"],
              ["observed_at", "实际调用时间（带时区ISO格式）", "text"],
              ["platform", "平台名称", "text"],
              ["field_mapping", "需求、内容数、作者数的字段和单位", "text"],
              ["coverage_definition", "覆盖范围、采样方式和去重口径", "text"],
              ["keywords_per_brand", "每品牌关键词数", "number"],
              ["pages_per_keyword", "每词分页数", "number"],
              ["runs_per_day", "每日轮次", "number"],
              ["monthly_budget", "200品牌月预算（元）", "number"],
              ...proof,
              ...common,
            ]}
          />
          <label>
            已实测指标
            <select name="metrics" multiple required>
              <option value="demand">需求</option>
              <option value="contents">内容数</option>
              <option value="authors">独立作者数</option>
            </select>
          </label>
          <label>
            <input
              style={{ width: "auto" }}
              type="checkbox"
              name="storage_allowed"
            />
            凭证明确允许保存数据
          </label>
          <label>
            <input
              style={{ width: "auto" }}
              type="checkbox"
              name="automated_access_allowed"
            />
            凭证明确允许自动调用
          </label>
          <button disabled={busy}>保存实测记录</button>
        </form>
      </details>
      <details>
        <summary>登记连续7天验证日报</summary>
        <p>
          须从账户实测登记日开始，连续记录7个完整自然日；不允许补填登记前的日期。10—20个已核验品牌覆盖至少3个品类，七天保持一致。成功率和完整率≥95%，重复率≤5%，最大延迟≤360分钟。
        </p>
        <form onSubmit={(e) => submit(e, "trial")}>
          <label>
            实测批次
            <select name="audit_id" required>
              <option value="">请选择</option>
              {audits.map((a) => (
                <option key={a.id} value={a.id}>
                  {sources.find((s) => s.id === a.config.source_id)?.name} ·{" "}
                  {a.config.observed_at}
                </option>
              ))}
            </select>
          </label>
          <label>
            试点品牌（多选10—20个）
            <select name="brand_ids" multiple required size={8}>
              {brands
                .filter((b) => b.active && b.review_status === "verified")
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} · {b.category}
                  </option>
                ))}
            </select>
          </label>
          <Fields
            items={[
              ["day", "上海自然日", "date"],
              ["requests", "请求总数", "number"],
              ["successes", "成功次数", "number"],
              ["completeness", "字段完整率（0—1）", "number"],
              ["duplicate_rate", "重复率（0—1）", "number"],
              ["max_delay_minutes", "最大延迟（分钟）", "number"],
              ["cost_yuan", "当日增量成本（元，不含固定月费）", "number"],
              ...proof,
              ...common,
            ]}
          />
          <button disabled={busy}>保存日报</button>
        </form>
      </details>
      <details>
        <summary>全国活动上海参与与风险核验</summary>
        <label>
          选择事件
          <select
            value={eventId}
            disabled={busy}
            onChange={(e) => {
              setEventId(e.target.value);
              setEventState(null);
            }}
          >
            <option value="">请选择</option>
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.brand_name} · {e.title}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={busy || !eventId}
          onClick={() =>
            run(async () =>
              setEventState(await request(`/events/${eventId}/admission`)),
            )
          }
        >
          读取当前版本
        </button>
        {eventState && (
          <>
            <p>
              {eventState.local_candidate
                ? "上海可参与候选（不自动推荐）"
                : eventState.local_review_valid
                  ? "已有有效核验，未满足可参与候选条件"
                  : "未核验、过期或事件已更正"}
              ；历史记录{eventState.history.length}条。
            </p>
            <form
              key={eventId + eventState.event_fingerprint}
              onSubmit={(e) => submit(e, "event")}
            >
              <label>
                上海参与
                <select name="participation">
                  <option value="unknown">未知</option>
                  <option value="available">可参与</option>
                  <option value="unavailable">不可参与</option>
                </select>
              </label>
              <label>
                风险
                <select name="risk">
                  <option value="unknown">未排查</option>
                  <option value="none">已排查无上述风险</option>
                  <option value="food_safety">食品安全</option>
                  <option value="negative_sentiment">负面舆情</option>
                  <option value="false_discount">虚假优惠</option>
                  <option value="out_of_stock">缺货</option>
                </select>
              </label>
              <label>
                上海适用门店
                <input name="store_name" />
              </label>
              <label>
                上海门店地址
                <input name="store_address" />
              </label>
              <label>
                已核实价格（元，未知留空）
                <input name="price_yuan" type="number" min="0" step="0.01" />
              </label>
              <Fields
                items={[
                  ["conditions", "适用时间、价格门槛与参与限制", "text"],
                  ["evidence_url", "上海参与与风险证据链接", "url"],
                  ["valid_until", "本次核验有效期（带时区ISO格式）", "text"],
                  ...common,
                ]}
              />
              <button disabled={busy}>记录核验</button>
            </form>
          </>
        )}
      </details>
      <button type="button" disabled={busy} onClick={() => run(refresh)}>
        重新检查准入状态
      </button>
    </section>
  );
}
