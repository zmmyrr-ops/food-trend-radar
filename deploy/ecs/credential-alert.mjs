// Dedicated alert sender. Never stores an application login code or retries an SMS.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = process.env.RADAR_DATA_ROOT || "/opt/food-trend-radar/data";
try {
  const config = JSON.parse(
    await readFile(resolve(root, "secrets/pnvs.json"), "utf8"),
  );
  const alert = JSON.parse(
    await readFile(resolve(root, "secrets/credential-alert.json"), "utf8"),
  );
  if (!alert.enabled || !/^1[3-9]\d{9}$/.test(alert.phone || ""))
    throw Error("CONFIG");
  for (const key of [
    "accessKeyId",
    "accessKeySecret",
    "signName",
    "templateCode",
  ]) {
    if (!config[key]) throw Error("CONFIG");
  }
  const require = createRequire(resolve(root, "tools/pnvs/package.json"));
  const sdk = require("@alicloud/dypnsapi20170525");
  const { $OpenApiUtil } = require("@alicloud/openapi-core");
  const { RuntimeOptions } = require("@darabonba/typescript");
  const client = new sdk.default(
    new $OpenApiUtil.Config({
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      endpoint: "dypnsapi.aliyuncs.com",
    }),
  );
  if (process.argv.includes("--check-config")) {
    console.log("credential-alert configuration_ready");
  } else {
    const response = await client.sendSmsVerifyCodeWithOptions(
      new sdk.SendSmsVerifyCodeRequest({
        phoneNumber: alert.phone,
        countryCode: "86",
        schemeName: "credential-alert",
        signName: config.signName,
        templateCode: config.templateCode,
        templateParam: JSON.stringify({ code: "999999", min: "5" }),
        validTime: 300,
        interval: 60,
        duplicatePolicy: 2,
        returnVerifyCode: false,
        autoRetry: 0,
      }),
      new RuntimeOptions({
        autoretry: false,
        maxAttempts: 1,
        connectTimeout: 10000,
        readTimeout: 20000,
      }),
    );
    if (response.body?.code !== "OK" || response.body?.success !== true)
      throw Error("SMS_FAILED");
    console.log("credential-alert submitted");
  }
} catch {
  console.error("credential-alert configuration_or_send_failed");
  process.exitCode = 1;
}
