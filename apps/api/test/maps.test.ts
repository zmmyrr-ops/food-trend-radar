import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { registerMaps } from "../src/maps.js";

test("地图仅公开Web Key，安全密钥由固定目标代理注入", async () => {
  const dir = await mkdtemp(join(tmpdir(), "map-config-")),
    path = join(dir, "maps.json");
  await writeFile(
    path,
    JSON.stringify({ key: "test-web-key", secret: "test-server-secret" }),
  );
  const app = express();
  registerMaps(app, path);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    original = globalThis.fetch;
  let forwarded = "";
  globalThis.fetch = (async (input: any, init: any) => {
    if (String(input).startsWith("https://restapi.amap.com")) {
      forwarded = String(input);
      return new Response('{"status":"1"}', {
        headers: { "Content-Type": "application/json" },
      });
    }
    return original(input, init);
  }) as typeof fetch;
  try {
    const c = await (await original(base + "/api/v3/maps/config")).json();
    assert.deepEqual(c, { key: "test-web-key" });
    assert.equal(
      (
        await original(
          base +
            "/_AMapService/v3/place/text?keywords=test&key=override&jscode=override",
        )
      ).status,
      200,
    );
    const u = new URL(forwarded);
    assert.equal(u.hostname, "restapi.amap.com");
    assert.equal(u.searchParams.get("key"), "test-web-key");
    assert.equal(u.searchParams.get("jscode"), "test-server-secret");
    assert.equal((await original(base + "/_AMapService/unknown")).status, 404);
    assert.equal(
      (await original(base + "/_AMapService/v3/place/text", { method: "POST" }))
        .status,
      405,
    );
  } finally {
    globalThis.fetch = original;
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
