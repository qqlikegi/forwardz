# ForwardZ Cloudflare Workers 面板 (`cf-panel`)

基于 **Cloudflare Workers（Static Assets）+ 单实例 SQLite Durable Object (`PanelHub`)** 的 ForwardZ 全功能面板，专为 **Cloudflare Free 免费版** 深度优化，并与传统 Go VPS 面板（`panel/`）保持 100% API、协议和 `.sql.gz` 数据库备份兼容。

> 完整架构、双模式切换、协议规范与 AI 交接文档见 [../docs/DEPLOY_AND_HANDOFF.md](../docs/DEPLOY_AND_HANDOFF.md)。

## 架构与 Free Plan 优化要点

- **零面板 VPS**：前端由 Workers Static Assets 免费托管（不扣 Worker 请求数）；全部 `/api/v1/*`、WebSocket Hub、14 张 SQLite 表、单个 `*/5 * * * *` 统一 Cron（按系统设置动态间隔探测隧道链路与转发落地延迟/丢包 + 整点统计/每日重置）、DO Alarm 定时 R2 备份全部运行在单实例 SQLite Durable Object 内。
- **Free 免费版配额保护**：
  - 入口层（`src/index.ts`）直接拦截非 WebSocket 的 `/system-info` 探测请求（返回 `426`），不唤醒 DO。
  - 节点空闲时每 25 秒发纯文本 `"ping"`，由 DO `setWebSocketAutoResponse` 平台层自动回 `"pong"`（**0 DO 唤醒、0 请求、0 时长费**）。
  - 仅在管理员打开「节点监控」页建立管理 WS 时下发 `SetReportInterval(intervalSec=2)` 开启 2 秒实时监控，关闭页面立刻恢复 `intervalSec=0`。
  - 节点流量上报采用**双触发 + 噪点过滤**（默认 10 分钟 / 1024 MB / 64 KB，网页实时可调并广播生效），经加密 WebSocket `FlowReport` 批量合并写库（享受 20:1 DO 入站消息折算）。
- **零限流 GitHub Release 检测**：`/api/v1/node/upgrade-info` 优先通过 `HEAD/GET /releases/latest` 的 302 `Location` 与 `releases.atom` 获取最新版本号并缓存 10 分钟，彻底避开 Workers 共享出口 IP 的 `api.github.com` 403 限流。

## 一、部署到 Cloudflare

```bash
# 1. 构建前端产物到 vite-frontend/dist
cd vite-frontend
npm install --legacy-peer-deps
npm run build

# 2. 安装依赖并登录 Cloudflare
cd ../cf-panel
npm install
npx wrangler login

# 3. 设置 JWT 密钥（可选；若不设置则首次启动自动随机生成并存入 DO SQLite）
npx wrangler secret put JWT_SECRET

# 4. 部署 Worker + Static Assets + Durable Object + Cron
npm run deploy
```

部署完成后在 Cloudflare Dashboard → Workers → `forwardz-panel` → Settings → Domains & Routes 绑定你的自定义域名（强烈建议绑定独立子域，避免国内访问 `workers.dev` 不稳定）。

### 环境变量说明（`wrangler.jsonc` / Secrets）

| 名称 | 类型 | 默认值 / 说明 |
|---|---|---|
| `PANEL_VERSION` | vars | 面板显示版本（如 `1.06-cf`） |
| `TZ_OFFSET_MINUTES` | vars | 时区偏移分钟数（默认 `480`，即东八区 UTC+8） |
| `RELEASE_REPO` | vars | 节点更新与安装脚本仓库（默认 `qqlikegi/forwardz`） |
| `JWT_SECRET` | secret | 可选，JWT 签名密钥；未设时持久化保存在 `system_setting.jwt_secret` |
| `MIGRATION_TOKEN` | secret | 临时迁移/恢复令牌；仅导入数据库时设置，用完**务必删除** |

## 二、导入 / 恢复数据库（支持 VPS 迁移与 R2 备份恢复）

`scripts/migrate_sqlite.py` 自动识别 **`.sql.gz` / `.sql` / `.db.gz` / `.db`** 四种格式（无论是从 R2 下载的 CF/VPS `.sql.gz` 云备份，还是 VPS 本地的 `forwardz.db` 均可直接导入）：

```bash
# 1. 临时开启迁移令牌（至少 8 位随机字符串）
cd cf-panel
npx wrangler secret put MIGRATION_TOKEN

# 2. 运行导入脚本（自动分块写入、校准自增序列、逐表校验行数）
python scripts/migrate_sqlite.py \
  --db "/path/to/forwardz-panel-backup-20261126-030000.sql.gz" \
  --url "https://你的CF面板域名" \
  --token "<刚才设置的MIGRATION_TOKEN>" \
  --panel-addr "https://你的CF面板域名"

# 3. 校验通过后立即删除迁移令牌，关闭导入入口
npx wrangler secret delete MIGRATION_TOKEN
```

## 三、R2 自动备份与恢复回 VPS

- 在面板「系统配置 → 云存储备份」填入 R2 的 S3 终结点、Bucket、Access Key、Secret Key，开启自动备份后由 DO `alarm()` 按设定时间每日上传 `forwardz-panel-backup-YYYYMMDD-HHMMSS.sql.gz` 并按保留份数循环清理旧文件。
- 需要把 CF 面板的数据切回传统 VPS 面板时，直接下载 R2 中最新的 `.sql.gz`，在 VPS 上执行：
  ```bash
  systemctl stop forwardz-panel
  (set -a; . /opt/forwardz-panel/forwardz-panel.env; set +a; /opt/forwardz-panel/forwardz-panel -restore /root/forwardz-panel-backup-xxx.sql.gz)
  systemctl start forwardz-panel
  ```

## 四、本地开发与验证

```bash
cd cf-panel
npm run typecheck   # TypeScript 静态类型检查
npm test            # Vitest + @cloudflare/vitest-pool-workers 端到端测试
npm run dev         # 本地 wrangler dev 调试
```
