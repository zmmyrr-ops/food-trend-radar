// Archive an immutable directory only. Active database directories are forbidden.

import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createObjectStorage } from "../apps/api/dist/object-storage.js";

const directory = resolve(process.argv[2] || "");
if (!/^postgres-before-[a-zA-Z0-9-]+$/.test(basename(directory)))
  throw Error("Only immutable postgres-before-* snapshots are accepted");
const root = resolve(directory, "..");
const store = await createObjectStorage(
  root,
  join(root, "secrets", "oss.json"),
);
if (!store) throw Error("OSS not configured");
const files = [];
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isSymbolicLink()) throw Error("Symlink is not allowed");
    if (e.isDirectory()) await walk(path);
    else if (!e.name.includes(".oss.json")) files.push(path);
  }
}
await walk(directory);
let bytes = 0;
for (const path of files) {
  const info = await stat(path);
  await store.archive(path, false);
  bytes += info.size;
}

import { createHash } from "node:crypto";
// Verify every object by downloading it again and comparing SHA-256 before
// any immutable snapshot files are removed. Stream verification uses no disk.
import OSS from "ali-oss";

const cfg = JSON.parse(
  await readFile(join(root, "secrets", "oss.json"), "utf8"),
);
const client = new OSS({ ...cfg, secure: true, timeout: 120000 });
const manifest = [];
for (const path of files) {
  const receipt = await store.receipt(path);
  const result = await client.getStream(receipt.key);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of result.stream) {
    hash.update(chunk);
    size += chunk.length;
  }
  if (size !== receipt.size || hash.digest("hex") !== receipt.sha256)
    throw Error("Backup integrity check failed");
  manifest.push({ path: path.slice(directory.length + 1), ...receipt });
}
await mkdir(join(root, "reports"), { recursive: true });
await writeFile(
  join(root, "reports", basename(directory) + "-oss-manifest.json"),
  JSON.stringify(
    {
      bucket: cfg.bucket,
      created_at: new Date().toISOString(),
      files: manifest,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
await store.archive(
  join(root, "reports", basename(directory) + "-oss-manifest.json"),
  false,
);
// Keep small receipts and the manifest locally for disaster recovery.
if (process.argv.includes("--evict-verified"))
  for (const path of files) await rm(path);
console.log(
  JSON.stringify({
    verified_files: files.length,
    archived_bytes: bytes,
    evicted: process.argv.includes("--evict-verified"),
  }),
);
