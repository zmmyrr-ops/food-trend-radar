import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { createAccounts, legacyOwner } from "../src/accounts.js";
import { createCouponMedia } from "../src/coupon-media.js";
import { openDatabase } from "../src/db.js";
import { createVideoProjects } from "../src/video-projects.js";

test("账号登录、会话撤销及素材/视频跨账号隔离", async () => {
  const db = await openDatabase();
  const dir = await mkdtemp(join(tmpdir(), "radar-accounts-"));
  const media = await createCouponMedia(db, join(dir, "missing.json"));
  const videos = await createVideoProjects(db, dir);
  const accounts = await createAccounts(db, { testMode: true });
  const app = express();
  app.use(express.json());
  accounts.register(app);
  media.register(app);
  videos.register(app);
  app.post("/api/v3/admin-task", (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function call(
    path: string,
    cookie = "",
    method = "GET",
    body?: unknown,
  ) {
    return fetch(base + path, {
      method,
      headers: { cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function login(phone: string) {
    const r = await call("/api/auth/login", "", "POST", {
      phone,
      code: "666666",
    });
    assert.equal(r.status, 200);
    const c = r.headers.get("set-cookie")!;
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Strict/);
    return { cookie: c.split(";")[0], account: (await r.json()).account };
  }
  try {
    assert.equal((await call("/api/v3/video-projects")).status, 401);
    assert.equal(
      (
        await call("/api/auth/login", "", "POST", {
          phone: "13800000001",
          code: "123456",
        })
      ).status,
      401,
    );
    const a = await login("13800000001"),
      b = await login("13800000002");
    assert.equal(a.account.role, "user");
    assert.notEqual(a.account.id, b.account.id);
    const brand = randomUUID(),
      project = randomUUID(),
      upload = randomUUID(),
      job = randomUUID();
    await db.query(
      "INSERT INTO video_projects(id,owner_id,payload) VALUES($1,$2,$3)",
      [
        project,
        a.account.id,
        JSON.stringify({
          id: project,
          brand_id: brand,
          product_id: "p",
          assets: [],
          state: "draft",
          updated_at: new Date().toISOString(),
        }),
      ],
    );
    await db.query(
      "INSERT INTO video_uploads(id,owner_id,kind) VALUES($1,$2,'video')",
      [upload, a.account.id],
    );
    await db.query(
      "INSERT INTO coupon_media_jobs(id,brand_id,product_id,keyword,names,state,owner_id,resources) VALUES($1,$2,'p','brand','[]','complete',$3,$4)",
      [job, brand, a.account.id, JSON.stringify([{ id: "private-resource" }])],
    );
    assert.equal(
      (await (await call("/api/v3/video-projects", a.cookie)).json()).items
        .length,
      1,
    );
    assert.equal(
      (await (await call("/api/v3/video-projects", b.cookie)).json()).items
        .length,
      0,
    );
    for (const suffix of ["", "/download?inline=1", "/media/fake"]) {
      assert.equal(
        (await call(`/api/v3/video-projects/${project}${suffix}`, b.cookie))
          .status,
        404,
      );
    }
    for (const suffix of ["cancel", "analyze", "preview", "export"]) {
      assert.equal(
        (
          await call(
            `/api/v3/video-projects/${project}/${suffix}`,
            b.cookie,
            "POST",
            {},
          )
        ).status,
        404,
      );
    }
    assert.equal(
      (await call(`/api/v3/video-projects/${project}`, b.cookie, "DELETE", {}))
        .status,
      404,
    );
    assert.equal(
      (await call(`/api/v3/video-assets/${upload}`, b.cookie, "DELETE", {}))
        .status,
      404,
    );
    const q = `/api/v3/coupon-media?brand_id=${brand}&product_id=p`;
    assert.equal(
      (await (await call(q, a.cookie)).json()).job.resources[0].id,
      "private-resource",
    );
    assert.equal((await (await call(q, b.cookie)).json()).job, null);
    await call(`/api/v3/coupon-media/${job}/cancel`, b.cookie, "POST", {});
    assert.equal(
      (
        await db.query<{ state: string }>(
          "SELECT state FROM coupon_media_jobs WHERE id=$1",
          [job],
        )
      ).rows[0].state,
      "complete",
    );
    assert.equal(
      (await call("/api/v3/admin-task", a.cookie, "POST", {})).status,
      403,
    );
    await call("/api/auth/logout", a.cookie, "POST", {});
    assert.equal((await call("/api/auth/me", a.cookie)).status, 401);
    const again = await login("13800000001");
    assert.equal(again.account.id, a.account.id);
    await db.query("INSERT INTO video_projects(id,payload) VALUES($1,'{}')", [
      randomUUID(),
    ]);
    assert.equal(
      (await (await call("/api/v3/video-projects", b.cookie)).json()).items
        .length,
      0,
    );
    // A second account can own an independent task for the same coupon.
    await db.query(
      "INSERT INTO coupon_media_jobs(id,brand_id,product_id,keyword,names,state,owner_id) VALUES($1,$2,'p','brand','[]','complete',$3)",
      [randomUUID(), brand, b.account.id],
    );
    assert.equal(
      (await (await call(q, b.cookie)).json()).job.resources.length,
      0,
    );
    await db.query(
      "UPDATE account_sessions SET expires_at=now()-interval '1 minute' WHERE account_id=$1",
      [b.account.id],
    );
    assert.equal((await call("/api/auth/me", b.cookie)).status, 401);
    for (let i = 0; i < 10; i++)
      await call("/api/auth/login", "", "POST", {
        phone: "13800000004",
        code: "123456",
      });
    assert.equal(
      (
        await call("/api/auth/login", "", "POST", {
          phone: "13800000004",
          code: "666666",
        })
      ).status,
      429,
    );
    await createAccounts(db, { testMode: true, adminPhone: "13800000001" });
    assert.equal(
      (
        await db.query("SELECT id FROM video_projects WHERE owner_id=$1", [
          legacyOwner,
        ])
      ).rows.length,
      0,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await videos.stop();
    await media.drain();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
