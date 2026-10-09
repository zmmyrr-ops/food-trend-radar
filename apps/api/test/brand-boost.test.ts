import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createBrandBoost } from "../src/brand-boost.js";
import { createCoupons, SerialGate } from "../src/coupons.js";
import { openDatabase } from "../src/db.js";
import { changePoints, setupPoints } from "../src/points.js";

test("品牌加速：扣费幂等、多人合并、每天两次、冷却、失败退款", async () => {
  const db = await openDatabase();
  try {
    await db.exec(
      "CREATE TABLE accounts(id uuid PRIMARY KEY); UPDATE coupon_settings SET enabled=true",
    );
    const users = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of users)
      await db.query("INSERT INTO accounts VALUES($1)", [id]);
    await setupPoints(db);
    const brands = [randomUUID(), randomUUID(), randomUUID()];
    for (const [i, id] of brands.entries())
      await db.query(
        "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,$2,$2,'其他餐饮','https://example.com')",
        [id, "brand" + i],
      );
    const service = createBrandBoost(
      db,
      () => "sig",
      () => {},
    );
    const request = randomUUID();
    const first = await service.enqueue(users[0], brands[0], request);
    await service.enqueue(users[0], brands[0], request);
    assert.equal(
      (
        await db.query<any>(
          "SELECT balance FROM point_wallets WHERE owner_id=$1",
          [users[0]],
        )
      ).rows[0].balance,
      480,
    );
    await assert.rejects(
      service.enqueue(users[0], brands[0], randomUUID()),
      /你已加速/,
    );
    const second = await service.enqueue(users[1], brands[0], randomUUID());
    assert.equal(first.job_id, second.job_id);
    assert.equal(
      (
        await db.query<any>("SELECT votes FROM brand_boost_jobs WHERE id=$1", [
          first.job_id,
        ])
      ).rows[0].votes,
      2,
    );
    await service.enqueue(users[0], brands[1], randomUUID());
    await assert.rejects(
      service.enqueue(users[0], brands[2], randomUUID()),
      /今天已使用2次/,
    );
    await db.query(
      "UPDATE coupon_tasks SET state='complete',completed_at=now() WHERE brand_id=$1",
      [brands[0]],
    );
    await service.settle();
    await service.settle();
    const notifications = (
      await db.query<any>(
        "SELECT owner_id,title,read_at FROM subscription_messages WHERE kind='boost_complete'",
      )
    ).rows;
    assert.equal(notifications.length, 2);
    assert.deepEqual(
      new Set(notifications.map((n) => n.owner_id)),
      new Set(users.slice(0, 2)),
    );
    assert.ok(
      notifications.every(
        (n) => n.title.includes("暂无新券") && n.read_at === null,
      ),
    );
    await assert.rejects(
      service.enqueue(users[2], brands[0], randomUUID()),
      /已经是最新/,
    );
    await db.query(
      "UPDATE coupon_tasks SET state='partial' WHERE brand_id=$1",
      [brands[1]],
    );
    await service.settle();
    await service.settle();
    assert.equal(
      (
        await db.query<any>(
          "SELECT count(*)::int AS n FROM subscription_messages WHERE kind='boost_failed'",
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await db.query<any>(
          "SELECT balance FROM point_wallets WHERE owner_id=$1",
          [users[0]],
        )
      ).rows[0].balance,
      480,
    );
    await service.enqueue(users[0], brands[2], randomUUID());
    await db.exec("UPDATE coupon_settings SET pause_reason='AUTH_EXPIRED'");
    await service.settle();
    assert.equal(
      (
        await db.query<any>(
          "SELECT balance FROM point_wallets WHERE owner_id=$1",
          [users[0]],
        )
      ).rows[0].balance,
      480,
    );
    await assert.rejects(
      service.enqueue(users[2], brands[2], randomUUID()),
      /暂不可用/,
    );
    await db.exec("UPDATE coupon_settings SET pause_reason=NULL");
    await db.query(
      "UPDATE brand_boost_requests SET created_at=created_at-interval '1 day' WHERE owner_id=$1",
      [users[0]],
    );
    await service.enqueue(users[0], brands[1], randomUUID());
    await db.transaction((tx) =>
      changePoints(tx, users[2], -500, "test", "empty-wallet"),
    );
    await assert.rejects(
      service.enqueue(users[2], brands[2], randomUUID()),
      /POINTS_INSUFFICIENT/,
    );
    assert.equal(
      (
        await db.query<any>(
          "SELECT count(*)::int AS n FROM brand_boost_jobs WHERE brand_id=$1 AND state='queued'",
          [brands[2]],
        )
      ).rows[0].n,
      0,
    );
    const pending = (
      await db.query<any>(
        "SELECT run_id FROM brand_boost_jobs WHERE brand_id=$1 AND state='queued'",
        [brands[1]],
      )
    ).rows[0];
    await db.query(
      "INSERT INTO coupon_diffs(run_id,brand_id,product_id,kind,new_payload) VALUES($1,$2,'new-test','NEW_OBSERVED',$3)",
      [pending.run_id, brands[1], JSON.stringify({ identity: "name_match" })],
    );
    await db.query(
      "UPDATE coupon_tasks SET state='complete',completed_at=now() WHERE run_id=$1 AND brand_id=$2",
      [pending.run_id, brands[1]],
    );
    await service.settle();
    assert.match(
      (
        await db.query<any>(
          "SELECT title FROM subscription_messages WHERE brand_id=$1 AND kind='boost_complete'",
          [brands[1]],
        )
      ).rows[0].title,
      /发现1张新券/,
    );
  } finally {
    await db.close();
  }
});

test("优先队列复用同一串行采集器，多人加速排在前面", async () => {
  const db = await openDatabase();
  let release!: () => void;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  let entered!: () => void;
  const firstStarted = new Promise<void>((r) => {
    entered = r;
  });
  const order: string[] = [];
  let active = 0;
  let peak = 0;
  let worker: ReturnType<typeof createCoupons> | undefined;
  try {
    await db.exec(
      "CREATE TABLE accounts(id uuid PRIMARY KEY); UPDATE coupon_settings SET enabled=true",
    );
    const users = [randomUUID(), randomUUID()];
    for (const id of users)
      await db.query("INSERT INTO accounts VALUES($1)", [id]);
    await setupPoints(db);
    const brands = [randomUUID(), randomUUID(), randomUUID()];
    for (const [i, id] of brands.entries())
      await db.query(
        "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,$2,$2,'其他餐饮','https://example.com')",
        [id, "brand" + i],
      );
    worker = createCoupons(db, {
      gate: new SerialGate(
        async () => {},
        () => Date.now(),
        () => 0,
      ),
      fetchPage: async (name) => {
        active++;
        peak = Math.max(peak, active);
        order.push(name);
        if (order.length === 1) {
          entered();
          await blocked;
        }
        active--;
        return {
          status_code: 0,
          has_more: false,
          cursor: "0",
          product_list: [
            {
              product_id: "123",
              product_info: {
                product_name: "套餐",
                price_range: { min: 1000, max: 1000 },
                origin_price: 2000,
                status: 1,
              },
              nearest_poi_info: {
                brand_data: { brand_name: name, brand_id: "999" },
                poi_id: "123",
                poi_name: "上海店",
              },
            },
          ],
        };
      },
    });
    await worker.start();
    await firstStarted;
    const service = createBrandBoost(
      db,
      () => "unused",
      () => {},
    );
    await service.enqueue(users[0], brands[1], randomUUID());
    await service.enqueue(users[0], brands[2], randomUUID());
    await service.enqueue(users[1], brands[2], randomUUID());
    release();
    await worker.drain();
    assert.deepEqual(order, ["brand0", "brand2", "brand1"]);
    assert.equal(peak, 1);
    assert.equal(
      (
        await db.query<any>(
          "SELECT count(*)::int AS n FROM brand_boost_jobs WHERE state='complete'",
        )
      ).rows[0].n,
      2,
    );
  } finally {
    release();
    await worker?.stop();
    await db.close();
  }
});
