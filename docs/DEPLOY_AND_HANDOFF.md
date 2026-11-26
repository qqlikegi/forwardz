# ForwardZ 架构、双模式部署与 AI 快速接手手册

> 本文档面向**运维使用者**与**后续接手本项目的 AI / 开发者**，完整记录 ForwardZ 的双面板架构（Cloudflare Workers + 传统 VPS）、统一 Agent 协议、数据库双向互恢复机制、前端三主题体系以及构建发布规范。

---

## 一、项目总览与核心设计原则

ForwardZ 是一个单仓库多端项目，遵循 **「一套前端 + 一套节点端 + 一套统一数据库格式，驱动两种可随时互换的面板后端」** 原则：

```text
                       ┌───────────────────────────────┐
                       │    vite-frontend (React 19)   │
                       │  三套主题 · PC 侧栏 · 移动 H5   │
                       └───────┬───────────────┬───────┘
          Static Assets        │               │        go:embed (panel/web/dist)
                               ▼               ▼
              ┌────────────────────┐       ┌────────────────────┐
              │ cf-panel (Workers) │       │  panel (Go 单文件)  │
              │  SQLite DO 托管版   │       │  传统 VPS SQLite版 │
              └─────────┬──────────┘       └─────────┬──────────┘
                        │   完全一致的 13 表 Schema    │
                        │   统一 .sql.gz 云备份格式    │
                        │   CF ↔ VPS 双向无损互恢复    │
                        └──────────────┬──────────────┘
                                       │ 统一加密 WebSocket 协议
                                       │ (wss/ws 自动协商 · ping/pong · SetReportInterval · FlowReport · UpgradeAgent)
                                       ▼
                        ┌──────────────────────────────┐
                        │  agent (Go 单文件，各节点 VPS) │
                        │  TCP/UDP 多跳转发 · 换机自愈   │
                        └──────────────────────────────┘
```

### 目录与关键文件索引

| 路径 | 语言 / 运行时 | 关键职责与入口文件 |
|---|---|---|
| `cf-panel/` | TypeScript / Cloudflare Workers | **CF 面板**：`src/index.ts`（路由与 Cron 入口，拦截非 WS `/system-info`）、`src/panel-hub.ts`（单实例 `PanelHub` Durable Object、WS Hibernation、Alarm 调度）、`src/db/schema.ts` & `queries.ts`（13 张 SQLite 表）、`src/routes/{user,node,tunnel,forward,flow,backup,migrate}.ts`、`src/agent/{commands,reconcile}.ts`、`scripts/migrate_sqlite.py`、`test/panel.test.ts` |
| `panel/` | Go 1.23 / 纯 Go SQLite (`modernc.org/sqlite`) | **VPS 面板**：`main.go`（CLI 与 HTTP 服务）、`router.go`（API 路由 + `go:embed all:web`）、`ws.go`（与 CF 对齐的 WS Hub）、`h_node.go` + `h_node_ext.go`（节点 CRUD、流量策略、远程更新）、`h_flow.go`（HTTP & WS 流量入账、定时统计/重置）、`h_tunnel.go` / `tunnel_edit.go` / `h_forward.go` / `h_user.go`、`backup.go` & `cli_db.go`（统一 `.sql.gz` 备份与全格式 `-restore`）、`sql/schema.sql` & `data.sql` |
| `agent/` | Go | **节点端**：`main.go`（入口与版本号 `agentVersion`）、`x/socket/websocket_reporter.go`（WS 自动降级、心跳、指令分发、WS 流量上报）、`x/socket/upgrade.go`（安全远程自升级：镜像兜底、`-V` 校验、`.bak` 备份、原子替换、重启前刷流量）、`x/service/global_traffic_manager.go`（双触发 + 噪点过滤流量统计与 `FlushNow`） |
| `vite-frontend/` | React 19 + TS + Vite + HeroUI + Tailwind v4 | **共用前端**：`index.html`（防闪烁主题初始化）、`src/styles/globals.css`（三套主题 CSS 变量与组件覆写）、`src/components/theme-provider.tsx` & `theme-switcher.tsx`、`src/layouts/{admin,h5,h5-simple,default}.tsx`、`src/pages/admin-overview.tsx`（数据总览）、`src/pages/config.tsx` 及 4 个配置子卡片（`flow-policy-settings.tsx`、`agent-upgrade-settings.tsx`、`fingerprint-settings.tsx`、`backup-settings.tsx`） |
| 根目录脚本 | Bash | `panel_install.sh`（VPS 面板安装/更新/重置/卸载）、`install.sh`（Agent 安装与多实例共存）、`zf.sh`（`/usr/local/bin/zf` 统一管理菜单） |
| `.github/` | GitHub Actions | `workflows/release.yml`（构建 Agent + Go Panel + `go test` + `cf-panel` Vitest + Ubuntu 冒烟测试 + Release 发版）、`scripts/smoke-test.sh` |

---

## 二、统一 Agent ↔ Panel 通信协议规范（以 CF 标准为准）

无论是 `cf-panel` 还是 `panel`，都严格实现同一套协议，因此同一份 `forwardz-agent` 二进制切换面板时**只需改 `/etc/forwardz_agent/config.json` 的 `addr` 并重启**，无需更换程序：

1. **连接地址自动协商**（`agent/x/socket/websocket_reporter.go`）：
   - `https://domain` → `wss://domain/system-info?...`
   - `http://ip:port` 或 `ip:port` → `ws://ip:port/system-info?...`
   - 裸域名 `domain` → 先试 `wss://`（5 秒超时），失败自动回退 `ws://`。
2. **握手鉴权**：
   - 节点连入：`GET /system-info?type=1&secret=<node_secret>&version=<ver>&http=<0|1>&tls=<0|1>&socks=<0|1>`（必须带 `Upgrade: websocket`）。
   - 管理员监控页连入：`GET /system-info?type=0&secret=<jwt_token>`。
3. **传输加密**：除明文保活外，节点与面板间 JSON 消息统一封装为 `{"encrypted":true,"data":"<base64(iv12+ciphertext+tag)>","timestamp":<ms>}`（AES-256-GCM，密钥为 `SHA256(node_secret)`）。
4. **零开销保活 & 按需实时监控**：
   - 节点上线时，面板立即下发 `SetReportInterval`：
     ```json
     {
       "type": "SetReportInterval",
       "data": {
         "intervalSec": 0,
         "flowIntervalSec": 600,
         "flowThresholdBytes": 1073741824,
         "flowMinBytes": 65536
       }
     }
     ```
   - `intervalSec = 0`（无管理员打开节点监控页）：节点每 25 秒发纯文本 `"ping"`，面板原样回纯文本 `"pong"`（在 CF 上由平台 `setWebSocketAutoResponse` 处理，0 DO 唤醒）。
   - 当有管理员打开节点监控页建立管理 WS 时，面板广播 `intervalSec = 2`；最后一个管理 WS 断开时广播 `intervalSec = 0`。
5. **流量上报与配置对账**：
   - 收到 `SetReportInterval` 后，Agent 自动开启加密 WS `FlowReport` 通道（满足定时周期或流量阈值即上报，小流量按 `flowMinBytes` 过滤并在 1 小时兜底刷盘），面板回复 `FlowReportAck`；若 WS 短暂断开，Agent 自动回退到 HTTP `POST /flow/upload?secret=...`。
   - 节点重连后 3 秒及每 10 分钟通过 `POST /flow/config?secret=...`（或 WS `ConfigReport`）上报本机转发状态，面板按数据库期望状态自动补齐/纠正/清理（换机自愈）。
6. **网页一键远程更新**（`agent >= v1.04`，`v1.06` 增强多镜像测速与实时进度）：
   - 面板查询最新版本采用三级零限流策略：`HEAD/GET github.com/<repo>/releases/latest` 读取 302 `Location` → `releases.atom` XML → `api.github.com` 兜底，缓存 10 分钟；活动状态超过 4 分钟自动超时释放，避免卡死。
   - 节点下载线路自动判定：并行探测 `myip.ipip.net` + `ipinfo.io/country`（4 秒超时默认按受限网络处理）；大陆节点依次尝试 `ghfast.top` → `gh-proxy.com` → `ghproxy.net` → GitHub 直连，海外/港澳台节点优先 GitHub 直连再兜底镜像；连接头超 12 秒、卡顿 12 秒或 8 秒后均速 `< 80 KB/s` 自动秒切下一线路。
   - 下发 `UpgradeAgent`（`{repo, targetVersion, force}`）后，节点每 1.5 秒通过 WS `UpgradeStatus` 推送精简实时进度（如 `下载 Agent 62% · 8.5 MB/s (ghfast.top)`），试运行 `-V` 通过后备份 `.bak`、刷出未上报流量、原子替换二进制并退出，由 systemd `Restart=on-failure` 1–3 秒内自动拉起，重连后自动置为 `success`。

---

## 三、Cloudflare Workers 部署与运维指南（`cf-panel`）

### 3.1 首次部署

前置要求：Node.js 20+、Cloudflare 账号（Free 免费版即可）。

```bash
# 1. 编译共用前端到 vite-frontend/dist
cd vite-frontend
npm install --legacy-peer-deps
npm run build

# 2. 安装 cf-panel 依赖并登录 Cloudflare
cd ../cf-panel
npm install
npx wrangler login

# 3. 可选：固定 JWT 密钥（不设也会自动随机生成并持久化在 DO SQLite）
npx wrangler secret put JWT_SECRET

# 4. 部署 Worker + 静态资源 + SQLite Durable Object + Cron
npm run deploy
```

### 3.2 关键配置（`cf-panel/wrangler.jsonc`）

- **Static Assets**：`directory: "../vite-frontend/dist"`、`not_found_handling: "single-page-application"`、`run_worker_first: ["/api/*", "/flow/*", "/system-info"]`。静态页面请求不触发 Worker，不扣免费额度。
- **Durable Object**：单实例 `PanelHub`（固定名称 `main`），开启 `new_sqlite_classes: ["PanelHub"]`。
- **Cron 触发器（统一 1 个，极省账号限额）**：
  - `*/15 * * * *`（仅占用 Cloudflare Free Plan 全账号 5 个 Cron 限额中的 **1 个**）：
    - 每 15 分钟自动探测所有启用隧道的链路延迟与丢包率（写入 `tunnel_latency`，自动保留最近 25 小时）
    - 每个整点（`minute === 0`）顺序执行整点流量统计（写入 `statistics_flow` 与 `user_flow_daily`），并紧接着检查目标时区（`TZ_OFFSET_MINUTES=480` 为东八区）是否到达 `00:xx` 以每日一次执行流量月重置与到期停用
- **R2 定时备份**：使用 DO `ctx.storage.setAlarm()` 驱动，不占用额外 Cron 额度；在面板「系统配置 → 云存储备份」配置好 R2 S3 Endpoint 与 API Token 即可。
- **绑定自定义域名**：Cloudflare Dashboard → Workers & Pages → `forwardz-panel` → Settings → Domains & Routes → Add Custom Domain。

### 3.3 运维注意事项

- **部署后 DO 平滑切换**：部署新版本后，入口 Worker 秒级生效，但持有活跃 WebSocket 的单实例 `PanelHub` Durable Object 可能需要 1–2 分钟完成切换，期间属正常现象。
- **防止旧节点刷爆免费额度**：更换面板或卸载老版节点时，务必确认旧 VPS 上没有残留 `flux_agent.service` 等旧服务持续请求 `/system-info`（可在 VPS 用 `systemctl list-units | grep -iE 'gost|flux|forward'` 检查）。
- **日常更新部署**：修改 `vite-frontend` 或 `cf-panel` 后，执行 `npm --prefix vite-frontend run build && npm --prefix cf-panel run deploy` 即可。

---

## 四、传统 VPS 部署与运维指南（`panel`）

### 4.1 一键安装（推荐，Linux amd64 / arm64，root）

```bash
curl -L https://github.com/qqlikegi/forwardz/releases/latest/download/panel_install.sh -o panel_install.sh
chmod +x panel_install.sh
./panel_install.sh install
```

- 安装目录：`/opt/forwardz-panel`
- 数据库默认路径：`/opt/forwardz-panel/data/forwardz.db`
- 环境变量文件：`/opt/forwardz-panel/forwardz-panel.env`（`SERVER_PORT`、`DB_PATH`、`LOG_DIR`、`JWT_SECRET`、`TZ`）
- 服务管理：`systemctl status|restart forwardz-panel`、`journalctl -u forwardz-panel -f`
- 快捷菜单：SSH 输入 `zf` 可直接启停、更新、备份、导出、恢复备份或卸载。

### 4.2 手动从源码构建并运行

```bash
# 1. 构建前端并嵌入 panel/web/dist
cd vite-frontend && npm install --legacy-peer-deps && npm run build
rm -rf ../panel/web/dist && cp -r dist ../panel/web/dist

# 2. 编译 Go 单文件（无 CGO）
cd ../panel
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w -X main.version=1.05" -o forwardz-panel-amd64 .

# 3. 直接启动
SERVER_PORT=6365 DB_PATH=./data/forwardz.db ./forwardz-panel-amd64
```

### 4.3 面板内置 CLI 参数

（执行前先加载 `forwardz-panel.env` 以确保 `DB_PATH` 指向正确数据库）

```bash
forwardz-panel -v                              # 查看版本
forwardz-panel -fingerprint                    # 查看 8 位面板指纹
forwardz-panel -backup /root/a.db              # 热备份为完整 SQLite .db 文件
forwardz-panel -export /root/a.sql             # 导出为标准 SQL 文本
forwardz-panel -restore /root/backup.sql.gz    # 恢复数据库（兼容 .sql.gz/.sql/.db.gz/.db，自动 .bak 备份旧库）
forwardz-panel -reset-admin                    # 重置管理员账号（重新走首次初始化）
```

### 4.4 配置 HTTPS 反代（可选）

如果 VPS 面板前面挂了 Nginx / Caddy / Cloudflare Tunnel 提供 HTTPS，请确保转发 WebSocket 升级头（`Upgrade` / `Connection: upgrade`）和 `X-Forwarded-Proto: https`，然后在「系统配置 → 面板后端地址」直接填 `https://你的面板域名` 即可（`panel` 与 `agent` 已完全支持 `https://` 地址）。

---

## 五、数据库架构与双向互恢复手册（CF ↔ VPS）

### 5.1 统一 13 张核心表

`cf-panel/src/db/schema.ts` 与 `panel/sql/schema.sql` 保持严格一致：

`user`、`node`、`tunnel`、`chain_tunnel`、`forward`、`forward_port`、`speed_limit`、`user_tunnel`、`vite_config`、`statistics_flow`、`user_flow_daily`、`system_setting`、`tunnel_latency`。

其中 `system_setting` 保存内部配置（不经公开配置接口暴露），包括：
- `admin_initialized`、`panel_fingerprint`、`jwt_secret`
- `backup_enabled`、`backup_endpoint`、`backup_bucket`、`backup_access_key`、`backup_secret_key`、`backup_prefix`、`backup_keep`、`backup_mode`、`backup_time`、`backup_hours`、`backup_anchor`、`backup_last_*`
- `flow_report_interval_min`、`flow_report_threshold_mb`、`flow_report_min_kb`
- `last_reset_flow_day`

### 5.2 统一云备份格式

两套面板执行 R2 / S3 云备份时，**均产出完全一致的 `forwardz-panel-backup-YYYYMMDD-HHMMSS.sql.gz`**（gzip 压缩的标准 SQLite SQL 转储，自动排除 `sqlite_%` 与 `_cf_%` 系统内部表）。

### 5.3 场景 A：Cloudflare Workers → 传统 VPS（或用 R2 备份恢复 VPS）

1. 从 R2 存储桶下载最新的 `forwardz-panel-backup-YYYYMMDD-HHMMSS.sql.gz` 上传到 VPS（如 `/root/backup.sql.gz`）。
2. 在 VPS 上恢复（两种方式任选其一）：
   - **快捷菜单**：输入 `zf` → 选择面板 → `8. 恢复数据库` → 输入 `/root/backup.sql.gz`。
   - **命令行**：
     ```bash
     systemctl stop forwardz-panel
     (set -a; . /opt/forwardz-panel/forwardz-panel.env; set +a; /opt/forwardz-panel/forwardz-panel -restore /root/backup.sql.gz)
     systemctl start forwardz-panel
     ```
   > `-restore` 会自动校验 SQLite 完整性、补齐缺失表、将节点状态重置为离线、并把原有 `forwardz.db` 自动改名为 `.pre-restore-*.bak`。
3. 登录新 VPS 面板 →「系统配置」修改「面板后端地址」为 VPS 新地址。
4. 在各节点 VPS 上修改 `/etc/forwardz_agent/config.json` 里的 `addr` 为新面板地址（`secret` 与 `fingerprint` 无需改动），执行 `systemctl restart forwardz_agent` 即无缝接管全部转发。

### 5.4 场景 B：传统 VPS → Cloudflare Workers（或用 R2 备份恢复 CF）

`cf-panel/scripts/migrate_sqlite.py` 原生支持 `.sql.gz`、`.sql`、`.db.gz`、`.db` 四种输入：

```bash
# 1. 为 CF Worker 临时设置迁移令牌
cd cf-panel
npx wrangler secret put MIGRATION_TOKEN

# 2. 导入备份（可直接传入 R2 的 .sql.gz 或 VPS 的 forwardz.db）
python scripts/migrate_sqlite.py \
  --db "/path/to/forwardz-panel-backup-xxx.sql.gz" \
  --url "https://你的CF面板域名" \
  --token "<刚才设置的MIGRATION_TOKEN>" \
  --panel-addr "https://你的CF面板域名"

# 3. 校验报告全表 OK 后，立刻删除迁移令牌关闭迁移入口
npx wrangler secret delete MIGRATION_TOKEN
```

4. 同样将各节点 VPS 的 `/etc/forwardz_agent/config.json` 中 `addr` 改为 `"https://你的CF面板域名"`，执行 `systemctl restart forwardz_agent` 即可无缝切换。

> **重要提醒**：如果用同一份备份同时启动了两套面板（例如测试环境 + 生产环境），请务必在其中一套面板的「系统配置 → 面板指纹」重新生成新指纹，避免两套面板互相覆盖节点实例或同时操作同一 R2 备份目录。

---

## 六、开发者与 AI 接手速查表

### 6.1 前端三套主题架构

- 主题 ID：`obsidian`（精密曜石，暗色）、`ceramic`（瑞士冷瓷，浅色）、`amber`（暗夜琥珀，机房暗色），持久化键为 `localStorage.fz_ui_theme`（退出登录时 `src/utils/logout.ts` 会保留该偏好与侧栏折叠状态 `fz_sidebar_collapsed`）。
- 零闪烁初始化在 `vite-frontend/index.html` 内联 `<script>`；所有语义色与圆角令牌集中在 `vite-frontend/src/styles/globals.css`（`--fz-*` 与 `--heroui-*`），组件层统一使用 `.fz-card`、`.fz-subcard`、`.fz-cell`、`.fz-avatar`、`.fz-segment`。
- 如仅改 UI 效果，可按需保留回滚快照并复用 `preview/preview-server.mjs` 做本地无后端预览。

### 6.2 改动后的必跑验证清单

| 改动范围 | 验证命令 |
|---|---|
| `vite-frontend/` | `npm --prefix vite-frontend run build`（含 `tsc && vite build`） |
| `cf-panel/` | `npm --prefix cf-panel run typecheck && npm --prefix cf-panel test` |
| `panel/` | `cd panel && go test -v ./... && go build .`（推送 `main` 后 GitHub Actions 也会自动跑 Go 测试 + Linux 双架构构建 + Ubuntu 真机冒烟测试） |
| `agent/` | `cd agent && go build .`（同样由 GitHub Actions 自动验证编译与真机安装/转发） |

### 6.3 发版与隐私安全规范

- **CI 触发规则**（`.github/workflows/release.yml`）：
  - 推送到 `main`：自动构建并跑完 `panel` Go 单测、`cf-panel` Vitest、Ubuntu 端到端冒烟测试，**不发 Release**。
  - 推送 `v*` 标签（如 `git tag v1.05 && git push origin v1.05`）：所有测试通过后自动发布 GitHub Release（含 `forwardz-panel-{amd64,arm64}`、`forwardz-agent-{amd64,arm64}` 及 3 个安装管理脚本）。
- **关于仓库公开性与下载脚本**：`install.sh`、`panel_install.sh`、`zf.sh` 及节点端网页一键更新均通过免鉴权的 `github.com/<repo>/releases/latest/download/...` 拉取程序。**若仓库保持 Public，必须严禁提交任何真实域名、IP、账号 ID、R2/S3 密钥或 Token**；若日后改为 Private，则所有脚本与 `agent/x/socket/upgrade.go` 需配套增加 GitHub Token 鉴权下载逻辑。
