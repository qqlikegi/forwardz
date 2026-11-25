# ForwardZ Cloudflare Workers 面板 (`cf-panel`)

基于 **Cloudflare Workers（Static Assets）+ 单实例 SQLite Durable Object** 重构的 ForwardZ 全功能面板，专为 **Cloudflare Free 免费版** 与中小规模节点（≤ 10 个节点）深度优化。

## 架构特点

- **0 面板 VPS**：前端静态页面由 Workers Static Assets 免费托管（不消耗 Worker 请求配额）；所有 43 个 API、WebSocket Hub、12 张 SQLite 表、Cron 定时统计/重置、S3/R2 定时备份全部运行在单实例 SQLite Durable Object 中。
- **Free 免费版配额保底**：
  - 空闲时 Agent 发送明文 `"ping"`，由 DO `setWebSocketAutoResponse` 平台层自动回 `"pong"`（**0 DO 唤醒、0 请求、0 时长费**）。
  - 仅在管理员打开「节点管理」页时自动通知节点切换 **2 秒实时监控推送**，关闭页面自动回落节能模式。
  - Agent 流量上报改为每 **60 秒** 优先复用加密 WebSocket 通道（享受 20:1 DO 入站消息折算计费），并在 DO 内按用户/隧道聚合批量写库。
- **私人站点免验证码**：`/api/v1/captcha/check` 固定返回 `0`，避免旧库遗留开关导致锁死。

## 一、部署到 Cloudflare

```bash
cd cf-panel
npm install

# 1. 登录 Cloudflare（首次需要）
npx wrangler login

# 2. 构建前端（如改动过 vite-frontend）
cd ../vite-frontend
npm install --legacy-peer-deps
npm run build
cd ../cf-panel

# 3. 设置 JWT 密钥（可选；若不设也会自动生成并持久化在 DO SQLite 中）
npx wrangler secret put JWT_SECRET

# 4. 部署
npm run deploy
```

> 部署完成后会得到 `https://forwardz-panel.<你的子域>.workers.dev`，建议在 Cloudflare Dashboard → Workers → Settings → Domains & Routes 绑定你自己的自定义域名。

## 二、从旧 VPS 的 SQLite 数据库迁移

```bash
# 1. 在 Worker 上临时设置一个一次性迁移令牌
cd cf-panel
npx wrangler secret put MIGRATION_TOKEN
# （输入一串随机长字符串，例如用密码生成器生成 32 位）

# 2. 执行分块迁移脚本（会自动校验 12 张表的行数）
python scripts/migrate_sqlite.py \
  --db "C:\path\to\forwardz.db" \
  --url "https://你的CF面板域名" \
  --token "刚才设置的MIGRATION_TOKEN" \
  --panel-addr "https://你的CF面板域名"

# 3. 迁移验证通过后，立刻删除迁移令牌关闭入口
npx wrangler secret delete MIGRATION_TOKEN
```

## 三、升级节点端 Agent（VPS 上）

本次同时升级了 `agent/` 以支持：
- `https://` / `wss://` 自动识别（同时兼容旧版 `IP:端口`）
- 零计费 `ping`/`pong` 保活 + 按需 2 秒实时监控
- 每 60 秒经加密 WebSocket 上报流量（断线自动回退 HTTP）

将仓库代码推送到 GitHub 后，现有 `.github/workflows/release.yml` 会自动编出 `forwardz-agent-amd64` / `forwardz-agent-arm64`（或在任意 Linux 机器上在 `agent/` 目录执行 `CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o forwardz_agent .`）。

在每个节点 VPS 上替换新版二进制后，修改 `/etc/forwardz_agent/config.json` 中的 `addr` 为新的 CF 面板地址（例如 `"https://panel.example.com"`），保持原 `secret` 与 `fingerprint` 不变，重启 `systemctl restart forwardz_agent` 即可无缝接管已有转发。

## 本地开发与测试

```bash
cd cf-panel
npm run typecheck
npm test
npm run dev
```
