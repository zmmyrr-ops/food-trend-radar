import { readFile, writeFile } from "node:fs/promises";
import {
  brandInput,
  leisureCategories,
  researchEvidenceInput,
} from "../packages/contracts/dist/index.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const base = arg("--base", "http://127.0.0.1:3011");
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))
  throw Error("Use the local service API");
const file = arg("--catalog", "catalog/shanghai-leisure-2026-09-30.json");
const reportFile = arg("--report", "/tmp/leisure-import-report.json");
const apply = process.argv.includes("--apply");
const catalog = JSON.parse(await readFile(file, "utf8"));
const norm = (s) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s_]+/gu, "");
async function api(path, body, method = "POST") {
  const r = await fetch(
    base + path,
    body
      ? {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  const d = await r.json();
  if (!r.ok) throw Error(`${path}: ${r.status} ${JSON.stringify(d)}`);
  return d;
}
const before = (await api("/v1/brands")).items;
const byName = new Map();
for (const b of before)
  for (const n of [b.name, ...b.aliases]) {
    const k = norm(n);
    byName.set(k, [...(byName.get(k) || []), b]);
  }
const batchNames = new Set();
const planned = catalog.brands.map(({ evidence, ...raw }) => {
  const input = brandInput.parse(raw);
  if (!leisureCategories.includes(input.category))
    throw Error("Non-leisure entry");
  for (const n of [input.name, ...input.aliases]) {
    const k = norm(n);
    if (batchNames.has(k)) throw Error(`Batch collision: ${n}`);
    batchNames.add(k);
  }
  const matches = new Map(
    [input.name, ...input.aliases].flatMap((n) =>
      (byName.get(norm(n)) || []).map((b) => [b.id, b]),
    ),
  );
  if (matches.size > 1) throw Error(`Ambiguous existing brand: ${input.name}`);
  return {
    input,
    evidence: evidence.map((e) => researchEvidenceInput.parse(e)),
    existing: [...matches.values()][0],
  };
});
const report = {
  batch: catalog.batch,
  applied: apply,
  before_total: before.length,
  before_active: before.filter((b) => b.active).length,
  created: 0,
  existing: 0,
  records: [],
};
for (const row of planned) {
  if (!apply) continue;
  const saved = row.existing || (await api("/v1/brands", row.input));
  if (row.existing) report.existing++;
  else report.created++;
  // Never reclassify or reactivate an existing reviewed brand silently.
  for (const e of row.evidence) await api(`/v1/brands/${saved.id}/evidence`, e);
  report.records.push({
    id: saved.id,
    name: saved.name,
    category: saved.category,
    active: saved.active,
    created: !row.existing,
  });
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
}
if (apply) {
  const after = (await api("/v1/brands")).items;
  report.after_total = after.length;
  report.after_active = after.filter((b) => b.active).length;
  report.finished_at = new Date().toISOString();
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
}
console.log(
  JSON.stringify({
    ...report,
    records: undefined,
    planned: planned.length,
    new: planned.filter((x) => !x.existing).length,
  }),
);
