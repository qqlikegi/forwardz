#!/usr/bin/env python3
"""
将 ForwardZ 备份文件无损导入/恢复至 Cloudflare Workers 面板（支持双向互迁）。

支持输入格式（自动识别）：
  - .sql.gz / .sql ：Cloudflare Workers 或 VPS 面板的 R2 云备份 / SQL 导出文件
  - .db.gz  / .db  ：VPS 面板的 SQLite 二进制数据库文件

用法:
  python cf-panel/scripts/migrate_sqlite.py \\
      --db /path/to/forwardz-panel-backup-xxx.sql.gz \\
      --url https://your-panel.workers.dev \\
      --token <你的 MIGRATION_TOKEN> \\
      [--panel-addr https://your-panel.workers.dev] \\
      [--batch-size 100]

仅使用 Python 3 标准库（gzip / sqlite3 / tempfile / urllib / json），Windows / Linux / macOS 均可直接运行。
"""

import argparse
import gzip
import json
import os
import sqlite3
import sys
import tempfile
import urllib.error
import urllib.request

TABLES = [
    "user",
    "node",
    "tunnel",
    "chain_tunnel",
    "forward",
    "forward_port",
    "speed_limit",
    "user_tunnel",
    "vite_config",
    "statistics_flow",
    "user_flow_daily",
    "system_setting",
    "tunnel_latency",
    "forward_latency",
    "latency_bucket",
]


def api_call(base_url: str, path: str, token: str, payload: dict | None = None) -> dict:
    url = base_url.rstrip("/") + path
    data = json.dumps(payload if payload is not None else {}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Migration-Token": token,
            "User-Agent": "ForwardZ-Migrator/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            result = json.loads(raw)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} 调用 {path} 失败: {body}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"连接 {url} 失败: {e}") from e

    if result.get("code") != 0:
        raise RuntimeError(f"接口 {path} 返回错误: {result}")
    return result


def read_sqlite(db_path: str) -> tuple[dict[str, list[dict]], dict[str, int]]:
    with open(db_path, "rb") as f:
        raw = f.read()

    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)

    tmp_file: str | None = None
    try:
        if raw[:16] == b"SQLite format 3\x00":
            # 直接读取 .db，若是 .db.gz 则解压到临时文件再以只读方式打开
            if db_path.lower().endswith(".gz"):
                fd, tmp_file = tempfile.mkstemp(suffix=".db")
                with os.fdopen(fd, "wb") as tf:
                    tf.write(raw)
                conn = sqlite3.connect(f"file:{tmp_file}?mode=ro", uri=True)
            else:
                conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        else:
            # .sql / .sql.gz 文本快照：在内存 SQLite 中还原后按标准 12 表读取
            conn = sqlite3.connect(":memory:")
            conn.executescript(raw.decode("utf-8"))

        conn.row_factory = sqlite3.Row
        cur = conn.cursor()

        existing_tables = {
            r[0]
            for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }

        data: dict[str, list[dict]] = {}
        for table in TABLES:
            if table not in existing_tables:
                data[table] = []
                continue
            rows = [dict(r) for r in cur.execute(f'SELECT * FROM "{table}"').fetchall()]
            data[table] = rows

        sequences: dict[str, int] = {}
        if "sqlite_sequence" in existing_tables:
            for r in cur.execute("SELECT name, seq FROM sqlite_sequence").fetchall():
                sequences[str(r[0])] = int(r[1])

        conn.close()
        return data, sequences
    finally:
        if tmp_file and os.path.exists(tmp_file):
            os.remove(tmp_file)


def main() -> int:
    parser = argparse.ArgumentParser(description="将 ForwardZ 备份（.sql.gz/.sql/.db.gz/.db）导入到 Cloudflare Workers 面板")
    parser.add_argument("--db", required=True, help="备份文件路径（支持 .sql.gz / .sql / .db.gz / .db）")
    parser.add_argument("--url", required=True, help="新 Cloudflare 面板地址（例如 https://panel.example.com）")
    parser.add_argument("--token", required=True, help="在 Workers 中临时设置的 MIGRATION_TOKEN")
    parser.add_argument("--panel-addr", default="", help="可选：迁移后自动写入系统配置的面板地址（不填则保留旧库配置）")
    parser.add_argument("--batch-size", type=int, default=100, help="每批导入行数（默认 100，最大 200）")
    parser.add_argument("--dry-run", action="store_true", help="仅检查本地 SQLite 内容，不上传")
    args = parser.parse_args()

    batch_size = max(1, min(200, args.batch_size))

    print(f"[1/5] 读取本地 SQLite 数据库: {args.db}")
    data, sequences = read_sqlite(args.db)
    for t in TABLES:
        print(f"      - {t:<18}: {len(data[t])} 行")

    if args.dry_run:
        print("[dry-run] 仅检查本地数据，未上传。")
        return 0

    print(f"\n[2/5] 检查目标 CF 面板连通性: {args.url}")
    api_call(args.url, "/api/v1/migrate/status", args.token)

    print("[3/5] 清空目标面板初始种子数据...")
    api_call(args.url, "/api/v1/migrate/reset", args.token)

    print(f"[4/5] 分块导入数据（每批 {batch_size} 行）...")
    for table in TABLES:
        rows = data[table]
        if not rows:
            continue
        total_inserted = 0
        for i in range(0, len(rows), batch_size):
            chunk = rows[i : i + batch_size]
            res = api_call(
                args.url,
                "/api/v1/migrate/batch",
                args.token,
                {"table": table, "rows": chunk},
            )
            total_inserted += int(res["data"]["inserted"])
        print(f"      ✓ {table:<18}: 导入 {total_inserted}/{len(rows)} 行")

    print("[5/5] 校准自增序列并验证最终行数...")
    final_res = api_call(
        args.url,
        "/api/v1/migrate/finalize",
        args.token,
        {"sequences": sequences, "panelAddr": args.panel_addr.strip()},
    )
    remote_counts = final_res["data"]["counts"]
    fingerprint = final_res["data"].get("fingerprint", "")

    mismatch = False
    print("\n=== 迁移校验报告 ===")
    for t in TABLES:
        src = len(data[t])
        dst = int(remote_counts.get(t, -1))
        ok_mark = "OK" if src == dst or (t == "system_setting" and dst >= src) or (t == "vite_config" and dst >= src) else "DIFF!"
        if ok_mark != "OK":
            mismatch = True
        print(f"  {t:<18} 本地={src:<6} CF={dst:<6} [{ok_mark}]")
    print(f"  面板指纹: {fingerprint}")

    if mismatch:
        print("\n⚠️ 部分表行数不一致，请核查日志！", file=sys.stderr)
        return 2

    print("\n✅ 迁移完成且校验通过！")
    print("👉 安全提醒：请立刻执行 `npx wrangler secret delete MIGRATION_TOKEN` 关闭迁移入口。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
