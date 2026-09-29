import {
  access,
  cp,
  lstat,
  mkdir,
  readlink,
  rename,
  symlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireDatabaseLease } from "../apps/api/dist/database-lease.js";

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const home = join(
  homedir(),
  "Library",
  "Application Support",
  "food-trend-radar",
);
const runtime = join(home, "runtime");
const data = join(home, "data");
if (process.platform !== "darwin") throw new Error("仅支持 macOS");
const release = await acquireDatabaseLease(join(source, "data", "postgres"));
try {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const stage = join(home, `runtime-${Date.now()}`);
  await mkdir(stage, { mode: 0o700 });
  for (const path of [
    "package.json",
    "package-lock.json",
    "node_modules",
    "apps/api/dist",
    "apps/api/package.json",
    "apps/web/dist",
    "apps/web/package.json",
    "packages/contracts",
    "catalog",
  ]) {
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await cp(join(source, path), join(stage, path), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  const info = await lstat(join(source, "data"));
  if (info.isSymbolicLink()) {
    if ((await readlink(join(source, "data"))) !== data)
      throw new Error("现有数据链接不属于此运行目录，停止切换");
  } else {
    if (
      await access(data).then(
        () => true,
        () => false,
      )
    )
      throw new Error("目标数据目录已存在，停止切换");
    await rename(join(source, "data"), data);
    try {
      await symlink(data, join(source, "data"));
    } catch (error) {
      await rename(data, join(source, "data"));
      throw error;
    }
  }
  await symlink(data, join(stage, "data"));
  if (
    await access(runtime).then(
      () => true,
      () => false,
    )
  )
    await rename(runtime, join(home, `runtime-previous-${Date.now()}`));
  await rename(stage, runtime);
  console.log(
    "运行目录已准备：" +
      runtime +
      "。原项目 data 链接至同一数据目录；未复制第二份正在使用的数据库。",
  );
} finally {
  await release();
}
