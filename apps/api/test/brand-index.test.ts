import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createBrandIndex,
  indexAvailable,
  indexSchema,
} from "../src/brand-index.js";
import { openDatabase } from "../src/db.js";
import { pickPriority } from "../src/pick-priority.js";

const now = Date.now();
const end = new Date(now - 86400000).toISOString().slice(0, 10);
const sample = {
  brand_id: randomUUID(),
  keyword: "瑞幸咖啡",
  source: "baidu_web" as const,
  region: "上海" as const,
  device: "PC+移动" as const,
  metric: "search_index_7d_summary" as const,
  status: "available" as const,
  period_start: new Date(Date.parse(end) - 6 * 86400000)
    .toISOString()
    .slice(0, 10),
  period_end: end,
  observed_at: new Date(now).toISOString(),
  daily_average: 225,
  mom: -0.02,
  source_url: "https://index.baidu.com/v2/main/index.html#/trend/瑞幸咖啡",
};
test("品牌指数严格区分7日概览、缺失与过期，不接收未来统计", () => {
  assert.ok(indexSchema.safeParse(sample).success);
  for (const patch of [
    { region: "全国" },
    { period_start: end },
    { mom: null },
    { status: "not_indexed" },
    { observed_at: new Date(now + 86400000).toISOString() },
    { source_url: "https://example.com" },
  ])
    assert.equal(indexSchema.safeParse({ ...sample, ...patch }).success, false);
  assert.equal(indexAvailable(sample, now), true);
  assert.equal(indexAvailable(sample, now + 73 * 3600000), false);
  assert.equal(
    indexAvailable(
      { ...sample, status: "not_indexed", daily_average: null, mom: null },
      now,
    ),
    false,
  );
});
test("指数正负环比按公开规则计分，未知不加分", () => {
  const base = { speed: null, acceleration: null, reduction_rate: null };
  assert.equal(pickPriority(base).raw_score, 0);
  assert.equal(pickPriority({ ...base, brand_growth: -0.27 }).raw_score, 0);
  assert.equal(pickPriority({ ...base, brand_growth: -0.02 }).raw_score, 4.6);
  assert.equal(pickPriority({ ...base, brand_growth: 0.25 }).raw_score, 10);
});
test("网页观测持久保存，旧观测不能覆盖同窗口新数据", async () => {
  const db = await openDatabase();
  try {
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'瑞幸咖啡','index-test','咖啡','https://example.com')",
      [sample.brand_id],
    );
    const service = await createBrandIndex(db);
    await service.save(sample);
    await service.save({
      ...sample,
      observed_at: new Date(now - 1000).toISOString(),
      daily_average: 999,
    });
    assert.equal((await service.read())[0].daily_average, 225);
    assert.equal((await (await createBrandIndex(db)).read()).length, 1);
  } finally {
    await db.close();
  }
});
