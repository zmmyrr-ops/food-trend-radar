import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { assessCoupon } from "../src/coupon-evidence.js";
import {
  createCoupons,
  diffCoupon,
  normalizeCoupon,
  SerialGate,
} from "../src/coupons.js";
import { openDatabase } from "../src/db.js";

async function fixture() {
  return JSON.parse(
    await readFile(
      new URL("fixtures/douyin-selection-sanitized.json", import.meta.url),
      "utf8",
    ),
  );
}
test("真实脱敏样本保留上海门店证据，不把寿喜烧商家归到牛New", async () => {
  const raw = await fixture();
  const coupon = normalizeCoupon(raw, ["牛New"]);
  assert.equal(coupon.identity, "unresolved");
  assert.equal(coupon.city_evidence, "上海市");
  assert.equal(
    assessCoupon(coupon, null).city_status,
    "associated_poi_shanghai",
  );
  assert.equal(assessCoupon(coupon, null).value_verdict, "unverified");
  assert.ok(!JSON.stringify(coupon.source_evidence).includes("x-signature"));
  delete raw.nearest_poi_info.poi_display_info;
  assert.equal(
    assessCoupon(normalizeCoupon(raw, ["牛New"]), null).city_status,
    "unknown",
  );
});
test("未知金额、区间价、新客换档、同价增量不误报确定优惠", async () => {
  const original = normalizeCoupon(await fixture(), ["牛New"]);
  const current = { ...original, price_min_fen: 29900, price_max_fen: 29900 };
  assert.equal(assessCoupon(current, original).delta_fen, -3000);
  assert.equal(assessCoupon(current, original).value_verdict, "unverified");
  const unknown = { ...original, price_min_fen: null };
  assert.equal(diffCoupon(unknown, current, true), "PRICE_DATA_CHANGED");
  assert.equal(assessCoupon(current, unknown).delta_fen, null);
  assert.equal(
    assessCoupon({ ...current, price_max_fen: 39900 }, original)
      .price_direction,
    "range_not_comparable",
  );
  const restricted = {
    ...current,
    name: "新客会员双人套餐，工作日预约，另付服务费",
    poi_id: "another",
  };
  const assessment = assessCoupon(restricted, original, true);
  assert.equal(assessment.identity_conflict, true);
  assert.ok(assessment.changed_fields.includes("关联门店"));
  assert.ok(assessment.title_clues.includes("新客"));
  assert.ok(assessment.title_clues.includes("附加费用"));
  assert.equal(
    assessCoupon({ ...original, name: "同价升级三人餐" }, original)
      .same_price_better,
    null,
  );
  assert.equal(
    diffCoupon(original, { ...original, platform_brand_id: "different" }, true),
    "TERMS_CHANGED_UNVERIFIED",
  );
  assert.equal(
    assessCoupon(current, { ...original, price_min_fen: 0, price_max_fen: 0 })
      .reduction_rate,
    null,
  );
});
test("自动映射候选仅来自完整基线，跨品牌 ID 冲突可识别", async () => {
  const db = await openDatabase();
  const ids = [randomUUID(), randomUUID()];
  let time = 0;
  const gate = new SerialGate(
    async (ms) => {
      time += ms;
    },
    () => time,
    () => 0,
  );
  const raw = await fixture();
  raw.nearest_poi_info.brand_data = {
    brand_id: "9007199254740993",
    brand_name: "品牌甲",
  };
  const service = createCoupons(db, {
    gate,
    fetchPage: async () => ({
      status_code: 0,
      cursor: 12,
      has_more: false,
      product_list: [raw],
    }),
  });
  try {
    for (const [i, id] of ids.entries())
      await db.query(
        "INSERT INTO brands(id,name,name_key,category,aliases,shanghai_evidence_url) VALUES($1,$2,$3,'火锅',$4,'https://example.com')",
        [id, `候选${i}`, `candidate${i}`, JSON.stringify(["品牌甲"])],
      );
    assert.equal(
      (await db.query("SELECT * FROM coupon_brand_candidates")).rows.length,
      0,
    );
    await service.start(ids);
    await service.drain();
    const candidates = (
      await db.query<{ platform_brand_id: string }>(
        "SELECT * FROM coupon_brand_candidates",
      )
    ).rows;
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].platform_brand_id, "9007199254740993");
    assert.equal(
      (
        await db.query(
          "SELECT platform_brand_id FROM coupon_brand_candidates GROUP BY platform_brand_id HAVING count(DISTINCT brand_id)>1",
        )
      ).rows.length,
      1,
    );
  } finally {
    await service.stop();
    await db.close();
  }
});
