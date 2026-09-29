import assert from "node:assert/strict";
import test from "node:test";
import { increasedQuantities } from "../src/package-quantity.js";

const group = (a: number, b = 1) => [
  {
    group_name: "套餐",
    item_list: [
      { name: "牛肉", unit: "份", count: a },
      { name: "饮料", unit: "杯", count: b },
    ],
  },
];
test("same returned package with more quantities preserves exact item units", () => {
  assert.deepEqual(increasedQuantities(group(1), group(2)), [
    { name: "牛肉", unit: "份", before: 1, after: 2 },
  ]);
  assert.deepEqual(increasedQuantities(group(1, 2), group(2, 1)), []);
  assert.deepEqual(
    increasedQuantities(group(1), [
      { ...group(2)[0], option_count: 1, total_count: 2 },
    ]),
    [],
  );
  assert.deepEqual(
    increasedQuantities(group(1), [
      { item_list: [{ name: "牛肉", unit: "克", count: 200 }] },
    ]),
    [],
  );
  assert.deepEqual(
    increasedQuantities(group(1), [
      { item_list: [{ name: "牛肉", count: 2 }] },
    ]),
    [],
  );
});
