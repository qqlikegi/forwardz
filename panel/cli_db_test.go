package main

import (
	"compress/gzip"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func TestBackupAndExportRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if err := openDB(filepath.Join(dir, "forwardz.db")); err != nil {
		t.Fatal(err)
	}
	defer closeDB()
	mustExec("INSERT INTO system_setting (name, value) VALUES (?, ?)", "k'1", "中文 \"值\"\n换行")
	mustExec("INSERT INTO user_flow_daily (user_id, day, flow) VALUES (1, '2026-11-09', 123456789012)")
	mustExec(`INSERT INTO node (name, secret, server_ip, port, created_time, status) VALUES ('n1', 'sec1', '1.1.1.1', '1000-2000', 1700000000000, 1)`)

	bak := filepath.Join(dir, "out", "b.db")
	if err := backupDBTo(bak); err != nil {
		t.Fatal(err)
	}
	if err := backupDBTo(bak); err == nil {
		t.Fatal("已存在的文件不应被覆盖")
	}
	dump := filepath.Join(dir, "out", "d.sql")
	if err := exportSQLTo(dump); err != nil {
		t.Fatal(err)
	}

	// 验证云备份 snapshotDB 输出的 .sql.gz 可通过 restoreDBFrom 直接还原（与 CF 面板备份互通）
	sqlGzBytes, err := snapshotDB()
	if err != nil {
		t.Fatalf("snapshotDB 失败: %v", err)
	}
	sqlGzPath := filepath.Join(dir, "out", "cf-compat.sql.gz")
	if err := os.WriteFile(sqlGzPath, sqlGzBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	restoredFromSQL := filepath.Join(dir, "restored-sql.db")
	if _, err := restoreDBFrom(sqlGzPath, restoredFromSQL); err != nil {
		t.Fatalf("restoreDBFrom(.sql.gz) 失败: %v", err)
	}

	// 验证 .db.gz 也能通过 restoreDBFrom 还原
	rawBak, err := os.ReadFile(bak)
	if err != nil {
		t.Fatal(err)
	}
	dbGzPath := filepath.Join(dir, "out", "legacy.db.gz")
	gf, err := os.Create(dbGzPath)
	if err != nil {
		t.Fatal(err)
	}
	zw := gzip.NewWriter(gf)
	_, _ = zw.Write(rawBak)
	_ = zw.Close()
	_ = gf.Close()
	restoredFromDB := filepath.Join(dir, "restored-db.db")
	if _, err := restoreDBFrom(dbGzPath, restoredFromDB); err != nil {
		t.Fatalf("restoreDBFrom(.db.gz) 失败: %v", err)
	}

	script, _ := os.ReadFile(dump)
	imp, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(dir, "imported.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer imp.Close()
	if _, err := imp.Exec(string(script)); err != nil {
		t.Fatalf("导入 SQL 失败: %v", err)
	}
	for _, p := range []string{bak, filepath.Join(dir, "imported.db"), restoredFromSQL, restoredFromDB} {
		c, err := sql.Open("sqlite", "file:"+filepath.ToSlash(p))
		if err != nil {
			t.Fatal(err)
		}
		var v string
		var flow int64
		if err := c.QueryRow("SELECT value FROM system_setting WHERE name = ?", "k'1").Scan(&v); err != nil || v != "中文 \"值\"\n换行" {
			t.Fatalf("%s: 设置值不一致 %q %v", p, v, err)
		}
		if err := c.QueryRow("SELECT flow FROM user_flow_daily WHERE user_id = 1").Scan(&flow); err != nil || flow != 123456789012 {
			t.Fatalf("%s: 流量不一致 %d %v", p, flow, err)
		}
		var users int
		_ = c.QueryRow("SELECT COUNT(*) FROM user").Scan(&users)
		if users == 0 {
			t.Fatalf("%s: 缺少用户表数据", p)
		}
		if p == restoredFromSQL || p == restoredFromDB {
			var nodeStatus int
			if err := c.QueryRow("SELECT status FROM node WHERE name = 'n1'").Scan(&nodeStatus); err != nil || nodeStatus != 0 {
				t.Fatalf("%s: 恢复后节点应重置为离线(0)，实际 %d (%v)", p, nodeStatus, err)
			}
		}
		c.Close()
	}
}

func TestCFProtocolHelpers(t *testing.T) {
	if got := processServerAddress("https://panel.example.com/"); got != "https://panel.example.com" {
		t.Fatalf("HTTPS 地址被破坏: %s", got)
	}
	if got := processServerAddress("2001:db8::1:6365"); got != "[2001:db8::1]:6365" {
		t.Fatalf("IPv6 地址未正确加括号: %s", got)
	}
	if !supportsRemoteUpgrade("v1.04") || !supportsRemoteUpgrade("1.05") || supportsRemoteUpgrade("1.03") {
		t.Fatalf("supportsRemoteUpgrade 判定异常")
	}
	atom := []byte(`<?xml version="1.0" encoding="UTF-8"?><feed><entry><id>tag:github.com,2008:Repository/1/v1.04</id><updated>2026-11-26T00:23:24Z</updated><link rel="alternate" href="https://github.com/qqlikegi/forwardz/releases/tag/v1.04"/><title>v1.04</title></entry></feed>`)
	info := parseReleaseAtom(atom, "qqlikegi/forwardz")
	if info == nil || info.LatestVersion != "1.04" || info.PublishedAt != "2026-11-26T00:23:24Z" {
		t.Fatalf("parseReleaseAtom 解析失败: %+v", info)
	}
}
