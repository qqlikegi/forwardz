package main

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// AgentResult 节点执行命令的结果（节点执行命令的返回）
type AgentResult struct {
	Msg  string
	Data map[string]any
}

func (g *AgentResult) ok() bool { return g != nil && g.Msg == "OK" }

type wsConn struct {
	conn    *websocket.Conn
	mu      sync.Mutex
	isNode  bool
	id      int64  // 节点 ID 或用户 ID
	secret  string // 节点密钥（用于加密）
	closed  bool
	version string
}

func (c *wsConn) send(msg []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return websocket.ErrCloseSent
	}
	if c.isNode {
		msg = encryptForNode(c.secret, msg)
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.conn.WriteMessage(websocket.TextMessage, msg)
}

// sendPlain 发送明文文本帧（用于 CF 协议标准的 ping -> pong 节能保活回复）
func (c *wsConn) sendPlain(msg []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return websocket.ErrCloseSent
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.conn.WriteMessage(websocket.TextMessage, msg)
}

func (c *wsConn) close() {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	_ = c.conn.Close()
}

type Hub struct {
	mu            sync.RWMutex
	nodes         map[int64]*wsConn
	admins        map[*wsConn]struct{}
	upgradeStates map[int64]*NodeUpgradeState
	pending       sync.Map // requestId -> chan *AgentResult
}

var hub = &Hub{
	nodes:         map[int64]*wsConn{},
	admins:        map[*wsConn]struct{}{},
	upgradeStates: map[int64]*NodeUpgradeState{},
}

func (h *Hub) isNodeOnline(nodeID int64) bool {
	h.mu.RLock()
	_, ok := h.nodes[nodeID]
	h.mu.RUnlock()
	return ok
}

func (h *Hub) onlineNodeCount() int {
	h.mu.RLock()
	n := len(h.nodes)
	h.mu.RUnlock()
	return n
}

func (h *Hub) hasAdmins() bool {
	h.mu.RLock()
	has := len(h.admins) > 0
	h.mu.RUnlock()
	return has
}

func (h *Hub) getUpgradeState(nodeID int64) *NodeUpgradeState {
	h.mu.RLock()
	st := h.upgradeStates[nodeID]
	h.mu.RUnlock()
	if st == nil {
		return nil
	}
	cp := *st
	return &cp
}

func (h *Hub) setUpgradeState(nodeID int64, st *NodeUpgradeState) {
	h.mu.Lock()
	if st == nil {
		delete(h.upgradeStates, nodeID)
	} else {
		cp := *st
		h.upgradeStates[nodeID] = &cp
	}
	h.mu.Unlock()
}

func buildReportIntervalPayload(intervalSec int, policy FlowReportPolicy) []byte {
	msg, _ := json.Marshal(map[string]any{
		"type": "SetReportInterval",
		"data": map[string]any{
			"intervalSec":        intervalSec,
			"flowIntervalSec":    policy.FlowIntervalSec,
			"flowThresholdBytes": policy.FlowThresholdBytes,
			"flowMinBytes":       policy.FlowMinBytes,
		},
	})
	return msg
}

func (h *Hub) notifyTelemetryMode(intervalSec int) {
	payload := buildReportIntervalPayload(intervalSec, loadFlowReportPolicy())
	h.mu.RLock()
	nodes := make([]*wsConn, 0, len(h.nodes))
	for _, n := range h.nodes {
		nodes = append(nodes, n)
	}
	h.mu.RUnlock()
	for _, n := range nodes {
		_ = n.send(payload)
	}
}

func (h *Hub) pushFlowPolicyToOnlineNodes(policy FlowReportPolicy) int {
	intervalSec := 0
	if h.hasAdmins() {
		intervalSec = 2
	}
	payload := buildReportIntervalPayload(intervalSec, policy)
	h.mu.RLock()
	nodes := make([]*wsConn, 0, len(h.nodes))
	for _, n := range h.nodes {
		nodes = append(nodes, n)
	}
	h.mu.RUnlock()
	pushed := 0
	for _, n := range nodes {
		if n.send(payload) == nil {
			pushed++
		}
	}
	return pushed
}

var upgrader = websocket.Upgrader{
	CheckOrigin:     func(*http.Request) bool { return true },
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
}

func (h *Hub) handleWS(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	secret := q.Get("secret")
	c := &wsConn{}
	if q.Get("type") == "1" {
		node, err := queryOne(scanNode, "SELECT "+nodeCols+" FROM node WHERE secret = ?", secret)
		if err != nil || node == nil || secret == "" {
			log.Printf("节点验证失败：未找到匹配的 secret，IP: %s", clientIP(r))
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		c.isNode, c.id, c.secret, c.version = true, node.ID, secret, q.Get("version")
	} else {
		claims, valid := parseToken(secret)
		if !valid {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		c.id = claims.UserID
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(16 << 20)
	c.conn = conn

	if c.isNode {
		h.nodeOnline(c, q.Get("http"), q.Get("tls"), q.Get("socks"))
	} else {
		h.mu.Lock()
		prevAdmins := len(h.admins)
		h.admins[c] = struct{}{}
		h.mu.Unlock()
		if prevAdmins == 0 {
			h.notifyTelemetryMode(2)
		}
	}

	defer h.onClose(c)
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if len(bytes.TrimSpace(msg)) > 0 {
			h.onMessage(c, msg)
		}
	}
}

func (h *Hub) nodeOnline(c *wsConn, httpS, tlsS, socksS string) {
	h.mu.Lock()
	old := h.nodes[c.id]
	h.nodes[c.id] = c
	h.mu.Unlock()
	if old != nil {
		log.Printf("节点 %d 已有连接，新连接将覆盖旧连接", c.id)
		old.close()
	}

	sets := "status = 1"
	args := []any{}
	if c.version != "" {
		sets += ", version = ?"
		args = append(args, c.version)
	}
	for col, v := range map[string]string{"http": httpS, "tls": tlsS, "socks": socksS} {
		if n, err := strconv.Atoi(v); err == nil {
			sets += ", " + col + " = ?"
			args = append(args, n)
		}
	}
	args = append(args, c.id)
	if _, err := db.Exec("UPDATE node SET "+sets+" WHERE id = ?", args...); err != nil {
		log.Printf("节点 %d 状态更新失败: %v", c.id, err)
		return
	}
	log.Printf("节点 %d 上线，版本: %s", c.id, c.version)
	h.broadcast(map[string]any{"id": strconv.FormatInt(c.id, 10), "type": "status", "data": 1})

	// 若该节点正处于远程升级中，重连上线即视为升级完成（与 CF 面板逻辑一致）
	if prevUp := h.getUpgradeState(c.id); prevUp != nil && isActiveUpgradeStatus(prevUp.Status) {
		newVer := normalizeVersion(c.version)
		if newVer == "" {
			newVer = prevUp.ToVersion
		}
		msg := "已重启并重新上线"
		if newVer != "" {
			msg = "已升级至 " + newVer + " 并重新上线"
		}
		h.setUpgradeState(c.id, &NodeUpgradeState{
			Status:      "success",
			FromVersion: prevUp.FromVersion,
			ToVersion:   newVer,
			Message:     msg,
			UpdatedAt:   nowMs(),
		})
	}

	// 与 CF 面板统一：无管理员看监控页时切节能 ping/pong 保活，有管理员时切 2 秒实时推送，并同步最新流量上报策略
	intervalSec := 0
	if h.hasAdmins() {
		intervalSec = 2
	}
	_ = c.send(buildReportIntervalPayload(intervalSec, loadFlowReportPolicy()))
}

func (h *Hub) onClose(c *wsConn) {
	c.close()
	if !c.isNode {
		h.mu.Lock()
		delete(h.admins, c)
		remaining := len(h.admins)
		h.mu.Unlock()
		if remaining == 0 {
			h.notifyTelemetryMode(0)
		}
		return
	}
	h.mu.Lock()
	current := h.nodes[c.id] == c
	if current {
		delete(h.nodes, c.id)
	}
	h.mu.Unlock()
	if !current {
		return // 已被新连接替换，不改状态
	}
	if _, err := db.Exec("UPDATE node SET status = 0 WHERE id = ?", c.id); err != nil {
		log.Printf("节点 %d 离线状态更新失败: %v", c.id, err)
	}
	log.Printf("节点 %d 离线", c.id)
	h.broadcast(map[string]any{"id": strconv.FormatInt(c.id, 10), "type": "status", "data": 0})
}

func (h *Hub) onMessage(c *wsConn, raw []byte) {
	// 0. 兼容 CF 协议标准：明文 ping -> 明文 pong 节能保活
	if c.isNode && bytes.Equal(bytes.TrimSpace(raw), []byte("ping")) {
		_ = c.sendPlain([]byte("pong"))
		return
	}

	payload := raw
	if c.isNode {
		payload = decryptIfNeeded(raw, c.secret)
	}

	// 1. 节点经加密 WebSocket 上报流量 / 配置 / 远程升级进度（与 CF 面板协议完全一致）
	if c.isNode && (bytes.Contains(payload, []byte(`"FlowReport"`)) ||
		bytes.Contains(payload, []byte(`"ConfigReport"`)) ||
		bytes.Contains(payload, []byte(`"UpgradeStatus"`))) {
		var env struct {
			Type      string          `json:"type"`
			Data      json.RawMessage `json:"data"`
			RequestID string          `json:"requestId"`
		}
		if json.Unmarshal(payload, &env) == nil {
			switch env.Type {
			case "UpgradeStatus":
				var d struct {
					Status      string `json:"status"`
					FromVersion string `json:"fromVersion"`
					ToVersion   string `json:"toVersion"`
					Message     string `json:"message"`
				}
				if json.Unmarshal(env.Data, &d) == nil {
					st := sanitizeUpgradeStatus(d.Status)
					msg := d.Message
					if msg == "" {
						msg = st
					}
					h.setUpgradeState(c.id, &NodeUpgradeState{
						Status:      st,
						FromVersion: normalizeVersion(d.FromVersion),
						ToVersion:   normalizeVersion(d.ToVersion),
						Message:     msg,
						UpdatedAt:   nowMs(),
					})
				}
				return
			case "FlowReport":
				var items []flowReportItem
				if json.Unmarshal(env.Data, &items) == nil {
					processFlowItems(items)
					if env.RequestID != "" {
						ack, _ := json.Marshal(map[string]any{
							"type":      "FlowReportAck",
							"requestId": env.RequestID,
							"message":   "OK",
						})
						_ = c.send(ack)
					}
				}
				return
			case "ConfigReport":
				cfgBytes := env.Data
				var asStr string
				if json.Unmarshal(env.Data, &asStr) == nil {
					cfgBytes = []byte(asStr)
				}
				if actual, err := stateFromReport(cfgBytes); err == nil {
					nodeID := c.id
					go func() {
						defer func() {
							if e := recover(); e != nil {
								log.Printf("节点 %d WS 配置对账异常: %v", nodeID, e)
							}
						}()
						reconcileNode(nodeID, actual)
					}()
				}
				return
			}
		}
	}

	if bytes.Contains(payload, []byte("memory_usage")) {
		_ = c.send([]byte(`{"type":"call"}`))
	} else if bytes.Contains(payload, []byte("requestId")) {
		var resp struct {
			RequestID string          `json:"requestId"`
			Message   *string         `json:"message"`
			Type      string          `json:"type"`
			Data      json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(payload, &resp); err == nil && resp.RequestID != "" {
			if ch, ok := h.pending.LoadAndDelete(resp.RequestID); ok {
				result := &AgentResult{}
				if resp.Message != nil {
					result.Msg = *resp.Message
				} else if resp.Type == "PingResponse" {
					result.Msg = "OK"
				} else {
					result.Msg = "无响应消息"
				}
				var data map[string]any
				if len(resp.Data) > 0 && json.Unmarshal(resp.Data, &data) == nil {
					result.Data = data
				}
				ch.(chan *AgentResult) <- result
			}
		}
		log.Printf("收到节点 %d 响应: %s", c.id, truncate(payload, 500))
	}

	if c.isNode {
		msg, _ := json.Marshal(map[string]any{"id": strconv.FormatInt(c.id, 10), "type": "info", "data": string(payload)})
		h.mu.RLock()
		admins := make([]*wsConn, 0, len(h.admins))
		for a := range h.admins {
			admins = append(admins, a)
		}
		h.mu.RUnlock()
		for _, a := range admins {
			_ = a.send(msg)
		}
	}
}

func (h *Hub) broadcast(v any) {
	msg, _ := json.Marshal(v)
	h.mu.RLock()
	admins := make([]*wsConn, 0, len(h.admins))
	for a := range h.admins {
		admins = append(admins, a)
	}
	h.mu.RUnlock()
	for _, a := range admins {
		_ = a.send(msg)
	}
}

func (h *Hub) closeAll() {
	h.mu.Lock()
	conns := []*wsConn{}
	for _, c := range h.nodes {
		conns = append(conns, c)
	}
	for c := range h.admins {
		conns = append(conns, c)
	}
	h.mu.Unlock()
	for _, c := range conns {
		c.close()
	}
}

// sendMsg 向节点发送命令并等待响应（最长 10 秒）
func sendMsg(nodeID int64, data any, typ string) *AgentResult {
	hub.mu.RLock()
	c := hub.nodes[nodeID]
	hub.mu.RUnlock()
	if c == nil {
		return &AgentResult{Msg: "节点不在线"}
	}
	requestID := newUUID()
	ch := make(chan *AgentResult, 1)
	hub.pending.Store(requestID, ch)
	defer hub.pending.Delete(requestID)

	msg, _ := json.Marshal(map[string]any{"type": typ, "data": data, "requestId": requestID})
	if err := c.send(msg); err != nil {
		return &AgentResult{Msg: "发送消息失败: " + err.Error()}
	}
	select {
	case r := <-ch:
		log.Printf("节点 %d 执行 %s: %s", nodeID, typ, r.Msg)
		return r
	case <-time.After(10 * time.Second):
		log.Printf("节点 %d 执行 %s 响应超时", nodeID, typ)
		return &AgentResult{Msg: "等待响应超时"}
	}
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "..."
}
