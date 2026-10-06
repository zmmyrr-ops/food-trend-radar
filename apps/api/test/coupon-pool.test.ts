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
test("品牌增量更新原子替换、失败保留旧池、到期移出、禁用隐藏；只有优先券限制500张", async () => {
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
    let fullReads = 0;
    let clockBatches = 0;
    const query = db.query.bind(db);
    db.query = ((...args: Parameters<typeof db.query>) => {
      if (args[0].includes("SELECT c.payload,b.category")) fullReads++;
      if (args[0].includes("calculated_at::text AS version,payload"))
        clockBatches++;
      return query(...args);
    }) as typeof db.query;
    const concurrent = await Promise.all([
      pool.read(),
      pool.read(),
      pool.read(),
    ]);
    assert.equal(concurrent[0].length, 510);
    assert.equal(fullReads, 1, "concurrent requests share one full pool load");
    concurrent[0].pop();
    assert.equal(
      (await pool.read()).length,
      510,
      "returned arrays are independent",
    );
    assert.equal(
      fullReads,
      1,
      "repeated reads only check the small revision row",
    );
    const tuples = () =>
      db.query(
        "SELECT product_id,ctid::text FROM coupon_pool_candidates ORDER BY product_id",
      );
    const beforeRefresh = (await tuples()).rows;
    await pool.refreshBrand(brand);
    assert.deepEqual(
      (await tuples()).rows,
      beforeRefresh,
      "unchanged refresh must not rewrite PostgreSQL tuples",
    );
    await db.query(
      "UPDATE coupon_pool_candidates SET payload=jsonb_set(payload,'{is_new}','true'::jsonb) WHERE brand_id=$1 AND product_id='1'",
      [brand],
    );
    await pool.tick();
    assert.equal(
      clockBatches,
      3,
      "510 coupons are processed in bounded 200-row batches",
    );
    assert.equal(
      (
        await db.query<{ is_new: boolean }>(
          "SELECT (payload->>'is_new')::boolean AS is_new FROM coupon_pool_candidates WHERE brand_id=$1 AND product_id='1'",
          [brand],
        )
      ).rows[0].is_new,
      false,
    );
    const selected = selectPicks(await pool.read(), {
      view: "recommended",
      order: "priority",
      search: "",
      offset: 0,
      limit: 20,
    });
    assert.equal(selected.filtered.length, 500);
    assert.equal(selected.counts.all, 510);
    const outside = current.find(
      (x) => !selected.filtered.some((y) => y.product_id === x.product_id),
    )!;
    outside.title = "上限外的券";
    outside.watching = true;
    outside.kind = "price_drop";
    outside.usage_inputs = undefined;
    outside.priority = {
      ...outside.priority,
      score: 0,
      value_gate: { ...outside.priority.value_gate, eligible: false },
    };
    outside.use_outlook = { ...outside.use_outlook, fully_excluded: true };
    await pool.refreshBrand(brand);
    const complete = await pool.read();
    for (const view of ["all", "watching", "price_drop"] as const) {
      const result = selectPicks(complete, {
        view,
        order: "priority",
        search: "上限外的券",
        offset: 0,
        limit: 20,
      });
      assert.equal(result.filtered.length, 1, view);
      assert.equal(result.filtered[0].product_id, outside.product_id);
      assert.equal(result.counts.recommended, 0);
    }
    const all = selectPicks(complete, {
      view: "all",
      order: "priority",
      search: "",
      offset: 500,
      limit: 20,
    });
    assert.equal(all.filtered.length, 510);
    assert.equal(all.filtered.slice(500, 520).length, 10);

    fail = true;
    await assert.rejects(pool.refreshBrand(brand), /source failed/);
    assert.equal((await pool.read()).length, 510);
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

test("单品牌更新只重读该品牌，禁用后立即移出缓存", async () => {
  const db = await openDatabase();
  const ids = [randomUUID(), randomUUID()];
  const run = randomUUID();
  await db.exec(
    "CREATE TABLE radar_read_models(name text PRIMARY KEY,payload jsonb,calculated_at timestamptz); CREATE TABLE coupon_dispositions(brand_id uuid,product_id text); CREATE TABLE brand_index_observations(brand_id uuid)",
  );
  await db.query("INSERT INTO coupon_runs(id,status) VALUES($1,'complete')", [
    run,
  ]);
  for (const id of ids) {
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1::uuid,$1::text,$1::text,'火锅','https://example.com')",
      [id],
    );
    await db.query("INSERT INTO coupon_baselines VALUES($1,$2)", [id, run]);
  }
  const current = new Map(ids.map((id) => [id, picks(id, run, 1)]));
  const pool = await createCouponPool(db, async (id) => current.get(id)!);
  try {
    for (const id of ids) await pool.refreshBrand(id);
    assert.equal((await pool.read()).length, 2);
    const query = db.query.bind(db);
    const loaded: string[][] = [];
    db.query = ((...args: Parameters<typeof db.query>) => {
      if (args[0].includes("SELECT c.payload,b.category"))
        loaded.push(args[1]![0] as string[]);
      return query(...args);
    }) as typeof db.query;
    current.get(ids[0])![0].title = "更新的券";
    await pool.refreshBrand(ids[0]);
    assert.equal(
      (await pool.read()).find((x) => x.brand_id === ids[0])?.title,
      "更新的券",
    );
    assert.deepEqual(loaded, [[ids[0]]]);
    await db.query("UPDATE brands SET active=false WHERE id=$1", [ids[1]]);
    assert.deepEqual(
      (await pool.read()).map((x) => x.brand_id),
      [ids[0]],
    );
    assert.deepEqual(loaded, [[ids[0]]]);
  } finally {
    await pool.stop();
    await db.close();
  }
});
