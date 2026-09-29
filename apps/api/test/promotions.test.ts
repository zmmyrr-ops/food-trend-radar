import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";

test("promotion details roundtrip, corrections, validation and CSV compatibility", async () => {
  const db = await openDatabase();
  const server = createApp(db).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  async function request(path: string, body?: unknown, method = "POST") {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1${path}`,
      body === undefined
        ? undefined
        : {
            method,
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "promotion-test",
            },
            body: JSON.stringify(body),
          },
    );
    return { status: response.status, data: await response.json() };
  }
  try {
    const brand = await request("/brands", {
      name: "优惠测试品牌",
      category: "茶饮果饮",
      shanghai_evidence_url: "https://example.com/store",
    });
    const draft = {
      brand_id: brand.data.id,
      title: "优惠测试",
      type: "优惠",
      starts_at: "2026-09-20T00:00:00Z",
      ends_at: "2026-09-25T00:00:00Z",
      source_url: "https://example.com/event",
      evidence_note: "仅测试",
      original_price: 30.5,
      effective_price: 0,
      promotion_terms: "会员领取，每人一次",
      collaboration: "测试IP",
      store_scope: "selected",
      applicable_stores: ["上海南京西路店", "上海浦东店"],
    };
    for (const changes of [
      { original_price: -1 },
      { effective_price: 1.001 },
      { original_price: 100001 },
      { store_scope: "selected", applicable_stores: [] },
      { store_scope: "all_shanghai" },
      { applicable_stores: ["上海 A 店", "上海Ａ店"] },
    ])
      assert.equal(
        (await request("/events", { ...draft, ...changes })).status,
        422,
      );
    const created = await request("/events", draft);
    assert.equal(created.status, 201);
    assert.equal(Number(created.data.effective_price), 0);
    assert.equal(Number(created.data.original_price), 30.5);
    assert.deepEqual(created.data.applicable_stores, draft.applicable_stores);
    assert.equal(created.data.promotion_terms, draft.promotion_terms);
    assert.equal(created.data.collaboration, draft.collaboration);
    const corrected = await request(
      `/events/${created.data.id}`,
      {
        ...draft,
        original_price: null,
        effective_price: 9.9,
        store_scope: "unknown",
        applicable_stores: [],
        promotion_terms: "门店范围待重新核验",
      },
      "PUT",
    );
    assert.equal(corrected.status, 200);
    assert.equal(corrected.data.original_price, null);
    assert.equal(corrected.data.store_scope, "unknown");
    assert.deepEqual(corrected.data.applicable_stores, []);
    const history = (await request(`/events/${created.data.id}/history`)).data
      .items;
    assert.equal(Number(history[0].snapshot.original_price), 30.5);
    assert.deepEqual(
      history[0].snapshot.applicable_stores,
      draft.applicable_stores,
    );
    const columns =
      "brand_id,title,type,starts_at,ends_at,source_url,evidence_note,original_price,effective_price,promotion_terms,collaboration,store_scope,applicable_stores\n";
    const csv =
      columns +
      `${brand.data.id},CSV优惠,优惠,2026-09-20T00:00:00Z,2026-09-25T00:00:00Z,https://example.com/csv,测试,20,9.90,每人一次,测试IP,selected,上海甲店|上海乙店\n` +
      `${brand.data.id},坏门店,优惠,2026-09-20T00:00:00Z,2026-09-25T00:00:00Z,https://example.com/csv,测试,,,,,selected,`;
    const preview = await request("/imports/preview", { csv });
    assert.equal(preview.data.valid, 1);
    assert.equal(preview.data.errors[0].row, 3);
    assert.equal((await request("/events")).data.items.length, 1);
    const imported = await request("/imports", { csv });
    assert.equal(imported.data.created, 1);
    assert.equal(imported.data.errors.length, 1);
    const events = (await request("/events")).data.items;
    const saved = events.find((e: { title: string }) => e.title === "CSV优惠");
    assert.deepEqual(saved.applicable_stores, ["上海甲店", "上海乙店"]);
    assert.equal(Number(saved.effective_price), 9.9);
    assert.equal(saved.collaboration, "测试IP");
    assert.equal((await request("/opportunities")).data.p72, null);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  }
});
