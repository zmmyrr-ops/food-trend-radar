# 阿里云 ECS 部署

访问入口：`https://ruming.top/food-trend-radar/`。HTTPS Nginx 对整个目录使用 Basic Auth，后端仅监听 `127.0.0.1:3011`，不开放公网管理端口。

## 文件与运行时

- `/opt/food-trend-radar/app`：项目与构建产物；`app/data` 链接到独立数据目录。
- `/opt/food-trend-radar/data`：数据库、备份、私有凭据、运行日志。禁止提交 Git。
- `/opt/food-trend-radar/node`：独立 Node 22，避免更改原站 Node。
- `food-trend-radar.service`：以专用用户 `food-radar` 运行。
- `nginx-location.conf`：只加入原站 HTTPS server，不覆盖原站其他 location。

## 构建与更新

使用 Node >=22.12，执行 `npm ci`、`npm run check`，再执行 `npm run build:ecs`（固定子目录构建参数，勿用普通 build 产物发布）。Linux 必须安装 Linux 平台依赖，不可复制 macOS node_modules。

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

## 视频工作室运行时

生产机已安装Noto CJK字体。渲染工具使用 `/opt/food-trend-radar/ffmpeg-linux`（ffmpeg-static b6.1.1对应Linux二进制，含libass）与 `/opt/food-trend-radar/ffprobe-linux`（ffprobe-static 3.1.0）。systemd drop-in `video.conf` 设置 `FFMPEG_PATH` 和 `FFPROBE_PATH`。新机器可通过锁定的npm依赖安装对应平台文件后配置这两个变量，不得复制macOS二进制到Linux。

百炼密钥文件 `/opt/food-trend-radar/data/secrets/bailian.json`，格式为含api_key的JSON，仅food-radar可读。Nginx本项目location的client_max_body_size为51m，后端单文件上限50MB；不要扩大其他站点上传限制。视频子进程仅通过IPC回传数据库变更，不直接打开PGlite。视频目录可独立备份，发布时不把大体积视频目录反复打进代码备份。

## 2026-09-30 性能修复

数据库仍为单实例 PGlite，但唯一数据库实例现在运行在 Node 工作线程中；HTTP 主线程通过串行 RPC 访问。事务独占队列，失败回滚，备份也在数据库线程执行。不要额外开启服务实例或直接打开线上数据库目录。

销量、机会列表和优先分复用 `radar_read_models` 持久化结果；源表变更通过事务内触发器更新版本，下一次读取失效重建。即使数据不变也最多缓存60秒，保障节日边界和证据时效。后台每分钟预热优先分；证据历史批处理每5分钟，诊断和报表每15分钟。页面只查询可见模块，隐藏页面暂停轮询。平台采集限速和现有风控暂停状态保持不变。

发布必须执行 `npm run build:ecs`，该命令验证 HTML 中的 JS/CSS 路径及文件存在。先复制新静态资源，再原子替换 index.html，保留上一版散列资源供旧页面使用。更新数据库执行方式前应在服务正常停止后复制数据目录作为回滚点。恢复时不要覆盖切换后新增数据，应先判断是否只需回退代码。

验证：健康接口不能被长 SQL 阻塞；检查首次及重复查询、规则/品牌修改后的缓存失效、事务回滚、冷启动持久结果恢复、品牌和视频数量。性能记录的 SQL 耗时包含队列等待，不能当作纯 SQL 执行耗时。
