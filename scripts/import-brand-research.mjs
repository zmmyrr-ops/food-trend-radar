import { readFile, writeFile } from "node:fs/promises";

const catalog = JSON.parse(
  await readFile(
    new URL("../catalog/shanghai-brands.json", import.meta.url),
    "utf8",
  ),
);
const base = "http://127.0.0.1:3001/v1";
async function api(path, body) {
  const r = await fetch(
    base + path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const d = await r.json();
  if (!r.ok) throw new Error(`${path}: ${JSON.stringify(d)}`);
  return d;
}
const existing = (await api("/brands")).items;
const normalized = (s) => s.normalize("NFKC").trim().toLowerCase();
const map = new Map(existing.map((b) => [normalized(b.name), b]));
const report = {
  created: 0,
  existing: 0,
  reviewed: 0,
  evidence: 0,
  records: [],
};
for (const b of catalog.brands) {
  let saved = map.get(normalized(b.name));
  const isNew = !saved;
  if (!saved) {
    saved = await api("/brands", {
      name: b.name,
      category: b.category,
      aliases: b.aliases,
      keywords: b.keywords,
      shanghai_evidence_url: b.shanghai_evidence_url,
      active: true,
    });
    map.set(normalized(b.name), saved);
    report.created++;
  } else report.existing++;
  for (const e of b.evidence) {
    await api(`/brands/${saved.id}/evidence`, {
      source_title: catalog.sources[e.source_id].title,
      url: e.url,
      source_name: e.source_name,
      location: e.mall_or_address,
      position: e.position,
      evidence_type: e.evidence_type,
      published_at: e.published_at,
      observed_at: e.retrieved_at,
      research_status: b.research_status,
      note: b.review_note,
    });
    report.evidence++;
  }
  // Do not overwrite an existing human decision or edited record on reruns.
  if (isNew && b.research_status === "directory_checked") {
    await api(`/brands/${saved.id}/review`, {
      revision: saved.revision,
      decision: "verified",
      reviewer: "Codex公开目录资料核对",
      note: b.review_note + " 证据：" + b.shanghai_evidence_url,
    });
    report.reviewed++;
  }
  report.records.push({
    name: b.name,
    id: saved.id,
    research_status: b.research_status,
  });
}
await writeFile(
  new URL("../catalog/import-report.json", import.meta.url),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify({ ...report, records: undefined }));
