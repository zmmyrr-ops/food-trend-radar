import assert from "node:assert/strict";
import test from "node:test";
import {
  affordability,
  compareTerms,
  usability,
  type VerifiedTerms,
} from "../src/coupon-comparison.js";

const base: VerifiedTerms = {
  brandId: "b1",
  type: "套餐",
  quality: "同产品",
  unit: "份",
  quantity: 2,
  priceFen: 10000,
  storeIds: ["s1"],
  qualification: "所有用户",
  feesFen: 0,
  usableWindows: "每日",
  validFrom: "2026-09-21",
  validTo: "2026-10-01",
  evidenceComplete: true,
};
test("confirmed price and quantity improvements require identical eligibility and scope", () => {
  assert.equal(
    compareTerms(base, { ...base, priceFen: 7000 }).improvement.low,
    100,
  );
  assert.equal(
    compareTerms(base, { ...base, quantity: 3 }).kind,
    "quantity_increase",
  );
  for (const change of [
    { qualification: "仅新客" },
    { feesFen: 200 },
    { storeIds: ["s2"] },
    { quality: "低档套餐" },
    { validTo: "2026-09-22" },
  ])
    assert.equal(
      compareTerms(base, { ...base, priceFen: 5000, ...change }).kind,
      "not_comparable",
    );
  assert.equal(
    compareTerms(base, { ...base, evidenceComplete: false }).kind,
    "unverified",
  );
  assert.equal(compareTerms(base, { ...base, priceFen: 0 }).kind, "unverified");
});
test("affordability requires five distinct items; unknown availability preserves interval", () => {
  assert.deepEqual(
    affordability(10, Array(10).fill({ id: "same", unitFen: 20 })),
    { low: 0, high: 100 },
  );
  assert.equal(
    affordability(
      10,
      [10, 20, 30, 40, 50].map((unitFen, i) => ({ id: String(i), unitFen })),
    ).low,
    90,
  );
  assert.deepEqual(usability([true, false, null, null]), { low: 25, high: 75 });
});
