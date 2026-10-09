import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import express from "express";
import { createAccounts, hashAccountPassword } from "../src/accounts.js";
import { openDatabase } from "../src/db.js";

test("remember duration, SMS reset isolation, replay prevention and session revocation", async () => {
  const db = await openDatabase();
  let sends = 0;
  const accounts = await createAccounts(db, {
    sms: {
      send: async () => {
        sends++;
      },
      check: async (_p, c) => c === "123456",
    },
  });
  await db.query(
    "INSERT INTO accounts(id,phone,password_hash) VALUES($1,$2,$3)",
    [randomUUID(), "13800000002", await hashAccountPassword("OldPass123")],
  );
  const app = express();
  app.use(express.json());
  accounts.register(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (path: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const phone = "13800000002";
  try {
    const temporary = await call("/api/auth/login", {
      phone,
      password: "OldPass123",
    });
    assert.equal(temporary.status, 200);
    assert.doesNotMatch(
      temporary.headers.get("set-cookie")!,
      /Max-Age|Expires/,
    );
    const saved = await call("/api/auth/login", {
      phone,
      password: "OldPass123",
      remember: true,
    });
    assert.match(saved.headers.get("set-cookie")!, /Max-Age=2592000/);
    const login = await saved.json();
    assert.equal(login.expires_in, 2592000);
    const ttl = (
      await db.query<{ seconds: number }>(
        "SELECT extract(epoch FROM (expires_at-now()))::int AS seconds FROM account_sessions ORDER BY expires_at DESC LIMIT 1",
      )
    ).rows[0].seconds;
    assert.ok(ttl > 2591990 && ttl <= 2592000);
    assert.equal(
      (await call("/api/auth/sms", { phone, purpose: "reset" })).status,
      200,
    );
    assert.equal(sends, 1);
    assert.equal(
      (await call("/api/auth/sms", { phone, purpose: "reset" })).status,
      429,
    );
    assert.equal(
      (
        await call("/api/auth/reset-password", {
          phone,
          code: "000000",
          password: "NewPass123",
        })
      ).status,
      400,
    );
    await db.query(
      "UPDATE sms_challenges SET purpose='register' WHERE phone=$1",
      [phone],
    );
    assert.equal(
      (
        await call("/api/auth/reset-password", {
          phone,
          code: "123456",
          password: "NewPass123",
        })
      ).status,
      400,
    );
    await db.query("UPDATE sms_challenges SET purpose='reset' WHERE phone=$1", [
      phone,
    ]);
    assert.equal(
      (
        await call("/api/auth/reset-password", {
          phone,
          code: "123456",
          password: "NewPass123",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(base + "/api/auth/me", {
          headers: { Authorization: `Bearer ${login.token}` },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await call("/api/auth/reset-password", {
          phone,
          code: "123456",
          password: "AgainPass123",
        })
      ).status,
      400,
    );
    assert.equal(
      (await call("/api/auth/login", { phone, password: "OldPass123" })).status,
      401,
    );
    assert.equal(
      (await call("/api/auth/login", { phone, password: "NewPass123" })).status,
      200,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
  }
});
