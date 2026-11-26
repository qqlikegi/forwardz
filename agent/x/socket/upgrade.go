package socket

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
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

type downloadCandidate struct {
	label string
	url   string
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

	w.sendUpgradeStatus("downloading", curVer, targetVer, "正在选择下载线路...")

	directURL := fmt.Sprintf("https://github.com/%s/releases/latest/download/forwardz-agent-%s", repo, arch)
	var candidates []downloadCandidate
	if isChinaMainland() {
		candidates = []downloadCandidate{
			{label: "ghfast.top", url: "https://ghfast.top/" + directURL},
			{label: "gh-proxy.com", url: "https://gh-proxy.com/" + directURL},
			{label: "ghproxy.net", url: "https://ghproxy.net/" + directURL},
			{label: "GitHub", url: directURL},
		}
	} else {
		candidates = []downloadCandidate{
			{label: "GitHub", url: directURL},
			{label: "ghfast.top", url: "https://ghfast.top/" + directURL},
			{label: "gh-proxy.com", url: "https://gh-proxy.com/" + directURL},
		}
	}

	tmpPath := exePath + ".new"
	var dlErr error
	for idx, cand := range candidates {
		w.sendUpgradeStatus("downloading", curVer, targetVer, fmt.Sprintf("正在下载 Agent (%s)...", cand.label))
		fmt.Printf("⬇️ [%d/%d] 尝试通过 %s 下载: %s\n", idx+1, len(candidates), cand.label, cand.url)

		err := downloadBinaryWithProgress(cand.url, tmpPath, func(downloaded, total int64, speedBps float64) {
			speedStr := formatDownloadSpeed(speedBps)
			if total > 0 {
				pct := int(float64(downloaded) * 100 / float64(total))
				if pct > 100 {
					pct = 100
				}
				w.sendUpgradeStatus(
					"downloading",
					curVer,
					targetVer,
					fmt.Sprintf("下载 Agent %d%% · %s (%s)", pct, speedStr, cand.label),
				)
			} else {
				mb := float64(downloaded) / (1024 * 1024)
				w.sendUpgradeStatus(
					"downloading",
					curVer,
					targetVer,
					fmt.Sprintf("下载 Agent %.1f MB · %s (%s)", mb, speedStr, cand.label),
				)
			}
		})
		if err == nil {
			dlErr = nil
			break
		}
		dlErr = err
		fmt.Printf("⚠️ 通过 %s 下载失败: %v\n", cand.label, err)
		if idx+1 < len(candidates) {
			w.sendUpgradeStatus(
				"downloading",
				curVer,
				targetVer,
				fmt.Sprintf("切换线路 %s...", candidates[idx+1].label),
			)
		}
	}
	if dlErr != nil {
		_ = os.Remove(tmpPath)
		w.sendUpgradeStatus("failed", curVer, targetVer, fmt.Sprintf("下载失败: %v", dlErr))
		return
	}

	w.sendUpgradeStatus("verifying", curVer, targetVer, "正在校验 Agent...")
	if err := os.Chmod(tmpPath, 0755); err != nil {
		_ = os.Remove(tmpPath)
		w.sendUpgradeStatus("failed", curVer, targetVer, fmt.Sprintf("设置权限失败: %v", err))
		return
	}

	newVer, err := verifyAgentBinary(tmpPath)
	if err != nil {
		_ = os.Remove(tmpPath)
		w.sendUpgradeStatus("failed", curVer, targetVer, fmt.Sprintf("校验失败（已保留原版）: %v", err))
		return
	}

	if !force && newVer != "" && newVer == curVer {
		_ = os.Remove(tmpPath)
		w.sendUpgradeStatus("up_to_date", curVer, newVer, fmt.Sprintf("已是最新 %s", newVer))
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
		w.sendUpgradeStatus("failed", curVer, newVer, fmt.Sprintf("替换文件失败: %v", err))
		return
	}

	w.sendUpgradeStatus("restarting", curVer, newVer, fmt.Sprintf("已更新至 %s，重启中...", newVer))
	fmt.Printf("🔄 节点端自更新完成 (%s -> %s)，正在刷盘流量并重启...\n", curVer, newVer)

	// 退出前刷盘一次未上报流量，防止丢失统计
	service.GetGlobalTrafficManager().FlushNow()
	time.Sleep(800 * time.Millisecond)

	// systemd 服务配置为 Restart=on-failure，非零退出后 systemd 会立即用新二进制拉起进程
	os.Exit(1)
}

func formatDownloadSpeed(bps float64) string {
	if bps >= 1024*1024 {
		return fmt.Sprintf("%.1f MB/s", bps/(1024*1024))
	}
	return fmt.Sprintf("%.0f KB/s", bps/1024)
}

// isChinaMainland 并行探测国内源 myip.ipip.net 与海外源 ipinfo.io：
// 谁先返回明确地区就采用谁；若 4 秒内均超时/失败，默认按受限网络优先使用加速镜像，避免国内机误走 GitHub 直连卡死。
func isChinaMainland() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()

	resCh := make(chan bool, 2)
	var wg sync.WaitGroup
	client := &http.Client{
		Transport: &http.Transport{
			DialContext:           (&net.Dialer{Timeout: 3 * time.Second}).DialContext,
			TLSHandshakeTimeout:   3 * time.Second,
			ResponseHeaderTimeout: 3 * time.Second,
		},
	}

	// 探测 1：国内可毫秒级直连的 ipip.net
	wg.Add(1)
	go func() {
		defer wg.Done()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://myip.ipip.net", nil)
		if err != nil {
			return
		}
		req.Header.Set("User-Agent", "curl/8.0")
		resp, err := client.Do(req)
		if err != nil {
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, 256))
		if err != nil {
			return
		}
		text := strings.TrimSpace(string(b))
		if !strings.Contains(text, "来自于") && !strings.Contains(text, "IP") {
			return
		}
		isCN := strings.Contains(text, "中国") &&
			!strings.Contains(text, "香港") &&
			!strings.Contains(text, "澳门") &&
			!strings.Contains(text, "台湾")
		select {
		case resCh <- isCN:
		default:
		}
	}()

	// 探测 2：海外可毫秒级直连的 ipinfo.io
	wg.Add(1)
	go func() {
		defer wg.Done()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://ipinfo.io/country", nil)
		if err != nil {
			return
		}
		req.Header.Set("User-Agent", "curl/8.0")
		resp, err := client.Do(req)
		if err != nil {
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, 32))
		if err != nil {
			return
		}
		code := strings.TrimSpace(string(b))
		if len(code) != 2 {
			return
		}
		select {
		case resCh <- strings.EqualFold(code, "CN"):
		default:
		}
	}()

	doneCh := make(chan struct{})
	go func() {
		wg.Wait()
		close(doneCh)
	}()

	select {
	case isCN := <-resCh:
		cancel()
		return isCN
	case <-doneCh:
		select {
		case isCN := <-resCh:
			return isCN
		default:
			// 两路均不可达时默认优先走加速镜像（海外节点总能连通 ipinfo.io）
			return true
		}
	case <-ctx.Done():
		return true
	}
}

// downloadBinaryWithProgress 下载二进制文件，内置连接/响应头快速超时、卡顿检测（12s 无数据）与龟速切换（8s 后均速 <80KB/s）
func downloadBinaryWithProgress(
	downloadURL, dstPath string,
	onProgress func(downloaded, total int64, speedBps float64),
) error {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	tr := &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 15 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 12 * time.Second,
		Proxy:                 http.ProxyFromEnvironment,
	}
	defer tr.CloseIdleConnections()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "ForwardZ-Agent-Updater/1.0")

	client := &http.Client{Transport: tr}
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

	var downloaded atomic.Int64
	var lastReadNano atomic.Int64
	start := time.Now()
	lastReadNano.Store(start.UnixNano())

	var watchMu sync.Mutex
	watchReason := ""
	stopWatch := make(chan struct{})
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stopWatch:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				now := time.Now()
				idle := now.Sub(time.Unix(0, lastReadNano.Load()))
				if idle > 12*time.Second {
					watchMu.Lock()
					watchReason = "连接卡顿超时"
					watchMu.Unlock()
					cancel()
					return
				}
				elapsed := now.Sub(start).Seconds()
				if elapsed >= 8 {
					avgSpeed := float64(downloaded.Load()) / elapsed
					if avgSpeed < 80*1024 {
						watchMu.Lock()
						watchReason = fmt.Sprintf("速度过慢 (%.0f KB/s)", avgSpeed/1024)
						watchMu.Unlock()
						cancel()
						return
					}
				}
			}
		}
	}()

	buf := make([]byte, 32*1024)
	lastReport := start
	var readErr error
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				readErr = werr
				break
			}
			cur := downloaded.Add(int64(n))
			now := time.Now()
			lastReadNano.Store(now.UnixNano())
			if onProgress != nil && now.Sub(lastReport) >= 1500*time.Millisecond {
				elapsed := now.Sub(start).Seconds()
				if elapsed > 0 {
					onProgress(cur, resp.ContentLength, float64(cur)/elapsed)
				}
				lastReport = now
			}
		}
		if rerr != nil {
			if rerr != io.EOF {
				readErr = rerr
			}
			break
		}
	}

	close(stopWatch)
	closeErr := f.Close()
	if readErr != nil {
		watchMu.Lock()
		reason := watchReason
		watchMu.Unlock()
		if reason != "" {
			return fmt.Errorf("%s", reason)
		}
		return readErr
	}
	if closeErr != nil {
		return closeErr
	}
	totalDownloaded := downloaded.Load()
	// 正常 Go 二进制超过 10MB，低于 1MB 视为异常响应页
	if totalDownloaded < 1024*1024 {
		return fmt.Errorf("下载文件体积异常 (%d bytes)", totalDownloaded)
	}
	if resp.ContentLength > 0 && totalDownloaded != resp.ContentLength {
		return fmt.Errorf("下载不完整 (%d/%d bytes)", totalDownloaded, resp.ContentLength)
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
