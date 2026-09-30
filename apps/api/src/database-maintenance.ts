import type { PGlite } from "@electric-sql/pglite";

// PGlite does not run PostgreSQL's normal autovacuum background workers.
// Reclaim dead rows explicitly so repeated cache updates reuse disk space.
export function createDatabaseMaintenance(db: PGlite, now = Date.now) {
  let completedAt = -Infinity;
  let fullAt = -Infinity;
  let active: Promise<void> | undefined;
  return () => {
    if (active) return active;
    if (now() - completedAt < 5 * 60_000) return Promise.resolve();
    active = (async () => {
      const tables = await db.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY CASE WHEN tablename IN ('coupon_pool_candidates','radar_read_models') THEN 0 ELSE 1 END,tablename",
      );
      const full = now() - fullAt >= 60 * 60_000;
      for (const { tablename } of tables.rows.filter(
        (t) =>
          full ||
          ["coupon_pool_candidates", "radar_read_models"].includes(t.tablename),
      ))
        await db.exec(
          `VACUUM (ANALYZE) public."${tablename.replace(/"/g, '""')}"`,
        );
      await db.exec("CHECKPOINT");
      completedAt = now();
      if (full) fullAt = completedAt;
    })().finally(() => {
      active = undefined;
    });
    return active;
  };
}
