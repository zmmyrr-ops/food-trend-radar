import assert from "node:assert/strict";
import test from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { createSalesHeat } from "../src/sales-heat.js";

test("销量查询合并并发请求，完成后重新读取，失败后可重试", async () => {
  let calls = 0;
  let release!: () => void;
  let failure = false;
  const db = {
    query: async () => {
      calls++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (failure) throw new Error("temporary query failure");
      return { rows: [] };
    },
  } as unknown as PGlite;
  const heat = createSalesHeat(db);
  const first = heat.read();
  const second = heat.read();
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  failure = true;
  const failed = heat.read();
  assert.equal(calls, 2);
  release();
  await assert.rejects(failed, /temporary/);
  failure = false;
  const retried = heat.read();
  assert.equal(calls, 3);
  release();
  assert.deepEqual(await retried, []);
});
