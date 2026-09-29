import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireDatabaseLease } from "../src/database-lease.js";

test("database lease rejects duplicate and symlink paths, releases for restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "radar-lease-"));
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireDatabaseLease(join(root, "db"));
    await symlink(join(root, "db"), join(root, "alias"));
    await assert.rejects(acquireDatabaseLease(join(root, "db")), /其他进程/);
    await assert.rejects(acquireDatabaseLease(join(root, "alias")), /其他进程/);
    await release();
    release = await acquireDatabaseLease(join(root, "db"));
  } finally {
    await release?.();
    await rm(root, { recursive: true, force: true });
  }
});
