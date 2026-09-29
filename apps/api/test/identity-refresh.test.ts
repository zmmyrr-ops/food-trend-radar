import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { brandCoverage } from "../src/brand-coverage.js";
import { createCoupons, SerialGate } from "../src/coupons.js";
import { openDatabase } from "../src/db.js";

test("name changes automatically create one durable serial refresh and reset baseline", async () => {
  const db = await openDatabase(),
    brand = randomUUID();
  let calls = 0;
  const service = createCoupons(db, {
    gate: new SerialGate(
      async () => {},
      () => Date.now(),
      () => 0,
    ),
    fetchPage: async (name) => {
      calls++;
      return {
        status_code: 0,
        cursor: 1,
        has_more: false,
        product_list: [
          {
            product_id: "123",
            product_info: {
              product_name: "券",
              price_range: { min: 100, max: 100 },
            },
            nearest_poi_info: {
              brand_data: { brand_name: name, brand_id: "456" },
            },
          },
        ],
      };
    },
  });
  try {
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'旧名称','refresh-test','火锅','https://example.com')",
      [brand],
    );
    await db.query("UPDATE coupon_settings SET enabled=true");
    const initial = await service.start([brand]);
    await service.drain();
    assert.equal(calls, 1);
    await db.query(
      "UPDATE brands SET name='新名称',aliases='[\"旧名称\"]' WHERE id=$1",
      [brand],
    );
    assert.equal(
      (await brandCoverage(db)).items[0].review.status,
      "config_pending",
    );
    service.kick();
    await service.drain();
    assert.equal(calls, 2);
    assert.equal(
      (await brandCoverage(db)).items[0].review.status,
      "name_candidates",
    );
    const rows = (
      await db.query<{ name: string; comparison_status: string }>(
        "SELECT name,comparison_status FROM coupon_tasks ORDER BY completed_at",
      )
    ).rows;
    assert.equal(rows[0].name, "旧名称");
    assert.equal(rows[1].name, "新名称");
    assert.equal(rows[1].comparison_status, "QUERY_CHANGED");
    const refresh = (
      await db.query<{ run_id: string }>(
        "SELECT run_id FROM coupon_identity_refreshes",
      )
    ).rows;
    assert.equal(refresh.length, 1);
    assert.notEqual(refresh[0].run_id, initial);
    service.kick();
    await service.drain();
    assert.equal(calls, 2);
    // A reverted/old baseline cannot cause an infinite retry of a previously attempted configuration.
    await db.query("UPDATE coupon_baselines SET run_id=$1 WHERE brand_id=$2", [
      initial,
      brand,
    ]);
    service.kick();
    await service.drain();
    assert.equal(calls, 2);
  } finally {
    await service.stop();
    await db.close();
  }
});

test("full-pool request expands an active subset without duplicating or rewriting tasks", async () => {
  const db = await openDatabase();
  const ids = [randomUUID(), randomUUID()];
  const service = createCoupons(db);
  try {
    await db.query("UPDATE coupon_settings SET pause_reason='USER_PAUSED'");
    for (const [i, id] of ids.entries())
      await db.query(
        "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,$2,$2,'火锅','https://example.com')",
        [id, `合并品牌${i}`],
      );
    const run = await service.start([ids[0]]);
    await service.drain();
    await db.query("UPDATE brands SET name='变更名称' WHERE id=$1", [ids[0]]);
    assert.equal(await service.start(), run);
    await service.drain();
    assert.equal(await service.start(), run);
    await service.drain();
    const tasks = (
      await db.query<{ brand_id: string; name: string }>(
        "SELECT brand_id,name FROM coupon_tasks WHERE run_id=$1",
        [run],
      )
    ).rows;
    assert.equal(tasks.length, 2);
    assert.equal(tasks.find((t) => t.brand_id === ids[0])?.name, "合并品牌0");
  } finally {
    await service.stop();
    await db.close();
  }
});
