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

func TestTunnelLatencySummary(t *testing.T) {
	dir := t.TempDir()
	if err := openDB(filepath.Join(dir, "lat.db")); err != nil {
		t.Fatal(err)
	}
	defer closeDB()

	saveLatencyRow(7, 24.4, 0, true)
	saveLatencyRow(7, 65.6, 10, true)
	saveLatencyRow(7, -1, 100, false)
	saveLatencyRow(8, 12.0, 0, true)

	m := buildLatencyHistoryMap(24, nil, 7)
	s := m["7"]
	if s == nil || s.SampleCount != 3 || s.MinLatency == nil || s.AvgLatency == nil || s.MaxLatency == nil || s.PacketLoss == nil {
		t.Fatalf("汇总结果不完整: %+v", s)
	}
	if *s.MinLatency != 24.4 || *s.AvgLatency != 45.0 || *s.MaxLatency != 65.6 {
		t.Fatalf("延迟统计异常: min=%v avg=%v max=%v", *s.MinLatency, *s.AvgLatency, *s.MaxLatency)
	}
	if *s.PacketLoss != 36.7 {
		t.Fatalf("丢包率统计异常: got %v want 36.7", *s.PacketLoss)
	}

	// 验证普通用户只能看到自己被分配隧道的 24h 延迟历史
	mustExec(`INSERT INTO user_tunnel (user_id, tunnel_id, speed_id, num, flow, in_flow, out_flow, flow_reset_time, exp_time, status)
		VALUES (2, 7, NULL, 5, 10, 0, 0, 1, 2727251700000, 1)`)
	u2TunMap := buildLatencyHistoryMap(24, &Claims{UserID: 2, RoleID: 1}, 0)
	if len(u2TunMap) != 1 || u2TunMap["7"] == nil || u2TunMap["8"] != nil {
		t.Fatalf("普通用户隧道延迟隔离失败: %+v", u2TunMap)
	}

	// 验证转发 24h 落地延迟汇总及普通用户归属隔离
	mustExec(`INSERT INTO forward (id, user_id, user_name, name, tunnel_id, remote_addr, strategy, in_flow, out_flow, created_time, updated_time, status, inx)
		VALUES (10, 2, 'u2', 'f10', 7, '1.1.1.1:443', 'fifo', 0, 0, 1, 1, 1, 0),
		       (11, 3, 'u3', 'f11', 7, '8.8.8.8:443', 'fifo', 0, 0, 1, 1, 1, 0)`)
	saveForwardLatencyRow(10, 18.2, 0, true)
	saveForwardLatencyRow(10, 41.8, 0, true)
	saveForwardLatencyRow(11, 90.0, 50, true)

	u2Map := buildForwardLatencyHistoryMap(24, &Claims{UserID: 2, RoleID: 1}, 0)
	if len(u2Map) != 1 || u2Map["10"] == nil || u2Map["11"] != nil {
		t.Fatalf("普通用户转发延迟隔离失败: %+v", u2Map)
	}
	if *u2Map["10"].MinLatency != 18.2 || *u2Map["10"].AvgLatency != 30.0 || *u2Map["10"].MaxLatency != 41.8 {
		t.Fatalf("转发延迟统计异常: %+v", u2Map["10"])
	}
	adminMap := buildForwardLatencyHistoryMap(24, &Claims{UserID: 1, RoleID: 0}, 0)
	if len(adminMap) != 2 {
		t.Fatalf("管理员应能看到全部转发延迟，实际 %d", len(adminMap))
	}
}
