import { Worker } from "node:worker_threads";
import type { PGlite } from "@electric-sql/pglite";

/** One database owner in a worker. The HTTP event loop never executes WASM SQL. */
export async function openWorkerDatabase(directory?: string): Promise<PGlite> {
  const worker = new Worker(new URL("./database-worker.js", import.meta.url), {
    workerData: { directory },
  });
  let next = 0;
  let dead: Error | undefined;
  const calls = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let ready!: () => void;
  let failed!: (error: Error) => void;
  const startup = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const fail = (error: Error) => {
    dead = error;
    failed(error);
    for (const call of calls.values()) call.reject(error);
    calls.clear();
  };
  worker.on("error", fail);
  worker.on("exit", () => fail(new Error("DATABASE_WORKER_CLOSED")));
  worker.on("message", ({ ready: initialized, id, result, error }) => {
    if (initialized) {
      ready();
      return;
    }
    const call = calls.get(id);
    calls.delete(id);
    if (error) call?.reject(Object.assign(new Error(error.message), error));
    else call?.resolve(result);
  });
  await startup.catch(async (error) => {
    await worker.terminate();
    throw error;
  });
  function rpc(method: string, ...args: unknown[]) {
    if (dead) return Promise.reject(dead);
    return new Promise<unknown>((resolve, reject) => {
      const id = ++next;
      calls.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, method, args });
      } catch (error) {
        calls.delete(id);
        reject(error);
      }
    });
  }
  let tail = Promise.resolve();
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  const client = {
    query: (sql: string, params?: unknown[]) =>
      exclusive(() => rpc("query", sql, params)),
    exec: (sql: string) => exclusive(() => rpc("exec", sql)),
    transaction: (work: (tx: unknown) => Promise<unknown>) =>
      exclusive(async () => {
        await rpc("begin");
        try {
          const result = await work({
            query: (sql: string, params?: unknown[]) =>
              rpc("query", sql, params),
            exec: (sql: string) => rpc("exec", sql),
          });
          await rpc("end", true);
          return result;
        } catch (error) {
          await rpc("end", false).catch(() => undefined);
          throw error;
        }
      }),
    dumpDataDir: (compression?: string) =>
      exclusive(() => rpc("dumpDataDir", compression)),
    close: () =>
      exclusive(async () => {
        try {
          await rpc("close");
        } finally {
          await worker.terminate();
        }
      }),
  };
  // Deliberately expose only the subset used by application repositories.
  return client as unknown as PGlite;
}
