import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeRules } from "../src/coupon-rules.js";
import { createCoupons, SerialGate } from "../src/coupons.js";
import { openDatabase } from "../src/db.js";

const fixture = JSON.parse(
  await readFile(
    new URL("./fixtures/commodity-sanitized.json", import.meta.url),
    "utf8",
  ),
);
test("real commodity response keeps restrictive rules but strips signed image URLs", () => {
  const r = normalizeRules(fixture);
  assert.equal(r.status, "received");
  assert.equal(r.groups[0].item_list[0].count, 1);
  assert.ok(
    r.rules.some((x) => x.value.some((v) => v.content.includes("周六、周日"))),
  );
  assert.equal(r.full_comparability, false);
  assert.equal(JSON.stringify(r).includes("x-signature"), false);
  assert.equal(normalizeRules({ status_code: 0 }).status, "incomplete");
  assert.throws(
    () => normalizeRules({ status_code: 8 }),
    /BUSINESS_OR_SCHEMA_ERROR/,
  );
  const reversed = structuredClone(fixture);
  reversed.use_rule_info.body.reverse();
  assert.equal(normalizeRules(reversed).rule_fingerprint, r.rule_fingerprint);
});
test("selection and commodity share one gate; durable backfill, auth pause and recovery", async () => {
  const db = await openDatabase();
  const brand = randomUUID();
  let fail = true,
    active = 0,
    peak = 0;
  const calls: string[] = [];
  await db.query(
    "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,'测试品牌','rules-test','火锅','https://example.com')",
    [brand],
  );
  const gate = new SerialGate(
    async () => {},
    () => Date.now(),
    () => 0,
  );
  const service = createCoupons(db, {
    gate,
    fetchPage: async () => {
      active++;
      peak = Math.max(peak, active);
      calls.push("selection");
      active--;
      return {
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
      };
    },
    fetchRules: async () => {
      active++;
      peak = Math.max(peak, active);
      calls.push("commodity");
      active--;
      if (fail) throw new Error("AUTH_EXPIRED");
      return fixture;
    },
  });
  try {
    await service.start([brand]);
    await service.drain();
    assert.deepEqual(calls, ["selection", "commodity"]);
    assert.equal(peak, 1);
    assert.equal(
      (
        await db.query<{ pause_reason: string }>(
          "SELECT pause_reason FROM coupon_settings",
        )
      ).rows[0].pause_reason,
      "AUTH_EXPIRED",
    );
    assert.equal(
      (await db.query("SELECT * FROM coupon_rule_snapshots")).rows.length,
      0,
    );
    assert.equal(await service.enqueueRules(brand), 0);
    fail = false;
    await db.query("UPDATE coupon_settings SET pause_reason=NULL");
    service.kick();
    await service.drain();
    assert.equal(
      (await db.query("SELECT * FROM coupon_rule_snapshots")).rows.length,
      1,
    );
    assert.equal(
      (await db.query<{ state: string }>("SELECT state FROM coupon_rule_tasks"))
        .rows[0].state,
      "complete",
    );
    const requests = await db.query<{ kind: string; outcome: string }>(
      "SELECT kind,outcome FROM coupon_requests ORDER BY started_at",
    );
    assert.equal(requests.rows.filter((r) => r.kind === "commodity").length, 2);
    assert.equal(requests.rows.at(-1)?.outcome, "OK");
    await service.enqueueRules(brand);
    service.kick();
    await service.drain();
    assert.equal(calls.length, 3);
  } finally {
    await service.stop();
    await db.close();
  }
});

for (const pauseOnDetail of [false, true]) {
  test(`long selection interleaves detail work without concurrency; auth pause=${pauseOnDetail}`, async () => {
    const db = await openDatabase();
    const calls: string[] = [];
    let active = 0,
      peak = 0;
    async function track(kind: string) {
      calls.push(kind);
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
    }
    const service = createCoupons(db, {
      gate: new SerialGate(
        async () => {},
        () => Date.now(),
        () => 0,
      ),
      fetchPage: async (name) => {
        await track("selection");
        return {
          status_code: 0,
          cursor: 1,
          has_more: false,
          product_list: [
            {
              product_id: String(100 + Number(name.slice(-2))),
              product_info: {
                product_name: "测试券",
                price_range: { min: 100, max: 100 },
              },
              nearest_poi_info: {
                brand_data: { brand_name: name, brand_id: "456" },
              },
            },
          ],
        };
      },
      fetchRules: async () => {
        await track("rules");
        if (pauseOnDetail) throw new Error("AUTH_EXPIRED");
        return fixture;
      },
    });
    try {
      for (let i = 0; i < 11; i++)
        await db.query(
          "INSERT INTO brands(id,name,name_key,category,shanghai_evidence_url) VALUES($1,$2,$2,'火锅','https://example.com')",
          [randomUUID(), `公平调度${String(i).padStart(2, "0")}`],
        );
      await service.start();
      await service.drain();
      assert.deepEqual(calls.slice(0, 6), [
        "selection",
        "selection",
        "selection",
        "selection",
        "selection",
        "rules",
      ]);
      assert.equal(peak, 1);
      if (pauseOnDetail) {
        assert.equal(calls.length, 6);
        assert.equal(
          (await db.query("SELECT pause_reason FROM coupon_settings")).rows[0]
            .pause_reason,
          "AUTH_EXPIRED",
        );
      } else {
        assert.equal(calls[11], "rules");
        assert.equal(calls.filter((x) => x === "selection").length, 11);
        assert.equal(calls.filter((x) => x === "rules").length, 11);
        assert.equal(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM coupon_tasks WHERE state='complete'",
            )
          ).rows[0].n,
          11,
        );
      }
    } finally {
      await service.stop();
      await db.close();
    }
  });
}
