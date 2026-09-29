import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
export const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = z
    .object({
      HOST: z.enum(["127.0.0.1", "localhost"]).default("127.0.0.1"),
      PORT: z.coerce.number().int().min(1).max(65535).default(3001),
      DATA_DIR: z.string().min(1).default("./data/postgres"),
      WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
    })
    .parse(env);
  return { ...value, DATA_DIR: resolve(projectRoot, value.DATA_DIR) };
}
export function loadConfig() {
  const envFile = resolve(projectRoot, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  return readConfig();
}
