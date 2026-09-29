import assert from "node:assert/strict";
import test from "node:test";
import { reviewState } from "../src/brand-coverage.js";

const now = Date.parse("2026-09-28T08:00:00Z");
const row = {
  name: "品牌",
  aliases: ["别名"],
  query_name: "品牌",
  query_aliases: ["别名"],
  completed_at: "2026-09-28T07:00:00Z",
  recalled: 3,
  matched: 2,
  named: 3,
};
test("review distinguishes pending config, expired snapshots, and actual fresh candidates", () => {
  assert.equal(reviewState(row, now).status, "name_candidates");
  assert.equal(
    reviewState({ ...row, query_aliases: [] }, now).status,
    "config_pending",
  );
  assert.equal(
    reviewState({ ...row, completed_at: "2026-09-21T07:00:00Z" }, now).status,
    "stale_baseline",
  );
  assert.equal(
    reviewState({ ...row, completed_at: null }, now).status,
    "no_baseline",
  );
  assert.equal(
    reviewState({ ...row, matched: 0 }, now).status,
    "different_platform_names",
  );
  assert.equal(
    reviewState({ ...row, matched: 0, named: 0 }, now).status,
    "missing_platform_identity",
  );
  assert.equal(
    reviewState({ ...row, recalled: 0, matched: 0, named: 0 }, now).status,
    "no_recall",
  );
  assert.equal(
    reviewState({ ...row, completed_at: "2026-09-29T07:00:00Z" }, now)
      .baseline_fresh,
    false,
  );
});
