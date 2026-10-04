import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { compactCouponBrand } from "../src/coupon-storage.js";
import { openDatabase } from "../src/db.js";
import { createSalesHeat } from "../src/sales-heat.js";

test("完整历史迁为轻量点，当前和上一轮保留，热度与加速度不变，旧券仍可用于计划视频", async () => {
  const db = await openDatabase();
  const brand = randomUUID();
  const runs = Array.from({ length: 24 }, () => randomUUID());
  try {
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'压缩测试','compact-test','其他餐饮','https://example.com')",
      [brand],
    );
    for (let i = 0; i < runs.length; i++) {
      const at = new Date(
        Date.now() - (runs.length - i) * 2 * 3600000,
      ).toISOString();
      await db.query(
        "INSERT INTO coupon_runs(id,status,started_at,finished_at) VALUES($1,'complete',$2,$2)",
        [runs[i], at],
      );
      await db.query(
        "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,state,completed_at,query_signature,comparison_status,previous_run_id) VALUES($1,$2,'压缩测试','[]','complete',$3,'query','COMPARABLE',$4)",
        [runs[i], brand, at, runs[i - 1] ?? null],
      );
      const payload = {
        name: "套餐",
        identity: "name_match",
        platform_brand_id: "123",
        monthly_sales: String(100 + i * i),
        price_min_fen: 5000,
        price_max_fen: 5000,
        origin_price_fen: 10000,
        sale_end: "2099-01-01",
        unused: "x".repeat(4000),
      };
      await db.query("INSERT INTO coupon_items VALUES($1,$2,'1',$3,$4)", [
        runs[i],
        brand,
        JSON.stringify(payload),
        at,
      ]);
      await db.query(
        "INSERT INTO coupon_diffs VALUES($1,$2,'1','UNCHANGED',$3,$3,$4)",
        [runs[i], brand, JSON.stringify(payload), at],
      );
    }
    await db.query("INSERT INTO coupon_baselines VALUES($1,$2)", [
      brand,
      runs.at(-1),
    ]);
    const before = (await createSalesHeat(db).readBrand(brand))[0];
    assert.equal(await compactCouponBrand(db, brand), 22);
    const after = (await createSalesHeat(db).readBrand(brand))[0];
    for (const key of [
      "speed",
      "acceleration",
      "net_change",
      "hours",
      "price_fen",
    ] as const)
      assert.equal(after[key], before[key]);
    assert.equal((await db.query("SELECT * FROM coupon_items")).rows.length, 2);
    assert.equal(
      (await db.query("SELECT * FROM coupon_catalog")).rows.length,
      1,
    );
    assert.equal(
      (
        await db.query(
          "SELECT payload ? 'unused' AS extra FROM coupon_sales_points LIMIT 1",
        )
      ).rows[0].extra,
      false,
    );
    assert.equal(
      (await db.query("SELECT * FROM coupon_known_items")).rows.length,
      1,
    );
    assert.equal(
      (await db.query("SELECT * FROM coupon_change_history")).rows.length,
      0,
    );
    assert.equal(await compactCouponBrand(db, brand), 0);
  } finally {
    await db.close();
  }
});
