import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { openDatabase } from "../src/db.js";
import { enrichmentQuery } from "../src/enrichment-priority.js";

test("detail queue prioritizes real fixed-price drops but ordinary turns preserve baseline work", async () => {
  const db = await openDatabase(),
    run = randomUUID(),
    brand = randomUUID();
  try {
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'测试','priority-test','火锅','https://example.com')",
      [brand],
    );
    await db.query("INSERT INTO coupon_runs(id,status) VALUES($1,'complete')", [
      run,
    ]);
    for (const id of ["1", "2", "3"]) {
      await db.query(
        "INSERT INTO coupon_rule_tasks(run_id,brand_id,product_id) VALUES($1,$2,$3)",
        [run, brand, id],
      );
      await db.query(
        "INSERT INTO coupon_store_tasks(run_id,brand_id,product_id) VALUES($1,$2,$3)",
        [run, brand, id],
      );
    }
    for (const [id, before, after] of [
      ["2", 100, 200],
      ["3", 100, 80],
    ])
      await db.query(
        "INSERT INTO coupon_diffs(run_id,brand_id,product_id,kind,old_payload,new_payload) VALUES($1,$2,$3,'PRICE_CHANGED_UNVERIFIED',$4,$5)",
        [
          run,
          brand,
          id,
          JSON.stringify({ price_min_fen: before, price_max_fen: before }),
          JSON.stringify({ price_min_fen: after, price_max_fen: after }),
        ],
      );
    for (const table of ["coupon_rule_tasks", "coupon_store_tasks"] as const) {
      assert.equal(
        (await db.query<{ product_id: string }>(enrichmentQuery(table, true)))
          .rows[0].product_id,
        "3",
      );
      assert.equal(
        (await db.query<{ product_id: string }>(enrichmentQuery(table, false)))
          .rows[0].product_id,
        "1",
      );
    }
    const older = randomUUID();
    await db.query("INSERT INTO coupon_runs(id,status) VALUES($1,'complete')", [
      older,
    ]);
    await db.query(
      "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,state) VALUES($1,$2,'测试','[]','complete')",
      [older, brand],
    );
    await db.query(
      "INSERT INTO coupon_items(run_id,brand_id,product_id,payload,observed_at) VALUES($1,$2,'1','{}',now()-interval '7 days')",
      [older, brand],
    );
    await db.query(
      "INSERT INTO coupon_diffs(run_id,brand_id,product_id,kind) VALUES($1,$2,'1','NEW_OBSERVED')",
      [run, brand],
    );
    await db.query(
      "UPDATE coupon_diffs SET kind='NEW_OBSERVED',old_payload=NULL WHERE product_id='3'",
    );
    for (const table of ["coupon_rule_tasks", "coupon_store_tasks"] as const)
      assert.equal(
        (await db.query<{ product_id: string }>(enrichmentQuery(table, true)))
          .rows[0].product_id,
        "3",
      );
  } finally {
    await db.close();
  }
});

test("multi-batch enrichment rotates persistently and delayed retry yields to ready work", async () => {
  const db = await openDatabase();
  try {
    const run = randomUUID(),
      brand = randomUUID();
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'轮换','rotation','火锅','https://example.com')",
      [brand],
    );
    await db.query("INSERT INTO coupon_runs(id,status) VALUES($1,'complete')", [
      run,
    ]);
    for (const table of ["coupon_rule_tasks", "coupon_store_tasks"] as const) {
      for (const id of ["1", "2", "3"])
        await db.query(
          `INSERT INTO ${table}(run_id,brand_id,product_id) VALUES($1,$2,$3)`,
          [run, brand, id],
        );
      const next = async () =>
        (await db.query<{ product_id: string }>(enrichmentQuery(table, false)))
          .rows[0].product_id;
      assert.equal(await next(), "1");
      await db.query(
        `UPDATE ${table} SET last_attempt_at=now() WHERE product_id='1'`,
      );
      assert.equal(await next(), "2");
      await db.query(
        `UPDATE ${table} SET last_attempt_at=now()-interval '1 second' WHERE product_id='2'`,
      );
      assert.equal(await next(), "3");
      await db.query(
        `UPDATE ${table} SET last_attempt_at=now() WHERE product_id='3'`,
      );
      assert.equal(await next(), "2");
      await db.query(
        `UPDATE ${table} SET retry_at=now()+interval '1 hour' WHERE product_id='2'`,
      );
      assert.equal(await next(), "1");
      await db.query(
        `UPDATE ${table} SET retry_at=now()+interval '2 hours' WHERE product_id<>'2'`,
      );
      // If all jobs are deferred, a task is still returned; the global gate waits its retry deadline.
      assert.equal(await next(), "2");
    }
  } finally {
    await db.close();
  }
});
