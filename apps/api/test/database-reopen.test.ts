import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db.js";

test("disk database retains committed data across WAL switches and repeated reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "radar-reopen-"));
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      const db = await openDatabase(join(root, "postgres"));
      try {
        assert.equal(
          (await db.query("SHOW wal_recycle")).rows[0]?.wal_recycle,
          "off",
        );
        await db.exec(
          "CREATE TABLE IF NOT EXISTS restart_evidence(id int PRIMARY KEY, payload text)",
        );
        assert.equal(
          (
            await db.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM restart_evidence",
            )
          ).rows[0]?.count,
          cycle * 2000,
        );
        await db.query(
          "INSERT INTO restart_evidence SELECT n, string_agg(md5((n::text || j::text)), '') FROM generate_series($1::int,$2::int) n CROSS JOIN generate_series(1,100) j GROUP BY n",
          [cycle * 2000, (cycle + 1) * 2000 - 1],
        );
        await db.exec(
          "SELECT pg_switch_wal(); CHECKPOINT; SELECT pg_switch_wal(); CHECKPOINT;",
        );
      } finally {
        await db.close();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
