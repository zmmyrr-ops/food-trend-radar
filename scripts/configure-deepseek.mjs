import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Read only a literal assignment; never execute the user's shell configuration.
let key = process.env.DEEPSEEK_API_KEY;
if (!key) {
  const text = await readFile(join(homedir(), ".zshrc"), "utf8");
  const assignments = [
    ...text.matchAll(
      /^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#]+))\s*(?:#.*)?$/gm,
    ),
  ];
  const last = assignments.at(-1);
  key = last?.[1] ?? last?.[2] ?? last?.[3];
}
if (!key || !/^[A-Za-z0-9_-]{16,256}$/.test(key))
  throw new Error(
    "未找到有效的 DEEPSEEK_API_KEY 字面值；可通过环境变量运行此脚本",
  );
const dir = fileURLToPath(new URL("../data/secrets/", import.meta.url));
await mkdir(dir, { recursive: true, mode: 0o700 });
const path = join(dir, "deepseek.json");
await writeFile(`${path}.tmp`, JSON.stringify({ api_key: key }), {
  mode: 0o600,
});
await chmod(`${path}.tmp`, 0o600);
await rename(`${path}.tmp`, path);
console.log("DeepSeek 后端密钥已配置（权限 0600）；未输出密钥。");
