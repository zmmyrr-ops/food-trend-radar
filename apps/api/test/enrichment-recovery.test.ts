import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createRuleWorker } from "../src/coupon-rules.js";
import { createStoreWorker } from "../src/coupon-stores.js";
import { SerialGate } from "../src/coupons.js";
import { openDatabase } from "../src/db.js";

test("restart skips stale baseline enrichment without fetching, but permits fresh baseline jobs", async () => {
  const db = await openDatabase(),
    brand = randomUUID(),
    run = randomUUID();
  let calls = 0;
  const fetch = async () => {
    calls++;
    throw new Error("AUTH_EXPIRED");
  };
  const gate = new SerialGate(
    async () => {},
    () => Date.now(),
    () => 0,
  );
  const rules = createRuleWorker(db, {
    gate,
    paused: async () => false,
    fetchRules: fetch,
  });
  const stores = createStoreWorker(db, {
    gate,
    paused: async () => false,
    fetchDetail: fetch,
    fetchPois: fetch,
  });
  try {
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'测试','restart-test','火锅','https://example.com')",
      [brand],
    );
    await db.query("INSERT INTO coupon_runs(id,status) VALUES($1,'complete')", [
      run,
    ]);
    await db.query(
      "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,state,completed_at) VALUES($1,$2,'测试','[]','complete',now()-interval '7 days')",
      [run, brand],
    );
    await db.query("INSERT INTO coupon_baselines VALUES($1,$2)", [brand, run]);
    await db.query(
      "INSERT INTO coupon_items(run_id,brand_id,product_id,payload) VALUES($1,$2,'123','{\"identity\":\"name_match\"}')",
      [run, brand],
    );
    for (const table of ["coupon_rule_tasks", "coupon_store_tasks"])
      await db.query(
        `INSERT INTO ${table}(run_id,brand_id,product_id) VALUES($1,$2,'123')`,
        [run, brand],
      );
    assert.equal(await rules.enqueue(), 0);
    assert.equal(await stores.enqueue(), 0);
    assert.equal(await rules.next(), false);
    assert.equal(await stores.next(), false);
    assert.equal(calls, 0);
    for (const table of ["coupon_rule_tasks", "coupon_store_tasks"]) {
      const r = (
        await db.query<{ state: string; error_code: string }>(
          `SELECT state,error_code FROM ${table}`,
        )
      ).rows[0];
      assert.equal(r.state, "superseded");
      assert.equal(r.error_code, "BASELINE_OBSOLETE");
    }
    await db.query(
      "UPDATE coupon_tasks SET completed_at=now() WHERE run_id=$1",
      [run],
    );
    await db.query(
      "INSERT INTO coupon_items(run_id,brand_id,product_id,payload) VALUES($1,$2,'456','{\"identity\":\"name_match\"}')",
      [run, brand],
    );
    assert.equal(await rules.enqueue(), 1);
    assert.equal(await stores.enqueue(), 1);
    await rules.next();
    await stores.next();
    assert.equal(calls, 2);
    await db.query("UPDATE brands SET active=false WHERE id=$1", [brand]);
    await db.query(
      "INSERT INTO coupon_items(run_id,brand_id,product_id,payload) VALUES($1,$2,'789','{\"identity\":\"name_match\"}')",
      [run, brand],
    );
    assert.equal(await rules.enqueue(), 0);
    assert.equal(await stores.enqueue(), 0);
    assert.equal(await rules.next(), false);
    assert.equal(await stores.next(), false);
    assert.equal(calls, 2);
    for (const table of ["coupon_rule_tasks", "coupon_store_tasks"])
      assert.equal(
        (
          await db.query<{ state: string }>(
            `SELECT state FROM ${table} WHERE product_id='456'`,
          )
        ).rows[0].state,
        "superseded",
      );
  } finally {
    await db.close();
  }
});

test("network backfill retries survive worker recreation and stop after two retries", async () => {
  const db = await openDatabase();
  let calls = 0;
  try {
    const brand = randomUUID(),
      run = randomUUID();
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'重试','retry-persist','火锅','https://example.com')",
      [brand],
    );
    await db.query("INSERT INTO coupon_runs(id,status) VALUES($1,'complete')", [
      run,
    ]);
    await db.query(
      "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,state,completed_at) VALUES($1,$2,'重试','[]','complete',now())",
      [run, brand],
    );
    await db.query("INSERT INTO coupon_baselines VALUES($1,$2)", [brand, run]);
    await db.query(
      "INSERT INTO coupon_items(run_id,brand_id,product_id,payload) VALUES($1,$2,'123','{\"identity\":\"name_match\"}')",
      [run, brand],
    );
    const gate = new SerialGate(
      async () => {},
      () => Date.now(),
      () => 0,
    );
    const fetch = async () => {
      calls++;
      throw Error("NETWORK_ERROR");
    };
    const make = () => [
      createRuleWorker(db, {
        gate,
        paused: async () => false,
        fetchRules: fetch,
        retryDelayMs: 0,
      }),
      createStoreWorker(db, {
        gate,
        paused: async () => false,
        fetchDetail: fetch,
        fetchPois: fetch,
        retryDelayMs: 0,
      }),
    ];
    for (const worker of make()) {
      await worker.enqueue();
      await worker.next();
    }
    for (const worker of make()) {
      await worker.next();
      await worker.next();
      assert.equal(await worker.next(), false);
    }
    assert.equal(calls, 6);
    for (const table of ["coupon_rule_tasks", "coupon_store_tasks"]) {
      const row = (
        await db.query<{ state: string; retries: number; error_code: string }>(
          `SELECT state,retries,error_code FROM ${table}`,
        )
      ).rows[0];
      assert.deepEqual(row, {
        state: "failed",
        retries: 2,
        error_code: "NETWORK_ERROR",
      });
    }
    // A new worker must not reset the exhausted budget for this baseline.
    for (const worker of make()) {
      assert.equal(await worker.enqueue(), 0);
      assert.equal(await worker.next(), false);
    }
    assert.equal(calls, 6);
  } finally {
    await db.close();
  }
});

test("large store scopes yield between batches, keep cursors and rotation across worker restart", async () => {
  const db = await openDatabase();
  try {
    const brand = randomUUID(),
      run = randomUUID(),
      calls: string[] = [];
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'多批','batch-rotation','火锅','https://example.com')",
      [brand],
    );
    await db.query("INSERT INTO coupon_runs(id,status) VALUES($1,'complete')", [
      run,
    ]);
    await db.query(
      "INSERT INTO coupon_tasks(run_id,brand_id,name,aliases,state,completed_at) VALUES($1,$2,'多批','[]','complete',now())",
      [run, brand],
    );
    await db.query("INSERT INTO coupon_baselines VALUES($1,$2)", [brand, run]);
    for (const id of ["1", "2"])
      await db.query(
        'INSERT INTO coupon_items(run_id,brand_id,product_id,payload) VALUES($1,$2,$3,\'{"identity":"name_match"}\')',
        [run, brand, id],
      );
    const gate = new SerialGate(
      async () => {},
      () => Date.now(),
      () => 0,
    );
    const make = () =>
      createStoreWorker(db, {
        gate,
        paused: async () => false,
        fetchDetail: async (id) => {
          calls.push("scope:" + id);
          const ids = Array.from({ length: id === "1" ? 41 : 1 }, (_, i) =>
            String(i + 1),
          );
          return { status_code: 0, poi_count: ids.length, poi_id_list: ids };
        },
        fetchPois: async (id, ids) => {
          calls.push("lookup:" + id + ":" + ids[0]);
          return {
            status_code: 0,
            poi_list: ids.map((poi_id) => ({
              poi: {
                poi_id,
                poi_name: "门店",
                city_name: "上海市",
                ad_code: "310115",
              },
            })),
          };
        },
      });
    const first = make();
    await first.enqueue();
    await first.next();
    const restarted = make();
    for (let i = 0; i < 3; i++) assert.equal(await restarted.next(), true);
    assert.deepEqual(calls, ["scope:1", "scope:2", "lookup:1:1", "lookup:2:1"]);
    assert.deepEqual(
      (
        await db.query(
          "SELECT product_id,cursor,state FROM coupon_store_tasks ORDER BY product_id",
        )
      ).rows,
      [
        { product_id: "1", cursor: 20, state: "queued" },
        { product_id: "2", cursor: 1, state: "complete" },
      ],
    );
    await restarted.next();
    await restarted.next();
    assert.equal(await restarted.next(), false);
    assert.deepEqual(calls.slice(4), ["lookup:1:21", "lookup:1:41"]);
    assert.equal(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM coupon_store_items",
        )
      ).rows[0].n,
      42,
    );
  } finally {
    await db.close();
  }
});
