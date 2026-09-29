import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createAlerts } from "../src/alerts.js";
import {
  point,
  scoreOpportunity,
  unverifiedOpportunity,
} from "../src/opportunity-score.js";

test("site alerts reject incomplete evidence, deduplicate versions and allow material revision", async () => {
  const db = new PGlite();
  try {
    const alerts = await createAlerts(db);
    assert.equal(
      await alerts.opportunity(
        "brand",
        "coupon",
        "v1",
        unverifiedOpportunity(),
      ),
      null,
    );
    const score = scoreOpportunity({
      value: point(100),
      novelty: point(100),
      heat: point(100),
      environment: point(100),
      deduction: { low: 0, high: 0 },
      gates: {
        identity: true,
        shanghai: true,
        available: true,
        value: true,
        creatorCoverage: true,
      },
      confirmedChange: true,
    });
    await alerts.opportunity("brand", "coupon", "v1", score);
    await alerts.opportunity("brand", "coupon", "v1", score);
    assert.equal((await db.query("SELECT * FROM radar_alerts")).rows.length, 1);
    await alerts.opportunity("brand", "coupon", "v2", score);
    assert.equal((await db.query("SELECT * FROM radar_alerts")).rows.length, 2);
  } finally {
    await db.close();
  }
});
