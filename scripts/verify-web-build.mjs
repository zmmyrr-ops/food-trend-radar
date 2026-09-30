import { access, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const dir = resolve("apps/web/dist");
const html = await readFile(resolve(dir, "index.html"), "utf8");
const assets = [...html.matchAll(/(?:src|href)="([^" ]+\.(?:js|css))"/g)].map(
  (x) => x[1],
);
if (
  !assets.some((x) => x.endsWith(".js")) ||
  !assets.some((x) => x.endsWith(".css"))
)
  throw new Error("Missing JS/CSS entrypoints");
for (const asset of assets) {
  if (!asset.startsWith("/food-trend-radar/assets/"))
    throw new Error(`Invalid ECS base path: ${asset}`);
  await access(resolve(dir, "assets", basename(asset)));
}
console.log("ECS frontend base path and all entrypoint assets verified");
