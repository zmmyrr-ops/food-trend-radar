import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const filename = process.argv[2];
if (!filename)
  throw new Error("Usage: node scripts/verify-backup.mjs <backup.tar.gz>");
// Restore only in memory. Never open or overwrite the running database.
const db = new PGlite({
  loadDataDir: new Blob([await readFile(resolve(filename))]),
});
await db.waitReady;
try {
  const brands = (await db.query("SELECT count(*)::int AS count FROM brands"))
    .rows[0];
  const coupons = (
    await db.query("SELECT count(*)::int AS count FROM coupon_items")
  ).rows[0];
  const invalid = (
    await db.query(
      "SELECT count(*)::int AS count FROM coupon_baselines b LEFT JOIN coupon_tasks t ON t.run_id=b.run_id AND t.brand_id=b.brand_id WHERE t.state IS DISTINCT FROM 'complete'",
    )
  ).rows[0];
  if (invalid.count !== 0) throw new Error("INVALID_BASELINE_POINTER");
  console.log(
    JSON.stringify({
      restored: true,
      brands: brands.count,
      coupons: coupons.count,
      invalid_baselines: invalid.count,
    }),
  );
} finally {
  await db.close();
}
