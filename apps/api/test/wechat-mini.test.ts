import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import express from "express";
import { createAccounts } from "../src/accounts.js";
import { registerBrandBlacklist } from "../src/brand-blacklist.js";
import { registerBrandSubscriptions } from "../src/brand-subscriptions.js";
import { registerCouponPicks } from "../src/coupon-picks.js";
import { openDatabase } from "../src/db.js";
import { MINI_TEMPLATE_ID, miniTemplate } from "../src/wechat-mini.js";

test("微信模板字段长度与上海时间", () => {
  const d = miniTemplate({
    brand_name: "很长的品牌名称".repeat(10),
    title: "标题".repeat(30),
    kind: "new",
    created_at: "2026-10-05T00:12:00Z",
  });
  assert.equal(Array.from(d.thing1.value).length, 20);
  assert.equal(d.time4.value, "2026-10-05 08:12");
  assert.equal(d.thing2.value, "上海");
  assert.equal(Array.from(d.thing3.value).length, 20);
});
test("微信登录、限定接口、账号隔离、券字段脱敏、授权及消息幂等", async () => {
  const db = await openDatabase();
  let sent = 0;
  let sendFailure = false;
  const bodies: any[] = [];
  const accounts = await createAccounts(db, {
    testMode: true,
    wechat: {
      secret: async () => "test-secret",
      transport: async (url, body) => {
        if (url.includes("jscode2session")) {
          const code = new URL(url).searchParams.get("js_code");
          return code === "bad"
            ? { errcode: 40029 }
            : { openid: "openid-" + code };
        }
        if (url.includes("stable_token"))
          return { access_token: "test-token", expires_in: 7200 };
        sent++;
        bodies.push(body);
        if (sendFailure) throw Error("timeout");
        return { errcode: 0 };
      },
    },
  });
  const app = express();
  app.use(express.json());
  accounts.register(app);
  registerBrandSubscriptions(app, db);
  registerBrandBlacklist(app, db);
  const brand = randomUUID();
  await db.query(
    "INSERT INTO brands(id,name,name_key,aliases,category,active,shanghai_evidence_url) VALUES($1,'测试微信品牌','wx-test','[]','其他餐饮',true,'https://example.com')",
    [brand],
  );
  registerCouponPicks(
    app,
    async () => [],
    async () => [],
    db,
    undefined,
    undefined,
    async () =>
      [
        {
          brand_id: brand,
          product_id: "123",
          category: "其他餐饮",
          brand_name: "测试微信品牌",
          title: "半价券",
          price_fen: 1000,
          origin_price_fen: 2000,
          latest_sales: "12345",
          speed: 99,
          priority: {
            score: 50,
            value_gate: { eligible: true },
            parts: [{ name: "销量升温", value: 15 }],
          },
          use_outlook: { fully_excluded: false },
        },
      ] as any,
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = (path: string, token = "", body?: unknown) =>
    fetch(base + "/api/mini/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    assert.equal((await call("login", "", { code: "bad" })).status, 401);
    const a = await (await call("login", "", { code: "a" })).json();
    const b = await (await call("login", "", { code: "b" })).json();
    assert.equal((await call("profile")).status, 401);
    const avatar =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=";
    await db.query(
      "INSERT INTO brand_icons(brand_id,mime,content,source_url,kind) VALUES($1,'image/png',$2,'https://example.com/logo.png','official_logo')",
      [brand, avatar.split(",")[1]],
    );
    const icon = await call("brand-icons/" + brand);
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get("content-type")!, /^image\/png/);
    assert.match(icon.headers.get("cache-control")!, /max-age=3600/);
    assert.deepEqual(
      Buffer.from(await icon.arrayBuffer()),
      Buffer.from(avatar.split(",")[1], "base64"),
    );
    assert.equal((await call("brand-icons/not-a-uuid")).status, 404);
    assert.equal((await call("brand-icons/" + randomUUID())).status, 404);
    await db.query("UPDATE brands SET active=false WHERE id=$1", [brand]);
    assert.equal((await call("brand-icons/" + brand)).status, 404);
    await db.query("UPDATE brands SET active=true WHERE id=$1", [brand]);
    assert.equal(
      (
        await call("profile", a.token, {
          nickname: "探店达人",
          avatar_data: avatar,
        })
      ).status,
      200,
    );
    assert.equal(
      (await (await call("profile", a.token)).json()).profile.nickname,
      "探店达人",
    );
    assert.equal(
      (await (await call("profile", a.token)).json()).profile.avatar_data,
      avatar,
    );
    assert.equal(
      (await (await call("profile", b.token)).json()).profile.nickname,
      "",
    );
    assert.equal(
      (
        await call("profile", a.token, {
          avatar_data: "https://example.com/a.png",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call("profile", a.token, {
          avatar_data: "data:image/png;base64,YWJj",
        })
      ).status,
      400,
    );
    await call("profile", a.token, { nickname: "新昵称" });
    assert.equal(
      (await (await call("profile", a.token)).json()).profile.avatar_data,
      avatar,
    );
    assert.equal(a.template_id, MINI_TEMPLATE_ID);
    assert.equal(a.openid, undefined);
    assert.equal(a.session_key, undefined);
    assert.equal((await call("coupon-picks")).status, 401);
    assert.equal((await call("operations", a.token)).status, 404);
    const p = await (
      await call("coupon-picks?view=recommended", a.token)
    ).json();
    assert.equal(p.total, 1);
    assert.equal(p.items[0].heat_index, 50);
    assert.equal(p.items[0].latest_sales, undefined);
    assert.equal(p.items[0].speed, undefined);
    assert.equal(
      (
        await call("brand-blacklist", a.token, {
          brand_id: brand,
          blocked: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (await (await call("coupon-picks?view=recommended", a.token)).json())
        .total,
      0,
    );
    assert.equal(
      (await (await call("coupon-picks?view=recommended", b.token)).json())
        .total,
      1,
    );
    assert.equal(
      (await (await call("coupon-picks?view=all", a.token)).json()).total,
      1,
    );
    await call("brand-subscriptions", a.token, {
      brand_id: brand,
      subscribed: true,
    });
    const owner = (
      await db.query<{ owner_id: string }>(
        "SELECT owner_id FROM wechat_identities WHERE openid='openid-a'",
      )
    ).rows[0].owner_id;
    const insert = async () => {
      const id = randomUUID();
      await db.query(
        "INSERT INTO subscription_messages(id,owner_id,brand_id,product_id,kind,event_key,brand_name,title) VALUES($1,$2,$3,'123','new',$4,'测试品牌','测试券')",
        [id, owner, brand, id],
      );
      return id;
    };
    await insert();
    await accounts.tick();
    assert.equal(sent, 0);
    await call("notification-consent", a.token, { accepted: true });
    await insert();
    await Promise.all([accounts.tick(), accounts.tick()]);
    assert.equal(sent, 1);
    await accounts.tick();
    assert.equal(sent, 1);
    assert.equal(bodies[0].touser, "openid-a");
    assert.equal(bodies[0].template_id, MINI_TEMPLATE_ID);
    await call("notification-consent", a.token, { accepted: false });
    await insert();
    await accounts.tick();
    assert.equal(sent, 1);
    sendFailure = true;
    await call("notification-consent", a.token, { accepted: true });
    const id = await insert();
    await accounts.tick();
    await accounts.tick();
    assert.equal(sent, 2);
    assert.equal(
      (
        await db.query<{ state: string }>(
          "SELECT state FROM wechat_deliveries WHERE message_id=$1",
          [id],
        )
      ).rows[0].state,
      "unknown",
    );
    await call("logout", a.token, {});
    assert.equal((await call("brand-subscriptions", a.token)).status, 401);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
  }
});
