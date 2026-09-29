import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  brandInput,
  researchEvidenceInput,
} from "../packages/contracts/dist/index.js";

// Local API only. Does not query Douyin or alter collector settings.
const argument = (name) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`Missing value: ${name}`);
  return pathToFileURL(resolve(value));
};
const customCatalog = argument("--catalog");
const customReport = argument("--report");
if (customCatalog && process.argv.includes("--apply") && !customReport)
  throw new Error("Custom catalog requires --report when applying");
const file =
  customCatalog ||
  new URL(
    "../catalog/shanghai-brand-expansion-2026-09-29.json",
    import.meta.url,
  );
const catalog = JSON.parse(await readFile(file, "utf8"));
const apply = process.argv.includes("--apply");
if (apply)
  throw new Error(
    "目录命中直接入库已停用。请使用 reconcile-dianping-selection.mjs，按分类人气前100且有团购标记筛选后更新品牌池。",
  );
const base = "http://127.0.0.1:3001/v1";
const normalize = (value) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s_]+/gu, "");
async function api(path, body) {
  const response = await fetch(
    base + path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(`${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
const before = (await api("/brands")).items;
const names = new Map();
for (const brand of before)
  for (const name of [brand.name, ...brand.aliases])
    names.set(normalize(name), brand);
const plannedNames = new Map();
const planned = catalog.brands.map((brand) => {
  const input = brandInput.parse({
    name: brand.name,
    category: brand.category,
    aliases: brand.aliases,
    keywords: brand.keywords,
    active: brand.active,
    shanghai_evidence_url: brand.shanghai_evidence_url,
  });
  const evidence = brand.evidence.map(({ source_id, ...item }) =>
    researchEvidenceInput.parse(item),
  );
  for (const name of [brand.name, ...brand.aliases]) {
    const key = normalize(name);
    if (plannedNames.has(key) && plannedNames.get(key) !== brand.name)
      throw new Error(`Batch alias collision: ${name}`);
    plannedNames.set(key, brand.name);
  }
  const matches = [
    ...new Set(
      [brand.name, ...brand.aliases]
        .map((name) => names.get(normalize(name)))
        .filter(Boolean),
    ),
  ];
  if (matches.length > 1) throw new Error(`Ambiguous identity: ${brand.name}`);
  return { brand, input, evidence, existing: matches[0] };
});
const report = {
  batch: catalog.batch,
  applied: apply,
  started_at: new Date().toISOString(),
  before_total: before.length,
  before_active: before.filter((b) => b.active).length,
  created: 0,
  existing: 0,
  evidence: 0,
  records: [],
};
if (!apply) {
  console.log(
    JSON.stringify({
      mode: "preview",
      new: planned.filter((p) => !p.existing).length,
      existing: planned.filter((p) => p.existing).length,
      new_active: planned.filter((p) => !p.existing && p.input.active).length,
      new_inactive: planned.filter((p) => !p.existing && !p.input.active)
        .length,
      evidence: planned.reduce((n, p) => n + p.evidence.length, 0),
    }),
  );
} else {
  const reportFile =
    customReport ||
    new URL(
      "../catalog/brand-expansion-import-2026-09-29.json",
      import.meta.url,
    );
  for (const item of planned) {
    // Do not overwrite existing edits, review decisions, or active state.
    const saved = item.existing || (await api("/brands", item.input));
    if (item.existing) report.existing++;
    else report.created++;
    // Evidence endpoints are content-hash idempotent using the fixed observation timestamp.
    for (const evidence of item.evidence) {
      await api(`/brands/${saved.id}/evidence`, evidence);
      report.evidence++;
    }
    report.records.push({
      name: saved.name,
      id: saved.id,
      created: !item.existing,
      active: saved.active,
    });
    await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
  }
  const after = (await api("/brands")).items;
  report.after_total = after.length;
  report.after_active = after.filter((b) => b.active).length;
  report.finished_at = new Date().toISOString();
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report, records: undefined }));
}
