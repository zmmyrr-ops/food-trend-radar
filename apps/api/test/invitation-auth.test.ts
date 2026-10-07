import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { createAccounts } from "../src/accounts.js";
import { openDatabase } from "../src/db.js";
import { seedInvitation } from "./helpers/invitation.js";

test("邀请码准入、管理员发放、重置撤销与匿名接口保护", async () => {
  const db = await openDatabase();
  const accounts = await createAccounts(db, { testMode: true });
  const code = await seedInvitation(db, "13800000001");
  await db.query("UPDATE accounts SET role='admin' WHERE phone='13800000001'");
  const app = express();
  app.use(express.json());
  accounts.register(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (path: string, token = "", body?: unknown) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    for (const path of [
      "/api/v3/accounts",
      "/api/v3/coupon-picks",
      "/v1/brands",
      "/_AMapService/test",
      "/api/v3/video-projects",
    ])
      assert.equal((await call(path)).status, 401);
    for (const phone of ["13800000001", "13800009999"])
      assert.equal(
        (await call("/api/auth/login", "", { phone, code: "666666" })).status,
        401,
      );
    assert.equal(
      (await db.query("SELECT id FROM accounts WHERE phone='13800009999'")).rows
        .length,
      0,
    );
    assert.equal(
      (await (await call("/api/auth/config?phone=13800000001")).json())
        .login_mode,
      "password",
    );
    assert.equal(
      (await (await call("/api/auth/config?phone=13800009999")).json())
        .login_mode,
      "invitation",
    );
    assert.equal(
      (await call("/api/auth/login", "", { phone: "13800000001", code }))
        .status,
      401,
    );
    const login = await call("/api/auth/login", "", {
      phone: "13800000001",
      password: code,
    });
    assert.equal(login.status, 200);
    const admin = (await login.json()).token;
    const adminRow = (await (await call("/api/auth/me", admin)).json()).account;
    assert.equal(
      (await call(`/api/v3/accounts/${adminRow.id}/invitation`, admin, {}))
        .status,
      404,
    );
    const created = await call("/api/v3/accounts", admin, {
      phone: "13800000002",
    });
    assert.equal(created.status, 201);
    const user = await created.json();
    assert.equal(
      (await call("/api/v3/accounts", admin, { phone: "13800000002" })).status,
      409,
    );
    assert.equal(
      (
        await call("/api/v3/accounts", admin, {
          phone: "13800000003",
          role: "admin",
        })
      ).status,
      400,
    );
    const userToken = (
      await (
        await call("/api/auth/login", "", {
          phone: "13800000002",
          code: user.invitation_code,
        })
      ).json()
    ).token;
    assert.equal((await call("/api/v3/accounts", userToken)).status, 403);
    assert.equal(
      (await call("/api/v3/accounts", userToken, { phone: "13800000003" }))
        .status,
      403,
    );
    const rotated = await (
      await call(`/api/v3/accounts/${user.account.id}/invitation`, admin, {})
    ).json();
    assert.notEqual(rotated.invitation_code, user.invitation_code);
    assert.equal((await call("/api/auth/me", userToken)).status, 401);
    assert.equal(
      (
        await call("/api/auth/login", "", {
          phone: "13800000002",
          code: user.invitation_code,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await call("/api/auth/login", "", {
          phone: "13800000002",
          code: rotated.invitation_code,
        })
      ).status,
      200,
    );
    const listed = await (await call("/api/v3/accounts", admin)).text();
    assert.ok(!listed.includes(rotated.invitation_code));
    assert.ok(!listed.includes("invitation_hash"));
    assert.equal((await call("/api/auth/logout", admin, {})).status, 200);
    assert.equal((await call("/api/auth/me", admin)).status, 401);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
  }
});

test("既有手机号一次迁移、保留账号、撤销旧会话且不修改微信账号", async () => {
  const db = await openDatabase();
  const dir = await mkdtemp(join(tmpdir(), "invite-migrate-"));
  try {
    await createAccounts(db, {});
    await db.exec(
      "INSERT INTO accounts(id,phone) VALUES('11111111-1111-4111-8111-111111111111','13800000009'),('22222222-2222-4222-8222-222222222222','wx:test'); INSERT INTO account_sessions VALUES('old','11111111-1111-4111-8111-111111111111',now()+interval '1 day')",
    );
    const path = join(dir, "codes.json");
    await createAccounts(db, { invitationExportPath: path });
    const exported = JSON.parse(await readFile(path, "utf8"));
    assert.equal(exported.length, 1);
    assert.equal(exported[0].id, "11111111-1111-4111-8111-111111111111");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(
      (await db.query("SELECT * FROM account_sessions")).rows.length,
      0,
    );
    assert.equal(
      (
        await db.query<{ invitation_hash: string }>(
          "SELECT invitation_hash FROM accounts WHERE phone='wx:test'",
        )
      ).rows[0].invitation_hash,
      null,
    );
    await createAccounts(db, { invitationExportPath: path }); // no rotation on restart
    assert.equal(
      JSON.parse(await readFile(path, "utf8"))[0].invitation_code,
      exported[0].invitation_code,
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
