import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import OSS from "ali-oss";
import { z } from "zod";

const configSchema = z.object({
  bucket: z.string().min(3),
  region: z.string().default("oss-cn-beijing"),
  accessKeyId: z.string().min(1),
  accessKeySecret: z.string().min(1),
  internal: z.boolean().default(false),
  prefix: z
    .string()
    .regex(/^[a-zA-Z0-9/-]+$/)
    .default("tanhaodian/"),
});
const receiptSchema = z.object({
  bucket: z.string().optional(),
  key: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
});
export async function fileDigest(path: string, algorithm = "sha256") {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
// Receipts are local durable pointers. No local file is evicted before its
// remote checksum/length have been verified and its receipt atomically saved.
export async function createObjectStorage(
  root: string,
  configPath = join(root, "..", "secrets", "oss.json"),
  clientOverride?: OSS,
) {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  const config = configSchema.parse(JSON.parse(raw));
  const client =
    clientOverride ?? new OSS({ ...config, secure: true, timeout: 120000 });
  const signer =
    clientOverride ??
    (config.internal
      ? new OSS({ ...config, internal: false, secure: true })
      : client);
  const prefix =
    config.prefix.replace(/\/?$/, "/") + basename(resolve(root)) + "/";
  function keyFor(path: string) {
    const rel = relative(resolve(root), resolve(path));
    if (!rel || rel.startsWith("..") || rel.includes("\\"))
      throw Error("存储路径不合法");
    return prefix + rel;
  }
  async function receipt(path: string) {
    keyFor(path);
    try {
      const r = receiptSchema.parse(
        JSON.parse(await readFile(path + ".oss.json", "utf8")),
      );
      if (r.key !== keyFor(path)) throw Error("存储记录不匹配");
      return r;
    } catch (e: any) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  async function archive(path: string, evict = true) {
    const key = keyFor(path);
    let info;
    try {
      info = await stat(path);
    } catch (e: any) {
      if (e.code === "ENOENT") {
        const prior = await receipt(path);
        if (prior?.bucket === config.bucket) return;
        if (prior) throw Error("存储桶不匹配，本地文件不存在");
      }
      throw e;
    }
    const sha256 = await fileDigest(path);
    const previous = await receipt(path);
    if (
      !previous ||
      previous.bucket !== config.bucket ||
      previous.sha256 !== sha256 ||
      previous.size !== info.size
    ) {
      await client.put(key, path, {
        headers: {
          "Content-MD5": Buffer.from(
            await fileDigest(path, "md5"),
            "hex",
          ).toString("base64"),
          "x-oss-object-acl": "private",
          "x-oss-meta-sha256": sha256,
          "Cache-Control": "private, no-store",
        },
      });
    }
    const head = await client.head(key);
    const headers = head.res.headers as Record<string, string>;
    if (
      Number(headers["content-length"]) !== info.size ||
      headers["x-oss-meta-sha256"] !== sha256
    )
      throw Error("OSS校验失败，本地文件已保留");
    const temp = path + ".oss.json.tmp-" + randomUUID();
    await writeFile(
      temp,
      JSON.stringify({ bucket: config.bucket, key, sha256, size: info.size }),
      {
        mode: 0o600,
      },
    );
    await rename(temp, path + ".oss.json");
    if (evict) await rm(path, { force: true });
  }
  const restores = new Map<string, Promise<void>>();
  async function restore(path: string) {
    keyFor(path);
    try {
      await stat(path);
      return;
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    if (restores.has(path)) return restores.get(path)!;
    const task = (async () => {
      const r = await receipt(path);
      if (!r) throw Error("素材文件不存在，请重新获取");
      if (r.bucket !== config.bucket) throw Error("存储桶不匹配，禁止跨桶恢复");
      const temp = path + ".restore-" + randomUUID();
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await client.get(r.key, temp);
        if (
          (await stat(temp)).size !== r.size ||
          (await fileDigest(temp)) !== r.sha256
        )
          throw Error("OSS文件完整性校验失败");
        await rename(temp, path);
      } finally {
        await rm(temp, { force: true });
      }
    })();
    restores.set(path, task);
    try {
      await task;
    } finally {
      restores.delete(path);
    }
  }
  async function signedUrl(
    path: string,
    filename?: string,
    options?: { inline?: boolean },
  ) {
    const r = await receipt(path);
    if (!r) return null;
    if (r.bucket !== config.bucket) throw Error("存储桶不匹配");
    return signer.signatureUrl(r.key, {
      expires: 300,
      response: {
        "cache-control": "private, no-store",

        ...(filename
          ? {
              "content-disposition": `${options?.inline ? "inline" : "attachment"}; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
            }
          : {}),
      },
    });
  }
  async function readPrefix(path: string) {
    const r = await receipt(path);
    if (!r || r.bucket !== config.bucket) throw Error("素材存储记录不可用");
    const result = await client.get(r.key, {
      headers: { Range: "bytes=0-63" },
    });
    return Buffer.from(result.content).subarray(0, 64);
  }
  async function mediaStream(path: string, range?: string) {
    const r = await receipt(path);
    if (!r) return null;
    if (r.bucket !== config.bucket) throw Error("存储桶不匹配");
    return client.getStream(r.key, { headers: range ? { Range: range } : {} });
  }

  async function remove(path: string) {
    const r = await receipt(path);
    if (r) {
      if (r.bucket !== config.bucket) throw Error("存储桶不匹配");
      await client.delete(r.key);
    }
    await rm(path, { force: true });
    await rm(path + ".oss.json", { force: true });
  }
  async function removeDirectory(dir: string) {
    keyFor(dir);
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(
      (e) => {
        if (e.code === "ENOENT") return [];
        throw e;
      },
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await removeDirectory(path);
      else if (entry.name.endsWith(".oss.json"))
        await remove(path.slice(0, -9));
    }
    await rm(dir, { recursive: true, force: true });
  }
  return {
    archive,
    restore,
    signedUrl,
    readPrefix,
    mediaStream,
    remove,
    removeDirectory,
    receipt,
  };
}
