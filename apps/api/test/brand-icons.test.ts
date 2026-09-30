import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { cacheBrandIcon, platformImage } from "../src/brand-icons.js";
import { createCoupons, normalizeCoupon } from "../src/coupons.js";
import { openDatabase } from "../src/db.js";

test("图标拒绝非平台地址；券封面不会冒充品牌图标", () => {
  assert.equal(platformImage("http://127.0.0.1/icon.png"), null);
  assert.equal(platformImage("https://evil.douyinpic.com.example.com/i"), null);
  assert.equal(platformImage("https://user:pass@p3.douyinpic.com/i"), null);
  const raw = {
    product_id: "123",
    product_info: {
      product_name: "券",
      product_image: { url: "https://p3.douyinpic.com/product" },
    },
    nearest_poi_info: {
      brand_data: { brand_name: "品牌" },
      poi_image: { url: "https://p3.douyinpic.com/shop" },
    },
  };
  const c = normalizeCoupon(raw, ["品牌"]);
  assert.equal(c.brand_icon_kind, "shop_icon");
  assert.equal(c.brand_icon_url, "https://p3.douyinpic.com/shop");
});

test("券摘要关联正确品牌，图标以字节入库并从系统提供", async () => {
  const db = await openDatabase();
  const brand = randomUUID(),
    run = randomUUID();
  const originalFetch = globalThis.fetch;
  let server: Server | undefined;
  try {
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'品牌甲','品牌甲','其他餐饮','https://example.com')",
      [brand],
    );
    const coupon = {
      name: "100元代金券",
      identity: "name_match",
      price_min_fen: 6600,
      origin_price_fen: 10000,
      poi_name: "上海店",
      address: "上海",
      sale_end: "2027.01.01",
    };
    await db.query(
      "INSERT INTO coupon_items(run_id,brand_id,product_id,payload) VALUES($1,$2,'123',$3)",
      [run, brand, JSON.stringify(coupon)],
    );
    globalThis.fetch = async () =>
      new Response(Buffer.from([255, 216, 255, 224, 1]), { status: 200 });
    await cacheBrandIcon(
      db,
      brand,
      "https://p3.douyinpic.com/logo",
      "shop_icon",
    );
    globalThis.fetch = originalFetch;
    const app = express();
    createCoupons(db).register(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(
      `${base}/api/v3/coupons/123/summary?brand_id=${brand}`,
    );
    assert.equal(response.status, 200);
    const summary = await response.json();
    assert.equal(summary.item.title, "100元代金券");
    assert.equal(summary.item.price_fen, 6600);
    assert.equal(summary.item.icon_url, `/api/v3/brands/${brand}/icon`);
    assert.equal(
      (
        await fetch(
          `${base}/api/v3/coupons/123/summary?brand_id=${randomUUID()}`,
        )
      ).status,
      404,
    );
    const image = await fetch(base + summary.item.icon_url);
    assert.equal(image.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(
      Buffer.from(await image.arrayBuffer()),
      Buffer.from([255, 216, 255, 224, 1]),
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    await db.close();
  }
});

test("官方 Logo 精确入库，重复导入不变，店家图不能覆盖", async () => {
  const { seedOfficialBrandIcons } = await import("../src/brand-icons.js");
  const db = await openDatabase();
  const id = randomUUID(),
    unrelated = randomUUID();
  const originalFetch = globalThis.fetch;
  try {
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'肯德基','kfc','其他餐饮','https://www.kfc.com.cn/'),($2,'肯德基附近餐厅','other','其他餐饮','https://example.com')",
      [id, unrelated],
    );
    await seedOfficialBrandIcons(db);
    const before = (
      await db.query<any>("SELECT * FROM brand_icons WHERE brand_id=$1", [id])
    ).rows[0];
    assert.equal(before.kind, "official_logo");
    assert.match(before.source_url, /www\.kfc\.com\.cn/);
    assert.equal(
      (
        await db.query("SELECT 1 FROM brand_icons WHERE brand_id=$1", [
          unrelated,
        ])
      ).rows.length,
      0,
    );
    await seedOfficialBrandIcons(db);
    assert.deepEqual(
      (await db.query<any>("SELECT * FROM brand_icons WHERE brand_id=$1", [id]))
        .rows[0],
      before,
    );
    globalThis.fetch = async () =>
      new Response(Buffer.from([255, 216, 255, 224, 1]));
    await cacheBrandIcon(db, id, "https://p3.douyinpic.com/shop", "shop_icon");
    assert.deepEqual(
      (await db.query<any>("SELECT * FROM brand_icons WHERE brand_id=$1", [id]))
        .rows[0],
      before,
    );
    assert.match(
      (
        await db.query<{ icon_url: string }>(
          "SELECT icon_url FROM brands WHERE id=$1",
          [id],
        )
      ).rows[0].icon_url,
      /\?v=/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await db.close();
  }
});
