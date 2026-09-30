// Run with the video service stopped. Does not open the application database.

import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createObjectStorage } from "../apps/api/dist/object-storage.js";

const root = resolve(process.argv[2] || "data/videos");
if (!process.argv.includes("--service-stopped"))
  throw Error("Stop the video service, then pass --service-stopped");
const store = await createObjectStorage(root);
if (!store) throw Error("OSS is not configured");
let count = 0,
  bytes = 0;
for (const dir of await readdir(root, { withFileTypes: true })) {
  if (
    !dir.isDirectory() ||
    (dir.name !== "uploads" && !/^[a-f0-9-]{36}$/.test(dir.name))
  )
    continue;
  for (const file of await readdir(join(root, dir.name))) {
    const path = join(root, dir.name, file);
    if (
      /^(?:[a-f0-9-]{36}\.(?:source|audio)|(?:preview|export)-\d+\.mp4)$/.test(
        file,
      )
    ) {
      const size = (await stat(path)).size;
      await store.archive(path);
      count++;
      bytes += size;
    } else if (
      /^(render-\d+\.mp4|caption-\d+\.ass|concat\.txt)$/.test(file) ||
      file.endsWith(".jpg") ||
      file.endsWith(".tmp.mp4") ||
      file.endsWith(".download")
    ) {
      await rm(path, { force: true });
    }
  }
}
console.log(JSON.stringify({ archived_files: count, evicted_bytes: bytes }));
