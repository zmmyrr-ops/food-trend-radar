import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createAccounts } from "../src/accounts.js";
import { createApp } from "../src/app.js";
import { syncSubscriptionMessages } from "../src/brand-subscriptions.js";
import { initCoupons } from "../src/coupons.js";
import { openDatabase } from "../src/db.js";

test("普通用户模糊订阅、通知去重、已读与取消订阅按账号隔离", async () => {
  const db = await openDatabase();
  await initCoupons(db);
  await db.exec(
    "CREATE TABLE coupon_pool_candidates(brand_id uuid,product_id text,run_id uuid,observed_at timestamptz,sale_end timestamptz,payload jsonb)",
  );
  const accounts = await createAccounts(db, { testMode: true });
  const app = createApp(
    db,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    accounts,
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (path: string, cookie = "", body?: unknown) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async (phone: string) =>
    (await call("/api/auth/login", "", { phone, code: "666666" })).headers
      .get("set-cookie")!
      .split(";")[0];
  try {
    const a = await login("13800003101"),
      b = await login("13800003102");
    const brand = randomUUID(),
      run = randomUUID();
    await db.query(
      "INSERT INTO brands(id,name,name_key,aliases,category,active,shanghai_evidence_url) VALUES($1,'测试品牌订阅','subscription-test','[\"模糊别名\"]','其他餐饮',true,'https://example.com')",
      [brand],
    );
    const endpoint = "/api/v3/brand-subscriptions";
    assert.equal((await call(endpoint)).status, 401);
    assert.equal(
      (await (await call(endpoint + "/search?q=别名", a)).json()).items.length,
      1,
    );
    assert.equal(
      (await call(endpoint, a, { brand_id: brand, subscribed: true })).status,
      200,
    );
    await call(endpoint, a, { brand_id: brand, subscribed: true });
    assert.equal((await (await call(endpoint, a)).json()).items.length, 1);
    assert.equal((await (await call(endpoint, b)).json()).items.length, 0);
    await db.query("INSERT INTO coupon_baselines VALUES($1,$2)", [brand, run]);
    await db.query("INSERT INTO coupon_discoveries VALUES($1,'new',now())", [
      brand,
    ]);
    for (const [id, speed, acc] of [
      ["new", 0, 0],
      ["hot", 30, 4],
      ["cold", 10, 1],
    ] as const)
      await db.query(
        "INSERT INTO coupon_pool_candidates VALUES($1,$2,$3,now(),NULL,$4)",
        [
          brand,
          id,
          run,
          JSON.stringify({ title: "测试券", speed, acceleration: acc }),
        ],
      );
    await syncSubscriptionMessages(db);
    await syncSubscriptionMessages(db);
    const messages = await (await call(endpoint + "/messages", a)).json();
    assert.equal(messages.items.length, 2);
    assert.equal(messages.unread, 2);
    assert.equal(
      (await (await call(endpoint + "/messages", b)).json()).unread,
      0,
    );
    await call(endpoint + "/read", b, {
      ids: messages.items.map((m: { id: string }) => m.id),
    });
    assert.equal(
      (await (await call(endpoint + "/messages", a)).json()).unread,
      2,
    );
    await call(endpoint + "/read", a, {
      ids: messages.items.map((m: { id: string }) => m.id),
    });
    assert.equal(
      (await (await call(endpoint + "/messages", a)).json()).unread,
      0,
    );
    await call(endpoint, b, { brand_id: brand, subscribed: false });
    assert.equal((await (await call(endpoint, a)).json()).items.length, 1);
    await call(endpoint, a, { brand_id: brand, subscribed: false });
    assert.equal((await (await call(endpoint, a)).json()).items.length, 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
  }
});
