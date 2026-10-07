import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAccounts,
  hashAccountPassword,
  verifyPassword,
} from "../src/accounts.js";
import { openDatabase } from "../src/db.js";

test("admin bootstrap never overwrites a changed password; only first boot seeds credentials", async () => {
  const db = await openDatabase();
  for (const table of ["coupon_media_jobs", "video_projects", "video_uploads"])
    await db.exec(`CREATE TABLE ${table}(owner_id uuid)`);
  const bootstrap = await hashAccountPassword("Bootstrap123");
  const first = await createAccounts(db, {
    adminPhone: "13800009999",
    adminPasswordHash: bootstrap,
  });
  const changed = await hashAccountPassword("Changed456");
  await db.query(
    "UPDATE accounts SET password_hash=$1 WHERE phone='13800009999'",
    [changed],
  );
  const second = await createAccounts(db, {
    adminPhone: "13800009999",
    adminPasswordHash: bootstrap,
  });
  try {
    const row = (
      await db.query<{ id: string; password_hash: string }>(
        "SELECT id,password_hash FROM accounts WHERE phone='13800009999'",
      )
    ).rows[0];
    assert.ok(await verifyPassword("Changed456", row.password_hash));
    assert.equal(
      await verifyPassword("Bootstrap123", row.password_hash),
      false,
    );
    assert.equal(
      (
        await db.query<{ balance: number }>(
          "SELECT balance FROM point_wallets WHERE owner_id=$1",
          [row.id],
        )
      ).rows[0].balance,
      500,
    );
  } finally {
    await first.drain();
    await second.drain();
    await db.close();
  }
});
