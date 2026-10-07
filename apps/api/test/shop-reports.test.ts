import assert from "node:assert/strict";
import test from "node:test";
import { createAccounts } from "../src/accounts.js";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { seedInvitation } from "./helpers/invitation.js";

test("users submit private reports; only admin can atomically review and enable brands", async () => {
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
  async function login(phone: string) {
    const r = await call("/api/auth/login", "", {
      phone,
      code: await seedInvitation(db, phone),
    });
    return r.headers.get("set-cookie")!.split(";")[0];
  }
  try {
    const a = await login("13800002101"),
      b = await login("13800002102"),
      admin = await login("13800002103");
    await db.query(
      "UPDATE accounts SET role='admin' WHERE phone='13800002103'",
    );
    const payload = {
      name: "测试新店",
      address: "上海市测试路1号",
      category: "其他餐饮",
      url: "https://www.douyin.com/",
      note: "想找代金券",
    };
    assert.equal((await call("/api/v3/shop-reports")).status, 401);
    const r = await call("/api/v3/shop-reports", a, payload);
    assert.equal(r.status, 201);
    const id = (await r.json()).id;
    const repeat = await (
      await call("/api/v3/shop-reports", a, payload)
    ).json();
    assert.equal(repeat.duplicate, true);
    assert.equal(
      (await (await call("/api/v3/shop-reports", b)).json()).total,
      0,
    );
    assert.equal(
      (await (await call("/api/v3/shop-reports", admin)).json()).total,
      1,
    );
    const approval = {
      decision: "approve",
      brand: {
        name: "测试新店",
        category: "其他餐饮",
        shanghai_evidence_url: "https://www.douyin.com/",
        keywords: ["测试新店"],
      },
      note: "核实后收录",
    };
    assert.equal(
      (await call(`/api/v3/shop-reports/${id}/review`, a, approval)).status,
      403,
    );
    const accepted = await call(
      `/api/v3/shop-reports/${id}/review`,
      admin,
      approval,
    );
    assert.equal(accepted.status, 200, await accepted.clone().text());
    const brandId = (await accepted.json()).brand_id;
    assert.equal(
      (await db.query<any>("SELECT active FROM brands WHERE id=$1", [brandId]))
        .rows[0].active,
      true,
    );
    assert.equal(
      (await call(`/api/v3/shop-reports/${id}/review`, admin, approval)).status,
      409,
    );
    const own = await (await call("/api/v3/shop-reports", a)).json();
    assert.equal(own.items[0].status, "approved");
    assert.equal(own.items[0].review_note, "核实后收录");
    assert.equal(own.items[0].owner_id, undefined);
    const second = (
      await (
        await call("/api/v3/shop-reports", b, {
          ...payload,
          address: "上海市测试路2号",
        })
      ).json()
    ).id;
    await db.query("UPDATE brands SET active=false WHERE id=$1", [brandId]);
    assert.equal(
      (
        await call(`/api/v3/shop-reports/${second}/review`, admin, {
          decision: "approve",
          brand_id: brandId,
        })
      ).status,
      200,
    );
    assert.equal(
      (await db.query<any>("SELECT active FROM brands WHERE id=$1", [brandId]))
        .rows[0].active,
      true,
    );
    const third = (
      await (
        await call("/api/v3/shop-reports", b, {
          ...payload,
          name: "重复品牌候选",
        })
      ).json()
    ).id;
    assert.equal(
      (await call(`/api/v3/shop-reports/${third}/review`, admin, approval))
        .status,
      409,
    );
    assert.equal(
      (
        await db.query<any>("SELECT status FROM shop_reports WHERE id=$1", [
          third,
        ])
      ).rows[0].status,
      "pending",
    );
    assert.equal(
      (
        await call(`/api/v3/shop-reports/${third}/review`, admin, {
          decision: "reject",
          note: "请补充门店信息后重新上报",
        })
      ).status,
      200,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
  }
});
