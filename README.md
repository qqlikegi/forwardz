# ForwardZ

**流量转发管理系统** — 支持 **Cloudflare Workers（免费版无服务器）** 与 **传统 VPS（Go 单文件）** 双模式无缝切换部署；共用同一套三主题 Web UI、同一套 Go 节点端（Agent）以及同一套可双向互恢复的 `.sql.gz` SQLite 数据库快照。

Linux amd64 / arm64 ｜ Cloudflare Workers Free Plan ｜ [Apache-2.0](./LICENSE)

> **完整架构说明、双模式部署教程、数据库双向互恢复手册与 AI 接手指南，请参阅 [docs/DEPLOY_AND_HANDOFF.md](./docs/DEPLOY_AND_HANDOFF.md)。**

---

## 核心特性

| 维度 | 说明 |
|---|---|
| **双模式面板，功能 100% 对齐** | `cf-panel/`（Cloudflare Workers + 单实例 SQLite Durable Object）与 `panel/`（Go 单文件 + SQLite）接口、WS 协议、数据库结构完全一致，随时自由切换 |
| **同一节点端无缝双通** | `agent/` 以 CF 节能协议为标准：`wss://`/`ws://` 自动协商、明文 `ping`/`pong` 零开销保活、按需 2 秒实时监控、加密 WS 双触发流量上报、网页一键远程热升级 |
| **数据库双向互通互恢复** | 两套面板共用相同的 14 张 SQLite 表与统一 `.sql.gz` R2/S3 云备份格式；CF ↔ VPS 随时一条命令互相恢复备份 |
| **三套现代 UI 主题** | 精密曜石（深色）/ 瑞士冷瓷（浅色）/ 暗夜琥珀（机房风），所有用户登录后均可秒切，PC 与移动端 H5 分别适配 |
| **转发与运维能力** | TCP/UDP 转发、多跳隧道（tls/wss/tcp/mtls/mwss/mtcp）、24 小时隧道链路与转发落地延迟/丢包率自动探测与波形监控、单/双向计费、流量倍率、用户与隧道独立配额/限速、换机自动配置对账、一机多面板（8 位指纹） |

---

## 仓库目录速览

```text
forwardz/
├─ cf-panel/              Cloudflare Workers 面板（TypeScript + SQLite Durable Object）
│  ├─ src/                入口、PanelHub DO、全量 /api/v1 路由、R2 备份、迁移导入
│  ├─ scripts/            migrate_sqlite.py（支持 .sql.gz/.sql/.db.gz/.db 导入 CF）
│  ├─ test/               Vitest + Workers 端到端单元测试
│  └─ wrangler.jsonc      Wrangler 部署配置（DO、Static Assets、Cron）
├─ panel/                 传统 VPS 面板（Go 单文件，go:embed 内嵌前端 + 纯 Go SQLite）
│  ├─ main.go / router.go 入口、CLI（-backup/-export/-restore/-reset-admin/-fingerprint）
│  ├─ ws.go               与 CF 对齐的 WS Hub（ping/pong、按需监控、WS 流量/升级上报）
│  ├─ h_*.go              业务路由（含 flow-policy 与 upgrade-info/upgrade-all）
│  ├─ backup.go / cli_db.go 统一 .sql.gz 云备份与全格式数据库恢复
│  └─ sql/                14 张 SQLite 表定义（与 cf-panel/src/db/schema.ts 完全一致）
├─ agent/                 节点端（Go 单文件，同时无缝对接 CF 面板与 VPS 面板）
├─ vite-frontend/         共用前端（React 19 + TypeScript + Vite + HeroUI + Tailwind v4）
├─ docs/
│  └─ DEPLOY_AND_HANDOFF.md  完整双模式部署教程、协议规范与 AI 快速接手文档
├─ panel_install.sh       VPS 面板一键安装 / 更新 / 卸载脚本
├─ install.sh             节点端一键安装脚本（支持一机多面板共存）
├─ zf.sh                  SSH 快捷管理菜单（zf）
└─ .github/workflows/     CI：Go 测试 + CF Panel 测试 + Ubuntu 全流程冒烟测试 + 发版
```

---

## 快速开始

### 方式一：Cloudflare Workers 部署（0 服务器成本）

详见 [cf-panel/README.md](./cf-panel/README.md) 与 [docs/DEPLOY_AND_HANDOFF.md](./docs/DEPLOY_AND_HANDOFF.md#三cloudflare-workers-部署与运维指南)。

```bash
# 1. 构建前端静态资源
cd vite-frontend && npm install --legacy-peer-deps && npm run build

# 2. 登录并部署到 Cloudflare Workers
cd ../cf-panel && npm install
npx wrangler login
npx wrangler secret put JWT_SECRET   # 可选，不设会自动生成并持久化到 DO SQLite
npm run deploy
```

部署后建议在 Cloudflare Dashboard 绑定自定义域名，然后在面板「系统配置 → 云存储备份」填好 R2 密钥即可每日自动备份 `.sql.gz`。

### 方式二：传统 VPS 部署（Linux amd64 / arm64，root）

详见 [docs/DEPLOY_AND_HANDOFF.md](./docs/DEPLOY_AND_HANDOFF.md#四传统-vps-部署与运维指南)。

```bash
curl -L https://github.com/qqlikegi/forwardz/releases/latest/download/panel_install.sh -o panel_install.sh
chmod +x panel_install.sh
./panel_install.sh install
```

装完后 SSH 里随时输入 `zf` 打开快捷菜单（启停、升级、备份、导出、恢复备份、卸载）。

### 安装节点端（两种面板步骤完全一致）

1. 在面板「系统配置」设置面板地址（CF 填 `https://你的面板域名`；VPS 填 `公网IP:端口` 或反代后的 `https://域名`）。
2. 在「节点管理」新建节点 → 点击「安装」复制一键命令 → 到节点 VPS 执行。
3. 后续可在「系统配置 → 节点端远程更新」直接网页一键升级所有在线节点，无需逐台 SSH。

---

## 数据库双向互恢复（CF ↔ VPS）

两套面板自动云备份均输出完全一致的 `forwardz-panel-backup-YYYYMMDD-HHMMSS.sql.gz`：

- **从 CF（或任意 `.sql.gz`/`.db` 备份）恢复到 VPS 面板**：
  ```bash
  systemctl stop forwardz-panel
  (set -a; . /opt/forwardz-panel/forwardz-panel.env; set +a; /opt/forwardz-panel/forwardz-panel -restore /root/forwardz-panel-backup-xxx.sql.gz)
  systemctl start forwardz-panel
  ```
  也可在 VPS 上输入 `zf` → 选择面板 → `8. 恢复数据库`。
- **从 VPS（或 R2 `.sql.gz` 备份）恢复/迁移到 Cloudflare Workers 面板**：
  ```bash
  cd cf-panel && npx wrangler secret put MIGRATION_TOKEN
  python scripts/migrate_sqlite.py --db /path/to/backup.sql.gz --url https://你的CF域名 --token <MIGRATION_TOKEN> --panel-addr https://你的CF域名
  npx wrangler secret delete MIGRATION_TOKEN
  ```

---

## 本地测试与构建

```bash
# 前端构建
cd vite-frontend && npm run build

# CF 面板类型检查 & 单元测试
cd cf-panel && npm run typecheck && npm test

# VPS Go 面板单元测试 & 编译
cd panel && go test -v ./... && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o forwardz-panel-amd64 .

# 节点端编译
cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o forwardz-agent-amd64 .
```

---

## 免责声明与许可证

- 本项目仅供个人学习、研究与合法合规的网络流量转发用途，使用者需自行承担合规与运营责任。
- ForwardZ 以 [Apache License 2.0](./LICENSE) 开源；面板源自 [bqlpfy/flux-panel](https://github.com/bqlpfy/flux-panel)，节点端第三方声明见 [agent/THIRD_PARTY_NOTICES](./agent/THIRD_PARTY_NOTICES)。
