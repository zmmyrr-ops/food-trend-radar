import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { currentCouponDetail } from "../src/current-coupon-detail.js";
import { openDatabase } from "../src/db.js";

test("current details never borrow older rules/stores or another brand baseline, and reject stale/out-of-order data", async () => {
  const db = await openDatabase(),
    brand = randomUUID(),
    other = randomUUID(),
    run = randomUUID(),
    older = randomUUID();
  const now = Date.parse("2026-09-28T12:00:00Z"),
    at = "2026-09-28T11:00:00Z";
  try {
    for (const b of [brand, other])
      await db.query(
        "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'测试',$1::uuid::text,'火锅','https://example.com')",
        [b],
      );
    for (const r of [run, older])
      await db.query(
        "INSERT INTO coupon_runs(id,status) VALUES($1,'complete')",
        [r],
      );
    for (const [b, r] of [
      [brand, run],
      [other, older],
    ]) {
      await db.query(
        "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,state) VALUES($1,$2,'测试','[]','complete')",
        [r, b],
      );
      await db.query("INSERT INTO coupon_baselines VALUES($1,$2)", [b, r]);
      await db.query(
        "INSERT INTO coupon_items(run_id,brand_id,product_id,payload,observed_at) VALUES($1,$2,'1','{}',$3)",
        [r, b, at],
      );
    }
    for (const table of ["coupon_rule_snapshots", "coupon_store_snapshots"])
      await db.query(
        `INSERT INTO ${table}(run_id,product_id,payload,observed_at) VALUES($1,'1','{}',$2)`,
        [older, at],
      );
    for (const kind of ["rules", "stores"] as const) {
      assert.equal(
        (await currentCouponDetail(db, brand, "1", kind, now)).items.length,
        0,
      );
      assert.equal(
        (await currentCouponDetail(db, other, "1", kind, now)).items.length,
        1,
      );
      assert.equal(
        (await currentCouponDetail(db, brand, "2", kind, now)).context.status,
        "not_in_baseline",
      );
    }
    for (const table of ["coupon_rule_snapshots", "coupon_store_snapshots"])
      await db.query(
        `INSERT INTO ${table}(run_id,product_id,payload,observed_at) VALUES($1,'1','{}',$2)`,
        [run, at],
      );
    for (const kind of ["rules", "stores"] as const) {
      const valid = await currentCouponDetail(db, brand, "1", kind, now);
      assert.equal(valid.items[0].run_id, run);
      const stale = await currentCouponDetail(
        db,
        brand,
        "1",
        kind,
        now + 40 * 3600000,
      );
      assert.equal(stale.context.status, "stale");
      assert.equal(stale.items.length, 0);
    }
    await db.query(
      "UPDATE coupon_rule_snapshots SET observed_at='2026-09-28T10:00:00Z' WHERE run_id=$1",
      [run],
    );
    assert.equal(
      (await currentCouponDetail(db, brand, "1", "rules", now)).items.length,
      0,
    );
    await db.query(
      "UPDATE coupon_rule_snapshots SET observed_at='2026-09-28T13:00:00Z' WHERE run_id=$1",
      [run],
    );
    assert.equal(
      (await currentCouponDetail(db, brand, "1", "rules", now)).items.length,
      0,
    );
    assert.equal(
      (await currentCouponDetail(db, randomUUID(), "1", "rules", now)).context
        .status,
      "no_baseline",
    );
  } finally {
    await db.close();
  }
});
