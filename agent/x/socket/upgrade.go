package socket

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/qqlikegi/forwardz/agent/x/service"
)

const defaultReleaseRepo = "qqlikegi/forwardz"

var (
	validRepoRe = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
	upgradeMu   sync.Mutex
	upgrading   bool
)

// UpgradeAgentRequest 面板下发的远程升级节点端指令参数
type UpgradeAgentRequest struct {
	Repo          string `json:"repo,omitempty"`
	TargetVersion string `json:"targetVersion,omitempty"`
	Force         bool   `json:"force,omitempty"`
}

// handleUpgradeAgent 校验参数后启动后台异步升级并立即向面板确认，避免阻塞 WS 接收循环或触发超时
func (w *WebSocketReporter) handleUpgradeAgent(data interface{}) (map[string]interface{}, error) {
	var req UpgradeAgentRequest
	if data != nil {
		b, err := json.Marshal(data)
		if err != nil {
			return nil, fmt.Errorf("序列化升级参数失败: %v", err)
		}
		if err := json.Unmarshal(b, &req); err != nil {
			return nil, fmt.Errorf("解析升级参数失败: %v", err)
		}
	}

	repo := strings.TrimSpace(req.Repo)
	if repo == "" {
		repo = defaultReleaseRepo
	}
	if !validRepoRe.MatchString(repo) || strings.Contains(repo, "..") {
		return nil, fmt.Errorf("非法仓库格式: %s", repo)
	}

	arch := runtime.GOARCH
	if arch != "amd64" && arch != "arm64" {
		return nil, fmt.Errorf("不支持自动更新的架构: %s", arch)
	}

	curVer := strings.TrimPrefix(strings.TrimSpace(w.version), "v")
	targetVer := strings.TrimPrefix(strings.TrimSpace(req.TargetVersion), "v")
	if !req.Force && targetVer != "" && targetVer == curVer {
		return map[string]interface{}{
			"status":      "up_to_date",
			"fromVersion": curVer,
			"toVersion":   curVer,
		}, nil
	}

	upgradeMu.Lock()
	if upgrading {
		upgradeMu.Unlock()
		return nil, fmt.Errorf("已有升级任务正在进行中，请稍候")
	}
	upgrading = true
	upgradeMu.Unlock()

	go w.runSelfUpgrade(repo, arch, curVer, targetVer, req.Force)

	return map[string]interface{}{
		"status":      "started",
		"fromVersion": curVer,
		"toVersion":   targetVer,
	}, nil
}

func (w *WebSocketReporter) runSelfUpgrade(repo, arch, curVer, targetVer string, force bool) {
	defer func() {
		upgradeMu.Lock()
		upgrading = false
		upgradeMu.Unlock()
	}()

	exePath, err := os.Executable()
	if err != nil {
		w.sendUpgradeStatus("failed", curVer, targetVer, fmt.Sprintf("定位程序路径失败: %v", err))
		return
	}
	if resolved, evalErr := filepath.EvalSymlinks(exePath); evalErr == nil && resolved != "" {
		exePath = resolved
	}

	directURL := fmt.Sprintf("https://github.com/%s/releases/latest/download/forwardz-agent-%s", repo, arch)
	mirrorURL := "https://ghfast.top/" + directURL
	urls := []string{directURL, mirrorURL}
	if isChinaNetwork() {
		urls = []string{mirrorURL, directURL}
	}

	w.sendUpgradeStatus("downloading", curVer, targetVer, fmt.Sprintf("正在下载 forwardz-agent-%s...", arch))

	tmpPath := exePath + ".new"
	var dlErr error
	for _, u := range urls {
		if err := downloadBinaryToFile(u, tmpPath); err == nil {
			dlErr = nil
			break
		} else {
			dlErr = err
			fmt.Printf("⚠️ 从 %s 下载失败: %v\n", u, err)
		}
	}
	if dlErr != nil {
		_ = os.Remove(tmpPath)
		w.sendUpgradeStatus("failed", curVer, targetVer, fmt.Sprintf("下载新版本失败: %v", dlErr))
		return
	}

	w.sendUpgradeStatus("verifying", curVer, targetVer, "正在校验新版本程序完整性...")
	if err := os.Chmod(tmpPath, 0755); err != nil {
		_ = os.Remove(tmpPath)
		w.sendUpgradeStatus("failed", curVer, targetVer, fmt.Sprintf("设置执行权限失败: %v", err))
		return
	}

	newVer, err := verifyAgentBinary(tmpPath)
	if err != nil {
		_ = os.Remove(tmpPath)
		w.sendUpgradeStatus("failed", curVer, targetVer, fmt.Sprintf("新版本校验失败（已保留原程序）: %v", err))
		return
	}

	if !force && newVer != "" && newVer == curVer {
		_ = os.Remove(tmpPath)
		w.sendUpgradeStatus("up_to_date", curVer, newVer, fmt.Sprintf("当前已是最新版本 %s", newVer))
		return
	}

	// 备份当前二进制（尽力而为，不阻断原子替换）
	bakPath := exePath + ".bak"
	if err := copyFileSimple(exePath, bakPath); err != nil {
		fmt.Printf("⚠️ 备份旧版本失败（继续升级）: %v\n", err)
	}

	// POSIX 原子替换，避免覆盖运行中文件触发 ETXTBSY
	if err := os.Rename(tmpPath, exePath); err != nil {
		_ = os.Remove(tmpPath)
		w.sendUpgradeStatus("failed", curVer, newVer, fmt.Sprintf("替换程序文件失败: %v", err))
		return
	}

	w.sendUpgradeStatus("restarting", curVer, newVer, fmt.Sprintf("已更新至 %s，正在重启节点...", newVer))
	fmt.Printf("🔄 节点端自更新完成 (%s -> %s)，正在刷盘流量并重启...\n", curVer, newVer)

	// 退出前刷盘一次未上报流量，防止丢失统计
	service.GetGlobalTrafficManager().FlushNow()
	time.Sleep(800 * time.Millisecond)

	// systemd 服务配置为 Restart=on-failure，非零退出后 systemd 会立即用新二进制拉起进程
	os.Exit(1)
}

func isChinaNetwork() bool {
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("https://ipinfo.io/country")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 32))
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(b)) == "CN"
}

func downloadBinaryToFile(downloadURL, dstPath string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "ForwardZ-Agent-Updater/1.0")

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	f, err := os.OpenFile(dstPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		return err
	}
	n, copyErr := io.Copy(f, resp.Body)
	closeErr := f.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	// 正常 Go 二进制超过 10MB，低于 1MB 视为异常响应页
	if n < 1024*1024 {
		return fmt.Errorf("下载文件体积异常 (%d bytes)", n)
	}
	return nil
}

func verifyAgentBinary(binPath string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, binPath, "-V").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("试运行失败: %v", err)
	}
	text := strings.TrimSpace(string(out))
	fields := strings.Fields(text)
	if len(fields) < 2 || fields[0] != "forwardz" {
		return "", fmt.Errorf("版本输出格式异常: %s", text)
	}
	return strings.TrimPrefix(fields[1], "v"), nil
}

func copyFileSimple(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}
