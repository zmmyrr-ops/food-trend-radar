import assert from "node:assert/strict";
import test from "node:test";
import { classifyStoreCoverage } from "../src/store-coverage-audit.js";

const evidence = {
  brand_id: "brand",
  brand_name: "品牌",
  product_id: "1",
  run_id: "run",
  title: "券",
  state: "complete",
  error_code: null,
  reported_count: 10,
  returned_count: 10,
  queried_count: 10,
  received_count: 10,
  snapshot_complete: true,
  observed_at: "2026-09-29T00:00:00Z",
};
test("门店来源缺口和已查询缺口分别判定，等待不能冒充缺失", () => {
  assert.equal(classifyStoreCoverage(evidence), "complete");
  assert.equal(
    classifyStoreCoverage({
      ...evidence,
      state: "incomplete",
      reported_count: 100,
      snapshot_complete: false,
    }),
    "scope_truncated",
  );
  assert.equal(
    classifyStoreCoverage({
      ...evidence,
      state: "incomplete",
      received_count: 8,
      snapshot_complete: false,
    }),
    "lookup_missing",
  );
  assert.equal(
    classifyStoreCoverage({
      ...evidence,
      state: "queued",
      queried_count: 5,
      received_count: null,
      reported_count: 100,
    }),
    "lookup_pending",
  );
  assert.equal(
    classifyStoreCoverage({
      ...evidence,
      state: "queued",
      reported_count: null,
      returned_count: null,
      received_count: null,
    }),
    "scope_pending",
  );
  assert.equal(
    classifyStoreCoverage({
      ...evidence,
      state: "incomplete",
      queried_count: 5,
    }),
    "lookup_unfinished",
  );
});
test("空范围、超限、矛盾、终止及快照缺失不标完整", () => {
  assert.equal(
    classifyStoreCoverage({ ...evidence, received_count: 11 }),
    "scope_inconsistent",
  );
  assert.equal(
    classifyStoreCoverage({ ...evidence, queried_count: 11 }),
    "scope_inconsistent",
  );
  assert.equal(
    classifyStoreCoverage({ ...evidence, returned_count: 0 }),
    "empty_scope",
  );
  assert.equal(
    classifyStoreCoverage({ ...evidence, returned_count: 1001 }),
    "scope_limit",
  );
  assert.equal(
    classifyStoreCoverage({ ...evidence, reported_count: 5 }),
    "scope_inconsistent",
  );
  assert.equal(
    classifyStoreCoverage({ ...evidence, snapshot_complete: false }),
    "scope_inconsistent",
  );
  assert.equal(
    classifyStoreCoverage({ ...evidence, received_count: null }),
    "snapshot_missing",
  );
  assert.equal(
    classifyStoreCoverage({ ...evidence, state: "failed" }),
    "request_failed",
  );
});
