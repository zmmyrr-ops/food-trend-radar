import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { openDatabase } from "../src/db.js";

test("configuration rejects invalid ports and public listening without authentication", () => {
  assert.throws(() => readConfig({ PORT: "abc" }));
  assert.throws(() => readConfig({ PORT: "70000" }));
  assert.throws(() => readConfig({ HOST: "0.0.0.0" }));
  assert.equal(readConfig({}).PORT, 3001);
});
test("persistent brand/event workflow, validation, history and idempotent imports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "radar-test-"));
  let db = await openDatabase(join(directory, "pg"));
  const server = createApp(db).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  async function request(
    path: string,
    body?: unknown,
    method = "POST",
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(
      base + path,
      body === undefined
        ? undefined
        : {
            method,
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify(body),
          },
    );
    return { status: response.status, data: await response.json() };
  }
  try {
    assert.equal((await request("/ready")).data.status, "ready");
    const source = {
      name: "测试人工来源",
      url: "https://example.com",
      owner: "测试主体",
      purpose: "活动信息核验",
      coverage: "manual_sample",
      geography: "national",
      granularity: "day",
      delay_minutes: null,
      daily_quota: null,
      monthly_cost: null,
      retention_days: 90,
      display_allowed: false,
      training_allowed: false,
      authorization: "pending",
      authorization_url: null,
      expires_at: null,
      verification_note: "",
      enabled: true,
    };
    const createdSource = await request("/v1/sources", source);
    assert.equal(createdSource.status, 201);
    assert.equal(createdSource.data.gate.eligible, false);
    const sourceId = createdSource.data.id;
    assert.equal((await request("/v1/sources", source)).status, 409);
    assert.equal(
      (
        await request("/v1/sources", {
          ...source,
          name: "missing proof",
          authorization: "approved",
        })
      ).status,
      422,
    );
    assert.equal(
      (await request("/v1/sources", { ...source, daily_quota: -1 })).status,
      422,
    );
    const approved = {
      ...source,
      display_allowed: true,
      authorization: "approved",
      authorization_url: "https://example.com/license",
      expires_at: "2099-01-01T00:00:00Z",
      verification_note: "测试凭证核验",
    };
    const changed = await request(`/v1/sources/${sourceId}`, approved, "PUT");
    assert.equal(changed.status, 200);
    assert.equal(changed.data.gate.eligible, true);
    assert.equal(changed.data.training_allowed, false);
    assert.equal(
      (await request(`/v1/sources/${sourceId}/history`)).data.items[0].snapshot
        .config.authorization,
      "pending",
    );
    const expired = await request(
      `/v1/sources/${sourceId}`,
      { ...approved, expires_at: "2020-01-01T00:00:00Z" },
      "PUT",
    );
    assert.equal(expired.data.gate.eligible, false);
    const revoked = await request(
      `/v1/sources/${sourceId}`,
      { ...approved, authorization: "revoked" },
      "PUT",
    );
    assert.equal(revoked.data.gate.eligible, false);
    const listing = (await request("/v1/sources")).data.items[0];
    assert.equal(listing.geography, "national");
    assert.equal(listing.daily_quota, null);
    assert.equal(listing.gate.eligible, false);
    const draft = {
      name: "测试咖啡",
      category: "咖啡",
      aliases: ["测试别名"],
      shanghai_evidence_url: "https://example.com/shanghai",
      active: true,
    };
    const brand = await request("/v1/brands", draft);
    assert.equal(brand.status, 201);
    assert.equal(brand.data.region_code, "310000");
    const evidence = {
      source_title: "测试目录",
      url: "https://example.com/shanghai",
      source_name: "测试咖啡",
      location: "上海测试地址",
      position: "1F",
      evidence_type: "current_directory",
      published_at: null,
      observed_at: "2020-01-01T00:00:00Z",
      research_status: "directory_checked",
      note: "测试，不是真实营业数据",
    };
    assert.equal(
      (await request(`/v1/brands/${brand.data.id}/evidence`, evidence)).status,
      201,
    );
    await request(`/v1/brands/${brand.data.id}/evidence`, evidence);
    assert.equal(
      (await request(`/v1/brands/${brand.data.id}/evidence`)).data.items.length,
      1,
    );
    assert.equal(
      (
        await request(`/v1/brands/${brand.data.id}/evidence`, {
          ...evidence,
          observed_at: "2099-01-01T00:00:00Z",
        })
      ).status,
      422,
    );

    assert.equal(
      (await request("/v1/brands", { ...draft, name: " 测试咖啡 " })).status,
      409,
    );
    assert.equal(
      (
        await request("/v1/brands", {
          ...draft,
          shanghai_evidence_url: "javascript:alert(1)",
        })
      ).status,
      422,
    );
    assert.equal(
      (await request("/v1/brands", { ...draft, region_code: "110000" })).status,
      422,
    );
    assert.equal((await request("/v1/brands?q=测试别名")).data.items.length, 1);
    const review = {
      revision: 1,
      decision: "verified",
      reviewer: "测试核验人",
      note: "测试上海经营证据",
    };
    assert.equal(
      (await request(`/v1/brands/${brand.data.id}/review`, review)).status,
      422,
    );
    const updatedBrand = await request(
      `/v1/brands/${brand.data.id}`,
      { ...draft, keywords: ["测试咖啡 上海"] },
      "PUT",
    );
    assert.equal(updatedBrand.data.revision, 2);
    assert.equal(
      (await request(`/v1/brands/${brand.data.id}/review`, review)).status,
      409,
    );
    const verified = await request(`/v1/brands/${brand.data.id}/review`, {
      ...review,
      revision: 2,
    });
    assert.equal(verified.data.review_status, "verified");
    assert.equal(verified.data.reviewed_by, "测试核验人");
    assert.equal(
      (
        await request(`/v1/brands/${brand.data.id}/review`, {
          ...review,
          revision: 2,
        })
      ).status,
      409,
    );
    const edited = await request(
      `/v1/brands/${brand.data.id}`,
      { ...draft, keywords: ["更正关键词"] },
      "PUT",
    );
    assert.equal(edited.data.review_status, "pending");
    assert.equal(edited.data.reviewed_at, null);
    assert.equal(
      (await request(`/v1/brands/${brand.data.id}/history`)).data.items[0]
        .snapshot.review_status,
      "verified",
    );
    const input = {
      brand_id: brand.data.id,
      title: "测试新品",
      type: "新品",
      starts_at: "2026-09-20T08:00:00+08:00",
      ends_at: "2026-09-24T08:00:00+08:00",
      source_url: "https://example.com/news",
      source_id: sourceId,
      evidence_note: "测试证据，不是真实活动",
      effective_price: null,
      eligibility: "unknown",
      status: "pending",
    };
    assert.equal(
      (await request("/v1/events", { ...input, ends_at: input.starts_at }))
        .status,
      422,
    );
    assert.equal(
      (await request("/v1/events", { ...input, effective_price: -1 })).status,
      422,
    );
    const event = await request("/v1/events", input);
    assert.equal(event.status, 201);
    assert.equal(event.data.source_id, sourceId);
    assert.equal(event.data.original_price, null);
    assert.equal(event.data.store_scope, "unknown");
    assert.deepEqual(event.data.applicable_stores, []);
    assert.equal(
      (
        await request("/v1/events", {
          ...input,
          title: "无效来源",
          source_id: "00000000-0000-4000-8000-000000000001",
        })
      ).status,
      422,
    );
    assert.equal((await request("/v1/events", input)).status, 409);
    assert.equal(
      (
        await request(
          `/v1/events/${event.data.id}`,
          { ...input, evidence_note: "更正后的证据" },
          "PUT",
        )
      ).status,
      200,
    );
    const history = await request(`/v1/events/${event.data.id}/history`);
    assert.equal(
      history.data.items[0].snapshot.evidence_note,
      input.evidence_note,
    );
    const columns =
      "brand_id,title,type,starts_at,ends_at,source_url,evidence_note,effective_price,eligibility,status\n";
    const rows = Array.from(
      { length: 100 },
      (_, i) =>
        `${brand.data.id},批量新品${i},新品,2026-09-20T00:00:00Z,2026-09-24T00:00:00Z,https://example.com/news,导入测试,,unknown,pending`,
    ).join("\n");
    const csv =
      columns +
      rows +
      "\nwrong,无效,新品,wrong,wrong,wrong,测试,,unknown,pending";
    const preview = await request("/v1/imports/preview", { csv });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.valid, 100);
    assert.equal(preview.data.errors.length, 1);
    assert.equal((await request("/v1/events")).data.items.length, 1);
    assert.equal((await request("/v1/imports")).data.items.length, 0);
    const sameRow = rows.split("\n")[0];
    const fileDuplicates = await request("/v1/imports/preview", {
      csv: columns + sameRow + "\n" + sameRow,
    });
    assert.equal(fileDuplicates.data.valid, 1);
    assert.equal(fileDuplicates.data.duplicates, 1);
    assert.equal(
      (await request("/v1/imports/preview", { csv: "brand_id,brand_id\na,b" }))
        .status,
      422,
    );
    assert.equal(
      (await request("/v1/imports/preview", { csv: "title\nonly title" }))
        .status,
      422,
    );
    const unknownSource = await request("/v1/imports/preview", {
      csv:
        columns.trim() +
        ",source_id\n" +
        sameRow +
        ",00000000-0000-4000-8000-000000000001",
    });
    assert.equal(unknownSource.data.valid, 0);
    assert.match(unknownSource.data.errors[0].message, /source_id/);
    const imported = await request("/v1/imports", { csv }, "POST", {
      "Idempotency-Key": "batch-1",
    });
    assert.equal(imported.status, 200);
    assert.equal(imported.data.created, 100);
    assert.equal(imported.data.errors.length, 1);
    const stored = await request(`/v1/imports/${imported.data.id}`);
    assert.deepEqual(stored.data.result, imported.data);
    assert.equal(
      (await request("/v1/imports/00000000-0000-4000-8000-000000000001"))
        .status,
      404,
    );
    const afterPreview = await request("/v1/imports/preview", { csv });
    assert.equal(afterPreview.data.valid, 0);
    assert.equal(afterPreview.data.duplicates, 100);
    const replay = await request("/v1/imports", { csv }, "POST", {
      "Idempotency-Key": "batch-1",
    });
    assert.deepEqual(replay.data, imported.data);
    const duplicate = await request("/v1/imports", { csv }, "POST", {
      "Idempotency-Key": "batch-2",
    });
    assert.equal(duplicate.data.created, 0);
    assert.equal(duplicate.data.duplicates, 100);
    assert.equal(
      (
        await request("/v1/imports", { csv: csv + "\n" }, "POST", {
          "Idempotency-Key": "batch-1",
        })
      ).status,
      409,
    );
    assert.equal((await request("/v1/events")).data.items.length, 101);
    const p = await request("/v1/opportunities");
    assert.equal(p.data.p72, null);
    assert.equal(p.data.headstart_index, null);
    assert.deepEqual(p.data.items, []);
    assert.equal(
      (
        await request("/v1/brands", draft, "POST", {
          Origin: "https://evil.example",
        })
      ).status,
      403,
    );
    const malformed = await fetch(base + "/v1/brands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert(malformed.headers.get("x-request-id"));
    assert.equal((await request("/v1/unknown")).status, 404);
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    await db.close();
    db = await openDatabase(join(directory, "pg"));
    assert.equal((await db.query("SELECT * FROM brands")).rows.length, 1);
    assert.equal((await db.query("SELECT * FROM data_sources")).rows.length, 1);
    assert.equal((await db.query("SELECT * FROM events")).rows.length, 101);
    assert.equal(
      (await db.query("SELECT * FROM schema_migrations")).rows.length,
      7,
    );
  } finally {
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
