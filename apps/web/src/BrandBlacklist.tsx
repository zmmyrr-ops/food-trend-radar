import { useEffect, useState } from "react";
import { visitRequest } from "./VisitPlans";

type Brand = { brand_id: string; name: string };
export function BrandBlacklist({ onChange }: { onChange: () => void }) {
  const [items, setItems] = useState<Brand[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    void visitRequest("brand-blacklist")
      .then((d) => setItems(d.items))
      .catch(() => setError("黑名单加载失败，请刷新重试"));
  }, []);
  useEffect(() => {
    let alive = true;
    setResults([]);
    setSearching(Boolean(query.trim()));
    const timer = setTimeout(async () => {
      if (!query.trim()) return;
      try {
        const d = await visitRequest(
          `brand-blacklist/search?q=${encodeURIComponent(query.trim())}`,
        );
        if (alive) setResults(d.items);
      } catch {
        if (alive) setError("品牌搜索失败，请重试");
      } finally {
        if (alive) setSearching(false);
      }
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);
  async function update(brand: Brand, blocked: boolean) {
    setBusy(true);
    setError("");
    try {
      await visitRequest("brand-blacklist", "POST", {
        brand_id: brand.brand_id,
        blocked,
      });
      setItems((old) =>
        blocked
          ? [...old.filter((b) => b.brand_id !== brand.brand_id), brand]
          : old.filter((b) => b.brand_id !== brand.brand_id),
      );
      onChange();
    } catch {
      setError("保存失败，请重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="brand-blacklist">
      <summary>
        品牌黑名单{items.length > 0 ? ` · ${items.length}` : ""}
      </summary>
      <div className="blacklist-body">
        <p>不再向你推荐这些品牌的优先券，可随时移除。</p>
        <input
          aria-label="搜索黑名单品牌"
          placeholder="输入品牌名或别名…"
          maxLength={80}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setError("");
          }}
        />
        {error && <p role="alert">{error}</p>}
        {query.trim() && (
          <div className="blacklist-results" aria-live="polite">
            {searching ? (
              <p>搜索中…</p>
            ) : !results.length ? (
              <p>未找到匹配品牌</p>
            ) : (
              results.map((b) => {
                const blocked = items.some((x) => x.brand_id === b.id);
                return (
                  <div key={b.id}>
                    <span>{b.name}</span>
                    <button
                      disabled={busy || blocked}
                      onClick={() =>
                        void update({ brand_id: b.id, name: b.name }, true)
                      }
                    >
                      {blocked ? "已添加" : "加入黑名单"}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}
        <div className="blacklist-tags">
          {items.map((b) => (
            <button
              key={b.brand_id}
              disabled={busy}
              aria-label={`移除${b.name}`}
              onClick={() => void update(b, false)}
            >
              {b.name}
              <span aria-hidden="true"> ×</span>
            </button>
          ))}
        </div>
        {!items.length && <small>尚未添加品牌</small>}
      </div>
    </details>
  );
}
