import React, { useId, useMemo, useState } from "react";

export interface TunnelLatencyPoint {
  t: number;
  ms: number;
  loss: number;
  ok: boolean;
}

export interface TunnelLatencySummary {
  tunnelId?: number;
  forwardId?: number;
  minLatency: number | null;
  avgLatency: number | null;
  maxLatency: number | null;
  latestLatency: number | null;
  packetLoss: number | null;
  sampleCount: number;
  points: TunnelLatencyPoint[];
}

interface TunnelLatencyBarProps {
  summary?: TunnelLatencySummary;
  probing?: boolean;
  onProbe: () => void;
  title?: string;
  compact?: boolean;
}

const fmtMs = (v: number | null) => {
  if (v === null || v < 0) return "--";
  return v >= 100 ? `${Math.round(v)}ms` : `${v.toFixed(1).replace(/\.0$/, "")}ms`;
};

const fmtLoss = (v: number | null) => {
  if (v === null) return "--";
  if (v === 0) return "0%";
  return v >= 10 ? `${Math.round(v)}%` : `${v.toFixed(1).replace(/\.0$/, "")}%`;
};

const fmtClock = (ts: number) => {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
};

/** 隧道 / 转发卡片底部 24h 健康与延迟展示栏：最快 / 平均 / 最慢 / 丢包率 + 轻量交互波形 */
export const TunnelLatencyBar: React.FC<TunnelLatencyBarProps> = ({
  summary,
  probing = false,
  onProbe,
  title = "24h 延迟",
  compact = false,
}) => {
  const gradId = useId().replace(/:/g, "");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const points = summary?.points ?? [];
  const hasData = points.length > 0;
  const latestPt = hasData ? points[points.length - 1] : null;
  const activePt = hoverIdx !== null && points[hoverIdx] ? points[hoverIdx] : null;

  // 健康等级决定波形与状态灯颜色
  const health = useMemo(() => {
    if (!hasData || !summary) {
      return { color: "var(--fz-muted)", dotClass: "bg-default-400", label: "待采集" };
    }
    const loss = summary.packetLoss ?? 0;
    const avg = summary.avgLatency;
    if ((latestPt && !latestPt.ok) || avg === null || loss >= 10 || avg >= 180) {
      return { color: "var(--fz-red)", dotClass: "bg-danger-500", label: "波动/异常" };
    }
    if (loss >= 2 || avg >= 80) {
      return { color: "var(--fz-orange)", dotClass: "bg-warning-500", label: "偏高" };
    }
    return { color: "var(--fz-green)", dotClass: "bg-success-500", label: "健康" };
  }, [hasData, summary, latestPt]);

  // 计算轻量 SVG 波形几何坐标（viewBox: 240 x 40）
  const chart = useMemo(() => {
    const W = 240;
    const H = 40;
    const padTop = 5;
    const padBottom = 4;
    const usableH = H - padTop - padBottom;
    const okVals = points.filter((p) => p.ok).map((p) => p.ms);
    if (okVals.length === 0) {
      return { W, H, segments: [] as string[], areaPaths: [] as string[], coords: [] as Array<{ x: number; y: number; ok: boolean }>, avgY: null as number | null };
    }
    const rawMin = Math.min(...okVals);
    const rawMax = Math.max(...okVals);
    const spread = Math.max(rawMax - rawMin, Math.max(10, rawMax * 0.25));
    const yMin = Math.max(0, rawMin - spread * 0.15);
    const yMax = rawMax + spread * 0.15;
    const mapY = (ms: number) => {
      if (yMax <= yMin) return padTop + usableH * 0.5;
      return padTop + usableH * (1 - (ms - yMin) / (yMax - yMin));
    };
    const n = points.length;
    const coords = points.map((p, idx) => ({
      x: n === 1 ? W / 2 : (idx / (n - 1)) * W,
      y: p.ok ? mapY(p.ms) : H - 2,
      ok: p.ok,
    }));

    // 连续成功点拼成折线与面积填充（断连点处自然断开，不画误导斜线）
    const segments: string[] = [];
    const areaPaths: string[] = [];
    let cur: Array<{ x: number; y: number }> = [];
    const flush = () => {
      if (cur.length >= 2) {
        const line = cur.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
        segments.push(line);
        areaPaths.push(`${line} L${cur[cur.length - 1].x.toFixed(1)},${H} L${cur[0].x.toFixed(1)},${H} Z`);
      }
      cur = [];
    };
    for (const c of coords) {
      if (c.ok) cur.push({ x: c.x, y: c.y });
      else flush();
    }
    flush();

    const avgY = summary?.avgLatency !== null && summary?.avgLatency !== undefined ? mapY(summary.avgLatency) : null;
    return { W, H, segments, areaPaths, coords, avgY };
  }, [points, summary?.avgLatency]);

  const pickIndexFromClientX = (clientX: number, rect: DOMRect) => {
    if (points.length === 0 || rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const idx = Math.round(ratio * (points.length - 1));
    setHoverIdx(idx);
  };

  const lossColorClass =
    summary?.packetLoss === null || summary?.packetLoss === undefined
      ? "text-default-500"
      : summary.packetLoss >= 5
        ? "text-danger"
        : summary.packetLoss > 0
          ? "text-warning"
          : "text-success";

  return (
    <div className={`fz-cell ${compact ? "px-2 py-1.5 mt-2.5 space-y-1.5" : "px-2.5 py-2 mt-3 space-y-2"}`}>
      {/* 顶栏：健康灯 + 标题 + 动态读数/悬停详情 + 一键检测按钮 */}
      <div className="flex items-center justify-between gap-1.5 min-h-[18px]">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${health.dotClass}`} />
          <span className="text-[11px] font-medium text-default-600 whitespace-nowrap">{title}</span>
          <span className="text-[11px] text-default-500 tabular-nums truncate">
            {activePt
              ? `${fmtClock(activePt.t)} · ${activePt.ok ? fmtMs(activePt.ms) : "超时"} · 丢包 ${fmtLoss(activePt.loss)}`
              : hasData
                ? latestPt?.ok
                  ? `最新 ${fmtMs(latestPt.ms)}`
                  : "最近探测超时"
                : compact
                  ? "自动采集"
                  : "自动定时采集"}
          </span>
        </div>

        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onProbe}
          disabled={probing}
          title="立即探测一次延迟"
          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-default-500 hover:text-foreground hover:bg-[var(--fz-fill)] transition-colors cursor-pointer flex-shrink-0 disabled:opacity-50"
          style={{ borderRadius: "calc(var(--fz-r-cell) - 2px)" }}
        >
          <svg
            className={`w-3 h-3 ${probing ? "animate-spin text-primary" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
          <span>{probing ? "测速中" : "测速"}</span>
        </button>
      </div>

      {/* 四格核心指标：最快 / 平均 / 最慢 / 丢包率 */}
      <div className="grid grid-cols-4 gap-1 text-center">
        <div className={`${compact ? "px-0.5" : "px-1"} py-1 rounded bg-[var(--fz-card-bg)]/60 border border-[var(--fz-hairline)] min-w-0`}>
          <div className="text-[10px] text-default-500 leading-tight whitespace-nowrap">最快</div>
          <div className={`${compact ? "text-[11px]" : "text-[11.5px]"} font-bold tabular-nums text-success mt-0.5 leading-tight whitespace-nowrap`}>
            {fmtMs(summary?.minLatency ?? null)}
          </div>
        </div>
        <div className={`${compact ? "px-0.5" : "px-1"} py-1 rounded bg-[var(--fz-card-bg)]/60 border border-[var(--fz-hairline)] min-w-0`}>
          <div className="text-[10px] text-default-500 leading-tight whitespace-nowrap">平均</div>
          <div className={`${compact ? "text-[11px]" : "text-[11.5px]"} font-bold tabular-nums text-foreground mt-0.5 leading-tight whitespace-nowrap`}>
            {fmtMs(summary?.avgLatency ?? null)}
          </div>
        </div>
        <div className={`${compact ? "px-0.5" : "px-1"} py-1 rounded bg-[var(--fz-card-bg)]/60 border border-[var(--fz-hairline)] min-w-0`}>
          <div className="text-[10px] text-default-500 leading-tight whitespace-nowrap">最慢</div>
          <div className={`${compact ? "text-[11px]" : "text-[11.5px]"} font-bold tabular-nums text-warning mt-0.5 leading-tight whitespace-nowrap`}>
            {fmtMs(summary?.maxLatency ?? null)}
          </div>
        </div>
        <div className={`${compact ? "px-0.5" : "px-1"} py-1 rounded bg-[var(--fz-card-bg)]/60 border border-[var(--fz-hairline)] min-w-0`}>
          <div className="text-[10px] text-default-500 leading-tight whitespace-nowrap">丢包率</div>
          <div className={`${compact ? "text-[11px]" : "text-[11.5px]"} font-bold tabular-nums mt-0.5 leading-tight whitespace-nowrap ${lossColorClass}`}>
            {fmtLoss(summary?.packetLoss ?? null)}
          </div>
        </div>
      </div>

      {/* 24 小时延迟波形图 */}
      <div
        className={`relative ${compact ? "h-9" : "h-10"} w-full select-none touch-pan-y`}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseMove={(e) => pickIndexFromClientX(e.clientX, e.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => setHoverIdx(null)}
        onTouchMove={(e) => {
          if (e.touches[0]) pickIndexFromClientX(e.touches[0].clientX, e.currentTarget.getBoundingClientRect());
        }}
        onTouchEnd={() => setHoverIdx(null)}
      >
        {!hasData ? (
          <div className="h-full w-full flex items-center justify-center border border-dashed border-[var(--fz-hairline)] rounded text-[10.5px] text-default-400 px-1 truncate">
            {compact ? "点「测速」或等待自动采集" : "暂无 24h 波形，点击右上角「测速」或等待自动采集"}
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${chart.W} ${chart.H}`}
            preserveAspectRatio="none"
            className="w-full h-full overflow-visible"
          >
            <defs>
              <linearGradient id={`fzLatGrad-${gradId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={health.color} stopOpacity={0.28} />
                <stop offset="100%" stopColor={health.color} stopOpacity={0.02} />
              </linearGradient>
            </defs>

            {/* 平均延迟虚线参考基线 */}
            {chart.avgY !== null && (
              <line
                x1={0}
                y1={chart.avgY}
                x2={chart.W}
                y2={chart.avgY}
                stroke="var(--fz-hairline-strong)"
                strokeWidth={0.8}
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
            )}

            {/* 面积渐变 */}
            {chart.areaPaths.map((d, i) => (
              <path key={`a-${i}`} d={d} fill={`url(#fzLatGrad-${gradId})`} />
            ))}

            {/* 折线波形 */}
            {chart.segments.map((d, i) => (
              <path
                key={`l-${i}`}
                d={d}
                fill="none"
                stroke={health.color}
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {/* 仅有 1 个有效点时画中轴基线 + 实心点 */}
            {points.length === 1 && chart.coords[0]?.ok && (
              <>
                <line
                  x1={0}
                  y1={chart.coords[0].y}
                  x2={chart.W}
                  y2={chart.coords[0].y}
                  stroke={health.color}
                  strokeOpacity={0.35}
                  strokeWidth={1.2}
                  strokeDasharray="2 3"
                  vectorEffect="non-scaling-stroke"
                />
                <circle cx={chart.coords[0].x} cy={chart.coords[0].y} r={3} fill={health.color} />
              </>
            )}

            {/* 异常/超时采样点底部红标 */}
            {chart.coords.map((c, idx) =>
              !c.ok ? (
                <line
                  key={`f-${idx}`}
                  x1={c.x}
                  y1={chart.H - 9}
                  x2={c.x}
                  y2={chart.H}
                  stroke="var(--fz-red)"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null,
            )}

            {/* 悬停游标 */}
            {hoverIdx !== null && chart.coords[hoverIdx] && (
              <>
                <line
                  x1={chart.coords[hoverIdx].x}
                  y1={0}
                  x2={chart.coords[hoverIdx].x}
                  y2={chart.H}
                  stroke="var(--fz-muted)"
                  strokeWidth={1}
                  strokeDasharray="2 2"
                  vectorEffect="non-scaling-stroke"
                />
                <circle
                  cx={chart.coords[hoverIdx].x}
                  cy={chart.coords[hoverIdx].y}
                  r={3}
                  fill={chart.coords[hoverIdx].ok ? health.color : "var(--fz-red)"}
                  stroke="var(--fz-surface)"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              </>
            )}
          </svg>
        )}
      </div>
    </div>
  );
};

export default TunnelLatencyBar;
