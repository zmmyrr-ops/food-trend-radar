import assert from "node:assert/strict";
import test from "node:test";
import { readApiResponse } from "../../web/src/api-response.js";

test("网关HTML和无效JSON返回可读错误", async () => {
  await assert.rejects(
    readApiResponse(
      new Response("<html><h1>Bad Gateway</h1>", { status: 502 }),
    ),
    /服务暂时不可用/,
  );
  await assert.rejects(
    readApiResponse(new Response("<html>login")),
    /服务响应异常/,
  );
  await assert.rejects(
    readApiResponse(new Response("", { status: 401 })),
    /登录已失效/,
  );
});
test("清空成功和业务错误保持原有语义", async () => {
  assert.deepEqual(await readApiResponse(Response.json({ ok: true })), {
    ok: true,
  });
  assert.deepEqual(
    await readApiResponse(new Response(null, { status: 204 })),
    {},
  );
  await assert.rejects(
    readApiResponse(
      Response.json({ error: { message: "无权操作" } }, { status: 403 }),
    ),
    /无权操作/,
  );
});
