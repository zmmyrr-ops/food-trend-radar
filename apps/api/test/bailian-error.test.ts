import assert from "node:assert/strict";
import { test } from "node:test";
import { bailianError } from "../src/bailian-error.js";

test("Bailian HTTP 400 Arrearage is an account rejection, not invalid media", () => {
  const result = bailianError(400, {
    error: { code: "Arrearage", message: "Access denied" },
    request_id: "req-123",
  });
  assert.equal(result.accountRejected, true);
  assert.match(result.message, /欠费/);
  assert.match(result.message, /req-123/);
});
test("provider responses do not leak echoed credentials, prompts or URLs", () => {
  const result = bailianError(400, {
    error: { code: "InvalidParameter", message: "secret-key https://private" },
  });
  assert.equal(result.accountRejected, false);
  assert.match(result.message, /InvalidParameter/);
  assert.doesNotMatch(result.message, /secret-key|https:/);
  assert.doesNotThrow(() => bailianError(502, null));
  assert.match(bailianError(429, {}).message, /限流/);
});
