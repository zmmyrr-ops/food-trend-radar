import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readCouponSummary } from "../src/coupon-summary.js";

test("archived coupon summary distinguishes expiration, latest absence, and unknown", async () => {
  const db = new PGlite(),
    brand = randomUUID(),
    run = randomUUID();
  try {
    await db.exec(
      `CREATE TABLE brands(id uuid,name text,name_key text,category text,aliases jsonb,keywords jsonb,shanghai_evidence_url text,active boolean,icon_url text); CREATE TABLE coupon_items(brand_id uuid,product_id text,run_id uuid,payload jsonb,observed_at timestamptz DEFAULT now()); CREATE TABLE coupon_catalog(brand_id uuid,product_id text,payload jsonb,observed_at timestamptz DEFAULT now()); CREATE VIEW coupon_known_items AS SELECT * FROM coupon_catalog; CREATE TABLE coupon_baselines(brand_id uuid,run_id uuid); CREATE TABLE coupon_tasks(brand_id uuid,run_id uuid,state text);`,
    );
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,aliases,keywords,shanghai_evidence_url,active) VALUES($1,'测试','测试','其他餐饮','[]','[]','https://example.com',true)",
      [brand],
    );
    await db.query(
      "INSERT INTO coupon_catalog(brand_id,product_id,payload) VALUES($1,'123',$2)",
      [
        brand,
        JSON.stringify({
          identity: "name_match",
          name: "归档券",
          sale_end: "2099-01-01",
        }),
      ],
    );
    assert.equal((await readCouponSummary(db, brand, "123"))?.title, "归档券");
    await db.query("INSERT INTO coupon_baselines VALUES($1,$2)", [brand, run]);
    await db.query("INSERT INTO coupon_tasks VALUES($1,$2,'partial')", [
      brand,
      run,
    ]);
    assert.equal(
      (await readCouponSummary(db, brand, "123"))?.availability,
      "available",
    );
    await db.exec("UPDATE coupon_tasks SET state='complete'");
    assert.equal(
      (await readCouponSummary(db, brand, "123"))?.availability,
      "unavailable",
    );
    await db.exec(
      `UPDATE coupon_catalog SET payload=jsonb_set(payload,'{sale_end}','"2020.01.01 23:59"')`,
    );
    assert.equal(
      (await readCouponSummary(db, brand, "123"))?.availability,
      "expired",
    );
    assert.equal(await readCouponSummary(db, brand, "456"), null);
  } finally {
    await db.close();
  }
});
