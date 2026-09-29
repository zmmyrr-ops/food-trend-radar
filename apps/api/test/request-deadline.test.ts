import assert from "node:assert/strict";
import { test } from "node:test";
import { RequestDeadline } from "../src/request-deadline.js";

test("超时取消不响应的传输：返回有界、禁止重叠、晚结束后保留间隔", async () => {
  const deadline = new RequestDeadline(15);
  let finish!: (value: string) => void;
  let signal!: AbortSignal;
  const result = deadline.run((s) => {
    signal = s;
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  await assert.rejects(result, /REQUEST_TIMEOUT/);
  assert.equal(signal.aborted, true);
  assert.equal(deadline.pending, true);
  let called = false;
  await assert.rejects(
    deadline.run(async () => {
      called = true;
    }),
    /REQUEST_TIMEOUT/,
  );
  assert.equal(called, false);
  const ended = Date.now();
  finish("late");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deadline.pending, false);
  assert.equal(await deadline.run(async () => "next"), "next");
  assert.ok(Date.now() - ended >= 1950);
});

test("响应头到达但正文挂起仍受总时限保护，晚拒绝不会成为未处理异常", async () => {
  const deadline = new RequestDeadline(15);
  let rejectBody!: (error: Error) => void;
  await assert.rejects(
    deadline.run(async () => {
      await Promise.resolve("headers");
      return new Promise((_, reject) => {
        rejectBody = reject;
      });
    }),
    /REQUEST_TIMEOUT/,
  );
  rejectBody(new Error("late body error"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deadline.pending, false);
});

test("正常结果和普通网络错误保持原语义并释放通道", async () => {
  const deadline = new RequestDeadline(100);
  assert.equal(await deadline.run(async () => 42), 42);
  await assert.rejects(
    deadline.run(async () => {
      throw new Error("NETWORK_ERROR");
    }),
    /NETWORK_ERROR/,
  );
  assert.equal(deadline.pending, false);
  assert.equal(await deadline.run(async () => 43), 43);
});
