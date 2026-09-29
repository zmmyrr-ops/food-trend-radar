import { resolve } from "node:path";
import { createApp } from "./app.js";
import { loadConfig, projectRoot } from "./config.js";
import { createCoupons } from "./coupons.js";
import { acquireDatabaseLease } from "./database-lease.js";
import { openDatabase } from "./db.js";
import { createOperations } from "./operations.js";
import { recoverInterruptedRequests } from "./request-recovery.js";

import {
  RuntimeDiagnostics,
  startRuntimeReporting,
} from "./runtime-diagnostics.js";

const config = loadConfig();
const releaseLease = await acquireDatabaseLease(config.DATA_DIR);
const db = await openDatabase(config.DATA_DIR).catch(async (error) => {
  await releaseLease();
  throw error;
});
const runtime = new RuntimeDiagnostics();
runtime.attach(db);
const stopHeartbeat = runtime.heartbeat();
const stopRuntimeReporting = await startRuntimeReporting(
  runtime,
  resolve(projectRoot, "data/reports/runtime-diagnostics-current.json"),
);
await recoverInterruptedRequests(db);
const radar = createCoupons(db, {
  credentialPath: resolve(projectRoot, "data/secrets/douyin-headers.json"),
});
const operations = await createOperations(
  db,
  resolve(projectRoot, "data/backups"),
  (label, work) => runtime.track(label, work),
);
void operations.tick().catch(console.error);
radar.kick();
const timer = setInterval(() => {
  void operations.tick().catch(console.error);
  void radar.schedule().catch(console.error);
}, 60000);
void radar.schedule().catch(console.error);
const server = createApp(
  db,
  config.WEB_ORIGIN,
  undefined,
  radar,
  operations,
  () => runtime.snapshot(),
).listen(config.PORT, config.HOST, () =>
  console.log(`上海优惠券机会雷达 http://${config.HOST}:${config.PORT}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    clearInterval(timer);
    stopHeartbeat();
    const stopped = radar.stop();
    server.close(async () => {
      await stopped;
      await operations.drain();
      await stopRuntimeReporting();
      await db.close();
      await releaseLease();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 35000).unref();
  });
}
