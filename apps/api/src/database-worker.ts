import { parentPort, workerData } from "node:worker_threads";
import type { Transaction } from "@electric-sql/pglite";
import { openDatabase } from "./db.js";

const port = parentPort!;
const db = await openDatabase(workerData.directory);
let tx: Transaction | undefined;
let finish: ((commit: boolean) => void) | undefined;
let transaction: Promise<void> | undefined;
port.on("message", async ({ id, method, args }) => {
  try {
    let result: unknown;
    if (method === "begin") {
      await new Promise<void>((ready, reject) => {
        transaction = db
          .transaction(async (value) => {
            tx = value;
            const commit = await new Promise<boolean>((resolve) => {
              finish = resolve;
              ready();
            });
            if (!commit) throw new Error("ROLLBACK_REQUESTED");
          })
          .then(() => undefined);
        // Attach rejection handling immediately; the end request still awaits it.
        void transaction.catch(reject);
      });
    } else if (method === "end") {
      finish!(args[0]);
      try {
        await transaction;
      } catch (error) {
        if (args[0]) throw error;
      } finally {
        tx = undefined;
        finish = undefined;
        transaction = undefined;
      }
    } else if (method === "query")
      result = await (tx ?? db).query(args[0], args[1]);
    else if (method === "exec") result = await (tx ?? db).exec(args[0]);
    else if (method === "dumpDataDir") result = await db.dumpDataDir(args[0]);
    else if (method === "close") await db.close();
    else throw new Error("UNKNOWN_DATABASE_OPERATION");
    port.postMessage({ id, result });
  } catch (error) {
    const e = error as Error & { code?: string; constraint?: string };
    port.postMessage({
      id,
      error: { message: e.message, code: e.code, constraint: e.constraint },
    });
  }
});
port.postMessage({ ready: true });
