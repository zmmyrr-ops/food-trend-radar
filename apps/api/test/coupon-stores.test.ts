import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  parseStorePage,
  parseStoreScope,
  resumePartialStoreTasks,
} from "../src/coupon-stores.js";
import { createCoupons, SerialGate } from "../src/coupons.js";
import { openDatabase } from "../src/db.js";

const poi = (id: string) => ({
  poi: {
    poi_id: id,
    poi_name: "上海测试店",
    city_name: "上海市",
    ad_code: "310115",
    phone_list: ["private"],
    cover: "secret",
  },
});
test("store scope requires exact distinct IDs; Shanghai requires city and code; strips unrelated fields", () => {
  assert.equal(
    parseStoreScope({ status_code: 0, poi_count: 2, poi_id_list: ["1", "1"] })
      .consistent,
    false,
  );
  assert.equal(
    parseStoreScope({ status_code: 0, poi_count: 2, poi_id_list: ["1"] })
      .consistent,
    false,
  );
  const p = parseStorePage({ status_code: 0, poi_list: [poi("1")] }, ["1"])[0];
  assert.equal(p.shanghai, true);
  assert.equal("phone_list" in p, false);
  assert.equal("cover" in p, false);
  assert.equal(
    parseStorePage(
      {
        status_code: 0,
        poi_list: [{ poi: { ...poi("1").poi, ad_code: "320100" } }],
      },
      ["1"],
    )[0].shanghai,
    false,
  );
  assert.throws(
    () => parseStorePage({ status_code: 0, poi_list: [poi("2")] }, ["1"]),
    /STORE_SCOPE_MISMATCH/,
  );
  assert.throws(
    () =>
      parseStorePage({ status_code: 0, poi_list: [poi("1"), poi("1")] }, ["1"]),
    /STORE_SCOPE_MISMATCH/,
  );
});
for (const { missing, truncated, firstBatchOnly } of [
  { missing: false, truncated: false, firstBatchOnly: false },
  { missing: true, truncated: false, firstBatchOnly: false },
  { missing: true, truncated: false, firstBatchOnly: true },
  { missing: false, truncated: true, firstBatchOnly: false },
])
  test(`store collection persists scope and chunks; missing=${missing}, truncated=${truncated}, firstBatchOnly=${firstBatchOnly}`, async () => {
    const db = await openDatabase(),
      brand = randomUUID();
    const ids = Array.from({ length: 23 }, (_, i) => String(i + 1));
    const batches: string[][] = [];
    await db.query(
      "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'测试品牌','store-test','火锅','https://example.com')",
      [brand],
    );
    const service = createCoupons(db, {
      gate: new SerialGate(
        async () => {},
        () => Date.now(),
        () => 0,
      ),
      fetchPage: async () => ({
        status_code: 0,
        cursor: 1,
        has_more: false,
        product_list: [
          {
            product_id: "123",
            product_info: {
              product_name: "测试券",
              price_range: { min: 100, max: 100 },
            },
            nearest_poi_info: {
              brand_data: { brand_name: "测试品牌", brand_id: "456" },
            },
          },
        ],
      }),
      fetchStoreDetail: async () => ({
        status_code: 0,
        poi_count: truncated ? 109 : 23,
        poi_id_list: ids,
      }),
      fetchStorePois: async (_id, requested) => {
        batches.push(requested);
        return {
          status_code: 0,
          poi_list: (missing && (!firstBatchOnly || requested[0] === "1")
            ? requested.slice(1)
            : requested
          ).map(poi),
        };
      },
    });
    try {
      await service.start([brand]);
      await service.drain();
      assert.deepEqual(
        batches.map((b) => b.length),
        [20, 3],
      );
      const task = (
        await db.query<{ state: string; error_code: string }>(
          "SELECT state,error_code FROM coupon_store_tasks",
        )
      ).rows[0];
      assert.equal(
        task.state,
        missing || truncated ? "incomplete" : "complete",
      );
      if (missing) assert.equal(task.error_code, "STORE_IDS_MISSING");
      const payload = (
        await db.query<{
          payload: {
            complete: boolean;
            matched_count: number;
            unverified_count: number;
            missing_ids: string[];
            queried_id_count: number;
          };
        }>("SELECT payload FROM coupon_store_snapshots")
      ).rows[0].payload;
      assert.equal(payload.complete, !missing && !truncated);
      if (truncated) {
        assert.equal(task.error_code, "STORE_COUNT_MISMATCH");
        assert.equal(payload.unverified_count, 86);
      }
      assert.equal(
        payload.matched_count,
        missing ? (firstBatchOnly ? 22 : 21) : 23,
      );
      assert.equal(payload.queried_id_count, 23);
      assert.deepEqual(
        payload.missing_ids,
        missing ? (firstBatchOnly ? ["1"] : ["1", "21"]) : [],
      );
      assert.equal(await resumePartialStoreTasks(db), 0);
      if (missing && firstBatchOnly) {
        // Recreate the legacy early-stop state; only the unqueried tail may resume.
        await db.query(
          "UPDATE coupon_store_tasks SET cursor=20,state='incomplete',error_code='STORE_IDS_MISSING'",
        );
        await db.query(
          "DELETE FROM coupon_store_items WHERE poi_id IN ('21','22','23')",
        );
        await db.query(
          "UPDATE coupon_store_snapshots SET payload=jsonb_set(payload,'{matched_count}','19'::jsonb)",
        );
        await db.query(
          "UPDATE coupon_items SET observed_at=now()-interval '37 hours'",
        );
        assert.equal(await resumePartialStoreTasks(db), 0);
        await db.query(
          "UPDATE coupon_items SET observed_at=now()+interval '1 hour'",
        );
        assert.equal(await resumePartialStoreTasks(db), 0);
        await db.query("UPDATE coupon_items SET observed_at=now()");
        await db.query("UPDATE brands SET active=false WHERE id=$1", [brand]);
        assert.equal(await resumePartialStoreTasks(db), 0);
        await db.query("UPDATE brands SET active=true WHERE id=$1", [brand]);
        assert.equal(await resumePartialStoreTasks(db), 1);
        assert.equal(await resumePartialStoreTasks(db), 0);
        service.kick();
        await service.drain();
        assert.deepEqual(batches.at(-1), ["21", "22", "23"]);
        const saved = (
          await db.query<{
            payload: {
              complete: boolean;
              matched_count: number;
              missing_ids: string[];
            };
          }>("SELECT payload FROM coupon_store_snapshots")
        ).rows[0].payload;
        assert.equal(saved.matched_count, 22);
        assert.equal(saved.complete, false);
        assert.deepEqual(saved.missing_ids, ["1"]);
        assert.equal(await resumePartialStoreTasks(db), 0);
      }
      service.kick();
      await service.drain();
      assert.equal(batches.length, missing && firstBatchOnly ? 3 : 2);
    } finally {
      await service.stop();
      await db.close();
    }
  });

test("partial scope lookup is allowed only for valid unique bounded IDs", () => {
  const scope = (count: number, ids: string[]) =>
    parseStoreScope({ status_code: 0, poi_count: count, poi_id_list: ids });
  assert.equal(scope(109, ["1", "2"]).lookup_allowed, true);
  assert.equal(scope(1, ["1", "2"]).lookup_allowed, false);
  assert.equal(scope(3, ["1", "1"]).lookup_allowed, false);
  assert.equal(scope(0, []).lookup_allowed, false);
  assert.equal(
    scope(
      1001,
      Array.from({ length: 1001 }, (_, i) => String(i)),
    ).lookup_allowed,
    false,
  );
});

test("known invalid store arguments fail only that coupon; unknown codes remain blocking", async () => {
  assert.throws(
    () =>
      parseStorePage({ status_code: 2062000001, status_msg: "参数不合法" }, [
        "1",
      ]),
    /STORE_INVALID_ARGUMENTS/,
  );
  assert.throws(
    () => parseStorePage({ status_code: 999, status_msg: "参数不合法" }, ["1"]),
    /BUSINESS_OR_SCHEMA_ERROR/,
  );
  assert.throws(
    () =>
      parseStorePage({ status_code: 2062000001, status_msg: "其他错误" }, [
        "1",
      ]),
    /BUSINESS_OR_SCHEMA_ERROR/,
  );
  const db = await openDatabase();
  const brand = randomUUID();
  await db.query(
    "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'测试品牌','invalid-store-test','火锅','https://example.com')",
    [brand],
  );
  const calls: string[] = [];
  const service = createCoupons(db, {
    gate: new SerialGate(
      async () => {},
      () => Date.now(),
      () => 0,
    ),
    fetchPage: async () => ({
      status_code: 0,
      cursor: 1,
      has_more: false,
      product_list: ["123", "124"].map((product_id) => ({
        product_id,
        product_info: {
          product_name: "测试券",
          price_range: { min: 100, max: 100 },
        },
        nearest_poi_info: {
          brand_data: { brand_name: "测试品牌", brand_id: "456" },
        },
      })),
    }),
    fetchStoreDetail: async () => ({
      status_code: 0,
      poi_count: 1,
      poi_id_list: ["1"],
    }),
    fetchStorePois: async (product) => {
      calls.push(product);
      return product === "123"
        ? { status_code: 2062000001, status_msg: "参数不合法" }
        : { status_code: 0, poi_list: [poi("1")] };
    },
  });
  try {
    await service.start([brand]);
    await service.drain();
    const tasks = (
      await db.query(
        "SELECT product_id,state,error_code FROM coupon_store_tasks ORDER BY product_id",
      )
    ).rows;
    assert.deepEqual(tasks, [
      {
        product_id: "123",
        state: "failed",
        error_code: "STORE_INVALID_ARGUMENTS",
      },
      { product_id: "124", state: "complete", error_code: null },
    ]);
    assert.equal(
      (await db.query("SELECT pause_reason FROM coupon_settings")).rows[0]
        .pause_reason,
      null,
    );
    assert.deepEqual(
      (
        await db.query("SELECT product_id FROM coupon_store_snapshots")
      ).rows.map((r) => r.product_id),
      ["124"],
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM coupon_requests WHERE outcome='STORE_INVALID_ARGUMENTS'",
        )
      ).rows[0].n,
      1,
    );
    service.kick();
    await service.drain();
    assert.equal(calls.filter((id) => id === "123").length, 1);
  } finally {
    await service.stop();
    await db.close();
  }
});
