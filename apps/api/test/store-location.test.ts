import assert from "node:assert/strict";
import test from "node:test";
import {
  matchesStreet,
  storeLocationQueries,
  streetAddress,
} from "../../web/src/store-location.js";

test("store location uses address without dropping saved floor information", () => {
  const address = "新虹街道申长路688号6F";
  assert.equal(streetAddress(address), "新虹街道申长路688号");
  assert.deepEqual(storeLocationQueries("湘辣辣", address), [
    "湘辣辣 新虹街道申长路688号",
    "湘辣辣",
    "新虹街道申长路688号",
  ]);
  assert.equal(matchesStreet("上海市闵行区申长路688号6楼", address), true);
  assert.equal(matchesStreet("上海市闵行区申长路1688号", address), false);
  assert.equal(matchesStreet("上海市其他路688号", address), false);
  assert.deepEqual(storeLocationQueries("", address), ["新虹街道申长路688号"]);
});
