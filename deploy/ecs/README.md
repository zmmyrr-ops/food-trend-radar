# 阿里云 ECS 部署

访问入口：`https://ruming.top/food-trend-radar/`。HTTPS Nginx 对整个目录使用 Basic Auth，后端仅监听 `127.0.0.1:3011`，不开放公网管理端口。

## 文件与运行时

- `/opt/food-trend-radar/app`：项目与构建产物；`app/data` 链接到独立数据目录。
- `/opt/food-trend-radar/data`：数据库、备份、私有凭据、运行日志。禁止提交 Git。
- `/opt/food-trend-radar/node`：独立 Node 22，避免更改原站 Node。
- `food-trend-radar.service`：以专用用户 `food-radar` 运行。
- `nginx-location.conf`：只加入原站 HTTPS server，不覆盖原站其他 location。

## 构建与更新

使用 Node >=22.12，执行 `npm ci`、`npm run check`，再执行 `VITE_BASE_PATH=/food-trend-radar/ npm run build`。Linux 必须安装 Linux 平台依赖，不可复制 macOS node_modules。

更新前备份数据库和当前发布目录，暂停采集、停止服务后切换代码。保留独立 data 目录及凭据，启动后验证健康接口、品牌数、采集状态和页面资源。验证通过再恢复采集。禁止本机和 ECS 同时运行采集任务。

## 运维

```sh
systemctl status food-trend-radar
journalctl -u food-trend-radar -n 100 --no-pager
systemctl stop food-trend-radar
systemctl start food-trend-radar
nginx -t
```

每日备份由应用生成，保留最近 7 份，目录 `data/backups`。异地备份需另外配置。迁移时先暂停并正常停止原实例，确认进程退出后复制整个数据库目录；禁止热复制 PGlite 文件。恢复历史备份前先停止服务，并用 `scripts/verify-backup.mjs` 验证备份。新实例验收失败时停止新实例、恢复原代码与数据库副本，确认只有一个采集实例再恢复旧服务。

访问密码保存在运维端私有文件，服务端只保存 htpasswd 哈希；不得加入仓库。凭据失效、平台风控时保持暂停，人工重新登录后更新凭据，不能绕过校验。串行请求间隔保持 1–2 秒。
