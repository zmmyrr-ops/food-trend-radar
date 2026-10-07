import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import express from "express";
import { createAccounts } from "../src/accounts.js";
import { openDatabase } from "../src/db.js";
import { changePoints, setupPoints } from "../src/points.js";
import { registerStudioCopy } from "../src/studio-copy.js";
import { createVisitPlans } from "../src/visit-plans.js";
import { seedInvitation } from "./helpers/invitation.js";

test("copy charge is idempotent, failure refunds and interrupted operation recovers", async () => {
  const db = await openDatabase();
  const accounts = await createAccounts(db, {});
  await createVisitPlans(db);
  const password = await seedInvitation(db, "13800001111");
  const owner = (
    await db.query<{ id: string }>(
      "SELECT id FROM accounts WHERE phone='13800001111'",
    )
  ).rows[0].id;
  await db.transaction((tx) =>
    changePoints(tx, owner, 100, "测试余额", "seed"),
  );
  const plan = randomUUID(),
    store = randomUUID();
  await db.query(
    "INSERT INTO visit_plans(id,owner_id,name,date) VALUES($1,$2,'计划','2026-10-08')",
    [plan, owner],
  );
  await db.query(
    "INSERT INTO visit_plan_stores(id,plan_id,name,address,lat,lng,identity) VALUES($1,$2,'店名','上海',31,121,'s')",
    [store, plan],
  );
  const app = express();
  app.use(express.json());
  accounts.register(app);
  registerStudioCopy(app, db, "/missing", async () => []);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const original = globalThis.fetch,
    env = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-only";
  let calls = 0,
    fail = false;
  globalThis.fetch = (async (input: any, init: any) => {
    if (String(input).startsWith("https://api.deepseek.com/")) {
      calls++;
      return fail
        ? new Response("{}", { status: 500 })
        : Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    titles: ["标题一", "标题二", "标题三"],
                  }),
                },
              },
            ],
          });
    }
    return original(input, init);
  }) as typeof fetch;
  async function post(path: string, body: any, token = "") {
    const r = await fetch(base + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  }
  const balance = async () =>
    (
      await db.query<{ balance: number }>(
        "SELECT balance FROM point_wallets WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].balance;
  try {
    const token = (
      await post("/api/auth/login", { phone: "13800001111", password })
    ).data.token;
    const request = {
      visit_store_id: store,
      kind: "titles",
      request_id: randomUUID(),
    };
    assert.equal(
      (await post("/api/v3/studio-copy", request, token)).status,
      200,
    );
    assert.equal(await balance(), 95);
    assert.equal(
      (await post("/api/v3/studio-copy", request, token)).status,
      200,
    );
    assert.equal(await balance(), 95);
    assert.equal(calls, 1);
    fail = true;
    assert.equal(
      (
        await post(
          "/api/v3/studio-copy",
          { ...request, request_id: randomUUID() },
          token,
        )
      ).status,
      502,
    );
    assert.equal(await balance(), 95);
    await db.transaction(async (tx) => {
      await changePoints(tx, owner, -5, "生成标题", "copy:interrupted");
      await tx.query(
        "INSERT INTO point_operations(key,owner_id) VALUES($1,$2)",
        ["copy:interrupted", owner],
      );
    });
    assert.equal(await balance(), 90);
    await setupPoints(db);
    assert.equal(await balance(), 95);
    await setupPoints(db);
    assert.equal(await balance(), 95);
    await db.query("UPDATE point_wallets SET balance=0 WHERE owner_id=$1", [
      owner,
    ]);
    const before = calls;
    assert.equal(
      (
        await post(
          "/api/v3/studio-copy",
          { ...request, request_id: randomUUID() },
          token,
        )
      ).status,
      402,
    );
    assert.equal(calls, before);
  } finally {
    globalThis.fetch = original;
    if (env === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = env;
    await new Promise<void>((r) => server.close(() => r()));
    await accounts.drain();
    await db.close();
  }
});
