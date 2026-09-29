import { mkdir, readFile, writeFile } from "node:fs/promises";

const base = "http://127.0.0.1:3001";
const config = JSON.parse(
  await readFile(
    new URL("../catalog/brand-identity-corrections.json", import.meta.url),
    "utf8",
  ),
);
async function request(path, body) {
  const r = await fetch(
    `${base}${path}`,
    body
      ? {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  if (!r.ok) throw new Error(`LOCAL_API_${r.status}`);
  return r.json();
}
const brands = (await request("/v1/brands")).items;
const normalize = (s) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s·•]/g, "");
const plans = config.corrections.map((c) => {
  const b = brands.find((b) => b.id === c.brand_id);
  if (!b || ![c.expected_name, c.name].includes(b.name))
    throw new Error(`BRAND_CHANGED_${c.brand_id}`);
  const aliases = [
    ...new Set([
      ...b.aliases,
      ...c.aliases,
      ...(b.name !== c.name ? [b.name] : []),
    ]),
  ].filter((a) => normalize(a) !== normalize(c.name));
  for (const other of brands.filter((x) => x.id !== b.id)) {
    const names = [other.name, ...other.aliases].map(normalize);
    if ([c.name, ...aliases].some((n) => names.includes(normalize(n))))
      throw new Error(`ALIAS_CONFLICT_${c.brand_id}_${other.id}`);
  }
  if (
    c.excluded_from_aliases.some((a) =>
      aliases.map(normalize).includes(normalize(a)),
    )
  )
    throw new Error(`EXCLUDED_ALIAS_${c.brand_id}`);
  const body = {
    name: c.name,
    category: b.category,
    aliases,
    shanghai_evidence_url: b.shanghai_evidence_url,
    active: b.active,
    keywords: b.keywords,
  };
  return {
    id: b.id,
    before: { name: b.name, aliases: b.aliases },
    body,
    source_url: c.source_url,
    changed:
      b.name !== c.name ||
      JSON.stringify(b.aliases) !== JSON.stringify(aliases),
  };
});
// Read only local snapshots to estimate the effect; never rewrite historical identity.
if (process.argv.includes("--impact")) {
  for (const p of plans.filter((p) => p.changed)) {
    let offset = 0,
      total = 0,
      before = 0,
      after = 0;
    const names = [p.body.name, ...p.body.aliases].map(normalize);
    do {
      const page = await request(
        `/api/v3/opportunities?brand_id=${p.id}&limit=100&offset=${offset}`,
      );
      total = page.total;
      for (const item of page.items) {
        if (item.payload.identity === "name_match") before++;
        if (names.includes(normalize(item.payload.platform_brand_name || "")))
          after++;
      }
      if (!page.items.length) break;
      offset += page.items.length;
    } while (offset < total);
    p.impact = {
      snapshot_products: total,
      scanned: offset,
      stored_name_matches: before,
      proposed_name_matches: after,
      caveat: "对已有快照的精确名称重算，不代表新增实采或身份核验通过",
    };
  }
}
const apply = process.argv.includes("--apply");
const results = [];
for (const p of plans) {
  if (apply && p.changed) await request(`/v1/brands/${p.id}`, p.body);
  results.push({
    id: p.id,
    before: p.before,
    after: { name: p.body.name, aliases: p.body.aliases },
    changed: p.changed,
    source_url: p.source_url,
    impact: p.impact,
  });
}
if (apply) {
  await mkdir(new URL("../data/reports/", import.meta.url), {
    recursive: true,
  });
  await writeFile(
    new URL(
      `../data/reports/brand-corrections-${Date.now()}.json`,
      import.meta.url,
    ),
    JSON.stringify(
      { at: new Date().toISOString(), version: config.version, results },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
console.log(
  JSON.stringify({ mode: apply ? "applied" : "preview", results }, null, 2),
);
