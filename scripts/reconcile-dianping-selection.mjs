import { readFile, writeFile } from "node:fs/promises";
import {
  brandInput,
  researchEvidenceInput,
} from "../packages/contracts/dist/index.js";

// Reconcile the operational pool only after every category has completed.
// Historical brands/coupons are retained; no external collector is started.
const root = new URL("../", import.meta.url);
const read = async (name) =>
  JSON.parse(await readFile(new URL(name, root), "utf8"));
const write = async (name, data) =>
  writeFile(new URL(name, root), JSON.stringify(data, null, 2) + "\n");
const policy = await read("catalog/dianping-admission-policy-2026-09-29.json");
const core = await read("catalog/core-brands-309.json");
const coreIds = new Set(core.protected_ids);
const raw = await read("catalog/dianping-category-popularity-2026-09-29.json");
const apply = process.argv.includes("--apply");
if (apply && !raw.complete)
  throw new Error("分类采集未完成，不允许替换启用品牌池；只能生成候选名单");
const verifiedPrefixOnly = process.argv.includes("--verified-prefix-only");
const normalize = (value) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s_]+/gu, "");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
assert(raw.policy === policy.policy, "Admission policy mismatch");
assert(
  raw.complete || verifiedPrefixOnly,
  "Category collection incomplete; reconciliation blocked",
);
assert(
  verifiedPrefixOnly || raw.categories.length === policy.categories.length,
  "Category coverage mismatch",
);
const expectedCategories = new Set(policy.categories.map((c) => c.id));
const seenCategories = new Set();
const selected = new Map();
const categoryMap = {
  132: "咖啡",
  117: "烘焙甜品",
  34236: "茶饮果饮",
  110: "火锅烧烤",
  508: "火锅烧烤",
  34303: "火锅烧烤",
  112: "中式快餐小吃",
  215: "中式快餐小吃",
  32725: "中式快餐小吃",
};
const otherCategories = new Set([
  "113",
  "114",
  "115",
  "116",
  "111",
  "118",
  "2714",
  "33759",
  "234",
  "2797",
]);
for (const category of raw.categories) {
  assert(
    expectedCategories.has(category.id) && !seenCategories.has(category.id),
    "Unexpected or duplicate category",
  );
  seenCategories.add(category.id);
  assert(
    verifiedPrefixOnly || (category.complete && !category.error),
    `Incomplete category: ${category.name}`,
  );
  // A verified prefix still proves ranks <=100. Unknown categories never qualify.
  assert(
    category.pages.length > 0 &&
      category.pages.every((p, index) => p.page === index + 1),
    "Missing ranking prefix page",
  );
  assert(
    category.brands.length <= 100 &&
      category.pages.every((p) => p.sort_verified),
    "Invalid rank or sort evidence",
  );
  const keys = new Set();
  for (const [index, brand] of category.brands.entries()) {
    assert(
      brand.category_rank === index + 1 && !keys.has(normalize(brand.name)),
      "Duplicate brand or nonsequential rank",
    );
    keys.add(normalize(brand.name));
    const qualifying = brand.shops.filter(
      (shop) =>
        shop.has_group_deal &&
        shop.deals.some(
          (deal) =>
            deal.marker === "igroup" &&
            /^https?:\/\/t\.dianping\.com\/deal\/\d+$/.test(deal.url),
        ),
    );
    if (!qualifying.length) continue;
    const shop = qualifying[0];
    assert(
      category.pages.some(
        (p) => p.url === shop.ranking_url && p.page === shop.page,
      ),
      "Missing observed ranking page",
    );
    const key = normalize(brand.name);
    const record = selected.get(key) || {
      name: brand.name,
      category:
        categoryMap[category.id] ||
        (otherCategories.has(category.id) ? "其他餐饮" : "中餐及本地特色"),
      qualifications: [],
    };
    record.qualifications.push({
      category_id: category.id,
      category: category.name,
      brand_rank: brand.category_rank,
      shop_name: shop.name,
      shop_url: shop.url,
      ranking_url: shop.ranking_url,
      page: shop.page,
      page_position: shop.page_position,
      observed_at: category.pages.find((p) => p.page === shop.page).observed_at,
      deal: shop.deals.find((d) => d.marker === "igroup"),
    });
    selected.set(key, record);
  }
}
assert(
  selected.size > 0,
  "Empty selection; refusing to disable the entire pool",
);
async function api(path, body, method = "POST") {
  const response = await fetch(
    "http://127.0.0.1:3001/v1" + path,
    body === undefined
      ? undefined
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(`${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
const before = (await api("/brands")).items;
const names = new Map();
for (const brand of before)
  for (const name of [brand.name, ...brand.aliases]) {
    const key = normalize(name);
    const matches = names.get(key) || [];
    if (!matches.some((b) => b.id === brand.id)) matches.push(brand);
    names.set(key, matches);
  }
const plans = [...selected.values()].map((record) => {
  const matches = names.get(normalize(record.name)) || [];
  assert(matches.length <= 1, `Ambiguous stored identity: ${record.name}`);
  const existing = matches[0];
  const first = record.qualifications[0];
  const input = brandInput.parse(
    existing
      ? {
          name: existing.name,
          category: existing.category,
          aliases: existing.aliases,
          keywords: existing.keywords,
          active: true,
          shanghai_evidence_url: existing.shanghai_evidence_url,
        }
      : {
          name: record.name,
          category: record.category,
          aliases: [],
          keywords: [record.name],
          active: true,
          shanghai_evidence_url: first.shop_url,
        },
  );
  const evidence = record.qualifications.map((q) =>
    researchEvidenceInput.parse({
      source_title: `${q.category}人气前100品牌·第${q.brand_rank}名·有团购`,
      source_name: "大众点评上海分类人气列表",
      url: q.ranking_url,
      location: `上海；${q.shop_name}`,
      position: `${q.category}，品牌序位${q.brand_rank}，列表第${q.page}页第${q.page_position}店`,
      evidence_type: "current_directory",
      published_at: null,
      observed_at: q.observed_at,
      research_status: "directory_checked",
      note: `按页面人气排序、同品牌去重后的前100名；该入选门店显示igroup团购标记。团购链接：${q.deal.url}；门店：${q.shop_url}。仅证明大众点评目录团购标记，不代表抖音售券、当前可购买或热卖。`,
    }),
  );
  return { ...record, existing, input, evidence };
});
const keepIds = new Set([
  ...coreIds,
  ...plans.filter((p) => p.existing).map((p) => p.existing.id),
]);
const deactivate = before.filter((b) => b.active && !keepIds.has(b.id));
const manifest = {
  policy: policy.policy,
  prepared_at: new Date().toISOString(),
  collection_complete: raw.complete,
  verified_prefix_only: verifiedPrefixOnly,
  pending_categories: policy.categories
    .filter((c) => !raw.categories.some((r) => r.id === c.id && r.complete))
    .map((c) => ({ id: c.id, name: c.name })),
  category_count: raw.categories.length,
  selected_count: plans.length,
  categories: raw.categories.map((c) => ({
    id: c.id,
    name: c.name,
    top_brands: c.brands.length,
    selected: c.brands.filter((b) => b.shops.some((s) => s.has_group_deal))
      .length,
    complete: c.complete,
    stop_reason: c.stop_reason,
    error: c.error,
  })),
  selected: plans.map(({ existing, input, qualifications }) => ({
    existing_id: existing?.id ?? null,
    ...input,
    qualifications,
  })),
  deactivate: deactivate.map((b) => ({
    id: b.id,
    name: b.name,
    reason: "未取得本轮分类人气前100且有团购的双条件证据",
  })),
};
await write("catalog/dianping-qualified-brands-2026-09-29.json", manifest);
const summary = {
  selected: plans.length,
  create: plans.filter((p) => !p.existing).length,
  reactivate: plans.filter((p) => p.existing && !p.existing.active).length,
  deactivate: deactivate.length,
};
if (!apply) {
  console.log(JSON.stringify({ mode: "preview", ...summary }));
} else {
  const backupFile = new URL(
    "catalog/dianping-admission-before-2026-09-29.json",
    root,
  );
  // Preserve the first pre-change snapshot across retries.
  try {
    await writeFile(backupFile, JSON.stringify(before, null, 2) + "\n", {
      flag: "wx",
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const reportFile = "catalog/dianping-admission-reconcile-2026-09-29.json";
  const report = {
    started_at: new Date().toISOString(),
    ...summary,
    operations: [],
  };
  assert(
    [...coreIds].every((id) => before.some((b) => b.id === id && b.active)),
    "原始品牌保留名单缺失或被停用，请先核对恢复，禁止覆盖",
  );
  const selectedIds = new Set(coreIds);
  for (const plan of plans) {
    let saved = plan.existing;
    if (!saved) saved = await api("/brands", plan.input);
    else if (!saved.active)
      saved = await api(`/brands/${saved.id}`, plan.input, "PUT");
    for (const evidence of plan.evidence)
      await api(`/brands/${saved.id}/evidence`, evidence);
    selectedIds.add(saved.id);
    report.operations.push({ id: saved.id, name: saved.name, active: true });
    await write(reportFile, report);
  }
  // All selected rows have been saved before removing any old operational rows.
  for (const brand of deactivate) {
    const input = brandInput.parse({
      name: brand.name,
      category: brand.category,
      aliases: brand.aliases,
      keywords: brand.keywords,
      shanghai_evidence_url: brand.shanghai_evidence_url,
      active: false,
    });
    await api(`/brands/${brand.id}`, input, "PUT");
    report.operations.push({ id: brand.id, name: brand.name, active: false });
    await write(reportFile, report);
  }
  const after = (await api("/brands")).items;
  assert(
    after.filter((b) => b.active).length === selectedIds.size &&
      after.every((b) => b.active === selectedIds.has(b.id)),
    "Active pool readback mismatch",
  );
  report.finished_at = new Date().toISOString();
  report.after_total = after.length;
  report.after_active = selectedIds.size;
  report.active_pool_verified = true;
  await write(reportFile, report);
  console.log(JSON.stringify({ ...report, operations: undefined }));
}
