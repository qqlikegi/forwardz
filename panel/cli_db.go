package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ---------- 命令行：备份 / 导出 / 恢复数据库（供 zf 菜单和云备份调用，兼容 CF 面板 .sql.gz 备份） ----------

// backupDBTo 用 VACUUM INTO 生成一份完整、一致的数据库文件，可直接替换面板数据库文件恢复
func backupDBTo(dst string) error {
	dst, err := filepath.Abs(dst)
	if err != nil {
		return err
	}
	if _, err := os.Stat(dst); err == nil {
		return fmt.Errorf("目标文件已存在: %s", dst)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if _, err := db.Exec("VACUUM INTO ?", dst); err != nil {
		os.Remove(dst)
		return err
	}
	return nil
}

// exportSQLTo 导出为纯文本 SQL（建表语句 + INSERT），与 CF 面板导出的 SQL 格式 100% 互通
func exportSQLTo(dst string) (err error) {
	dst, err = filepath.Abs(dst)
	if err != nil {
		return err
	}
	if _, err := os.Stat(dst); err == nil {
		return fmt.Errorf("目标文件已存在: %s", dst)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer func() {
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			os.Remove(dst)
		}
	}()
	return exportSQLToWriter(f)
}

// exportSQLToWriter 将当前数据库在一个一致的只读事务里写入 SQL 文本（供 -export 与 R2 .sql.gz 云备份共用）
func exportSQLToWriter(out io.Writer) error {
	w := bufio.NewWriterSize(out, 1<<20)

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	type object struct{ typ, name, sql string }
	rows, err := tx.Query(`SELECT type, name, sql FROM sqlite_master
		WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
		ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`)
	if err != nil {
		return err
	}
	var objs []object
	for rows.Next() {
		var o object
		if err := rows.Scan(&o.typ, &o.name, &o.sql); err != nil {
			rows.Close()
			return err
		}
		objs = append(objs, o)
	}
	rows.Close()

	fmt.Fprintf(w, "-- ForwardZ 面板 %s 数据库导出 %s\n", version, time.Now().Format("2006-01-02 15:04:05"))
	fmt.Fprintln(w, "PRAGMA foreign_keys=OFF;")
	fmt.Fprintln(w, "BEGIN TRANSACTION;")
	for _, o := range objs {
		if o.typ != "table" {
			continue
		}
		fmt.Fprintf(w, "%s;\n", o.sql)
		if err := dumpTable(tx, w, o.name); err != nil {
			return fmt.Errorf("导出表 %s 失败: %w", o.name, err)
		}
	}
	for _, o := range objs {
		if o.typ != "table" {
			fmt.Fprintf(w, "%s;\n", o.sql)
		}
	}
	fmt.Fprintln(w, "COMMIT;")
	return w.Flush()
}

// restoreDBFrom 从任意受支持的备份文件（.sql.gz / .sql / .db.gz / .db）恢复至 targetDBPath：
// - 自动识别 gzip 压缩与 SQLite 二进制 / SQL 文本格式（原生兼容 Cloudflare Workers 面板的 R2 .sql.gz 备份）
// - 先导入到临时文件并做 integrity_check、补齐表结构与重置节点离线状态，验证通过后再原子替换目标文件
// - 若目标数据库已存在，会自动保留 .pre-restore-*.bak 防止误操作
func restoreDBFrom(srcPath, targetDBPath string) (backupPath string, err error) {
	srcPath, err = filepath.Abs(srcPath)
	if err != nil {
		return "", err
	}
	targetDBPath, err = filepath.Abs(targetDBPath)
	if err != nil {
		return "", err
	}

	raw, err := readBackupPayload(srcPath)
	if err != nil {
		return "", err
	}
	if len(raw) == 0 {
		return "", fmt.Errorf("备份文件为空: %s", srcPath)
	}

	if err := os.MkdirAll(filepath.Dir(targetDBPath), 0o755); err != nil {
		return "", err
	}
	tmpDB := filepath.Join(filepath.Dir(targetDBPath), fmt.Sprintf(".restore-%d.db", time.Now().UnixNano()))
	cleanupTmp := func() {
		_ = os.Remove(tmpDB)
		_ = os.Remove(tmpDB + "-wal")
		_ = os.Remove(tmpDB + "-shm")
	}
	defer func() {
		if err != nil {
			cleanupTmp()
		}
	}()

	isSQLiteBin := len(raw) >= 16 && bytes.Equal(raw[:16], []byte("SQLite format 3\x00"))
	if isSQLiteBin {
		if err = os.WriteFile(tmpDB, raw, 0o600); err != nil {
			return "", fmt.Errorf("写入临时数据库失败: %w", err)
		}
	}

	imp, err := sql.Open("sqlite", "file:"+filepath.ToSlash(tmpDB)+"?_pragma=busy_timeout(5000)")
	if err != nil {
		return "", fmt.Errorf("打开临时数据库失败: %w", err)
	}
	if !isSQLiteBin {
		if _, err = imp.Exec(string(raw)); err != nil {
			_ = imp.Close()
			return "", fmt.Errorf("执行 SQL 备份失败: %w", err)
		}
	}
	// 补齐可能缺失的新表（兼容旧版备份）
	for _, stmt := range splitSQL(schemaSQL) {
		if _, err = imp.Exec(stmt); err != nil {
			_ = imp.Close()
			return "", fmt.Errorf("校验表结构失败: %w", err)
		}
	}
	var integrity string
	if err = imp.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		_ = imp.Close()
		return "", fmt.Errorf("数据库完整性校验失败: %s (%v)", integrity, err)
	}
	// 跨环境恢复后统一先置所有节点为离线，等待节点连入面板后自动上线
	if _, err = imp.Exec("UPDATE node SET status = 0"); err != nil {
		_ = imp.Close()
		return "", fmt.Errorf("重置节点状态失败: %w", err)
	}
	_, _ = imp.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
	if err = imp.Close(); err != nil {
		return "", err
	}
	_ = os.Remove(tmpDB + "-wal")
	_ = os.Remove(tmpDB + "-shm")

	if _, statErr := os.Stat(targetDBPath); statErr == nil {
		backupPath = fmt.Sprintf("%s.pre-restore-%s.bak", targetDBPath, time.Now().Format("20060102-150405"))
		if err = os.Rename(targetDBPath, backupPath); err != nil {
			return "", fmt.Errorf("备份原数据库失败（请确认面板已停止运行）: %w", err)
		}
	}
	_ = os.Remove(targetDBPath + "-wal")
	_ = os.Remove(targetDBPath + "-shm")

	if err = os.Rename(tmpDB, targetDBPath); err != nil {
		if backupPath != "" {
			_ = os.Rename(backupPath, targetDBPath)
		}
		return "", fmt.Errorf("替换数据库文件失败: %w", err)
	}
	return backupPath, nil
}

func readBackupPayload(srcPath string) ([]byte, error) {
	f, err := os.Open(srcPath)
	if err != nil {
		return nil, fmt.Errorf("无法打开备份文件: %w", err)
	}
	defer f.Close()

	const maxBackupBytes = 256 << 20
	raw, err := io.ReadAll(io.LimitReader(f, maxBackupBytes+1))
	if err != nil {
		return nil, fmt.Errorf("读取备份文件失败: %w", err)
	}
	if len(raw) > maxBackupBytes {
		return nil, fmt.Errorf("备份文件超过 256MB 限制")
	}
	if len(raw) >= 2 && raw[0] == 0x1f && raw[1] == 0x8b {
		zr, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, fmt.Errorf("解压 gzip 备份失败: %w", err)
		}
		defer zr.Close()
		out, err := io.ReadAll(io.LimitReader(zr, maxBackupBytes+1))
		if err != nil {
			return nil, fmt.Errorf("解压 gzip 备份失败: %w", err)
		}
		if len(out) > maxBackupBytes {
			return nil, fmt.Errorf("解压后的备份超过 256MB 限制")
		}
		return out, nil
	}
	return raw, nil
}

func quoteIdent(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }

func dumpTable(tx *sql.Tx, w *bufio.Writer, table string) error {
	rows, err := tx.Query("SELECT * FROM " + quoteIdent(table))
	if err != nil {
		return err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return err
	}
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	prefix := "INSERT INTO " + quoteIdent(table) + " VALUES("
	for rows.Next() {
		if err := rows.Scan(ptrs...); err != nil {
			return err
		}
		w.WriteString(prefix)
		for i, v := range vals {
			if i > 0 {
				w.WriteByte(',')
			}
			w.WriteString(sqlLiteral(v))
		}
		w.WriteString(");\n")
	}
	return rows.Err()
}

func sqlLiteral(v any) string {
	switch x := v.(type) {
	case nil:
		return "NULL"
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		return strconv.FormatFloat(x, 'g', -1, 64)
	case bool:
		if x {
			return "1"
		}
		return "0"
	case []byte:
		return "X'" + hex.EncodeToString(x) + "'"
	case string:
		return "'" + strings.ReplaceAll(x, "'", "''") + "'"
	case time.Time:
		return "'" + x.Format("2006-01-02 15:04:05") + "'"
	default:
		return "'" + strings.ReplaceAll(fmt.Sprint(x), "'", "''") + "'"
	}
}
