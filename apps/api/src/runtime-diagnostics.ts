import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PGlite } from "@electric-sql/pglite";

type Entry = { id: number; label: string; caller: string; started_ms: number };
export class RuntimeDiagnostics {
  private next = 0;
  private pending = 0;
  private active = new Map<number, Entry>();
  private slow: (Entry & { duration_ms: number; failed: boolean })[] = [];
  private maxLag = 0;
  private lastLag = 0;
  constructor(private clock = () => performance.now()) {}
  async track<T>(
    label: string,
    work: () => Promise<T>,
    caller = "stage",
  ): Promise<T> {
    const entry = { id: ++this.next, label, caller, started_ms: this.clock() };
    this.pending++;
    if (this.active.size < 200) this.active.set(entry.id, entry);
    let failed = false;
    try {
      return await work();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.pending--;
      this.active.delete(entry.id);
      const duration_ms = Math.round(this.clock() - entry.started_ms);
      if (duration_ms >= 250) {
        this.slow.push({ ...entry, duration_ms, failed });
        this.slow = this.slow.slice(-100);
      }
    }
  }
  snapshot() {
    return {
      generated_at: new Date().toISOString(),
      pending: this.pending,
      active: [...this.active.values()].map((x) => ({
        ...x,
        elapsed_ms: Math.round(this.clock() - x.started_ms),
      })),
      slow: this.slow,
      event_loop: { last_lag_ms: this.lastLag, max_lag_ms: this.maxLag },
      caveat:
        "调用数包含嵌套步骤与查询。耗时包含数据库排队，不等同于 SQL 执行时间。只保留最近 100 次超过 250 毫秒的调用，不保存 SQL、参数、响应正文或异常消息。进程重启清空；事件循环完全阻塞时此接口也无法即时响应。",
    };
  }
  heartbeat() {
    let expected = this.clock() + 1000;
    const timer = setInterval(() => {
      this.lastLag = Math.max(0, Math.round(this.clock() - expected));
      this.maxLag = Math.max(this.maxLag, this.lastLag);
      expected = this.clock() + 1000;
    }, 1000);
    timer.unref();
    return () => clearInterval(timer);
  }
  attach(db: PGlite) {
    const caller = () =>
      (new Error().stack?.match(/[\w.-]+\.(?:js|ts):\d+:\d+/g) ?? []).find(
        (x) => !x.startsWith("runtime-diagnostics."),
      ) ?? "unknown";
    const query = db.query.bind(db);
    db.query = ((...args: Parameters<PGlite["query"]>) =>
      this.track(
        `db.query:${createHash("sha256").update(args[0]).digest("hex").slice(0, 16)}`,
        () => query(...args),
        caller(),
      )) as PGlite["query"];
    const transaction = db.transaction.bind(db);
    db.transaction = ((...args: Parameters<PGlite["transaction"]>) =>
      this.track(
        "db.transaction",
        () => transaction(...args),
        caller(),
      )) as PGlite["transaction"];
  }
}

/** Bounded local evidence, independent of the database/report pipeline. */
export async function startRuntimeReporting(
  monitor: RuntimeDiagnostics,
  filename: string,
  intervalMs = 10_000,
) {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  await rename(filename, `${filename}.previous`).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  let active: Promise<void> | undefined;
  let lastError: string | null = null;
  const flush = () => {
    if (!active)
      active = (async () => {
        await writeFile(
          `${filename}.tmp`,
          JSON.stringify(
            { ...monitor.snapshot(), previous_write_error: lastError },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        await rename(`${filename}.tmp`, filename);
        lastError = null;
      })()
        .catch(() => {
          lastError = "RUNTIME_REPORT_WRITE_FAILED";
        })
        .finally(() => {
          active = undefined;
        });
    return active;
  };
  await flush();
  const timer = setInterval(() => {
    void flush();
  }, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await active;
    await flush();
  };
}
