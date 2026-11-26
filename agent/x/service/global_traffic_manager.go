package service

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"
)

// GlobalTrafficManager 全局流量管理器（所有服务共享）
// 支持「定时周期 + 累计流量阈值」双触发上报与微小噪点过滤，减少面板数据库写入。
type GlobalTrafficManager struct {
	mu             sync.RWMutex
	reportingMu    sync.Mutex
	serviceTraffic map[string]*ServiceTraffic // key: 服务名, value: 流量数据
	pendingBytes   int64                      // 当前所有服务未上报总字节数
	reportInterval time.Duration              // 定时上报周期（默认 60s，连上 CF 面板后按面板下发策略动态生效）
	thresholdBytes int64                      // 流量快报阈值（字节，0 表示禁用）
	minNoiseBytes  int64                      // 微小噪点过滤阈值（字节，0 表示不过滤；兜底 1 小时必报）
	ctx            context.Context
	cancel         context.CancelFunc
	reportTicker   *time.Ticker
	triggerCh      chan struct{}
	resetTickerCh  chan struct{}
}

// ServiceTraffic 单个服务的流量累积
type ServiceTraffic struct {
	mu          sync.Mutex
	ServiceName string
	UpBytes     int64     // 上行流量（累积）
	DownBytes   int64     // 下行流量（累积）
	FirstSeen   time.Time // 本轮首次产生流量的时间（用于 1 小时噪点兜底上报）
}

var (
	globalManager     *GlobalTrafficManager
	globalManagerOnce sync.Once
)

// GetGlobalTrafficManager 获取全局流量管理器单例
func GetGlobalTrafficManager() *GlobalTrafficManager {
	globalManagerOnce.Do(func() {
		ctx, cancel := context.WithCancel(context.Background())
		interval := 60 * time.Second
		if v := os.Getenv("FORWARDZ_FLOW_INTERVAL"); v != "" {
			if sec, err := strconv.Atoi(v); err == nil && sec >= 5 {
				interval = time.Duration(sec) * time.Second
			}
		}
		globalManager = &GlobalTrafficManager{
			serviceTraffic: make(map[string]*ServiceTraffic),
			reportInterval: interval,
			thresholdBytes: 0,
			minNoiseBytes:  0,
			ctx:            ctx,
			cancel:         cancel,
			reportTicker:   time.NewTicker(interval),
			triggerCh:      make(chan struct{}, 1),
			resetTickerCh:  make(chan struct{}, 1),
		}
		// 启动定时上报协程
		go globalManager.startReporting()
	})
	return globalManager
}

// UpdateReportPolicy 动态更新流量上报策略（由面板通过 SetReportInterval 下发，秒级生效无需重启）
// intervalSec <= 0 表示保持原周期；thresholdBytes / minNoiseBytes < 0 表示保持原值。
func (m *GlobalTrafficManager) UpdateReportPolicy(intervalSec int, thresholdBytes int64, minNoiseBytes int64) {
	m.mu.Lock()
	intervalChanged := false
	if intervalSec > 0 {
		if intervalSec < 10 {
			intervalSec = 10
		} else if intervalSec > 86400 {
			intervalSec = 86400
		}
		next := time.Duration(intervalSec) * time.Second
		if next != m.reportInterval {
			m.reportInterval = next
			intervalChanged = true
		}
	}
	if thresholdBytes >= 0 {
		m.thresholdBytes = thresholdBytes
	}
	if minNoiseBytes >= 0 {
		m.minNoiseBytes = minNoiseBytes
	}
	shouldFlushNow := m.thresholdBytes > 0 && m.pendingBytes >= m.thresholdBytes
	curInterval := m.reportInterval
	curThreshold := m.thresholdBytes
	curMinNoise := m.minNoiseBytes
	m.mu.Unlock()

	if intervalChanged {
		select {
		case m.resetTickerCh <- struct{}{}:
		default:
		}
	}
	if shouldFlushNow {
		select {
		case m.triggerCh <- struct{}{}:
		default:
		}
	}
	fmt.Printf("⚙️ 流量上报策略已同步: 周期=%v, 流量阈值=%dMB, 噪点过滤=%dKB\n",
		curInterval, curThreshold/(1024*1024), curMinNoise/1024)
}

// AddTraffic 添加流量到指定服务（由各服务调用）
func (m *GlobalTrafficManager) AddTraffic(serviceName string, upBytes, downBytes int64) {
	if upBytes == 0 && downBytes == 0 {
		return
	}

	m.mu.Lock()
	traffic, exists := m.serviceTraffic[serviceName]
	if !exists {
		traffic = &ServiceTraffic{
			ServiceName: serviceName,
			FirstSeen:   time.Now(),
		}
		m.serviceTraffic[serviceName] = traffic
	}

	traffic.mu.Lock()
	if traffic.UpBytes == 0 && traffic.DownBytes == 0 {
		traffic.FirstSeen = time.Now()
	}
	traffic.UpBytes += upBytes
	traffic.DownBytes += downBytes
	traffic.mu.Unlock()

	m.pendingBytes += upBytes + downBytes
	hitThreshold := m.thresholdBytes > 0 && m.pendingBytes >= m.thresholdBytes
	m.mu.Unlock()

	if hitThreshold {
		select {
		case m.triggerCh <- struct{}{}:
		default:
		}
	}
}

// startReporting 启动定时与阈值双触发上报协程
func (m *GlobalTrafficManager) startReporting() {
	for {
		select {
		case <-m.reportTicker.C:
			m.collectAndReport(false)

		case <-m.triggerCh:
			m.collectAndReport(false)
			m.mu.RLock()
			iv := m.reportInterval
			m.mu.RUnlock()
			m.reportTicker.Reset(iv)

		case <-m.resetTickerCh:
			m.mu.RLock()
			iv := m.reportInterval
			m.mu.RUnlock()
			m.reportTicker.Reset(iv)

		case <-m.ctx.Done():
			fmt.Printf("⏹️ 全局流量上报器已停止\n")
			return
		}
	}
}

// FlushNow 立即全量上报当前所有未发送流量（用于升级重启或优雅退出前防丢数）
func (m *GlobalTrafficManager) FlushNow() {
	m.collectAndReport(true)
}

// collectAndReport 收集所有符合条件的服务流量并合并上报
// flushAll=false 时启用微小噪点过滤（低于 minNoiseBytes 且未满 1 小时的零碎流量继续留在内存累加）
func (m *GlobalTrafficManager) collectAndReport(flushAll bool) {
	m.reportingMu.Lock()
	defer m.reportingMu.Unlock()

	m.mu.Lock()
	if len(m.serviceTraffic) == 0 {
		m.mu.Unlock()
		return
	}

	minNoise := m.minNoiseBytes
	now := time.Now()
	reportData := make(map[string]struct {
		up   int64
		down int64
	})

	for name, traffic := range m.serviceTraffic {
		traffic.mu.Lock()
		total := traffic.UpBytes + traffic.DownBytes
		if total > 0 {
			keepWaiting := !flushAll && minNoise > 0 && total < minNoise &&
				!traffic.FirstSeen.IsZero() && now.Sub(traffic.FirstSeen) < time.Hour
			if !keepWaiting {
				reportData[name] = struct {
					up   int64
					down int64
				}{
					up:   traffic.UpBytes,
					down: traffic.DownBytes,
				}
			}
		}
		traffic.mu.Unlock()
	}
	m.mu.Unlock()

	if len(reportData) == 0 {
		return
	}

	reportItems := make([]TrafficReportItem, 0, len(reportData))
	var totalUp, totalDown int64

	for serviceName, data := range reportData {
		reportItems = append(reportItems, TrafficReportItem{
			N: serviceName,
			U: data.up,
			D: data.down,
		})
		totalUp += data.up
		totalDown += data.down
	}

	// 批量发送上报请求（优先 WebSocket 通道，断线自动回退 HTTP）
	success, err := sendBatchTrafficReport(m.ctx, reportItems)
	if err != nil {
		fmt.Printf("❌ 全局流量上报失败: %v (总流量: ↑%d ↓%d, %d个服务)\n", err, totalUp, totalDown, len(reportItems))
		return
	}

	if !success {
		fmt.Printf("⚠️ 全局流量上报未成功 (总流量: ↑%d ↓%d, %d个服务)\n", totalUp, totalDown, len(reportItems))
		return
	}

	m.clearReportedTraffic(reportData)
}

// clearReportedTraffic 清空已成功上报的流量并重算总待报字节数
func (m *GlobalTrafficManager) clearReportedTraffic(reportedData map[string]struct {
	up   int64
	down int64
}) {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()
	for serviceName, reported := range reportedData {
		if traffic, exists := m.serviceTraffic[serviceName]; exists {
			traffic.mu.Lock()
			traffic.UpBytes -= reported.up
			traffic.DownBytes -= reported.down

			if traffic.UpBytes <= 0 && traffic.DownBytes <= 0 {
				traffic.mu.Unlock()
				delete(m.serviceTraffic, serviceName)
			} else {
				traffic.FirstSeen = now
				traffic.mu.Unlock()
			}
		}
	}

	var remain int64
	for _, traffic := range m.serviceTraffic {
		traffic.mu.Lock()
		remain += traffic.UpBytes + traffic.DownBytes
		traffic.mu.Unlock()
	}
	m.pendingBytes = remain
}

// Stop 停止全局流量管理器
func (m *GlobalTrafficManager) Stop() {
	m.FlushNow()
	if m.reportTicker != nil {
		m.reportTicker.Stop()
	}
	if m.cancel != nil {
		m.cancel()
	}
	fmt.Printf("🛑 全局流量管理器已停止\n")
}

// GetServiceTraffic 获取指定服务的当前流量（用于调试）
func (m *GlobalTrafficManager) GetServiceTraffic(serviceName string) (upBytes, downBytes int64) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if traffic, exists := m.serviceTraffic[serviceName]; exists {
		traffic.mu.Lock()
		upBytes = traffic.UpBytes
		downBytes = traffic.DownBytes
		traffic.mu.Unlock()
	}
	return
}
