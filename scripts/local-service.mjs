import { spawnSync } from "node:child_process";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const root = join(
  homedir(),
  "Library",
  "Application Support",
  "food-trend-radar",
  "runtime",
);
const label = "com.food-trend-radar.local";
const domain = `gui/${process.getuid()}`;
const target = `${domain}/${label}`;
const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
function launch(args, quiet = false) {
  return spawnSync("launchctl", args, { stdio: quiet ? "ignore" : "inherit" })
    .status;
}
function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
if (process.platform !== "darwin")
  throw new Error("此脚本仅适用于 macOS 登录会话。");
async function healthy() {
  try {
    const response = await fetch("http://127.0.0.1:3001/api/v3/status", {
      signal: AbortSignal.timeout(1000),
    });
    const value = await response.json();
    return response.ok && value.concurrency === 1;
  } catch {
    return false;
  }
}
const action = process.argv[2] ?? "status";
if (action === "install") {
  if (launch(["print", target], true) === 0) {
    console.log(
      "服务已加载；使用 status 查看状态。更新构建后可 stop 再 install。",
    );
  } else {
    if (await healthy())
      throw new Error(
        "请先暂停采集并停止当前服务，再安装后台服务，避免重复实例。",
      );
    await access(join(root, "apps/api/dist/server.js"));
    await mkdir(dirname(plist), { recursive: true });
    await mkdir(join(root, "data", "logs"), { recursive: true, mode: 0o700 });
    await writeFile(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(root, "apps/api/dist/server.js"))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>45</integer>
<key>EnvironmentVariables</key><dict><key>NODE_ENV</key><string>production</string></dict>
<key>StandardOutPath</key><string>${xml(join(root, "data/logs/service.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(root, "data/logs/service-error.log"))}</string>
</dict></plist>\n`,
      { mode: 0o600 },
    );
    if (launch(["bootstrap", domain, plist]) !== 0) process.exitCode = 1;
    else {
      let ready = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        if (await healthy()) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (ready)
        console.log(
          "本机服务健康检查通过。登录后启动，异常退出后重启；休眠期间不采集。",
        );
      else {
        launch(["bootout", target], true);
        await rename(plist, `${plist}.disabled`);
        console.error(
          "后台服务健康检查失败，已卸载并禁用自动启动。请检查 data/logs 与系统文件访问权限；当前未验收常驻运行。",
        );
        process.exitCode = 1;
      }
    }
  }
} else if (action === "stop") {
  process.exitCode = launch(["bootout", target]) === 0 ? 0 : 1;
} else if (action === "status") {
  process.exitCode = launch(["print", target]) === 0 ? 0 : 1;
} else
  throw new Error("用法：node scripts/local-service.mjs install|status|stop");
