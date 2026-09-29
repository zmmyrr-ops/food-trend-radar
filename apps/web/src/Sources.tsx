import { type DataSource, sourceInput } from "@radar/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { appFetch } from "./app-url";

async function request<T>(url: string, body?: unknown): Promise<T> {
  const r = await appFetch(
    `/v1${url}`,
    body
      ? {
          method: url.split("/").length > 2 ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message ?? "请求失败");
  return data;
}
const fields = [
  ["name", "来源名称", "text"],
  ["url", "来源页面", "url"],
  ["owner", "授权主体", "text"],
  ["purpose", "使用目的", "text"],
  ["authorization_url", "授权或用途许可凭证链接", "url"],
  [
    "expires_at",
    "授权到期时间（含时区，例如 2027-01-01T00:00:00+08:00）",
    "text",
  ],
  ["delay_minutes", "预计延迟（分钟，未知留空）", "number"],
  ["daily_quota", "每日配额（未知留空）", "number"],
  ["monthly_cost", "每月成本（元，未知留空）", "number"],
  ["retention_days", "保留天数", "number"],
] as const;
const choices = [
  [
    "coverage",
    "覆盖口径",
    [
      ["manual_sample", "人工搜索样本"],
      ["authorized_sample", "授权样本"],
      ["full", "全量"],
    ],
  ],
  [
    "geography",
    "地域范围",
    [
      ["shanghai", "上海"],
      ["national", "全国（不能替代上海热度）"],
    ],
  ],
  [
    "granularity",
    "时间粒度",
    [
      ["event", "事件"],
      ["day", "日级"],
      ["hour", "小时级"],
    ],
  ],
  [
    "authorization",
    "授权核验",
    [
      ["pending", "待核验"],
      ["approved", "已核验许可"],
      ["revoked", "已撤销"],
    ],
  ],
] as const;
export function Sources() {
  const [items, setItems] = useState<DataSource[]>([]),
    [edit, setEdit] = useState<DataSource | null>(null);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<
    { id: string; snapshot: { config: DataSource }; created_at: string }[]
  >([]);
  const refresh = async () =>
    setItems((await request<{ items: DataSource[] }>("/sources")).items);
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const raw: Record<string, unknown> = Object.fromEntries(f);
      for (const k of ["delay_minutes", "daily_quota", "monthly_cost"])
        raw[k] = f.get(k) === "" ? null : Number(f.get(k));
      raw.retention_days = Number(f.get("retention_days"));
      raw.authorization_url = f.get("authorization_url") || null;
      raw.expires_at = f.get("expires_at") || null;
      for (const k of ["display_allowed", "training_allowed", "enabled"])
        raw[k] = f.get(k) === "on";
      const v = sourceInput.parse(raw);
      await request(edit ? `/sources/${edit.id}` : "/sources", v);
      await refresh();
      setEdit(null);
      form.reset();
      setNotice("来源已保存。登记许可不代表已完成真实接口验证。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workspace">
      <section className="panel">
        <h2>{edit ? "编辑数据源" : "登记数据源"}</h2>
        <p>
          记录许可和覆盖口径；未接入自动采集。凭证只填链接，不填写密码或访问密钥。
        </p>
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
        <form key={edit?.id ?? "new"} onSubmit={submit}>
          {fields.map(([name, label, type]) => (
            <label key={name}>
              {label}
              <input
                name={name}
                type={type}
                min={type === "number" ? "0" : undefined}
                step={name === "monthly_cost" ? "0.01" : undefined}
                required={[
                  "name",
                  "url",
                  "owner",
                  "purpose",
                  "retention_days",
                ].includes(name)}
                defaultValue={
                  edit?.[name] ?? (name === "retention_days" ? 90 : "")
                }
              />
            </label>
          ))}
          {choices.map(([name, label, options]) => (
            <label key={name}>
              {label}
              <select name={name} defaultValue={edit?.[name] ?? options[0][0]}>
                {options.map(([value, title]) => (
                  <option key={value} value={value}>
                    {title}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <label>
            核验记录
            <textarea
              name="verification_note"
              maxLength={2000}
              defaultValue={edit?.verification_note}
              placeholder="许可范围、字段、账户实测结果及核验人；未知请明确记录"
            />
          </label>
          {(
            [
              ["display_allowed", "允许在工作台展示"],
              ["training_allowed", "允许模型训练"],
              ["enabled", "启用来源"],
            ] as const
          ).map(([name, label]) => (
            <label key={name}>
              <input
                style={{ width: "auto" }}
                type="checkbox"
                name={name}
                defaultChecked={edit?.[name] ?? false}
              />
              {label}
            </label>
          ))}
          <button disabled={busy} type="submit">
            保存来源
          </button>
          {edit && (
            <button
              type="button"
              className="secondary"
              onClick={() => setEdit(null)}
            >
              取消编辑
            </button>
          )}
        </form>
      </section>
      <section className="panel">
        <h2>来源与许可核验</h2>
        <p>
          准入提示仅检查启用、授权期限和展示许可。模型训练须另行检查训练许可；真实采集仍须完成数据门禁。
        </p>
        {!items.length && (
          <p className="empty">
            尚无登记来源。可以先登记人工录入所依据的官方公告。
          </p>
        )}
        {items.map((s) => (
          <article key={s.id} className="record">
            <h3>{s.name}</h3>
            <p>
              {s.gate.eligible
                ? "登记许可有效（未验证采集）"
                : s.gate.reasons.join("；")}
            </p>
            <p>
              {s.geography === "shanghai" ? "上海" : "全国"} ·{" "}
              {choices[0][2].find((x) => x[0] === s.coverage)?.[1]} ·{" "}
              {s.granularity === "hour"
                ? "小时级"
                : s.granularity === "day"
                  ? "日级"
                  : "事件"}
            </p>
            <p>
              训练许可：{s.training_allowed ? "允许" : "未允许"}；到期：
              {s.expires_at ?? "未知"}
            </p>
            <p>{s.verification_note || "暂无核验记录"}</p>
            <a href={s.url} target="_blank" rel="noreferrer">
              查看来源 ↗
            </a>
            <div className="buttons">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setEdit(s);
                  setHistory([]);
                }}
              >
                编辑与核验
              </button>
              <button
                type="button"
                className="secondary"
                onClick={async () => {
                  try {
                    setHistory(
                      (
                        await request<{ items: typeof history }>(
                          `/sources/${s.id}/history`,
                        )
                      ).items,
                    );
                    setNotice("已读取该来源的更正历史");
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "读取失败");
                  }
                }}
              >
                更正历史
              </button>
            </div>
          </article>
        ))}
        {history.map((h) => (
          <article className="record" key={h.id}>
            <h3>更正前：{h.snapshot.config.name}</h3>
            <p>{h.created_at}</p>
            <p>
              原授权：{h.snapshot.config.authorization}；原到期：
              {h.snapshot.config.expires_at ?? "未知"}
            </p>
            <p>{h.snapshot.config.verification_note || "无核验记录"}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
