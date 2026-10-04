import { spawn } from "node:child_process";
import { chmod, cp, mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";

async function directorySize(path: string): Promise<number> {
  let size = 0;
  for (const item of await readdir(path, { withFileTypes: true })) {
    const file = join(path, item.name);
    if (item.isDirectory()) size += await directorySize(file);
    else if (item.isFile()) size += (await stat(file)).size;
    else throw new Error("BACKUP_UNSUPPORTED_FILE");
  }
  return size;
}
/** Called only by the database owner, while the worker RPC queue is exclusive. */
export async function copyDatabaseSnapshot(
  db: PGlite,
  directory: string,
  destination: string,
) {
  if (!directory || resolve(destination).startsWith(resolve(directory) + "/"))
    throw new Error("BACKUP_INVALID_DIRECTORY");
  const size = await directorySize(directory);
  const free = await statfs(dirname(destination));
  // Reserve both the independent snapshot and worst-case compressed output, plus headroom.
  if (free.bavail * free.bsize < size * 2 + 512 * 1024 * 1024)
    throw new Error("BACKUP_DISK_HEADROOM");
  await db.exec("CHECKPOINT");
  await db.syncToFs();
  await mkdir(destination, { mode: 0o700 });
  try {
    await cp(directory, join(destination, basename(directory)), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
function archive(directory: string, target: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-czf", target, "-C", directory, "."], {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, GZIP: "-1" },
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 15 * 60_000);
    timer.unref();
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error("BACKUP_ARCHIVE_FAILED"));
    });
  });
}
export async function writeDatabaseBackup(db: PGlite, target: string) {
  const client = db as PGlite & {
    snapshotToDirectory?: (path: string) => Promise<void>;
  };
  const snapshot = target + ".snapshot";
  try {
    // These paths belong exclusively to this attempt, never the live database.
    await rm(snapshot, { recursive: true, force: true });
    if (!client.snapshotToDirectory) throw new Error("BACKUP_WORKER_REQUIRED");
    await client.snapshotToDirectory(snapshot);
    // Compression runs after releasing the DB queue; queries continue throughout.
    await archive(snapshot, target);
    await chmod(target, 0o600);
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}
