import type { PGlite } from "@electric-sql/pglite";

/** Call once at process startup, after the exclusive database lease and before workers. */
export async function recoverInterruptedRequests(db: PGlite) {
  // A crash does not tell us when the transport ended. Keep finished_at unknown;
  // callers must not infer a request gap from the later recovery timestamp.
  return (
    await db.query(`UPDATE coupon_requests
    SET outcome='INTERRUPTED',recovered_at=now()
    WHERE outcome='in_flight' AND finished_at IS NULL
    RETURNING id`)
  ).rows.length;
}
