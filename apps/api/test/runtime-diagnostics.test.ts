import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import {
  RuntimeDiagnostics,
  startRuntimeReporting,
} from "../src/runtime-diagnostics.js";

test("在途工作可读取，结束/失败清理；仅保留有界慢调用而不记录错误正文", async () => {
  let now = 0;
  const monitor = new RuntimeDiagnostics(() => now);
  let release!: () => void;
  const pending = monitor.track(
    "test",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  now = 500;
  assert.equal(monitor.snapshot().pending, 1);
  assert.equal(monitor.snapshot().active[0].elapsed_ms, 500);
  release();
  await pending;
  assert.equal(monitor.snapshot().pending, 0);
  assert.equal(monitor.snapshot().slow[0].duration_ms, 500);
  for (let i = 0; i < 105; i++)
    await monitor
      .track("failed", async () => {
        now += 300;
        throw Error("secret-payload");
      })
      .catch(() => {});
  assert.equal(monitor.snapshot().slow.length, 100);
  assert.equal(monitor.snapshot().slow[0].failed, true);
  assert.ok(!JSON.stringify(monitor.snapshot()).includes("secret-payload"));
});

test("诊断保留查询返回值和事务回滚语义，不暴露 SQL 或参数", async () => {
  const db = await openDatabase();
  let now = 0;
  const monitor = new RuntimeDiagnostics(() => (now += 300));
  monitor.attach(db);
  try {
    const result = await db.query<{ value: string }>(
      "SELECT $1::text AS value",
      ["private-value"],
    );
    assert.equal(result.rows[0].value, "private-value");
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query("UPDATE coupon_settings SET enabled=true");
        throw Error("rollback");
      }),
      /rollback/,
    );
    assert.equal(
      (
        await db.query<{ enabled: boolean }>(
          "SELECT enabled FROM coupon_settings",
        )
      ).rows[0].enabled,
      false,
    );
    const snapshot = JSON.stringify(monitor.snapshot());
    assert.ok(!snapshot.includes("private-value"));
    assert.ok(!snapshot.includes("SELECT"));
    assert.equal(monitor.snapshot().pending, 0);
  } finally {
    await db.close();
  }
});

test("运行诊断端点在工作未完成时仍可返回，无数据库读取", async () => {
  const db = await openDatabase();
  const monitor = new RuntimeDiagnostics();
  let release!: () => void;
  const pending = monitor.track(
    "held",
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  const app = createApp(db, undefined, undefined, undefined, undefined, () =>
    monitor.snapshot(),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    db.query = (() => {
      throw Error("must not query");
    }) as typeof db.query;
    const r = await fetch(
      `http://127.0.0.1:${address.port}/api/v3/runtime-diagnostics`,
      { signal: AbortSignal.timeout(2000) },
    );
    assert.equal(r.status, 200);
    assert.equal((await r.json()).pending, 1);
  } finally {
    release();
    await pending;
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
  }
});

test("诊断报告原子保存并保留前一进程记录，停服写出最终状态", async () => {
  const dir = await mkdtemp(join(tmpdir(), "radar-runtime-test-"));
  const file = join(dir, "current.json");
  await writeFile(file, "previous-process");
  try {
    const monitor = new RuntimeDiagnostics();
    const stop = await startRuntimeReporting(monitor, file);
    assert.equal(
      await readFile(`${file}.previous`, "utf8"),
      "previous-process",
    );
    assert.equal(JSON.parse(await readFile(file, "utf8")).pending, 0);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await monitor.track("done", async () => 1);
    await stop();
    assert.equal(JSON.parse(await readFile(file, "utf8")).pending, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
