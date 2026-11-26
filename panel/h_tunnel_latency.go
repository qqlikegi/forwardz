package main

// 隧道 24h 延迟与丢包监控（与 CF 面板完全对齐）：
// 每 15 分钟并发探测所有启用隧道的真实链路延迟与丢包率，保留最近 25 小时，支持网页一键立即探测。

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
)

const latencyRetentionMs int64 = 25 * 3600 * 1000

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

func parseFirstRemoteTarget(remoteAddr string) (string, int64, bool) {
	parts := strings.Split(remoteAddr, ",")
	if len(parts) == 0 {
		return "", 0, false
	}
	first := strings.TrimSpace(parts[0])
	if first == "" {
		return "", 0, false
	}
	if strings.HasPrefix(first, "[") {
		end := strings.Index(first, "]:")
		if end <= 1 {
			return "", 0, false
		}
		host := first[1:end]
		p, err := strconv.ParseInt(strings.TrimSpace(first[end+2:]), 10, 64)
		if err != nil || host == "" || p <= 0 || p > 65535 {
			return "", 0, false
		}
		return host, p, true
	}
	idx := strings.LastIndex(first, ":")
	if idx <= 0 {
		return "", 0, false
	}
	host := strings.TrimSpace(first[:idx])
	p, err := strconv.ParseInt(strings.TrimSpace(first[idx+1:]), 10, 64)
	if err != nil || host == "" || p <= 0 || p > 65535 {
		return "", 0, false
	}
	return host, p, true
}

func saveLatencyRow(tunnelID int64, latency, packetLoss float64, success bool) {
	lat := -1.0
	loss := 100.0
	succ := 0
	if success {
		lat = round1(latency)
		loss = round1(clampLoss(packetLoss))
		succ = 1
	}
	mustExec(
		"INSERT INTO tunnel_latency (tunnel_id, latency, packet_loss, success, created_time) VALUES (?, ?, ?, ?, ?)",
		tunnelID, lat, loss, succ, nowMs(),
	)
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

func quickTcpPing(nodeID int64, ip string, port int64) quickPingRes {
	if !hub.isNodeOnline(nodeID) {
		return quickPingRes{ok: false, ms: -1, loss: 100}
	}
	r := sendMsg(nodeID, map[string]any{"ip": ip, "port": port, "count": 3, "timeout": 3000}, "TcpPing")
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

func probeTunnelLatency(tunnel *Tunnel) bool {
	chains := listChains("WHERE tunnel_id = ? ORDER BY id", tunnel.ID)
	if len(chains) == 0 {
		return false
	}
	inNodes, hops, outNodes := groupChains(chains)
	if len(inNodes) == 0 {
		return false
	}

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
			return false
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
				saveLatencyRow(tunnel.ID, -1, 100, false)
				return true
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
					stageRes[sIdx][pIdx] = quickTcpPing(item.fromNodeID, item.ip, item.port)
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
				saveLatencyRow(tunnel.ID, -1, 100, false)
				return true
			}
			totalMs += okSum / float64(okCnt)
			stageLoss := lossSum / float64(len(resList))
			survival *= 1 - clampLoss(stageLoss)/100.0
		}
		saveLatencyRow(tunnel.ID, totalMs, (1-survival)*100, true)
		return true
	}

	// 端口转发（type=1）：优先探测该隧道首个启用转发的真实目标地址
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
			results[i] = quickTcpPing(nodeID, targetHost, targetPort)
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
		saveLatencyRow(tunnel.ID, -1, 100, false)
		return true
	}
	saveLatencyRow(tunnel.ID, okSum/float64(okCnt), lossSum/float64(len(results)), true)
	return true
}

func probeAllTunnelsLatency() int {
	mustExec("DELETE FROM tunnel_latency WHERE created_time < ?", nowMs()-latencyRetentionMs)
	tunnels, err := queryList(scanTunnel, "SELECT "+tunnelCols+" FROM tunnel WHERE status = 1 ORDER BY id ASC")
	must(err)
	if len(tunnels) == 0 {
		return 0
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	probed := 0
	for _, t := range tunnels {
		wg.Add(1)
		go func(tun *Tunnel) {
			defer wg.Done()
			if probeTunnelLatency(tun) {
				mu.Lock()
				probed++
				mu.Unlock()
			}
		}(t)
	}
	wg.Wait()
	return probed
}

func buildLatencyHistoryMap(hours int, tunnelID int64) map[string]*tunnelLatencySummary {
	if hours < 1 {
		hours = 24
	}
	if hours > 48 {
		hours = 48
	}
	since := nowMs() - int64(hours)*3600*1000
	var query string
	var args []any
	if tunnelID > 0 {
		query = "SELECT tunnel_id, latency, packet_loss, success, created_time FROM tunnel_latency WHERE tunnel_id = ? AND created_time >= ? ORDER BY created_time ASC"
		args = []any{tunnelID, since}
	} else {
		query = "SELECT tunnel_id, latency, packet_loss, success, created_time FROM tunnel_latency WHERE created_time >= ? ORDER BY tunnel_id ASC, created_time ASC"
		args = []any{since}
	}
	rows, err := db.Query(query, args...)
	must(err)
	defer rows.Close()

	grouped := map[int64][]tunnelLatencyPoint{}
	for rows.Next() {
		var tid, succ, created int64
		var lat, loss float64
		if err := rows.Scan(&tid, &lat, &loss, &succ, &created); err != nil {
			continue
		}
		okFlag := succ == 1 && lat >= 0
		pt := tunnelLatencyPoint{T: created, OK: okFlag}
		if okFlag {
			pt.Ms = round1(lat)
			pt.Loss = round1(clampLoss(loss))
		} else {
			pt.Ms = -1
			pt.Loss = 100
		}
		grouped[tid] = append(grouped[tid], pt)
	}

	out := map[string]*tunnelLatencySummary{}
	for tid, pts := range grouped {
		sum := &tunnelLatencySummary{
			TunnelID:    tid,
			SampleCount: len(pts),
			Points:      pts,
		}
		var okCnt int
		var okSum, minV, maxV, lossSum float64
		for _, p := range pts {
			lossSum += p.Loss
			if p.OK {
				if okCnt == 0 || p.Ms < minV {
					minV = p.Ms
				}
				if okCnt == 0 || p.Ms > maxV {
					maxV = p.Ms
				}
				okSum += p.Ms
				okCnt++
			}
		}
		if okCnt > 0 {
			mn := round1(minV)
			mx := round1(maxV)
			av := round1(okSum / float64(okCnt))
			sum.MinLatency = &mn
			sum.MaxLatency = &mx
			sum.AvgLatency = &av
		}
		if len(pts) > 0 {
			last := pts[len(pts)-1]
			if last.OK {
				lv := last.Ms
				sum.LatestLatency = &lv
			}
			pl := round1(lossSum / float64(len(pts)))
			sum.PacketLoss = &pl
		}
		out[strconv.FormatInt(tid, 10)] = sum
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
	return ok(buildLatencyHistoryMap(hours, 0))
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
		t := getTunnel(tid)
		if t == nil {
			return fail("隧道不存在")
		}
		probeTunnelLatency(t)
		return ok(buildLatencyHistoryMap(24, tid))
	}
	probeAllTunnelsLatency()
	return ok(buildLatencyHistoryMap(24, 0))
}
