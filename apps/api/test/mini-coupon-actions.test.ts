import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

test("mini coupon actions sync duplicate-brand cards, prevent duplicate writes and reload preferences", async () => {
  let page: any;
  let subscribed = false;
  let blocked = false;
  let writes = 0;
  let modal: any;
  let modalCount = 0;
  let release!: () => void;
  let pending = Promise.resolve();
  let failWrite = false;
  runInNewContext(
    readFileSync(
      new URL("../../../miniprogram/pages/coupons/index.js", import.meta.url),
      "utf8",
    ),
    {
      Page(value: any) {
        page = value;
      },
      require(path: string) {
        if (path.endsWith("config"))
          return { apiBase: "https://example.com/api/mini" };
        return {
          notice() {},
          async subscribeBrand() {
            writes++;
            await pending;
            if (failWrite) throw new Error("offline");
            subscribed = true;
            return true;
          },
          async request(path: string, method?: string) {
            if (method === "POST") {
              writes++;
              await pending;
              if (failWrite) throw new Error("offline");
              if (path === "brand-subscriptions") subscribed = true;
              else blocked = true;
              return { ok: true };
            }
            return {
              items: (path === "brand-subscriptions" ? subscribed : blocked)
                ? [{ brand_id: "a" }]
                : [],
            };
          },
        };
      },
      wx: {
        showToast() {},
        showModal(value: any) {
          modal = value;
          modalCount++;
        },
      },
    },
  );
  page.setData = (values: any) => Object.assign(page.data, values);
  page.data.items = [{ brand_id: "a" }, { brand_id: "a" }, { brand_id: "b" }];
  page.data.view = "all";
  let reloads = 0;
  page.load = async (reset: boolean) => {
    assert.equal(reset, true);
    reloads++;
    page.data.items = page.data.items.filter(
      (x: any) => !page.data.blockedIds.includes(x.brand_id),
    );
  };
  const event = { currentTarget: { dataset: { brand: "a" } } };
  await page.loadPreferences();
  pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = page.subscribe(event);
  await page.subscribe(event);
  assert.equal(writes, 1);
  assert.equal(page.data.items[1].subscribing, true);
  release();
  await first;
  assert.equal(page.data.items[0].subscribed, true);
  assert.equal(page.data.items[1].subscribed, true);
  assert.equal(page.data.items[2].subscribed, false);
  await page.subscribe(event);
  assert.equal(writes, 1);
  page.block(event);
  page.block(event);
  assert.equal(modalCount, 1);
  await modal.success({ confirm: false });
  assert.equal(page.data.items[0].blocking, false);
  page.block(event);
  await modal.success({ confirm: true });
  assert.equal(reloads, 1);
  assert.equal(page.data.items.length, 1);
  assert.equal(page.data.items[0].brand_id, "b");
  page.block(event);
  assert.equal(writes, 2);
  subscribed = false;
  blocked = false;
  page.data.items = [{ brand_id: "a" }, { brand_id: "a" }, { brand_id: "b" }];
  await page.loadPreferences();
  assert.equal(page.data.items[1].blocked, false);
  assert.equal(page.data.items[1].subscribed, false);
  failWrite = true;
  await page.subscribe(event);
  assert.equal(page.data.items[0].subscribing, false);
  assert.equal(page.data.items[0].subscribed, false);
});

test("brand subscription requires native acceptance before consent and brand writes", async () => {
  for (const result of ["accept", "reject", "fail", "consent-fail"]) {
    const calls: string[] = [];
    const module = { exports: {} as any };
    runInNewContext(
      readFileSync(
        new URL("../../../miniprogram/utils/api.js", import.meta.url),
        "utf8",
      ),
      {
        module,
        require: () => ({
          apiBase: "https://example.com/api/mini",
          templateId: "template",
        }),
        wx: {
          getStorageSync: () => "token",
          requestSubscribeMessage(options: any) {
            calls.push("native");
            if (result === "fail") options.fail({ message: "cancelled" });
            else
              options.success({
                template: result === "consent-fail" ? "accept" : result,
              });
          },
          request(options: any) {
            calls.push(options.url.split("/").pop());
            if (result === "consent-fail") options.fail();
            else options.success({ statusCode: 200, data: { ok: true } });
          },
          showModal() {
            calls.push("settings-prompt");
          },
        },
      },
    );
    const pending = module.exports.subscribeBrand("a");
    assert.deepEqual(
      calls,
      ["native"],
      "authorization starts synchronously from tap",
    );
    if (result === "fail" || result === "consent-fail") {
      await assert.rejects(pending);
      assert.equal(calls.includes("brand-subscriptions"), false);
    } else {
      assert.equal(await pending, result === "accept");
      assert.deepEqual(
        calls,
        result === "accept"
          ? ["native", "notification-consent", "brand-subscriptions"]
          : ["native", "notification-consent", "settings-prompt"],
      );
    }
  }
});

test("mini login preserves native network diagnostics, deduplicates taps and can retry", async () => {
  const module = { exports: {} as any };
  let loginCalls = 0;
  let requestCalls = 0;
  let fail = true;
  let token = "";
  runInNewContext(
    readFileSync(
      new URL("../../../miniprogram/utils/api.js", import.meta.url),
      "utf8",
    ),
    {
      module,
      require: () => ({
        apiBase: "https://example.com/api/mini",
        templateId: "template",
      }),
      wx: {
        login(options: any) {
          loginCalls++;
          options.success({ code: "one-use-code" });
        },
        setStorageSync(_key: string, value: string) {
          token = value;
        },
        request(options: any) {
          requestCalls++;
          if (fail)
            options.fail({
              errMsg: "request:fail url not in domain list",
              errno: 600002,
            });
          else
            options.success({
              statusCode: 200,
              data: { token: "session-token" },
            });
        },
      },
    },
  );
  const first = module.exports.login();
  assert.equal(module.exports.login(), first);
  await assert.rejects(first, (error: any) => {
    assert.match(error.message, /域名/);
    assert.equal(error.code, "600002");
    assert.match(error.detail, /request:fail url not in domain list/);
    assert.equal(error.detail.includes("one-use-code"), false);
    return true;
  });
  assert.equal(token, "");
  fail = false;
  assert.equal(await module.exports.login(), "session-token");
  assert.equal(loginCalls, 2);
  assert.equal(requestCalls, 2);
  assert.equal(token, "session-token");
});
