import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";

const filename = process.argv[2];
if (!filename)
  throw new Error("Usage: node scripts/verify-backup.mjs <backup.tar.gz>");
// Restore a trusted application backup into a separate temporary directory.
// Never load the complete archive/database into RAM or open the live database.
const temp = await mkdtemp(join(tmpdir(), "radar-restore-check-"));
let db;
try {
  await promisify(execFile)("tar", ["-xzf", resolve(filename), "-C", temp]);
  const dirs = (await readdir(temp, { withFileTypes: true })).filter((d) =>
    d.isDirectory(),
  );
  let directory;
  for (const d of dirs) {
    const path = join(temp, d.name);
    if (
      await access(join(path, "PG_VERSION"))
        .then(() => true)
        .catch(() => false)
    ) {
      directory = path;
      break;
    }
  }
  if (!directory) throw new Error("BACKUP_DATABASE_DIRECTORY_MISSING");
  db = new PGlite(directory);
  await db.waitReady;
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
  await db?.close();
  await rm(temp, { recursive: true, force: true });
}
