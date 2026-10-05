import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createAccounts } from "../src/accounts.js";
import { createApp } from "../src/app.js";
import { readBrandBlacklist } from "../src/brand-blacklist.js";
import { openDatabase } from "../src/db.js";

test("普通用户黑名单模糊搜索、添加去重、移除和账号隔离", async () => {
  const db = await openDatabase();
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
    const a = await login("13800004101"),
      b = await login("13800004102"),
      brand = randomUUID();
    await db.query(
      "INSERT INTO brands(id,name,name_key,aliases,category,active,shanghai_evidence_url) VALUES($1,'黑名单品牌','blacklist-test','[\"测试别名\"]','其他餐饮',true,'https://example.com')",
      [brand],
    );
    const path = "/api/v3/brand-blacklist";
    assert.equal((await call(path)).status, 401);
    assert.equal(
      (await (await call(path + "/search?q=别名", a)).json()).items[0].id,
      brand,
    );
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await call(path, a, { brand_id: brand, blocked: true })).status,
        200,
      );
    assert.equal((await (await call(path, a)).json()).items.length, 1);
    assert.equal((await (await call(path, b)).json()).items.length, 0);
    await call(path, b, { brand_id: brand, blocked: false });
    assert.equal((await (await call(path, a)).json()).items.length, 1);
    const owner = (
      await db.query<{ id: string }>(
        "SELECT id FROM accounts WHERE phone='13800004101'",
      )
    ).rows[0].id;
    assert.equal((await readBrandBlacklist(db, owner)).has(brand), true);
    await call(path, a, { brand_id: brand, blocked: false });
    assert.equal((await readBrandBlacklist(db, owner)).size, 0);
    assert.equal(
      (await call(path, a, { brand_id: randomUUID(), blocked: true })).status,
      404,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
  }
});
