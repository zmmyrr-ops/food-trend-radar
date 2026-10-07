import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { projectRoot } from "./config.js";
export type SmsAuth = {
  send: (phone: string) => Promise<void>;
  check: (phone: string, code: string) => Promise<boolean>;
};
export function createSmsAuth(): SmsAuth {
  async function client() {
    const file = await readFile(
      resolve(projectRoot, "data/secrets/pnvs.json"),
      "utf8",
    )
      .then(JSON.parse)
      .catch(() => ({}));
    const accessKeyId =
      process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || file.accessKeyId;
    const accessKeySecret =
      process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || file.accessKeySecret;
    const signName = process.env.PNVS_SIGN_NAME || file.signName;
    const templateCode = process.env.PNVS_TEMPLATE_CODE || file.templateCode;
    if (!accessKeyId || !accessKeySecret || !signName || !templateCode)
      throw Error("短信服务尚未配置");
    const require = createRequire(
      resolve(projectRoot, "data/tools/pnvs/package.json"),
    );
    const sdk = require("@alicloud/dypnsapi20170525");
    const { $OpenApiUtil } = require("@alicloud/openapi-core");
    const { RuntimeOptions } = require("@darabonba/typescript");
    return {
      sdk,
      signName,
      templateCode,
      client: new sdk.default(
        new $OpenApiUtil.Config({
          accessKeyId,
          accessKeySecret,
          endpoint: "dypnsapi.aliyuncs.com",
        }),
      ),
      runtime: new RuntimeOptions({
        autoretry: false,
        maxAttempts: 1,
        connectTimeout: 10000,
        readTimeout: 20000,
      }),
    };
  }
  return {
    async send(phone) {
      try {
        const c = await client();
        const r = await c.client.sendSmsVerifyCodeWithOptions(
          new c.sdk.SendSmsVerifyCodeRequest({
            phoneNumber: phone,
            countryCode: "86",
            signName: c.signName,
            templateCode: c.templateCode,
            templateParam: JSON.stringify({ code: "##code##", min: "5" }),
            codeType: 1,
            codeLength: 6,
            validTime: 300,
            interval: 60,
            duplicatePolicy: 1,
            returnVerifyCode: false,
            autoRetry: 0,
          }),
          c.runtime,
        );
        if (r.body?.code !== "OK" || r.body?.success !== true)
          throw Error("SMS_FAILED");
      } catch {
        throw Error("短信发送失败，请稍后再试或联系管理员");
      }
    },
    async check(phone, code) {
      try {
        const c = await client();
        const r = await c.client.checkSmsVerifyCodeWithOptions(
          new c.sdk.CheckSmsVerifyCodeRequest({
            phoneNumber: phone,
            countryCode: "86",
            verifyCode: code,
          }),
          c.runtime,
        );
        return (
          r.body?.code === "OK" &&
          r.body?.success === true &&
          r.body?.model?.verifyResult === "PASS"
        );
      } catch {
        throw Error("短信核验服务暂不可用，请稍后重试");
      }
    },
  };
}
