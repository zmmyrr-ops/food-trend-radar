import assert from "node:assert/strict";
import test from "node:test";
import { openWorkerDatabase } from "../dist/worker-database.js";

test("数据库工作线程保持事务隔离、回滚、JSON及备份兼容，慢 SQL 不阻塞主线程", async () => {
  const db = await openWorkerDatabase();
  try {
    await db.exec("CREATE TABLE worker_test(id int PRIMARY KEY,payload jsonb)");
    await db.transaction(async (tx) => {
      await tx.query("INSERT INTO worker_test VALUES(1,$1)", [
        JSON.stringify({ unicode: "上海", values: [1, 2] }),
      ]);
    });
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.exec("INSERT INTO worker_test VALUES(2,'{}')");
        throw new Error("expected rollback");
      }),
      /expected rollback/,
    );
    assert.deepEqual((await db.query("SELECT * FROM worker_test")).rows, [
      { id: 1, payload: { unicode: "上海", values: [1, 2] } },
    ]);
    let timerFired = false;
    const start = Date.now();
    const timer = setTimeout(() => {
      timerFired = true;
    }, 50);
    await db.query("SELECT pg_sleep(0.3)");
    clearTimeout(timer);
    assert.equal(timerFired, true);
    assert.ok(Date.now() - start >= 250);
    const t = db.transaction(async (tx) => {
      await tx.exec("INSERT INTO worker_test VALUES(3,'{}')");
      await new Promise((resolve) => setTimeout(resolve, 30));
      throw new Error("rollback third");
    });
    const rejected = assert.rejects(t, /rollback third/);
    const read = db.query("SELECT id FROM worker_test ORDER BY id");
    await rejected;
    assert.deepEqual((await read).rows, [{ id: 1 }]);
    const archive = await db.dumpDataDir("gzip");
    assert.ok(archive.size > 0);
  } finally {
    await db.close();
  }
});
