import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { couponAcceptance } from "../src/coupon-acceptance.js";
import { normalizeCoupon } from "../src/coupons.js";
import { openDatabase } from "../src/db.js";

test("acceptance isolates runs, incomplete tasks and old evidence; completed scans remain unverified", async () => {
  const db = await openDatabase();
  const brand = randomUUID(),
    pending = randomUUID(),
    run = randomUUID(),
    prev = randomUUID();
  const now = Date.parse("2026-09-28T08:00:00Z");
  try {
    for (const [i, id] of [brand, pending].entries())
      await db.query(
        "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,$2,$2,'火锅','https://example.com')",
        [id, `验收${i}`],
      );
    for (const id of [run, prev])
      await db.query(
        "INSERT INTO coupon_runs(id,status) VALUES($1,'complete')",
        [id],
      );
    await db.query(
      "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,state,comparison_status,previous_run_id) VALUES($1,$2,'验收0','[]','complete','COMPARABLE',$3)",
      [run, brand, prev],
    );
    await db.query(
      "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,state) VALUES($1,$2,'验收0','[]','complete'),($3,$4,'验收1','[]','queued')",
      [prev, brand, run, pending],
    );
    const coupon = (price: number) =>
      normalizeCoupon(
        {
          product_id: "123",
          product_info: {
            product_name: "套餐",
            price_range: { min: price, max: price },
          },
          nearest_poi_info: {
            brand_data: { brand_name: "验收0", brand_id: "1" },
          },
        },
        ["验收0"],
      );
    for (const [id, price, at] of [
      [prev, 10000, "2026-09-28T00:00:00Z"],
      [run, 9000, "2026-09-28T07:00:00Z"],
    ] as const)
      await db.query(
        "INSERT INTO coupon_items(run_id,brand_id,product_id,payload,observed_at) VALUES($1,$2,'123',$3,$4)",
        [id, brand, JSON.stringify(coupon(price)), at],
      );
    await db.query(
      "INSERT INTO coupon_items(run_id,brand_id,product_id,payload,observed_at) VALUES($1,$2,'123',$3,'2026-09-28T07:00:00Z')",
      [run, pending, JSON.stringify(coupon(5000))],
    );
    await db.query(
      "INSERT INTO coupon_rule_snapshots(run_id,product_id,payload,observed_at) VALUES($1,'123',$2,'2026-09-28T00:01:00Z')",
      [
        prev,
        JSON.stringify({
          status: "received",
          groups: [
            {
              group_name: "套餐",
              item_list: [{ name: "牛肉", count: 1, unit: "份" }],
            },
          ],
          rules: [
            {
              key: "use_date",
              name: "有效期",
              value: [{ content: "购买后7天内有效" }],
            },
          ],
        }),
      ],
    );
    await db.query(
      "INSERT INTO coupon_store_snapshots(run_id,product_id,payload,observed_at) VALUES($1,'123',$2,'2026-09-28T00:01:00Z')",
      [
        prev,
        JSON.stringify({
          complete: true,
          reported_count: 1,
          stores: [{ poi_id: "9", shanghai: true }],
        }),
      ],
    );
    let r = await couponAcceptance(db, run, now);
    assert.equal(r?.scan.finished, false);
    assert.equal(r?.counts.candidates, 1);
    assert.equal(r?.counts.price_drop_clues, 1);
    assert.equal(r?.counts.current_rules_ready, 0);
    assert.equal(r?.counts.current_stores_ready, 0);
    assert.equal(r?.counts.same_returned_conditions_drop, 0);
    assert.equal(r?.samples[0].delta_fen, -1000);
    assert.equal(r?.verdict, "not_accepted");
    await db.query(
      "UPDATE coupon_tasks SET state='complete' WHERE run_id=$1 AND brand_id=$2",
      [run, pending],
    );
    r = await couponAcceptance(db, run, now);
    assert.equal(r?.scan.finished, true);
    assert.equal(r?.counts.candidates, 2);
    assert.equal(r?.verdict, "not_accepted");
    r = await couponAcceptance(db, run, now + 40 * 3600000);
    assert.equal(r?.counts.fresh, 0);
    assert.equal(r?.counts.price_drop_clues, 0);
    assert.equal(await couponAcceptance(db, randomUUID(), now), null);
  } finally {
    await db.close();
  }
});
