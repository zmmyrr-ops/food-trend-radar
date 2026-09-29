import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:net";

// A process-owned local socket is released by the OS even after a crash.
// Hash collisions fail closed; this is single-host protection, not a distributed lease.
export async function acquireDatabaseLease(directory: string) {
  await mkdir(directory, { recursive: true });
  const canonical = await realpath(directory);
  const port =
    40000 +
    (createHash("sha256").update(canonical).digest().readUInt32BE(0) % 20000);
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", () =>
      reject(
        new Error(
          `数据库已由其他进程使用，或保护端口 ${port} 被占用。请先停止重复实例。`,
        ),
      ),
    );
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  server.unref();
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}
