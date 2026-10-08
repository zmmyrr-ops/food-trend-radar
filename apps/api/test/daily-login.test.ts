import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { grantDailyLoginPoints, setupPoints } from "../src/points.js";

test("daily login rewards are atomic, isolated and reset at Shanghai midnight", async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE TABLE accounts(id uuid PRIMARY KEY)");
    await setupPoints(db);
    const a = randomUUID(),
      b = randomUUID();
    await db.query("INSERT INTO accounts(id) VALUES($1),($2)", [a, b]);
    const before = new Date("2026-10-08T15:59:59Z");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => grantDailyLoginPoints(db, a, before)),
    );
    assert.equal(results.filter((r) => r.awarded).length, 1);
    assert.equal(results[0].day, "2026-10-08");
    assert.equal((await grantDailyLoginPoints(db, a, before)).balance, 20);
    assert.equal((await grantDailyLoginPoints(db, b, before)).balance, 20);
    const next = await grantDailyLoginPoints(
      db,
      a,
      new Date("2026-10-08T16:00:00Z"),
    );
    assert.equal(next.awarded, true);
    assert.equal(next.day, "2026-10-09");
    assert.equal(next.balance, 40);
    const entries = await db.query<{ amount: number; hidden: boolean }>(
      "SELECT amount,hidden FROM point_entries WHERE owner_id=$1",
      [a],
    );
    assert.equal(entries.rows.length, 2);
    assert.ok(entries.rows.every((r) => r.amount === 20 && !r.hidden));
  } finally {
    await db.close();
  }
});
