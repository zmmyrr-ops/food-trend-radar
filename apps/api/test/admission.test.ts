import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditInput,
  eventAdmissionInput,
  policy,
  type SourceInput,
  type TrialInput,
} from "@radar/contracts";
import { evaluateSource, fingerprint } from "../src/admission.js";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";

const source: SourceInput = {
  name: "隔离测试来源",
  url: "https://example.com",
  owner: "测试主体",
  purpose: "隔离测试",
  coverage: "full",
  geography: "shanghai",
  granularity: "hour",
  delay_minutes: 60,
  daily_quota: 50000,
  monthly_cost: 100,
  retention_days: 90,
  display_allowed: true,
  training_allowed: true,
  authorization: "approved",
  authorization_url: "https://example.com/license",
  expires_at: "2099-01-01T00:00:00Z",
  verification_note: "测试",
  enabled: true,
};
const config = auditInput.parse({
  source_id: "00000000-0000-4000-8000-000000000001",
  reviewer: "测试人",
  account_reference: "masked-test",
  endpoint: "https://example.com/api",
  evidence_url: "https://example.com/proof",
  evidence_sha256: "a".repeat(64),
  observed_at: "2026-09-10T00:00:00Z",
  storage_allowed: true,
  automated_access_allowed: true,
  metrics: ["demand", "contents", "authors"],
  field_mapping: "D指数,V条,U人",
  coverage_definition: "同平台上海全量",
  platform: "测试平台",
  keywords_per_brand: 3,
  pages_per_keyword: 3,
  runs_per_day: 24,
  monthly_budget: 10000,
  note: "全部为测试夹具，非实测",
});
const now = Date.parse("2026-09-20T06:00:00Z");
const audit = {
  id: config.source_id,
  source_id: config.source_id,
  source_hash: fingerprint(source),
  config,
  created_at: new Date("2026-09-10T00:00:00Z"),
};
const trials = Array.from({ length: 7 }, (_, i) => ({
  config: {
    audit_id: audit.id,
    day: `2026-09-${19 - i}`,
    brand_ids: Array.from(
      { length: 10 },
      (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    ),
    requests: 3000,
    successes: 2970,
    completeness: 0.99,
    duplicate_rate: 0.01,
    max_delay_minutes: 30,
    cost_yuan: 1,
    evidence_url: "https://example.com/proof",
    evidence_sha256: "a".repeat(64),
    reviewer: "测试",
    note: "测试日报",
  } satisfies TrialInput,
}));
test("source gates require seven consistent complete days, current authorization, compatible scope and budget", () => {
  const passed = evaluateSource(source, audit, trials, now);
  assert.equal(passed.passed, false);
  assert.equal(passed.projected_daily_calls, 51840); // 200品牌小时负载超出现有配额
});
test("admission boundary conditions fail closed", () => {
  const eligible = { ...source, daily_quota: 60000 };
  const validAudit = { ...audit, source_hash: fingerprint(eligible) };
  assert.equal(evaluateSource(eligible, validAudit, trials, now).passed, true);
  for (const records of [
    trials.slice(1),
    trials.map((t, i) => (i ? t : { config: { ...t.config, successes: 1 } })),
    trials.map((t, i) =>
      i ? t : { config: { ...t.config, day: "2026-09-20" } },
    ),
    trials.map((t, i) =>
      i
        ? t
        : {
            config: {
              ...t.config,
              brand_ids: [...t.config.brand_ids.slice(1), "changed"],
            },
          },
    ),
  ])
    assert.equal(
      evaluateSource(eligible, validAudit, records, now).passed,
      false,
    );
  for (const change of [
    { authorization: "revoked" },
    { geography: "national" },
    { coverage: "manual_sample" },
    { granularity: "day" },
    { daily_quota: 100 },
    { training_allowed: false },
    { monthly_cost: null },
    { delay_minutes: null },
  ] as Partial<SourceInput>[])
    assert.equal(
      evaluateSource({ ...eligible, ...change }, validAudit, trials, now)
        .passed,
      false,
    );
  assert.equal(
    evaluateSource(
      eligible,
      { ...validAudit, config: { ...config, monthly_budget: 1 } },
      trials,
      now,
    ).passed,
    false,
  );
  assert.equal(evaluateSource(eligible, undefined, [], now).passed, false);
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
});
test("admission API never publishes probabilities, records reviews and invalidates corrected event evidence", async () => {
  const db = await openDatabase();
  const server = createApp(db).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const addr = server.address();
  assert(addr && typeof addr === "object");
  async function call(path: string, body?: unknown, method = "POST") {
    const r = await fetch(
      `http://127.0.0.1:${addr.port}/v1${path}`,
      body
        ? {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : undefined,
    );
    return { status: r.status, data: await r.json() };
  }
  try {
    const initial = (await call("/admission")).data;
    assert.equal(initial.publication.allowed, false);
    assert.equal(initial.data_gate_passed, false);
    assert.equal(initial.brands.verified, 0);
    assert.equal(
      (
        await call("/admission/review", {
          policy_hash: "0".repeat(64),
          reviewer: "测试",
          note: "过期配置",
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await call("/admission/review", {
          policy_hash: initial.policy_hash,
          reviewer: "测试",
          note: "本地测试评审",
        })
      ).status,
      201,
    );
    assert.equal((await call("/admission")).data.policy_reviewed, true);
    const src = await call("/sources", source);
    const a = await call("/admission/audits", {
      ...config,
      source_id: src.data.id,
    });
    assert.equal(a.status, 201);
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    assert.equal(
      (
        await call("/admission/trials", {
          ...trials[0].config,
          audit_id: a.data.id,
          day: today,
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await call("/admission/trials", {
          ...trials[0].config,
          audit_id: a.data.id,
        })
      ).status,
      422,
    );
    const b = await call("/brands", {
      name: "测试品牌",
      category: "咖啡",
      shanghai_evidence_url: "https://example.com/sh",
      keywords: ["测试"],
    });
    const e = {
      brand_id: b.data.id,
      title: "测试全国新品",
      type: "新品",
      starts_at: "2026-01-01T00:00:00Z",
      ends_at: "2099-01-01T00:00:00Z",
      source_url: "https://example.com/event",
      evidence_note: "测试",
      eligibility: "available",
      status: "verified",
    };
    const created = await call("/events", e);
    const id = created.data.id;
    const state = (await call(`/events/${id}/admission`)).data;
    assert.equal(state.local_candidate, false);
    const local = {
      event_fingerprint: state.event_fingerprint,
      reviewer: "测试",
      note: "测试记录",
      risk: "none",
      participation: "available",
      stores: [
        {
          name: "测试上海店",
          address: "上海测试地址",
          region_code: "310000",
          evidence_url: "https://example.com/sh",
        },
      ],
      price_yuan: null,
      conditions: "条件待核实价格未知",
      evidence_url: "https://example.com/sh",
      valid_until: "2098-01-01T00:00:00Z",
    };
    assert.equal(
      eventAdmissionInput.safeParse({ ...local, stores: [] }).success,
      false,
    );
    assert.equal((await call(`/events/${id}/admission`, local)).status, 201);
    assert.equal(
      (await call(`/events/${id}/admission`)).data.local_candidate,
      true,
    );
    for (const risk of [
      "food_safety",
      "negative_sentiment",
      "false_discount",
      "out_of_stock",
      "unknown",
    ]) {
      await call(`/events/${id}/admission`, { ...local, risk });
      assert.equal(
        (await call(`/events/${id}/admission`)).data.local_candidate,
        false,
      );
    }
    await call(`/events/${id}`, { ...e, evidence_note: "更正" }, "PUT");
    assert.equal(
      (await call(`/events/${id}/admission`)).data.local_review_valid,
      false,
    );
    assert.equal((await call(`/events/${id}/admission`, local)).status, 422);
    const final = (await call("/admission")).data;
    assert.equal(final.publication.p72, null);
    assert.equal(final.publication.headstart_index, null);
    assert.equal(final.publication.allowed, false);
    assert.equal(
      Object.values(policy.features.weights).reduce((s, v) => s + v, 0),
      100,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
  }
});
