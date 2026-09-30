import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db.js";
import { createOperations } from "../src/operations.js";
import { readModel } from "../src/read-model-cache.js";

test("结果缓存持久化、并发合并、源数据变更失效、时钟过期和失败重试", async () => {
  const dir = await mkdtemp(join(tmpdir(), "radar-cache-"));
  const db = await openDatabase();
  const ops = await createOperations(db, join(dir, "backups"));
  try {
    let calls = 0;
    let fail = false;
    const read = readModel(
      db,
      "test",
      async () => {
        calls++;
        if (fail) throw new Error("failed");
        return { calls };
      },
      100,
    );
    assert.deepEqual(await Promise.all([read(), read()]), [
      { calls: 1 },
      { calls: 1 },
    ]);
    assert.deepEqual(await read(), { calls: 1 });
    assert.equal(
      (await db.query("SELECT name FROM radar_read_models WHERE name='test'"))
        .rows.length,
      1,
    );
    await db.exec("UPDATE brands SET active=false");
    assert.deepEqual(await read(), { calls: 2 });
    await db.exec("UPDATE brands SET active=true");
    fail = true;
    await assert.rejects(read(), /failed/);
    fail = false;
    assert.deepEqual(await read(), { calls: 4 });
    await new Promise((resolve) => setTimeout(resolve, 110));
    assert.deepEqual(await read(), { calls: 5 });
  } finally {
    await ops.drain();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("数据库重开后复用有效持久结果，修改任务会使结果失效", async () => {
  const dir = await mkdtemp(join(tmpdir(), "radar-persist-"));
  let db = await openDatabase(join(dir, "db"));
  let ops = await createOperations(db, join(dir, "backups"));
  try {
    const first = readModel(db, "persist", async () => ({ value: 42 }));
    await first();
    await ops.drain();
    await db.close();
    db = await openDatabase(join(dir, "db"));
    ops = await createOperations(db, join(dir, "backups"));
    let built = 0;
    const restored = readModel(db, "persist", async () => {
      built++;
      return { value: 43 };
    });
    assert.deepEqual(await restored(), { value: 42 });
    assert.equal(built, 0);
    await db.exec("UPDATE coupon_tasks SET state='complete'");
    assert.deepEqual(await restored(), { value: 43 });
    assert.equal(built, 1);
  } finally {
    await ops.drain();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
