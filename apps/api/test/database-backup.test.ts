import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { writeDatabaseBackup } from "../dist/database-backup.js";
import { openWorkerDatabase } from "../dist/worker-database.js";

const exec = promisify(execFile);
test("磁盘流式备份可恢复事务数据，压缩后原库继续写入，临时快照已清除", async () => {
  const root = await mkdtemp(join(tmpdir(), "radar-backup-test-"));
  const db = await openWorkerDatabase(join(root, "postgres"));
  let restored: Awaited<ReturnType<typeof openWorkerDatabase>> | undefined;
  try {
    await db.exec(
      "CREATE TABLE restore_probe(id int PRIMARY KEY,body text); INSERT INTO restore_probe VALUES(1,'上海备份验证')",
    );
    const target = join(root, "backup.tar.gz");
    await writeDatabaseBackup(db, target);
    assert.ok((await stat(target)).size > 0);
    await assert.rejects(stat(target + ".snapshot"), { code: "ENOENT" });
    await db.exec("INSERT INTO restore_probe VALUES(2,'备份后新增')");
    const restore = join(root, "restore");
    await mkdir(restore);
    await exec("tar", ["-xzf", target, "-C", restore]);
    restored = await openWorkerDatabase(join(restore, "postgres"));
    assert.deepEqual(
      (await restored.query("SELECT * FROM restore_probe ORDER BY id")).rows,
      [{ id: 1, body: "上海备份验证" }],
    );
    assert.equal(
      (await db.query("SELECT * FROM restore_probe")).rows.length,
      2,
    );
    await assert.rejects(db.dumpDataDir("gzip"), /MEMORY_BACKUP_DISABLED/);
  } finally {
    await restored?.close();
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
