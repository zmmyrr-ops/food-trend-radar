import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { createAccounts } from "../src/accounts.js";
import { openDatabase } from "../src/db.js";
import { createVideoProjects } from "../src/video-projects.js";

test("探店计划隔离、店铺去重、排序、视频归属及软删除保留视频", async () => {
  const db = await openDatabase(),
    dir = await mkdtemp(join(tmpdir(), "visits-")),
    videos = await createVideoProjects(db, dir),
    accounts = await createAccounts(db, { testMode: true });
  await videos.stop();
  const app = express();
  app.use(express.json());
  accounts.register(app);
  videos.register(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (path: string, cookie = "", method = "GET", body?: unknown) =>
    fetch(base + "/api/" + path, {
      method,
      headers: { cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async (phone: string) => {
    const r = await call("auth/login", "", "POST", { phone, code: "666666" });
    return {
      cookie: r.headers.get("set-cookie")!.split(";")[0],
      account: (await r.json()).account,
    };
  };
  try {
    const a = await login("13800001001"),
      b = await login("13800001002");
    assert.equal((await call("v3/visit-plans")).status, 401);
    assert.equal(
      (await fetch(base + "/_AMapService/v3/place/text")).status,
      401,
    );
    assert.equal(
      (
        await call("v3/visit-plans", a.cookie, "POST", {
          name: "x",
          date: "2026-02-31",
        })
      ).status,
      400,
    );
    const p = (
      await (
        await call("v3/visit-plans", a.cookie, "POST", {
          name: "周末探店",
          date: "2026-10-01",
        })
      ).json()
    ).id;
    const store = {
      name: "测试店",
      address: "上海市测试路1号",
      lat: 31.23,
      lng: 121.47,
    };
    const s = (
      await (
        await call(`v3/visit-plans/${p}/stores`, a.cookie, "POST", store)
      ).json()
    ).id;
    assert.ok(s);
    assert.equal(
      (
        await (
          await call(`v3/visit-plans/${p}/stores`, a.cookie, "POST", store)
        ).json()
      ).duplicate,
      true,
    );
    assert.equal(
      (await (await call("v3/visit-plans", b.cookie)).json()).items.length,
      0,
    );
    assert.equal(
      (await call(`v3/visit-plans/${p}`, b.cookie, "DELETE")).status,
      400,
    );
    assert.equal((await call(`v3/visit-stores/${s}`, b.cookie)).status, 404);
    const s2 = (
      await (
        await call(`v3/visit-plans/${p}/stores`, a.cookie, "POST", {
          ...store,
          name: "另一家店",
        })
      ).json()
    ).id;
    assert.equal(
      (
        await call(`v3/visit-plans/${p}/order`, a.cookie, "PUT", {
          ids: [s2, s],
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(`v3/visit-plans/${p}/order`, a.cookie, "PUT", {
          ids: [s, s],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call(`v3/visit-plans/${p}/stores/${s}`, a.cookie, "PATCH", {
          ...store,
          name: "新店名",
        })
      ).status,
      200,
    );
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await fetch(base + "/api/v3/video-assets", {
        method: "POST",
        headers: { cookie: a.cookie, "Content-Type": "image/png" },
        body: Buffer.alloc(200),
      });
      ids.push((await r.json()).id);
    }
    const body = {
      brand_id: "",
      product_id: "",
      visit_store_id: s,
      seconds: 12,
      resource_ids: [],
      upload_ids: ids,
      rights_confirmed: true,
    };
    assert.equal(
      (await call("v3/video-projects", b.cookie, "POST", body)).status,
      400,
    );
    assert.equal(
      (
        await call("v3/video-projects", a.cookie, "POST", {
          ...body,
          visit_store_id: randomUUID(),
        })
      ).status,
      400,
    );
    const r = await call("v3/video-projects", a.cookie, "POST", body);
    assert.equal(r.status, 201);
    const v = (await r.json()).project;
    assert.equal(v.visit_store_id, s);
    assert.equal(v.visit_plan_id, p);
    assert.equal(v.brand_name, "新店名");
    const history = await (
      await call(`v3/video-projects?visit_store_id=${s}`, a.cookie)
    ).json();
    assert.equal(history.items.length, 1);
    assert.equal(
      (
        await (
          await call(`v3/video-projects?visit_store_id=${s2}`, a.cookie)
        ).json()
      ).items.length,
      0,
    );
    assert.equal(
      (await call(`v3/video-projects/${v.id}`, b.cookie)).status,
      404,
    );
    await call(`v3/visit-plans/${p}`, a.cookie, "DELETE");
    assert.equal(
      (await (await call("v3/visit-plans", a.cookie)).json()).items.length,
      0,
    );
    assert.equal(
      (await call(`v3/video-projects/${v.id}`, a.cookie)).status,
      200,
    );
    assert.equal(
      (await call("v3/video-projects", a.cookie, "POST", body)).status,
      400,
    );
  } finally {
    await videos.stop();
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
