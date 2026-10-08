import assert from "node:assert/strict";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { createAccounts, hashAccountPassword } from "../src/accounts.js";
import { openDatabase } from "../src/db.js";
import { changePoints, refundPoints, setupPoints } from "../src/points.js";

test("legacy migration, verified invitation registration, SMS limits, rewards, hidden grants and password change", async () => {
  const db = await openDatabase();
  const dir = await mkdtemp(join(tmpdir(), "member-test-"));
  const key = randomBytes(32);
  await writeFile(join(dir, "account-invitation-key"), key);
  const admin = randomUUID(),
    old = randomUUID();
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("13800000002"));
  const encrypted = Buffer.concat([cipher.update("87654321"), cipher.final()]);
  const secret = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    "base64",
  );
  await db.exec(
    "CREATE TABLE accounts(id uuid PRIMARY KEY,phone text UNIQUE NOT NULL,role text NOT NULL DEFAULT 'user',created_at timestamptz NOT NULL DEFAULT now(),password_hash text,invitation_encrypted text)",
  );
  await db.query(
    "INSERT INTO accounts(id,phone,role,password_hash) VALUES($1,'13800000001','admin',$2)",
    [admin, await hashAccountPassword("AdminPass123")],
  );
  await db.query(
    "INSERT INTO accounts(id,phone,invitation_encrypted) VALUES($1,'13800000002',$2)",
    [old, secret],
  );
  let sends = 0,
    checks = 0;
  const options = {
    invitationExportPath: join(dir, "export.json"),
    sms: {
      send: async () => {
        sends++;
      },
      check: async (_p: string, code: string) => {
        checks++;
        return code === "123456";
      },
    },
  };
  const accounts = await createAccounts(db, options);
  const app = express();
  app.use(express.json());
  accounts.register(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (path: string, token = "", body?: unknown) => {
    const r = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
  try {
    let r = await call("/api/auth/login", "", {
      phone: "13800000002",
      password: "87654321",
    });
    assert.equal(r.status, 200);
    const user = r.data.token;
    r = await call("/api/auth/login", "", {
      phone: "13800000002",
      code: "87654321",
    });
    assert.equal(r.status, 400);
    const a = (
      await call("/api/auth/login", "", {
        phone: "13800000001",
        password: "AdminPass123",
      })
    ).data.token;
    assert.equal((await call("/api/member", user)).data.balance, 500);
    await setupPoints(db);
    assert.equal((await call("/api/member", user)).data.balance, 500);
    const referral = (await call("/api/member/invitation", user, {})).data.code;
    assert.match(referral, /^(?=.*[A-Z])(?=.*[2-9])[A-Z2-9]{6}$/);
    const concurrent = await Promise.all([
      call("/api/member/invitation", a, {}),
      call("/api/member/invitation", a, {}),
    ]);
    assert.equal(concurrent[0].status, 200);
    assert.equal(concurrent[1].status, 200);
    assert.equal(concurrent[0].data.code, concurrent[1].data.code);
    assert.notEqual(concurrent[0].data.code, referral);
    await assert.rejects(
      db.query("UPDATE accounts SET referral_code=$1 WHERE referral_code=$2", [
        referral,
        concurrent[0].data.code,
      ]),
    );

    assert.equal(
      (await call("/api/member/invitation", user, {})).data.code,
      referral,
    );
    assert.equal(
      (
        await call("/api/auth/sms", "", {
          phone: "13800000003",
          invitation_code: "000000",
        })
      ).status,
      400,
    );
    assert.equal(sends, 0);
    const smsBody = {
      phone: "13800000003",
      invitation_code: referral.toLowerCase(),
    };
    const parallel = await Promise.all([
      call("/api/auth/sms", "", smsBody),
      call("/api/auth/sms", "", smsBody),
    ]);
    assert.deepEqual(parallel.map((r) => r.status).sort(), [200, 429]);
    assert.equal(sends, 1);
    assert.equal(
      (
        await call("/api/auth/register", "", {
          ...smsBody,
          code: "999999",
          password: "NewPass123",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call("/api/auth/register", "", {
          ...smsBody,
          code: "123456",
          password: "NewPass123",
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await call("/api/auth/register", "", {
          ...smsBody,
          code: "123456",
          password: "NewPass123",
        })
      ).status,
      400,
    );
    const n = (
      await call("/api/auth/login", "", {
        phone: "13800000003",
        password: "NewPass123",
      })
    ).data.token;
    const newId = (await call("/api/auth/me", n)).data.account.id;
    assert.equal((await call("/api/member", n)).data.balance, 100);
    const inviter = (await call("/api/member", user)).data;
    assert.equal(inviter.balance, 600);
    assert.equal(inviter.invited[0].phone, "13800000003");
    assert.equal(checks, 2);
    const gift = { amount: 77, request_id: randomUUID(), note: "测试赠送" };
    assert.equal(
      (await call(`/api/admin/members/${newId}/points`, n, gift)).status,
      403,
    );
    assert.equal(
      (await call(`/api/admin/members/${newId}/points`, a, gift)).status,
      200,
    );
    await call(`/api/admin/members/${newId}/points`, a, gift);
    assert.equal((await call("/api/member", n)).data.balance, 177);
    assert.equal((await call("/api/member/points", n)).data.items.length, 1);
    assert.equal(
      (await call(`/api/admin/members/${newId}/points`, a)).data.items.length,
      2,
    );
    await db.transaction((tx) =>
      changePoints(tx, newId, -10, "获取素材", "test:charge"),
    );
    await refundPoints(db, "test:charge");
    await refundPoints(db, "test:charge");
    assert.equal((await call("/api/member", n)).data.balance, 177);
    await assert.rejects(
      db.transaction((tx) =>
        changePoints(tx, newId, -1000, "不足", "test:insufficient"),
      ),
      /POINTS_INSUFFICIENT/,
    );
    for (let i = 0; i < 5; i++) {
      if (i)
        await db.query(
          "UPDATE sms_limits SET last_sent_at=now()-interval '2 minutes' WHERE phone='13800000004'",
        );
      assert.equal(
        (
          await call("/api/auth/sms", "", {
            phone: "13800000004",
            invitation_code: referral,
          })
        ).status,
        200,
      );
    }
    await db.query(
      "UPDATE sms_limits SET last_sent_at=now()-interval '2 minutes' WHERE phone='13800000004'",
    );
    assert.equal(
      (
        await call("/api/auth/sms", "", {
          phone: "13800000004",
          invitation_code: referral,
        })
      ).status,
      429,
    );
    assert.equal(
      (
        await call("/api/member/password", n, {
          old_password: "NewPass123",
          password: "UpdatedPass123",
        })
      ).status,
      200,
    );
    assert.equal((await call("/api/member", n)).status, 401);
    assert.equal(
      (
        await call("/api/auth/login", "", {
          phone: "13800000003",
          password: "NewPass123",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await call("/api/auth/login", "", {
          phone: "13800000003",
          password: "UpdatedPass123",
        })
      ).status,
      200,
    );
    await createAccounts(db, options);
    assert.equal(
      (
        await call("/api/auth/login", "", {
          phone: "13800000003",
          password: "UpdatedPass123",
        })
      ).status,
      200,
    );
    assert.equal((await call("/api/member", user)).data.balance, 600);
    assert.equal((await call("/api/member/daily-login", "", {})).status, 401);
    const daily = await call("/api/member/daily-login", user, {});
    assert.equal(daily.status, 200);
    assert.equal(daily.data.awarded, true);
    assert.equal(daily.data.balance, 620);
    assert.equal(
      (await call("/api/member/daily-login", user, {})).data.awarded,
      false,
    );
    assert.equal((await call("/api/member", user)).data.balance, 620);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await accounts.drain();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
