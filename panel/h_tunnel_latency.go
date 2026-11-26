package main

// 隧道与转发 24h 延迟与丢包监控（5 分钟分桶聚合存储，与 CF 面板 100% 对齐）：
// 支持 10s / 20s / 30s / 1m / 3m / 10m / 30m / 60m 自动探测（或 0 关闭）及卡片手动测速。

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
)

const (
	latencyRetentionMs            int64 = 25 * 3600 * 1000
	latencyBucketMs               int64 = 5 * 60 * 1000
	defaultLatencyProbeInterval         = 60 // 默认 1 分钟（60 秒）
	minLatencyProbeInterval             = 10
	maxLatencyProbeInterval             = 3600
	latencyProbeIntervalSecKey          = "latency_probe_interval_sec"
	latencyProbeIntervalLegacyKey       = "latency_probe_interval_min"
	latencyProbeLastKey                 = "latency_probe_last_ms"
)

type tunnelLatencyPoint struct {
	T    int64   `json:"t"`
	Ms   float64 `json:"ms"`
	Loss float64 `json:"loss"`
	OK   bool    `json:"ok"`
}

type tunnelLatencySummary struct {
	TunnelID      int64                `json:"tunnelId"`
	MinLatency    *float64             `json:"minLatency"`
	AvgLatency    *float64             `json:"avgLatency"`
	MaxLatency    *float64             `json:"maxLatency"`
	LatestLatency *float64             `json:"latestLatency"`
	PacketLoss    *float64             `json:"packetLoss"`
	SampleCount   int                  `json:"sampleCount"`
	Points        []tunnelLatencyPoint `json:"points"`
}

type forwardLatencySummary struct {
	ForwardID     int64                `json:"forwardId"`
	MinLatency    *float64             `json:"minLatency"`
	AvgLatency    *float64             `json:"avgLatency"`
	MaxLatency    *float64             `json:"maxLatency"`
	LatestLatency *float64             `json:"latestLatency"`
	PacketLoss    *float64             `json:"packetLoss"`
	SampleCount   int                  `json:"sampleCount"`
	Points        []tunnelLatencyPoint `json:"points"`
}

type latencySampleInput struct {
	Key  string
	Ms   float64
	Loss float64
	OK   bool
	T    int64
}

type bucketEntry struct {
	N   int          `json:"n"`
	OK  int          `json:"ok"`
	Sum float64      `json:"sum"`
	Min float64      `json:"min"`
	Max float64      `json:"max"`
	Ls  float64      `json:"ls"`
	Lt  int64        `json:"lt"`
	Lm  float64      `json:"lm"`
	Ll  float64      `json:"ll"`
	Lo  int          `json:"lo"`
	Pts [][3]float64 `json:"pts,omitempty"`
}

var (
	latencyBucketMu    sync.Mutex
	latencyScheduleMu  sync.Mutex
	lastLatencyProbeMs int64
)

func round1(v float64) float64 {
	return math.Round(v*10) / 10
}

func clampLoss(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 100
	}
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

func loadLatencyProbeIntervalSec() int {
	rawSec := strings.TrimSpace(getSetting(latencyProbeIntervalSecKey))
	if rawSec != "" {
		n, err := strconv.Atoi(rawSec)
		if err != nil {
			return defaultLatencyProbeInterval
		}
		if n <= 0 {
			return 0
		}
		if n < minLatencyProbeInterval {
			return minLatencyProbeInterval
		}
		if n > maxLatencyProbeInterval {
			return maxLatencyProbeInterval
		}
		return n
	}
	// 兼容旧版按分钟保存的配置
	rawMin := strings.TrimSpace(getSetting(latencyProbeIntervalLegacyKey))
	if rawMin != "" {
		m, err := strconv.Atoi(rawMin)
		if err == nil {
			if m <= 0 {
				return 0
			}
			s := m * 60
			if s < minLatencyProbeInterval {
				return minLatencyProbeInterval
			}
			if s > maxLatencyProbeInterval {
				return maxLatencyProbeInterval
			}
			return s
		}
	}
	return defaultLatencyProbeInterval
}

func latencyPolicyGet(_ *Ctx) any {
	intervalSec := loadLatencyProbeIntervalSec()
	lastMs, _ := strconv.ParseInt(strings.TrimSpace(getSetting(latencyProbeLastKey)), 10, 64)
	latencyScheduleMu.Lock()
	if lastLatencyProbeMs > lastMs {
		lastMs = lastLatencyProbeMs
	}
	latencyScheduleMu.Unlock()
	intervalMin := 0
	if intervalSec > 0 {
		intervalMin = int(math.Round(float64(intervalSec) / 60.0))
		if intervalMin < 1 {
			intervalMin = 1
		}
	}
	return ok(map[string]any{
		"intervalSec":        intervalSec,
		"defaultIntervalSec": defaultLatencyProbeInterval,
		"intervalMin":        intervalMin,
		"lastProbeTime":      lastMs,
	})
}

func latencyPolicySave(c *Ctx) any {
	var d struct {
		IntervalSec Num `json:"intervalSec"`
		IntervalMin Num `json:"intervalMin"`
	}
	c.bind(&d)
	var sec int
	switch {
	case d.IntervalSec.Valid:
		sec = int(d.IntervalSec.Int())
	case d.IntervalMin.Valid:
		sec = int(d.IntervalMin.Int()) * 60
	default:
		return fail("请填写有效的探测间隔")
	}
	if sec != 0 && (sec < minLatencyProbeInterval || sec > maxLatencyProbeInterval) {
		return fail("探测间隔需为 0（关闭自动探测）或 10 秒–60 分钟")
	}
	setSetting(latencyProbeIntervalSecKey, strconv.Itoa(sec))
	lastMs, _ := strconv.ParseInt(strings.TrimSpace(getSetting(latencyProbeLastKey)), 10, 64)
	intervalMin := 0
	if sec > 0 {
		intervalMin = int(math.Round(float64(sec) / 60.0))
		if intervalMin < 1 {
			intervalMin = 1
		}
	}
	return ok(map[string]any{
		"intervalSec":        sec,
		"defaultIntervalSec": defaultLatencyProbeInterval,
		"intervalMin":        intervalMin,
		"lastProbeTime":      lastMs,
	})
}

func parseBucketMap(raw string) map[string]*bucketEntry {
	m := map[string]*bucketEntry{}
	if strings.TrimSpace(raw) == "" {
		return m
	}
	_ = json.Unmarshal([]byte(raw), &m)
	return m
}

func mergeSample(m map[string]*bucketEntry, s latencySampleInput, fallbackNow int64) {
	t := s.T
	if t <= 0 {
		t = fallbackNow
	}
	okFlag := s.OK && !math.IsNaN(s.Ms) && !math.IsInf(s.Ms, 0) && s.Ms >= 0
	ms := -1.0
	loss := 100.0
	lo := 0
	if okFlag {
		ms = round1(s.Ms)
		loss = round1(clampLoss(s.Loss))
		lo = 1
	}

	e := m[s.Key]
	if e == nil {
		e = &bucketEntry{Min: -1, Max: -1, Lt: t, Lm: ms, Ll: loss, Lo: lo}
		m[s.Key] = e
	}
	e.N++
	e.Ls = round1(e.Ls + loss)
	if okFlag {
		e.OK++
		e.Sum = round1(e.Sum + ms)
		if e.Min < 0 || ms < e.Min {
			e.Min = ms
		}
		if e.Max < 0 || ms > e.Max {
			e.Max = ms
		}
	}
	if t >= e.Lt {
		e.Lt = t
		e.Lm = ms
		e.Ll = loss
		e.Lo = lo
	}
	e.Pts = append(e.Pts, [3]float64{float64(t), ms, loss})
	if len(e.Pts) > 36 {
		e.Pts = e.Pts[len(e.Pts)-36:]
	}
}

func recordLatencySamples(samples []latencySampleInput, now int64) {
	if len(samples) == 0 {
		return
	}
	if now <= 0 {
		now = nowMs()
	}
	bucketMs := (now / latencyBucketMs) * latencyBucketMs

	latencyBucketMu.Lock()
	defer latencyBucketMu.Unlock()

	var raw string
	err := db.QueryRow("SELECT data FROM latency_bucket WHERE bucket_ms = ?", bucketMs).Scan(&raw)
	isNew := err != nil
	m := parseBucketMap(raw)
	for _, s := range samples {
		mergeSample(m, s, now)
	}
	encoded, _ := json.Marshal(m)
	mustExec(`INSERT INTO latency_bucket (bucket_ms, data) VALUES (?, ?)
		ON CONFLICT(bucket_ms) DO UPDATE SET data = excluded.data`, bucketMs, string(encoded))

	if isNew {
		mustExec("DELETE FROM latency_bucket WHERE bucket_ms < ?", now-latencyRetentionMs)
		stripBefore := bucketMs - latencyBucketMs*2
		rows, qerr := db.Query(`SELECT bucket_ms, data FROM latency_bucket WHERE bucket_ms <= ? AND data LIKE '%"pts":%'`, stripBefore)
		if qerr == nil {
			type pending struct {
				bMs  int64
				data string
			}
			var updates []pending
			for rows.Next() {
				var bMs int64
				var d string
				if rows.Scan(&bMs, &d) != nil {
					continue
				}
				bm := parseBucketMap(d)
				changed := false
				for _, entry := range bm {
					if len(entry.Pts) > 0 {
						entry.Pts = nil
						changed = true
					}
				}
				if changed {
					b, _ := json.Marshal(bm)
					updates = append(updates, pending{bMs: bMs, data: string(b)})
				}
			}
			rows.Close()
			for _, u := range updates {
				mustExec("UPDATE latency_bucket SET data = ? WHERE bucket_ms = ?", u.data, u.bMs)
			}
		}
	}
}

func purgeLatencyKey(key string) {
	latencyBucketMu.Lock()
	defer latencyBucketMu.Unlock()
	rows, err := db.Query("SELECT bucket_ms, data FROM latency_bucket WHERE data LIKE ?", `%"`+key+`"%`)
	if err != nil {
		return
	}
	type pending struct {
		bMs  int64
		data string
	}
	var updates []pending
	for rows.Next() {
		var bMs int64
		var d string
		if rows.Scan(&bMs, &d) != nil {
			continue
		}
		bm := parseBucketMap(d)
		if _, exists := bm[key]; exists {
			delete(bm, key)
			b, _ := json.Marshal(bm)
			updates = append(updates, pending{bMs: bMs, data: string(b)})
		}
	}
	rows.Close()
	for _, u := range updates {
		mustExec("UPDATE latency_bucket SET data = ? WHERE bucket_ms = ?", u.data, u.bMs)
	}
}

func saveLatencyRow(tunnelID int64, latency, packetLoss float64, success bool) {
	recordLatencySamples([]latencySampleInput{{
		Key: fmt.Sprintf("t:%d", tunnelID), Ms: latency, Loss: packetLoss, OK: success,
	}}, nowMs())
}

func saveForwardLatencyRow(forwardID int64, latency, packetLoss float64, success bool) {
	recordLatencySamples([]latencySampleInput{{
		Key: fmt.Sprintf("f:%d", forwardID), Ms: latency, Loss: packetLoss, OK: success,
	}}, nowMs())
}

func parseFirstRemoteTarget(remoteAddr string) (string, int64, bool) {
	parts := strings.Split(remoteAddr, ",")
	if len(parts) == 0 {
		return "", 0, false
	}
	host, port := splitHostPort(parts[0])
	if host == "" || port <= 0 || port > 65535 {
		return "", 0, false
	}
	return host, port, true
}

func recordDiagnoseLatencySample(tunnel *Tunnel, results []*diagResult) {
	var links []*diagResult
	for _, r := range results {
		if tunnel.Type == 2 {
			if r.ToChainType != nil {
				links = append(links, r)
			}
		} else {
			links = append(links, r)
		}
	}
	if len(links) == 0 {
		return
	}
	if tunnel.Type == 2 {
		stages := map[string][]*diagResult{}
		var order []string
		for _, r := range links {
			ft, fi := int64(0), int64(0)
			if r.FromChainType != nil {
				ft = *r.FromChainType
			}
			if r.FromInx != nil {
				fi = *r.FromInx
			}
			k := fmt.Sprintf("%d:%d", ft, fi)
			if _, exists := stages[k]; !exists {
				order = append(order, k)
			}
			stages[k] = append(stages[k], r)
		}
		totalMs := 0.0
		survival := 1.0
		for _, k := range order {
			st := stages[k]
			okSum, okCnt, lossSum := 0.0, 0, 0.0
			for _, r := range st {
				if r.Success && r.AverageTime >= 0 {
					okSum += r.AverageTime
					okCnt++
					lossSum += clampLoss(r.PacketLoss)
				} else {
					lossSum += 100
				}
			}
			if okCnt == 0 {
				saveLatencyRow(tunnel.ID, -1, 100, false)
				return
			}
			totalMs += okSum / float64(okCnt)
			stageLoss := lossSum / float64(len(st))
			survival *= 1 - clampLoss(stageLoss)/100.0
		}
		saveLatencyRow(tunnel.ID, totalMs, (1-survival)*100, true)
		return
	}

	okSum, okCnt, lossSum := 0.0, 0, 0.0
	for _, r := range links {
		if r.Success && r.AverageTime >= 0 {
			okSum += r.AverageTime
			okCnt++
			lossSum += clampLoss(r.PacketLoss)
		} else {
			lossSum += 100
		}
	}
	if okCnt == 0 {
		saveLatencyRow(tunnel.ID, -1, 100, false)
		return
	}
	saveLatencyRow(tunnel.ID, okSum/float64(okCnt), lossSum/float64(len(links)), true)
}

type quickPingRes struct {
	ok   bool
	ms   float64
	loss float64
}

func quickTcpPing(nodeID int64, ip string, port int64, fastMode bool) quickPingRes {
	if !hub.isNodeOnline(nodeID) {
		return quickPingRes{ok: false, ms: -1, loss: 100}
	}
	count := 3
	timeout := 3000
	if fastMode {
		count = 1
		timeout = 2000
	}
	r := sendMsg(nodeID, map[string]any{"ip": ip, "port": port, "count": count, "timeout": timeout}, "TcpPing")
	if !r.ok() || r.Data == nil {
		return quickPingRes{ok: false, ms: -1, loss: 100}
	}
	success, _ := r.Data["success"].(bool)
	if !success {
		return quickPingRes{ok: false, ms: -1, loss: 100}
	}
	ms, _ := r.Data["averageTime"].(float64)
	loss, _ := r.Data["packetLoss"].(float64)
	if math.IsNaN(ms) || math.IsInf(ms, 0) || ms < 0 {
		return quickPingRes{ok: false, ms: -1, loss: 100}
	}
	return quickPingRes{ok: true, ms: ms, loss: clampLoss(loss)}
}

type pingFuture struct {
	done chan struct{}
	res  quickPingRes
}

type batchPingCache struct {
	mu       sync.Mutex
	fastMode bool
	m        map[string]*pingFuture
}

func (c *batchPingCache) ping(nodeID int64, ip string, port int64, fastMode bool) quickPingRes {
	if c == nil {
		return quickTcpPing(nodeID, ip, port, fastMode)
	}
	key := fmt.Sprintf("%d|%s|%d", nodeID, ip, port)
	c.mu.Lock()
	if f, exists := c.m[key]; exists {
		c.mu.Unlock()
		<-f.done
		return f.res
	}
	f := &pingFuture{done: make(chan struct{})}
	c.m[key] = f
	c.mu.Unlock()

	f.res = quickTcpPing(nodeID, ip, port, c.fastMode || fastMode)
	close(f.done)
	return f.res
}

func probeTunnelLatencySample(tunnel *Tunnel, fastMode bool, cache *batchPingCache) *latencySampleInput {
	chains := listChains("WHERE tunnel_id = ? ORDER BY id", tunnel.ID)
	if len(chains) == 0 {
		return nil
	}
	inNodes, hops, outNodes := groupChains(chains)
	if len(inNodes) == 0 {
		return nil
	}
	key := fmt.Sprintf("t:%d", tunnel.ID)

	if tunnel.Type == 2 {
		stages := [][]*ChainTunnel{inNodes}
		for _, h := range hops {
			if len(h) > 0 {
				stages = append(stages, h)
			}
		}
		if len(outNodes) > 0 {
			stages = append(stages, outNodes)
		}
		if len(stages) < 2 {
			return nil
		}

		type pingPair struct {
			fromNodeID int64
			ip         string
			port       int64
		}
		stagePairs := make([][]pingPair, 0, len(stages)-1)
		for i := 0; i < len(stages)-1; i++ {
			var pairs []pingPair
			for _, fromCt := range stages[i] {
				for _, toCt := range stages[i+1] {
					toNode := getNode(toCt.NodeID)
					if toNode == nil || toCt.port() <= 0 {
						continue
					}
					pairs = append(pairs, pingPair{
						fromNodeID: fromCt.NodeID,
						ip:         toNode.ServerIP,
						port:       toCt.port(),
					})
				}
			}
			if len(pairs) == 0 {
				return &latencySampleInput{Key: key, Ms: -1, Loss: 100, OK: false}
			}
			stagePairs = append(stagePairs, pairs)
		}

		stageRes := make([][]quickPingRes, len(stagePairs))
		var wg sync.WaitGroup
		for si, pairs := range stagePairs {
			stageRes[si] = make([]quickPingRes, len(pairs))
			for pi, p := range pairs {
				wg.Add(1)
				go func(sIdx, pIdx int, item pingPair) {
					defer wg.Done()
					stageRes[sIdx][pIdx] = cache.ping(item.fromNodeID, item.ip, item.port, fastMode)
				}(si, pi, p)
			}
		}
		wg.Wait()

		totalMs := 0.0
		survival := 1.0
		for _, resList := range stageRes {
			okSum, okCnt, lossSum := 0.0, 0, 0.0
			for _, r := range resList {
				lossSum += r.loss
				if r.ok {
					okSum += r.ms
					okCnt++
				}
			}
			if okCnt == 0 {
				return &latencySampleInput{Key: key, Ms: -1, Loss: 100, OK: false}
			}
			totalMs += okSum / float64(okCnt)
			stageLoss := lossSum / float64(len(resList))
			survival *= 1 - clampLoss(stageLoss)/100.0
		}
		return &latencySampleInput{Key: key, Ms: totalMs, Loss: (1 - survival) * 100, OK: true}
	}

	fwds := listForwards("WHERE tunnel_id = ? ORDER BY status DESC, id ASC LIMIT 5", tunnel.ID)
	targetHost, targetPort, found := "", int64(0), false
	for _, f := range fwds {
		if h, p, ok := parseFirstRemoteTarget(f.RemoteAddr); ok {
			targetHost, targetPort, found = h, p, true
			break
		}
	}
	if !found {
		targetHost, targetPort = "223.5.5.5", 443
	}

	results := make([]quickPingRes, len(inNodes))
	var wg sync.WaitGroup
	for idx, ct := range inNodes {
		wg.Add(1)
		go func(i int, nodeID int64) {
			defer wg.Done()
			results[i] = cache.ping(nodeID, targetHost, targetPort, fastMode)
		}(idx, ct.NodeID)
	}
	wg.Wait()

	okSum, okCnt, lossSum := 0.0, 0, 0.0
	for _, r := range results {
		lossSum += r.loss
		if r.ok {
			okSum += r.ms
			okCnt++
		}
	}
	if okCnt == 0 {
		return &latencySampleInput{Key: key, Ms: -1, Loss: 100, OK: false}
	}
	return &latencySampleInput{Key: key, Ms: okSum / float64(okCnt), Loss: lossSum / float64(len(results)), OK: true}
}

func collectAllTunnelsLatencySamples(fastMode bool, cache *batchPingCache) []latencySampleInput {
	tunnels, err := queryList(scanTunnel, "SELECT "+tunnelCols+" FROM tunnel WHERE status = 1 ORDER BY id ASC")
	must(err)
	if len(tunnels) == 0 {
		return nil
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	var out []latencySampleInput
	for _, t := range tunnels {
		wg.Add(1)
		go func(tun *Tunnel) {
			defer wg.Done()
			if s := probeTunnelLatencySample(tun, fastMode, cache); s != nil {
				mu.Lock()
				out = append(out, *s)
				mu.Unlock()
			}
		}(t)
	}
	wg.Wait()
	return out
}

type remoteTarget struct {
	host string
	port int64
}

func parseRemoteTargets(remoteAddr string, maxTargets int) []remoteTarget {
	if maxTargets <= 0 {
		maxTargets = 3
	}
	var out []remoteTarget
	seen := map[string]bool{}
	for _, raw := range strings.Split(remoteAddr, ",") {
		host, port := splitHostPort(raw)
		if host == "" || port <= 0 || port > 65535 {
			continue
		}
		key := fmt.Sprintf("%s|%d", host, port)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, remoteTarget{host: host, port: port})
		if len(out) >= maxTargets {
			break
		}
	}
	return out
}

func recordForwardDiagnoseLatencySample(forwardID int64, results []*diagResult) {
	var dest []*diagResult
	for _, r := range results {
		if r.ToChainType == nil {
			dest = append(dest, r)
		}
	}
	if len(dest) == 0 {
		return
	}
	okSum, okCnt, lossSum := 0.0, 0, 0.0
	for _, r := range dest {
		if r.Success && r.AverageTime >= 0 {
			okSum += r.AverageTime
			okCnt++
			lossSum += clampLoss(r.PacketLoss)
		} else {
			lossSum += 100
		}
	}
	if okCnt == 0 {
		saveForwardLatencyRow(forwardID, -1, 100, false)
		return
	}
	saveForwardLatencyRow(forwardID, okSum/float64(okCnt), lossSum/float64(len(dest)), true)
}

func probeForwardLatencySample(f *Forward, fastMode bool, cache *batchPingCache) *latencySampleInput {
	tunnel := getTunnel(f.TunnelID)
	if tunnel == nil || tunnel.Status != 1 {
		return nil
	}
	chains := listChains("WHERE tunnel_id = ? ORDER BY id", tunnel.ID)
	if len(chains) == 0 {
		return nil
	}
	inNodes, _, outNodes := groupChains(chains)
	probeNodes := inNodes
	if tunnel.Type == 2 && len(outNodes) > 0 {
		probeNodes = outNodes
	}
	if len(probeNodes) == 0 {
		return nil
	}
	targets := parseRemoteTargets(f.RemoteAddr, 3)
	if len(targets) == 0 {
		return nil
	}

	type pair struct {
		nodeID int64
		host   string
		port   int64
	}
	pairs := make([]pair, 0, len(probeNodes)*len(targets))
	for _, ct := range probeNodes {
		for _, t := range targets {
			pairs = append(pairs, pair{nodeID: ct.NodeID, host: t.host, port: t.port})
		}
	}

	results := make([]quickPingRes, len(pairs))
	var wg sync.WaitGroup
	for idx, p := range pairs {
		wg.Add(1)
		go func(i int, item pair) {
			defer wg.Done()
			results[i] = cache.ping(item.nodeID, item.host, item.port, fastMode)
		}(idx, p)
	}
	wg.Wait()

	key := fmt.Sprintf("f:%d", f.ID)
	okSum, okCnt, lossSum := 0.0, 0, 0.0
	for _, r := range results {
		lossSum += r.loss
		if r.ok {
			okSum += r.ms
			okCnt++
		}
	}
	if okCnt == 0 {
		return &latencySampleInput{Key: key, Ms: -1, Loss: 100, OK: false}
	}
	return &latencySampleInput{Key: key, Ms: okSum / float64(okCnt), Loss: lossSum / float64(len(results)), OK: true}
}

func collectAllForwardsLatencySamples(fastMode bool, cache *batchPingCache) []latencySampleInput {
	forwards := listForwards("WHERE status = 1 ORDER BY id ASC")
	if len(forwards) == 0 {
		return nil
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	var out []latencySampleInput
	for _, f := range forwards {
		wg.Add(1)
		go func(fwd *Forward) {
			defer wg.Done()
			if s := probeForwardLatencySample(fwd, fastMode, cache); s != nil {
				mu.Lock()
				out = append(out, *s)
				mu.Unlock()
			}
		}(f)
	}
	wg.Wait()
	return out
}

func runScheduledLatencyProbe(force bool) {
	intervalSec := loadLatencyProbeIntervalSec()
	if intervalSec <= 0 {
		return
	}
	now := nowMs()
	latencyScheduleMu.Lock()
	if !force && lastLatencyProbeMs > 0 && now-lastLatencyProbeMs < int64(intervalSec)*1000-500 {
		latencyScheduleMu.Unlock()
		return
	}
	lastLatencyProbeMs = now
	latencyScheduleMu.Unlock()

	if intervalSec >= 60 {
		setSetting(latencyProbeLastKey, strconv.FormatInt(now, 10))
	}
	fastMode := intervalSec < 60
	cache := &batchPingCache{fastMode: fastMode, m: map[string]*pingFuture{}}

	var tSamples, fSamples []latencySampleInput
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		tSamples = collectAllTunnelsLatencySamples(fastMode, cache)
	}()
	go func() {
		defer wg.Done()
		fSamples = collectAllForwardsLatencySamples(fastMode, cache)
	}()
	wg.Wait()

	all := make([]latencySampleInput, 0, len(tSamples)+len(fSamples))
	all = append(all, tSamples...)
	all = append(all, fSamples...)
	if len(all) > 0 {
		recordLatencySamples(all, now)
	}
}

type bucketAcc struct {
	id        int64
	totalN    int
	totalOK   int
	sumMs     float64
	sumLoss   float64
	minMs     float64
	maxMs     float64
	latestT   int64
	latestOK  bool
	latestMs  float64
	bucketPts []tunnelLatencyPoint
	rawPts    []tunnelLatencyPoint
}

func collectBucketAcc(prefix string, hours int, allowed map[int64]bool, onlyID int64) map[int64]*bucketAcc {
	if hours < 1 {
		hours = 24
	}
	if hours > 48 {
		hours = 48
	}
	since := nowMs() - int64(hours)*3600*1000
	sinceBucket := (since / latencyBucketMs) * latencyBucketMs

	rows, err := db.Query("SELECT bucket_ms, data FROM latency_bucket WHERE bucket_ms >= ? ORDER BY bucket_ms ASC", sinceBucket)
	must(err)
	defer rows.Close()

	keyPrefix := prefix + ":"
	accMap := map[int64]*bucketAcc{}

	for rows.Next() {
		var bMs int64
		var raw string
		if rows.Scan(&bMs, &raw) != nil {
			continue
		}
		bm := parseBucketMap(raw)
		for k, e := range bm {
			if !strings.HasPrefix(k, keyPrefix) || e == nil || e.N <= 0 {
				continue
			}
			id, err := strconv.ParseInt(strings.TrimPrefix(k, keyPrefix), 10, 64)
			if err != nil || id <= 0 {
				continue
			}
			if onlyID > 0 && id != onlyID {
				continue
			}
			if allowed != nil && !allowed[id] {
				continue
			}
			acc := accMap[id]
			if acc == nil {
				acc = &bucketAcc{id: id, minMs: -1, maxMs: -1, latestT: -1, latestMs: -1}
				accMap[id] = acc
			}
			acc.totalN += e.N
			acc.totalOK += e.OK
			acc.sumMs += e.Sum
			acc.sumLoss += e.Ls
			if e.OK > 0 {
				if e.Min >= 0 && (acc.minMs < 0 || e.Min < acc.minMs) {
					acc.minMs = e.Min
				}
				if e.Max >= 0 && (acc.maxMs < 0 || e.Max > acc.maxMs) {
					acc.maxMs = e.Max
				}
			}
			if e.Lt >= acc.latestT {
				acc.latestT = e.Lt
				acc.latestOK = e.Lo == 1 && e.Lm >= 0
				if acc.latestOK {
					acc.latestMs = round1(e.Lm)
				} else {
					acc.latestMs = -1
				}
			}
			bOK := e.OK > 0
			ptT := e.Lt
			if ptT <= 0 {
				ptT = bMs
			}
			bPt := tunnelLatencyPoint{T: ptT, OK: bOK, Loss: round1(clampLoss(e.Ls / float64(e.N)))}
			if bOK {
				bPt.Ms = round1(e.Sum / float64(e.OK))
			} else {
				bPt.Ms = -1
			}
			acc.bucketPts = append(acc.bucketPts, bPt)

			for _, tuple := range e.Pts {
				ptTime := int64(tuple[0])
				if ptTime < since {
					continue
				}
				ptOK := tuple[1] >= 0
				rp := tunnelLatencyPoint{T: ptTime, OK: ptOK}
				if ptOK {
					rp.Ms = round1(tuple[1])
					rp.Loss = round1(clampLoss(tuple[2]))
				} else {
					rp.Ms = -1
					rp.Loss = 100
				}
				acc.rawPts = append(acc.rawPts, rp)
			}
		}
	}
	return accMap
}

func buildLatencyHistoryMap(hours int, claims *Claims, tunnelID int64) map[string]*tunnelLatencySummary {
	var allowed map[int64]bool
	if tunnelID <= 0 && claims != nil && claims.RoleID != 0 {
		allowed = map[int64]bool{}
		rows, err := db.Query("SELECT tunnel_id FROM user_tunnel WHERE user_id = ?", claims.UserID)
		must(err)
		for rows.Next() {
			var tid int64
			if rows.Scan(&tid) == nil {
				allowed[tid] = true
			}
		}
		rows.Close()
	}
	accMap := collectBucketAcc("t", hours, allowed, tunnelID)
	out := map[string]*tunnelLatencySummary{}
	for id, acc := range accMap {
		pts := acc.bucketPts
		if len(acc.bucketPts) < 4 && len(acc.rawPts) > len(acc.bucketPts) {
			pts = acc.rawPts
			if len(pts) > 60 {
				pts = pts[len(pts)-60:]
			}
		}
		sum := &tunnelLatencySummary{
			TunnelID:    id,
			SampleCount: acc.totalN,
			Points:      pts,
		}
		if acc.totalOK > 0 {
			mn := round1(acc.minMs)
			mx := round1(acc.maxMs)
			av := round1(acc.sumMs / float64(acc.totalOK))
			sum.MinLatency = &mn
			sum.MaxLatency = &mx
			sum.AvgLatency = &av
		}
		if acc.latestOK && acc.latestMs >= 0 {
			lv := acc.latestMs
			sum.LatestLatency = &lv
		}
		if acc.totalN > 0 {
			pl := round1(clampLoss(acc.sumLoss / float64(acc.totalN)))
			sum.PacketLoss = &pl
		}
		out[strconv.FormatInt(id, 10)] = sum
	}
	return out
}

func buildForwardLatencyHistoryMap(hours int, claims *Claims, forwardID int64) map[string]*forwardLatencySummary {
	var allowed map[int64]bool
	if forwardID <= 0 && claims != nil && claims.RoleID != 0 {
		allowed = map[int64]bool{}
		rows, err := db.Query("SELECT id FROM forward WHERE user_id = ?", claims.UserID)
		must(err)
		for rows.Next() {
			var fid int64
			if rows.Scan(&fid) == nil {
				allowed[fid] = true
			}
		}
		rows.Close()
	}
	accMap := collectBucketAcc("f", hours, allowed, forwardID)
	out := map[string]*forwardLatencySummary{}
	for id, acc := range accMap {
		pts := acc.bucketPts
		if len(acc.bucketPts) < 4 && len(acc.rawPts) > len(acc.bucketPts) {
			pts = acc.rawPts
			if len(pts) > 60 {
				pts = pts[len(pts)-60:]
			}
		}
		sum := &forwardLatencySummary{
			ForwardID:   id,
			SampleCount: acc.totalN,
			Points:      pts,
		}
		if acc.totalOK > 0 {
			mn := round1(acc.minMs)
			mx := round1(acc.maxMs)
			av := round1(acc.sumMs / float64(acc.totalOK))
			sum.MinLatency = &mn
			sum.MaxLatency = &mx
			sum.AvgLatency = &av
		}
		if acc.latestOK && acc.latestMs >= 0 {
			lv := acc.latestMs
			sum.LatestLatency = &lv
		}
		if acc.totalN > 0 {
			pl := round1(clampLoss(acc.sumLoss / float64(acc.totalN)))
			sum.PacketLoss = &pl
		}
		out[strconv.FormatInt(id, 10)] = sum
	}
	return out
}

func tunnelLatencyHistory(c *Ctx) any {
	var d struct {
		Hours Num `json:"hours"`
	}
	if len(strings.TrimSpace(string(c.Body))) > 0 {
		_ = json.Unmarshal(c.Body, &d)
	}
	hours := 24
	if d.Hours.Valid {
		hours = int(d.Hours.Int())
	}
	return ok(buildLatencyHistoryMap(hours, c.Claims, 0))
}

func tunnelProbeNow(c *Ctx) any {
	var d struct {
		TunnelID Num `json:"tunnelId"`
	}
	if len(strings.TrimSpace(string(c.Body))) > 0 {
		_ = json.Unmarshal(c.Body, &d)
	}
	if d.TunnelID.Valid && d.TunnelID.Int() > 0 {
		tid := d.TunnelID.Int()
		if !c.isAdmin() && getUserTunnel(c.userID(), tid) == nil {
			return fail("隧道不存在")
		}
		t := getTunnel(tid)
		if t == nil {
			return fail("隧道不存在")
		}
		if s := probeTunnelLatencySample(t, false, nil); s != nil {
			recordLatencySamples([]latencySampleInput{*s}, nowMs())
		}
		return ok(buildLatencyHistoryMap(24, c.Claims, tid))
	}
	if !c.isAdmin() {
		return failCode(403, "权限不足，仅管理员可操作")
	}
	samples := collectAllTunnelsLatencySamples(false, &batchPingCache{m: map[string]*pingFuture{}})
	if len(samples) > 0 {
		recordLatencySamples(samples, nowMs())
	}
	return ok(buildLatencyHistoryMap(24, c.Claims, 0))
}

func forwardLatencyHistory(c *Ctx) any {
	var d struct {
		Hours Num `json:"hours"`
	}
	if len(strings.TrimSpace(string(c.Body))) > 0 {
		_ = json.Unmarshal(c.Body, &d)
	}
	hours := 24
	if d.Hours.Valid {
		hours = int(d.Hours.Int())
	}
	return ok(buildForwardLatencyHistoryMap(hours, c.Claims, 0))
}

func forwardProbeNow(c *Ctx) any {
	var d struct {
		ForwardID Num `json:"forwardId"`
	}
	if len(strings.TrimSpace(string(c.Body))) > 0 {
		_ = json.Unmarshal(c.Body, &d)
	}
	if d.ForwardID.Valid && d.ForwardID.Int() > 0 {
		fid := d.ForwardID.Int()
		f := ownForward(fid, actorOf(c))
		if f == nil {
			return fail("转发不存在")
		}
		if s := probeForwardLatencySample(f, false, nil); s != nil {
			recordLatencySamples([]latencySampleInput{*s}, nowMs())
		}
		return ok(buildForwardLatencyHistoryMap(24, c.Claims, fid))
	}
	if !c.isAdmin() {
		return failCode(403, "权限不足，仅管理员可操作")
	}
	samples := collectAllForwardsLatencySamples(false, &batchPingCache{m: map[string]*pingFuture{}})
	if len(samples) > 0 {
		recordLatencySamples(samples, nowMs())
	}
	return ok(buildForwardLatencyHistoryMap(24, c.Claims, 0))
}
