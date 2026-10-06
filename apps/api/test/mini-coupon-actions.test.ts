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
  assert.equal(page.data.items[1].blocked, true);
  assert.equal(page.data.items.length, 3);
  page.block(event);
  assert.equal(writes, 2);
  subscribed = false;
  blocked = false;
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
