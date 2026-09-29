import { useEffect, useState } from "react";
import { appFetch } from "./app-url";

type Report = {
  total: number;
  generated_at: string;
  source: {
    reason: string;
    caveat: string;
    documentation_url: string;
    required_fields: string[];
  };
  items: {
    plan_id: string;
    brand_name: string;
    title: string;
    queries: { keyword: string; url: string }[];
    match_requirements: string[];
  }[];
};
export function CreatorSearchPanel({ brandId }: { brandId: string }) {
  const [data, setData] = useState<Report | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false,
      loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const r = await appFetch(
          `/api/v3/creator-search${brandId ? `?brand_id=${encodeURIComponent(brandId)}` : ""}`,
        );
        if (!r.ok) throw Error();
        const next = await r.json();
        if (!cancelled) {
          setData(next);
          setError("");
        }
      } catch {
        if (!cancelled) setError("检索准备状态读取失败，已有内容可能过期。");
      } finally {
        loading = false;
      }
    }
    setData(null);
    void load();
    const timer = setInterval(() => void load(), 60000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [brandId]);
  return (
    <section aria-label="达人覆盖验证">
      <h2>同券达人覆盖</h2>
      <p>
        自动采集尚未接通 · 达人数、视频数及发布增速：未知 · 扣分范围：0—30 分。
      </p>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <p>{data.source.reason}</p>
          <p>{data.source.caveat}</p>
          <details>
            <summary>查看自动检索准备（{data.total} 张机会券）</summary>
            <p>
              检索词随当前机会券生成，无须日常人工录入。下面的网页链接仅用于来源验证，打开不代表后台已完成搜索。
            </p>
            {data.items.map((x) => (
              <article key={x.plan_id}>
                <h3>
                  {x.brand_name} · {x.title}
                </h3>
                <ul>
                  {x.queries.map((q) => (
                    <li key={q.keyword}>
                      <a href={q.url} target="_blank" rel="noreferrer">
                        {q.keyword}
                      </a>
                    </li>
                  ))}
                </ul>
                <p>{x.match_requirements.join("；")}。</p>
              </article>
            ))}
            {!data.total && <p>当前没有符合条件的待检索机会券。</p>}
            <p>接入所需字段：{data.source.required_fields.join("、")}。</p>
            <a
              href={data.source.documentation_url}
              target="_blank"
              rel="noreferrer"
            >
              官方搜索接口说明
            </a>
          </details>
        </>
      )}
    </section>
  );
}
