import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createObjectStorage } from "../src/object-storage.js";

test("verified eviction, restoration, signed access and deletion; failures preserve originals", async () => {
  const root = await mkdtemp(join(tmpdir(), "radar-oss-"));
  const config = join(root, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      bucket: "test-bucket",
      accessKeyId: "test",
      accessKeySecret: "test",
      prefix: "private/",
    }),
  );
  const objects = new Map<string, { body: Buffer; headers: any }>();
  let broken = false;
  const client: any = {
    put: async (key: string, path: string, opts: any) => {
      assert.equal(opts.headers["x-oss-object-acl"], "private");
      objects.set(key, { body: await readFile(path), headers: opts.headers });
    },
    head: async (key: string) => {
      const o = objects.get(key)!;
      return {
        res: {
          headers: {
            "content-length": o.body.length,
            "x-oss-meta-sha256": broken
              ? "invalid"
              : o.headers["x-oss-meta-sha256"],
          },
        },
      };
    },
    get: async (key: string, path: string) => {
      await writeFile(path, objects.get(key)!.body);
    },
    signatureUrl: (key: string, opts: any) => {
      assert.equal(opts.expires, 300);
      return "https://private.invalid/" + key + "?signed";
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
  };
  try {
    const store = (await createObjectStorage(root, config, client))!;
    const path = join(root, "clip.mp4");
    await writeFile(path, "video fixture");
    broken = true;
    await assert.rejects(store.archive(path), /校验失败/);
    assert.equal(await readFile(path, "utf8"), "video fixture");
    assert.equal(await store.receipt(path), null);
    broken = false;
    await store.archive(path);
    await assert.rejects(stat(path));
    assert.match((await store.signedUrl(path))!, /signed/);
    await Promise.all([store.restore(path), store.restore(path)]);
    assert.equal(await readFile(path, "utf8"), "video fixture");
    await store.archive(path);
    await store.remove(path);
    assert.equal(objects.size, 0);
    assert.equal(await store.receipt(path), null);
    await assert.rejects(store.archive(join(root, "..", "escape")), /不合法/);
    assert.equal(await createObjectStorage(root, join(root, "absent")), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("internal transfer configuration never leaks an internal playback endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "radar-oss-internal-"));
  try {
    const config = join(root, "config.json");
    await writeFile(
      config,
      JSON.stringify({
        bucket: "test-private",
        region: "oss-cn-wulanchabu",
        accessKeyId: "test",
        accessKeySecret: "test",
        prefix: "private/",
        internal: true,
      }),
    );
    const path = join(root, "clip.mp4");
    await writeFile(
      path + ".oss.json",
      JSON.stringify({
        bucket: "test-private",
        key: "private/" + root.split("/").at(-1) + "/clip.mp4",
        sha256: "a".repeat(64),
        size: 12,
      }),
    );
    const storage = (await createObjectStorage(root, config))!;
    const url = new URL((await storage.signedUrl(path))!);
    assert.equal(url.hostname, "test-private.oss-cn-wulanchabu.aliyuncs.com");
    assert.equal(url.protocol, "https:");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
