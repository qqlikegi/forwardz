package main

// 与 CF 面板完全对齐的节点扩展接口：
// 1. 节点流量上报策略（双触发 + 噪点过滤），保存后实时广播给所有在线节点
// 2. 节点端远程一键更新（零限流 GitHub Release 探测 + 加密 WS 下发 UpgradeAgent + 进度追踪）

import (
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------- 节点流量上报策略 ----------

const (
	flowPolicyIntervalKey  = "flow_report_interval_min"
	flowPolicyThresholdKey = "flow_report_threshold_mb"
	flowPolicyMinKBKey     = "flow_report_min_kb"

	defaultFlowIntervalMin = 10
	defaultFlowThresholdMB = 1024
	defaultFlowMinKB       = 64
)

type FlowReportPolicy struct {
	IntervalMin        int   `json:"intervalMin"`
	ThresholdMB        int   `json:"thresholdMb"`
	MinKB              int   `json:"minKb"`
	FlowIntervalSec    int   `json:"flowIntervalSec"`
	FlowThresholdBytes int64 `json:"flowThresholdBytes"`
	FlowMinBytes       int64 `json:"flowMinBytes"`
}

func parseIntSetting(raw string, fallback, minV, maxV int) int {
	t := strings.TrimSpace(raw)
	if t == "" {
		return fallback
	}
	n, err := strconv.Atoi(t)
	if err != nil {
		return fallback
	}
	if n < minV {
		return minV
	}
	if n > maxV {
		return maxV
	}
	return n
}

func loadFlowReportPolicy() FlowReportPolicy {
	intervalMin := parseIntSetting(getSetting(flowPolicyIntervalKey), defaultFlowIntervalMin, 1, 60)
	thresholdMB := parseIntSetting(getSetting(flowPolicyThresholdKey), defaultFlowThresholdMB, 0, 102400)
	minKB := parseIntSetting(getSetting(flowPolicyMinKBKey), defaultFlowMinKB, 0, 10240)
	return FlowReportPolicy{
		IntervalMin:        intervalMin,
		ThresholdMB:        thresholdMB,
		MinKB:              minKB,
		FlowIntervalSec:    intervalMin * 60,
		FlowThresholdBytes: int64(thresholdMB) * 1024 * 1024,
		FlowMinBytes:       int64(minKB) * 1024,
	}
}

func nodeFlowPolicyGet(c *Ctx) any {
	p := loadFlowReportPolicy()
	return ok(map[string]any{
		"intervalMin":        p.IntervalMin,
		"thresholdMb":        p.ThresholdMB,
		"minKb":              p.MinKB,
		"flowIntervalSec":    p.FlowIntervalSec,
		"flowThresholdBytes": p.FlowThresholdBytes,
		"flowMinBytes":       p.FlowMinBytes,
		"onlineNodes":        hub.onlineNodeCount(),
	})
}

func nodeFlowPolicySave(c *Ctx) any {
	var d struct {
		IntervalMin Num `json:"intervalMin"`
		ThresholdMB Num `json:"thresholdMb"`
		MinKB       Num `json:"minKb"`
	}
	c.bind(&d)
	if !d.IntervalMin.Valid || d.IntervalMin.Int() < 1 || d.IntervalMin.Int() > 60 {
		return fail("上报间隔必须为 1–60 之间的整数（分钟）")
	}
	if !d.ThresholdMB.Valid || d.ThresholdMB.Int() < 0 || d.ThresholdMB.Int() > 102400 {
		return fail("流量快报阈值必须为 0–102400 之间的整数（MB，0 表示关闭）")
	}
	if !d.MinKB.Valid || d.MinKB.Int() < 0 || d.MinKB.Int() > 10240 {
		return fail("噪点过滤阈值必须为 0–10240 之间的整数（KB，0 表示不过滤）")
	}

	setSetting(flowPolicyIntervalKey, strconv.FormatInt(d.IntervalMin.Int(), 10))
	setSetting(flowPolicyThresholdKey, strconv.FormatInt(d.ThresholdMB.Int(), 10))
	setSetting(flowPolicyMinKBKey, strconv.FormatInt(d.MinKB.Int(), 10))

	p := loadFlowReportPolicy()
	pushed := hub.pushFlowPolicyToOnlineNodes(p)
	return ok(map[string]any{
		"intervalMin":        p.IntervalMin,
		"thresholdMb":        p.ThresholdMB,
		"minKb":              p.MinKB,
		"flowIntervalSec":    p.FlowIntervalSec,
		"flowThresholdBytes": p.FlowThresholdBytes,
		"flowMinBytes":       p.FlowMinBytes,
		"pushedNodes":        pushed,
	})
}

// ---------- 节点端远程一键更新 ----------

type NodeUpgradeState struct {
	Status      string `json:"status"`
	Message     string `json:"message"`
	FromVersion string `json:"fromVersion,omitempty"`
	ToVersion   string `json:"toVersion,omitempty"`
	UpdatedAt   int64  `json:"updatedAt"`
}

type LatestReleaseInfo struct {
	LatestVersion string
	ReleaseURL    string
	PublishedAt   string
}

var (
	verMajorMinorRe = regexp.MustCompile(`^(\d+)\.(\d+)`)
	releaseTagRe    = regexp.MustCompile(`(?i)/releases/tag/([^/?#]+)`)

	releaseCacheMu   sync.Mutex
	releaseCacheVal  *LatestReleaseInfo
	releaseCacheTime time.Time
)

const releaseCacheTTL = 10 * time.Minute

func normalizeVersion(v string) string {
	s := strings.TrimSpace(v)
	if len(s) > 0 && (s[0] == 'v' || s[0] == 'V') {
		s = s[1:]
	}
	return s
}

func supportsRemoteUpgrade(v string) bool {
	clean := normalizeVersion(v)
	m := verMajorMinorRe.FindStringSubmatch(clean)
	if len(m) < 3 {
		return false
	}
	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	return major > 1 || (major == 1 && minor >= 4)
}

func isActiveUpgradeStatus(s string) bool {
	switch s {
	case "started", "downloading", "verifying", "restarting":
		return true
	default:
		return false
	}
}

func sanitizeUpgradeStatus(s string) string {
	switch s {
	case "started", "downloading", "verifying", "restarting", "success", "up_to_date", "failed":
		return s
	default:
		return "downloading"
	}
}

func extractTagFromReleaseURL(rawURL string) string {
	m := releaseTagRe.FindStringSubmatch(rawURL)
	if len(m) < 2 {
		return ""
	}
	if dec, err := url.PathUnescape(m[1]); err == nil {
		return dec
	}
	return m[1]
}

func parseReleaseAtom(xmlData []byte, repo string) *LatestReleaseInfo {
	var feed struct {
		Entries []struct {
			ID      string `xml:"id"`
			Title   string `xml:"title"`
			Updated string `xml:"updated"`
			Links   []struct {
				Href string `xml:"href,attr"`
			} `xml:"link"`
		} `xml:"entry"`
	}
	if err := xml.Unmarshal(xmlData, &feed); err != nil || len(feed.Entries) == 0 {
		return nil
	}
	e := feed.Entries[0]
	href := ""
	for _, l := range e.Links {
		if l.Href != "" {
			href = l.Href
			break
		}
	}
	rawTag := extractTagFromReleaseURL(href)
	if rawTag == "" && e.ID != "" {
		parts := strings.Split(e.ID, "/")
		rawTag = strings.TrimSpace(parts[len(parts)-1])
	}
	if rawTag == "" {
		rawTag = strings.TrimSpace(e.Title)
	}
	ver := normalizeVersion(rawTag)
	if ver == "" {
		return nil
	}
	relURL := href
	if !strings.HasPrefix(relURL, "http") {
		relURL = "https://github.com/" + repo + "/releases/tag/" + url.PathEscape(rawTag)
	}
	return &LatestReleaseInfo{
		LatestVersion: ver,
		ReleaseURL:    relURL,
		PublishedAt:   strings.TrimSpace(e.Updated),
	}
}

// fetchLatestReleaseInfo 与 CF 面板一致的三级零限流探测：
// 1) HEAD/GET /releases/latest 读取 302 Location；2) releases.atom XML；3) api.github.com 兜底
func fetchLatestReleaseInfo(repo string, forceRefresh bool) (LatestReleaseInfo, string) {
	releaseCacheMu.Lock()
	if !forceRefresh && releaseCacheVal != nil && time.Since(releaseCacheTime) < releaseCacheTTL {
		cached := *releaseCacheVal
		releaseCacheMu.Unlock()
		return cached, ""
	}
	var prevCached *LatestReleaseInfo
	if releaseCacheVal != nil {
		cp := *releaseCacheVal
		prevCached = &cp
	}
	releaseCacheMu.Unlock()

	latestPageURL := "https://github.com/" + repo + "/releases/latest"
	noRedirectClient := &http.Client{
		Timeout: 8 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	normalClient := &http.Client{Timeout: 8 * time.Second}
	lastErr := ""

	// 1. 主路径：HEAD / GET 读取 302 Location（无 API 限流）
	for _, method := range []string{http.MethodHead, http.MethodGet} {
		req, err := http.NewRequest(method, latestPageURL, nil)
		if err != nil {
			lastErr = err.Error()
			continue
		}
		req.Header.Set("User-Agent", "ForwardZ-Panel")
		resp, err := noRedirectClient.Do(req)
		if err != nil {
			lastErr = err.Error()
			continue
		}
		loc := resp.Header.Get("Location")
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		if tag := extractTagFromReleaseURL(loc); tag != "" {
			relURL := loc
			if !strings.HasPrefix(relURL, "http") {
				relURL = "https://github.com" + loc
			}
			info := LatestReleaseInfo{
				LatestVersion: normalizeVersion(tag),
				ReleaseURL:    relURL,
			}
			releaseCacheMu.Lock()
			releaseCacheVal = &info
			releaseCacheTime = time.Now()
			releaseCacheMu.Unlock()
			return info, ""
		}
		lastErr = fmt.Sprintf("GitHub 跳转响应异常 (HTTP %d)", resp.StatusCode)
	}

	// 2. 次选路径：releases.atom（无 REST API 限流）
	if req, err := http.NewRequest(http.MethodGet, "https://github.com/"+repo+"/releases.atom", nil); err == nil {
		req.Header.Set("User-Agent", "ForwardZ-Panel")
		req.Header.Set("Accept", "application/atom+xml, application/xml, text/xml")
		if resp, err := normalClient.Do(req); err == nil {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				if parsed := parseReleaseAtom(body, repo); parsed != nil {
					releaseCacheMu.Lock()
					releaseCacheVal = parsed
					releaseCacheTime = time.Now()
					releaseCacheMu.Unlock()
					return *parsed, ""
				}
				lastErr = "GitHub releases.atom 未解析到版本"
			} else {
				lastErr = fmt.Sprintf("GitHub Atom HTTP %d", resp.StatusCode)
			}
		} else {
			lastErr = err.Error()
		}
	}

	// 3. 兜底路径：GitHub REST API
	if req, err := http.NewRequest(http.MethodGet, "https://api.github.com/repos/"+repo+"/releases/latest", nil); err == nil {
		req.Header.Set("User-Agent", "ForwardZ-Panel")
		req.Header.Set("Accept", "application/vnd.github+json")
		if resp, err := normalClient.Do(req); err == nil {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				var data struct {
					TagName     string `json:"tag_name"`
					HTMLURL     string `json:"html_url"`
					PublishedAt string `json:"published_at"`
				}
				if json.Unmarshal(body, &data) == nil && data.TagName != "" {
					relURL := data.HTMLURL
					if relURL == "" {
						relURL = latestPageURL
					}
					info := LatestReleaseInfo{
						LatestVersion: normalizeVersion(data.TagName),
						ReleaseURL:    relURL,
						PublishedAt:   data.PublishedAt,
					}
					releaseCacheMu.Lock()
					releaseCacheVal = &info
					releaseCacheTime = time.Now()
					releaseCacheMu.Unlock()
					return info, ""
				}
			} else if lastErr == "" {
				lastErr = fmt.Sprintf("GitHub API HTTP %d", resp.StatusCode)
			}
		} else if lastErr == "" {
			lastErr = err.Error()
		}
	}

	if prevCached != nil {
		return *prevCached, lastErr
	}
	return LatestReleaseInfo{ReleaseURL: latestPageURL}, lastErr
}

func nodeUpgradeInfo(c *Ctx) any {
	var d struct {
		Refresh bool `json:"refresh"`
	}
	if len(strings.TrimSpace(string(c.Body))) > 0 {
		_ = json.Unmarshal(c.Body, &d)
	}
	rel, fetchErr := fetchLatestReleaseInfo(releaseRepo, d.Refresh)
	list, err := queryList(scanNode, "SELECT "+nodeCols+" FROM node ORDER BY status DESC, id ASC")
	must(err)

	nodes := make([]map[string]any, 0, len(list))
	for _, n := range list {
		online := hub.isNodeOnline(n.ID)
		rawVer := ""
		if n.Version != nil {
			rawVer = *n.Version
		}
		curVer := normalizeVersion(rawVer)
		verOut := curVer
		if verOut == "" {
			verOut = rawVer
		}
		statusNum := 0
		if online {
			statusNum = 1
		}
		needsUpgrade := rel.LatestVersion != "" && curVer != "" && curVer != rel.LatestVersion
		nodes = append(nodes, map[string]any{
			"id":                    n.ID,
			"name":                  n.Name,
			"status":                statusNum,
			"version":               verOut,
			"supportsRemoteUpgrade": supportsRemoteUpgrade(curVer),
			"needsUpgrade":          needsUpgrade,
			"upgradeState":          hub.getUpgradeState(n.ID),
		})
	}
	return ok(map[string]any{
		"repo":          releaseRepo,
		"latestVersion": rel.LatestVersion,
		"releaseUrl":    rel.ReleaseURL,
		"publishedAt":   rel.PublishedAt,
		"fetchError":    fetchErr,
		"nodes":         nodes,
	})
}

func nodeUpgradeAll(c *Ctx) any {
	var d struct {
		Force         bool    `json:"force"`
		NodeIDs       []int64 `json:"nodeIds"`
		TargetVersion Str     `json:"targetVersion"`
	}
	if len(strings.TrimSpace(string(c.Body))) > 0 {
		c.bind(&d)
	}

	targetVersion := normalizeVersion(d.TargetVersion.V)
	if targetVersion == "" {
		rel, _ := fetchLatestReleaseInfo(releaseRepo, false)
		targetVersion = rel.LatestVersion
	}

	allNodes, err := queryList(scanNode, "SELECT "+nodeCols+" FROM node ORDER BY id ASC")
	must(err)

	idSet := map[int64]bool{}
	for _, id := range d.NodeIDs {
		if id > 0 {
			idSet[id] = true
		}
	}
	var targets []*Node
	for _, n := range allNodes {
		if len(d.NodeIDs) > 0 {
			if idSet[n.ID] {
				targets = append(targets, n)
			}
		} else if hub.isNodeOnline(n.ID) {
			targets = append(targets, n)
		}
	}
	if len(targets) == 0 {
		return fail("当前没有可更新的在线节点")
	}

	results := make([]map[string]any, len(targets))
	var wg sync.WaitGroup
	for idx, node := range targets {
		wg.Add(1)
		go func(i int, n *Node) {
			defer wg.Done()
			rawVer := ""
			if n.Version != nil {
				rawVer = *n.Version
			}
			curVer := normalizeVersion(rawVer)
			mkResult := func(st *NodeUpgradeState, save bool) map[string]any {
				if save {
					hub.setUpgradeState(n.ID, st)
				}
				return map[string]any{
					"nodeId":      n.ID,
					"name":        n.Name,
					"status":      st.Status,
					"fromVersion": st.FromVersion,
					"toVersion":   st.ToVersion,
					"message":     st.Message,
					"updatedAt":   st.UpdatedAt,
				}
			}

			if !hub.isNodeOnline(n.ID) {
				results[i] = mkResult(&NodeUpgradeState{
					Status:      "offline",
					FromVersion: curVer,
					ToVersion:   targetVersion,
					Message:     "节点离线",
					UpdatedAt:   nowMs(),
				}, false)
				return
			}
			if !supportsRemoteUpgrade(curVer) {
				verLabel := curVer
				if verLabel == "" {
					verLabel = "未知"
				}
				results[i] = mkResult(&NodeUpgradeState{
					Status:      "unsupported",
					FromVersion: curVer,
					ToVersion:   targetVersion,
					Message:     fmt.Sprintf("当前版本 %s 不支持远程一键更新，请先在节点 SSH 执行一次 zf 升级至 1.04+", verLabel),
					UpdatedAt:   nowMs(),
				}, true)
				return
			}
			if !d.Force && targetVersion != "" && curVer == targetVersion {
				results[i] = mkResult(&NodeUpgradeState{
					Status:      "up_to_date",
					FromVersion: curVer,
					ToVersion:   targetVersion,
					Message:     "已是最新版本 " + targetVersion,
					UpdatedAt:   nowMs(),
				}, true)
				return
			}

			r := sendMsg(n.ID, map[string]any{
				"repo":          releaseRepo,
				"targetVersion": targetVersion,
				"force":         d.Force,
			}, "UpgradeAgent")
			if !r.ok() {
				msg := r.Msg
				if msg == "" {
					msg = "下发升级指令失败"
				}
				results[i] = mkResult(&NodeUpgradeState{
					Status:      "failed",
					FromVersion: curVer,
					ToVersion:   targetVersion,
					Message:     msg,
					UpdatedAt:   nowMs(),
				}, true)
				return
			}
			if r.Data != nil {
				if remoteStatus, _ := r.Data["status"].(string); remoteStatus == "up_to_date" {
					toVer, _ := r.Data["toVersion"].(string)
					if toVer == "" {
						toVer = curVer
					}
					results[i] = mkResult(&NodeUpgradeState{
						Status:      "up_to_date",
						FromVersion: curVer,
						ToVersion:   toVer,
						Message:     "已是最新版本 " + toVer,
						UpdatedAt:   nowMs(),
					}, true)
					return
				}
			}
			results[i] = mkResult(&NodeUpgradeState{
				Status:      "started",
				FromVersion: curVer,
				ToVersion:   targetVersion,
				Message:     "已下发升级指令，等待节点下载并重启...",
				UpdatedAt:   nowMs(),
			}, true)
		}(idx, node)
	}
	wg.Wait()

	return ok(map[string]any{
		"targetVersion": targetVersion,
		"results":       results,
	})
}
