import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createDatabaseMaintenance } from "../src/database-maintenance.js";

test("manual vacuum preserves current data, is throttled, and serializes overlapping runs", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "CREATE TABLE coupon_pool_candidates(id int primary key,payload text); CREATE TABLE history(id int); INSERT INTO coupon_pool_candidates VALUES(1,'current'); INSERT INTO history VALUES(1)",
    );
    let clock = 0;
    const statements: string[] = [];
    const exec = db.exec.bind(db);
    db.exec = (async (sql: string, ...args: any[]) => {
      statements.push(sql);
      return exec(sql, ...args);
    }) as typeof db.exec;
    const maintain = createDatabaseMaintenance(db, () => clock);
    const one = maintain();
    assert.equal(maintain(), one);
    await one;
    assert.equal(
      statements.filter((s) => s.startsWith("CHECKPOINT")).length,
      1,
    );
    assert.equal(
      (
        await db.query<{ payload: string }>(
          "SELECT payload FROM coupon_pool_candidates",
        )
      ).rows[0].payload,
      "current",
    );
    const calls = statements.length;
    await maintain();
    assert.equal(statements.length, calls);
    clock += 5 * 60_000;
    await maintain();
    assert.equal(
      statements.filter((s) => s.includes("VACUUM") && s.includes("history"))
        .length,
      1,
    );
    clock += 60 * 60_000;
    await maintain();
    assert.equal(
      statements.filter((s) => s.includes("VACUUM") && s.includes("history"))
        .length,
      2,
    );
  } finally {
    await db.close();
  }
});
