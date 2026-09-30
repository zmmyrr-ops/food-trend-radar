import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { combinePicks, selectPicks } from "../src/coupon-picks.js";
import { createCouponPool, saleDeadline } from "../src/coupon-pool.js";
import { openDatabase } from "../src/db.js";
import { salesTrend, spacedSalesSamples } from "../src/sales-heat.js";

const now = Date.now();
const point = (run: string, sales: string, hours = 0) => ({
  run_id: run,
  observed_at: new Date(now - hours * 3600000).toISOString(),
  payload: {
    monthly_sales: sales,
    platform_brand_id: "1",
    identity: "name_match",
    name: "双人餐",
    price_min_fen: 6600,
    price_max_fen: 6600,
    origin_price_fen: 10000,
  },
});
function picks(brand: string, run: string, count: number, expired = false) {
  return combinePicks(
    Array.from({ length: count }, (_, i) => ({
      brand_id: brand,
      brand_name: "品牌",
      product_id: String(i + 1),
      title: "双人餐",
      price_fen: 6600,
      sale_end: expired ? "2020-01-01" : "2099-01-01",
      ...salesTrend([point(run, "150"), point("old", "100", 2)], now),
    })),
    [],
  );
}
test("循环密集快照使用真实的至少一小时锚点，不跨缺失或内容变化", () => {
  const dense = [
    point("1", "160"),
    point("2", "150", 0.5),
    point("3", "140", 1),
    point("4", "130", 1.5),
    point("5", "120", 2),
  ];
  const spaced = spacedSalesSamples(dense, now);
  assert.deepEqual(
    spaced.map((x) => x.run_id),
    ["1", "3", "5"],
  );
  assert.equal(salesTrend(spaced, now).speed, 20);
  const broken = dense.map((x) => ({ ...x }));
  broken[1] = { ...broken[1], missing: true } as (typeof broken)[number];
  assert.equal(salesTrend(spacedSalesSamples(broken, now), now).speed, null);
});
test("品牌增量更新原子替换、失败保留旧池、到期移出、禁用隐藏且最多500张", async () => {
  const db = await openDatabase();
  const brand = randomUUID(),
    run = randomUUID();
  await db.exec(
    "CREATE TABLE radar_read_models(name text PRIMARY KEY,payload jsonb,calculated_at timestamptz); CREATE TABLE coupon_dispositions(brand_id uuid,product_id text); CREATE TABLE brand_index_observations(brand_id uuid)",
  );
  await db.query(
    "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'品牌','pool','火锅','https://example.com')",
    [brand],
  );
  await db.query("INSERT INTO coupon_runs(id,status) VALUES($1,'complete')", [
    run,
  ]);
  await db.query("INSERT INTO coupon_baselines VALUES($1,$2)", [brand, run]);
  let current = picks(brand, run, 510),
    fail = false;
  const pool = await createCouponPool(db, async () => {
    if (fail) throw new Error("source failed");
    return current;
  });
  try {
    await pool.refreshBrand(brand);
    assert.equal((await pool.read()).length, 500);
    const selected = selectPicks(current, {
      view: "recommended",
      order: "priority",
      search: "",
      offset: 0,
      limit: 20,
    });
    assert.equal(selected.filtered.length, 500);
    fail = true;
    await assert.rejects(pool.refreshBrand(brand), /source failed/);
    assert.equal((await pool.read()).length, 500);
    fail = false;
    current = picks(brand, run, 1);
    await pool.refreshBrand(brand);
    assert.equal((await pool.read()).length, 1);
    current = picks(brand, run, 1, true);
    await pool.refreshBrand(brand);
    assert.equal((await pool.read()).length, 0);
    current = picks(brand, run, 2);
    await pool.refreshBrand(brand);
    await db.query("UPDATE brands SET active=false WHERE id=$1", [brand]);
    assert.equal((await pool.read()).length, 0);
    assert.equal(
      (await db.query("SELECT * FROM coupon_baselines")).rows.length,
      1,
    );
    assert.equal(saleDeadline("0"), null);
    assert.equal(saleDeadline("未知"), null);
    assert.equal(
      saleDeadline("1790755200"),
      new Date(1790755200000).toISOString(),
    );
  } finally {
    await pool.stop();
    await db.close();
  }
});
