import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const scopePath = new URL(
  "catalog/douyin-492-processing-2026-09-29.json",
  root,
);
const scope = JSON.parse(await readFile(scopePath, "utf8"));
const expectedIds = new Set(scope.brands.map((b) => b.id));
if (expectedIds.size !== 492)
  throw new Error("Frozen scope must contain 492 distinct brands");
async function read(path) {
  const response = await fetch("http://127.0.0.1:3001/api/v3" + path, {
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Local report API: ${response.status}`);
  return response.json();
}
const [tasks, runs, status, audit] = await Promise.all([
  read(`/runs/${scope.run_id}`),
  read("/runs"),
  read("/status"),
  read(`/runs/${scope.run_id}/requests?limit=1`),
]);
const run = runs.items.find((r) => r.id === scope.run_id);
if (
  !run ||
  tasks.items.length !== 492 ||
  tasks.items.some((t) => !expectedIds.has(t.brand_id))
)
  throw new Error("Run scope mismatch");
const classify = (task) =>
  task.state !== "complete"
    ? task.state === "partial"
      ? "请求未完整完成"
      : "等待或正在采集"
    : task.recalled === 0
      ? "本次搜索无结果"
      : task.matched > 0
        ? "有同名品牌候选券"
        : "有商品但品牌归属待核实";
const rows = tasks.items.map((task) => ({ ...task, result: classify(task) }));
const groups = rows.reduce(
  (out, r) => ({ ...out, [r.result]: (out[r.result] || 0) + 1 }),
  {},
);
const finished = run.status !== "running";
let snapshotExport = null;
if (finished) {
  // Export only this run's completed baselines. Failed tasks must not inherit an
  // older successful snapshot and appear completed in the current report.
  const coupons = [];
  for (let offset = 0; ; offset += 100) {
    const page = await read(
      `/opportunities?view=all&limit=100&offset=${offset}`,
    );
    for (const item of page.items)
      if (item.run_id === scope.run_id && expectedIds.has(item.brand_id)) {
        const p = item.payload;
        coupons.push({
          brand_id: item.brand_id,
          query_brand_name: item.brand_name,
          platform_brand_id: p.platform_brand_id,
          platform_brand_name: p.platform_brand_name,
          product_id: item.product_id,
          title: p.name,
          monthly_sales: p.monthly_sales,
          price_min_fen: p.price_min_fen,
          price_max_fen: p.price_max_fen,
          platform_status: p.status,
          sale_end: p.sale_end,
          identity: p.identity,
          poi_id: p.poi_id,
          poi_name: p.poi_name,
          address: p.address,
          observed_at: item.observed_at,
        });
      }
    if (offset + page.items.length >= page.total || !page.items.length) break;
  }
  const expected = rows
    .filter((t) => t.state === "complete")
    .reduce((n, t) => n + t.recalled, 0);
  if (coupons.length !== expected)
    throw new Error(
      "Snapshot export changed during read; retry before declaring export complete",
    );
  snapshotExport = {
    file: "catalog/douyin-492-coupon-snapshots-2026-09-29.json",
    count: coupons.length,
  };
  await writeFile(
    new URL(snapshotExport.file, root),
    JSON.stringify(
      { run_id: scope.run_id, exported_at: new Date().toISOString(), coupons },
      null,
      2,
    ) + "\n",
  );
}
const report = {
  run_id: scope.run_id,
  updated_at: new Date().toISOString(),
  scope_count: 492,
  run_status: run.status,
  pause_reason: status.pause_reason,
  list_processing_complete: rows.every((t) => t.state === "complete"),
  phase: finished
    ? "list_run_finished"
    : status.pause_reason
      ? "paused"
      : "running",
  completed_brands: rows.filter((t) => t.state === "complete").length,
  pages: rows.reduce((n, t) => n + t.pages, 0),
  recalled_products: rows.reduce((n, t) => n + t.recalled, 0),
  name_matched_products: rows.reduce((n, t) => n + t.matched, 0),
  audit: audit.summary,
  groups,
  rows,
  snapshot_export: snapshotExport,
  caveats: [
    "同名匹配仅为候选归属，不是最终品牌身份认证。",
    "搜索范围为上海，但连锁券的上海适用门店需另按门店证据核实。",
    "无结果不等于平台没有该品牌或商品。",
    "月售展示值来自券快照；单次采集不能计算热度提升速度。",
    "本轮核验既有492个品牌，不代表已经完成按销量排序发现新品牌。",
  ],
};
await writeFile(
  new URL("catalog/douyin-492-results-2026-09-29.json", root),
  JSON.stringify(report, null, 2) + "\n",
);
await writeFile(
  scopePath,
  JSON.stringify(
    { ...scope, status: report.phase, updated_at: report.updated_at },
    null,
    2,
  ) + "\n",
);
const lines = [
  "# 492个品牌抖音团购核验进度",
  "",
  `更新时间：${report.updated_at}；轮次：${scope.run_id}`,
  "",
  `状态：${report.phase}。完成列表分页：${report.completed_brands}/492。暂停原因：${report.pause_reason || "无"}。`,
  "",
  `已读取${report.pages}页，累计召回${report.recalled_products}条券记录，其中${report.name_matched_products}条为同名候选。跨品牌召回可能重复，不能把总数当成独立商品总量。`,
  "",
  "## 处理口径",
  "",
  ...report.caveats.map((c) => "- " + c),
  "",
  "## 分组汇总",
  "",
  ...Object.entries(groups).map(([name, n]) => `- ${name}：${n}个`),
  "",
  "## 逐品牌结果",
  "",
  ...rows.map(
    (r) =>
      `- **${r.name}**：${r.result}；${r.pages}页，召回${r.recalled}条，同名候选${r.matched}条${r.error_code ? "；错误：" + r.error_code : ""}`,
  ),
  "",
  "## 请求节奏",
  "",
  `请求数${audit.summary.total}，最小间隔${audit.summary.min_gap_ms ?? "尚无"}毫秒，低于1秒的间隔${audit.summary.short_gaps}次。`,
  "",
];
await writeFile(
  new URL("docs/品牌库/2026-09-29-492个品牌抖音团购核验.md", root),
  lines.join("\n"),
);
console.log(JSON.stringify({ ...report, rows: undefined, caveats: undefined }));
