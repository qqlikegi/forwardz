import { useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Divider } from "@heroui/divider";
import { Button } from "@heroui/button";
import { UserFilter } from "@/components/user-filter";
import toast from "react-hot-toast";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

import { getDashboardOverview } from "@/api";

interface OverviewUser {
  id: number;
  user: string;
  status: number;
  flow: number; // GB，99999 为无限制
  num: number;
  usedFlow: number;
  todayFlow: number;
  monthFlow: number;
  expTime: number;
  forwardCount: number;
  flowResetTime?: number; // 0 = 不重置（总流量型）；1-31 = 每月 N 号重置（月周期型）
}

interface Overview {
  nodeTotal: number;
  nodeOnline: number;
  totalUsedFlow: number;
  todayFlow: number;
  monthFlow: number;
  userCount: number;
  users: OverviewUser[];
  statisticsFlows: { time: string; flow: number }[];
}

type SortKey = "todayFlow" | "monthFlow" | "usedFlow";

const DEFAULT_TOP_USERS = 4;
const BYTES_PER_GB = 1024 ** 3;

const formatFlow = (v: number) => {
  if (!v || v <= 0) return "0 B";
  if (v < 1024) return v + " B";
  if (v < 1024 ** 2) return (v / 1024).toFixed(2) + " KB";
  if (v < 1024 ** 3) return (v / 1024 ** 2).toFixed(2) + " MB";
  if (v < 1024 ** 4) return (v / 1024 ** 3).toFixed(2) + " GB";
  return (v / 1024 ** 4).toFixed(2) + " TB";
};

const formatQuotaGB = (gb: number) => {
  if (!gb || gb === 99999) return "无限制";
  if (gb >= 1024 && gb % 1024 === 0) return `${gb / 1024} TB`;
  return `${gb} GB`;
};

const formatYMD = (ms: number) => {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const axisFlow = (v: number) => {
  if (v === 0) return "0";
  if (v < 1024) return `${v}B`;
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)}K`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)}M`;
  return `${(v / 1024 ** 3).toFixed(1)}G`;
};

const expBadge = (u: OverviewUser) => {
  if (u.status === 0) {
    return {
      text: u.expTime ? `停用 · ${formatYMD(u.expTime)}` : "已停用",
      cls: "bg-default-100 text-default-500 border-default-200/70 dark:bg-default-100/40 dark:border-white/10",
      isDate: false,
    };
  }
  if (!u.expTime || u.expTime <= 0) {
    return {
      text: "永久有效",
      cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
      isDate: false,
    };
  }
  const ymd = formatYMD(u.expTime);
  const days = Math.ceil((u.expTime - Date.now()) / 86400000);
  if (days <= 0) {
    return {
      text: `已过期 ${ymd}`,
      cls: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/25",
      isDate: true,
    };
  }
  if (days <= 7) {
    return {
      text: `${ymd} · 剩${days}天`,
      cls: "bg-amber-500/12 text-amber-600 dark:text-amber-400 border-amber-500/25",
      isDate: true,
    };
  }
  return {
    text: ymd,
    cls: "bg-[var(--fz-fill-2)] text-[var(--fz-secondary)] border-[var(--fz-hairline)]",
    isDate: true,
  };
};

function StatCard({
  label,
  value,
  sub,
  color,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  color: string;
  icon: React.ReactNode;
}) {
  return (
    <Card className="fz-card">
      <CardBody className="p-3 lg:p-3.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-default-500 truncate">{label}</p>
          <div className={`p-1.5 rounded-lg flex-shrink-0 ${color}`}>{icon}</div>
        </div>
        <div className="mt-1.5 flex items-baseline justify-between gap-2">
          <p className="text-lg lg:text-xl font-bold tabular-nums text-foreground truncate">{value}</p>
          {sub && <p className="text-[11px] text-default-500 truncate">{sub}</p>}
        </div>
      </CardBody>
    </Card>
  );
}

const icon = (d: string) => (
  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
    <path fillRule="evenodd" clipRule="evenodd" d={d} />
  </svg>
);

const CalendarIcon = () => (
  <svg
    className="w-3 h-3 flex-shrink-0 opacity-75"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={1.8}
    viewBox="0 0 24 24"
  >
    <rect width="18" height="18" x="3" y="4" rx="2" />
    <path d="M16 2v4M8 2v4M3 10h18" />
  </svg>
);

export default function AdminOverview() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("todayFlow");
  const [sortAsc, setSortAsc] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [showAllUsers, setShowAllUsers] = useState(false);

  const load = async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await getDashboardOverview();
      if (res.code === 0) setData(res.data);
      else if (!quiet) toast.error(res.msg || "获取数据失败");
    } catch {
      if (!quiet) toast.error("获取数据失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    localStorage.setItem("e", "/dashboard");
    const timer = setInterval(() => load(true), 60000);
    return () => clearInterval(timer);
  }, []);

  // 最近 24 小时，没有数据的小时补 0
  const chartData = useMemo(() => {
    const map = new Map<string, number>();
    (data?.statisticsFlows || []).forEach((i) => map.set(i.time, i.flow || 0));
    const now = Date.now();
    const out: { time: string; flow: number }[] = [];
    for (let i = 23; i >= 0; i--) {
      const h = new Date(now - i * 3600000).getHours().toString().padStart(2, "0") + ":00";
      out.push({ time: h, flow: map.get(h) || 0 });
    }
    return out;
  }, [data]);

  const peakFlow = useMemo(
    () => chartData.reduce((mx, item) => (item.flow > mx ? item.flow : mx), 0),
    [chartData],
  );

  // 下拉列表里的全部用户（按名称排序）
  const allUsers = useMemo(
    () => [...(data?.users || [])].sort((a, b) => a.user.localeCompare(b.user)),
    [data],
  );

  // 排序后的完整匹配用户列表
  const sortedUsers = useMemo(() => {
    return [...(data?.users || [])]
      .filter((u) => picked.size === 0 || picked.has(String(u.id)))
      .sort((a, b) => (sortAsc ? a[sortKey] - b[sortKey] : b[sortKey] - a[sortKey]));
  }, [data, sortKey, sortAsc, picked]);

  // 未筛选且未手动展开时，默认只展示流量最多的前 4 位，节省版面
  const visibleUsers = useMemo(() => {
    if (picked.size > 0 || showAllUsers) return sortedUsers;
    return sortedUsers.slice(0, DEFAULT_TOP_USERS);
  }, [sortedUsers, picked.size, showAllUsers]);

  const activeMetricTotal = useMemo(
    () => sortedUsers.reduce((sum, u) => sum + (u[sortKey] || 0), 0),
    [sortedUsers, sortKey],
  );

  const handleSortTab = (key: SortKey) => {
    if (key === sortKey) {
      setSortAsc((prev) => !prev);
    } else {
      setSortKey(key);
      setSortAsc(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="px-3 lg:px-6 pt-4 flex items-center justify-center h-64">
        <div className="flex items-center gap-3">
          <div className="animate-spin h-5 w-5 border-2 border-gray-200 dark:border-gray-700 border-t-gray-600 dark:border-t-gray-300 rounded-full" />
          <span className="text-default-600">正在加载数据...</span>
        </div>
      </div>
    );
  }

  const d =
    data ||
    ({
      nodeTotal: 0,
      nodeOnline: 0,
      totalUsedFlow: 0,
      todayFlow: 0,
      monthFlow: 0,
      userCount: 0,
      users: [],
      statisticsFlows: [],
    } as Overview);

  const sortTabs: { key: SortKey; label: string }[] = [
    { key: "todayFlow", label: "今日" },
    { key: "monthFlow", label: "本月" },
    { key: "usedFlow", label: "已用" },
  ];
  const activeTabLabel = sortTabs.find((t) => t.key === sortKey)?.label || "今日";
  const hiddenCount = sortedUsers.length - visibleUsers.length;

  return (
    <div className="px-3 lg:px-6 py-2 lg:py-4 space-y-4">
      {/* 顶部 4 格 KPI 指标行 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="在线节点"
          value={`${d.nodeOnline} / ${d.nodeTotal}`}
          sub={d.nodeTotal - d.nodeOnline > 0 ? `${d.nodeTotal - d.nodeOnline} 离线` : "全部在线"}
          color="bg-[var(--fz-fill)] text-[var(--fz-green)]"
          icon={icon(
            "M2 5a2 2 0 012-2h12a2 2 0 012 2v2a2 2 0 01-2 2H4a2 2 0 01-2-2V5zm14 1a1 1 0 11-2 0 1 1 0 012 0zM2 13a2 2 0 012-2h12a2 2 0 012 2v2a2 2 0 01-2 2H4a2 2 0 01-2-2v-2zm14 1a1 1 0 11-2 0 1 1 0 012 0z",
          )}
        />
        <StatCard
          label="总使用流量"
          value={formatFlow(d.totalUsedFlow)}
          sub={`${d.userCount} 位用户`}
          color="bg-[var(--fz-fill)] text-[var(--fz-accent)]"
          icon={icon(
            "M5.2 8.6h2v7.9h-2zM2.7 8.6h7L6.2 4.2zM12.8 3.5h2v7.9h-2zM10.3 11.4h7l-3.5 4.4z",
          )}
        />
        <StatCard
          label="今日流量"
          value={formatFlow(d.todayFlow)}
          color="bg-[var(--fz-fill)] text-[var(--fz-accent)]"
          icon={icon(
            "M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z",
          )}
        />
        <StatCard
          label="本月流量"
          value={formatFlow(d.monthFlow)}
          color="bg-[var(--fz-fill)] text-[var(--fz-accent)]"
          icon={icon(
            "M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z",
          )}
        />
      </div>

      {/* 下半主区：左 24h 流量趋势（5/12） + 右 用户流量卡片板块（7/12），PC 端等高并排，手机端自然堆叠 */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-stretch">
        {/* 左侧：24 小时流量统计 */}
        <Card className="fz-card xl:col-span-5 flex flex-col">
          <CardHeader className="px-4 py-3.5">
            <div className="flex items-center justify-between gap-2 w-full">
              <div className="flex items-baseline gap-2 min-w-0">
                <h2 className="text-[15px] font-semibold text-foreground truncate">24小时流量统计</h2>
                <span className="text-[11px] text-default-500 tabular-nums whitespace-nowrap">
                  峰值 {formatFlow(peakFlow)}/H
                </span>
              </div>
              <Button size="sm" variant="flat" className="h-8 min-w-0 px-3 text-xs flex-shrink-0" onPress={() => load()} isLoading={loading}>
                刷新
              </Button>
            </div>
          </CardHeader>
          <Divider />
          <CardBody className="px-2 pb-3 pt-2 flex-1 flex flex-col">
            <div className="h-52 sm:h-60 xl:flex-1 xl:min-h-[340px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 8, right: 12, left: -8, bottom: 0 }} accessibilityLayer={false}>
                  <defs>
                    <linearGradient id="fzOverviewAreaGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--fz-accent)" stopOpacity={0.32} />
                      <stop offset="100%" stopColor="var(--fz-accent)" stopOpacity={0.01} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--fz-hairline)" vertical={false} />
                  <XAxis
                    dataKey="time"
                    tick={{ fontSize: 11, fill: "var(--fz-muted)" }}
                    tickLine={false}
                    axisLine={{ stroke: "var(--fz-hairline)", strokeWidth: 1 }}
                    minTickGap={24}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "var(--fz-muted)" }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={axisFlow}
                    width={48}
                  />
                  <Tooltip
                    content={({ active, payload, label }) =>
                      active && payload && payload.length ? (
                        <div className="fz-card px-3 py-2 text-xs">
                          <p className="text-default-500">{`时间 ${label}`}</p>
                          <p className="font-semibold text-foreground tabular-nums mt-0.5">
                            {formatFlow((payload[0]?.value as number) || 0)}
                          </p>
                        </div>
                      ) : null
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="flow"
                    stroke="var(--fz-accent)"
                    strokeWidth={2.4}
                    fill="url(#fzOverviewAreaGrad)"
                    dot={false}
                    activeDot={{ r: 4, stroke: "var(--fz-accent)", strokeWidth: 2, fill: "var(--fz-surface)" }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardBody>
        </Card>

        {/* 右侧：用户流量独立卡片板块（内置子卡片，彻底告别裸贴背景） */}
        <Card className="fz-card xl:col-span-7 flex flex-col">
          <CardHeader className="px-4 py-3.5">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 w-full">
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                <h2 className="text-[15px] font-semibold text-foreground">用户流量</h2>
                <span className="fz-cell px-2 py-0.5 text-default-600 text-[11px] font-semibold tabular-nums">
                  {picked.size > 0
                    ? `${visibleUsers.length} / ${allUsers.length}`
                    : hiddenCount > 0
                      ? `Top ${visibleUsers.length} / ${sortedUsers.length}`
                      : sortedUsers.length}
                </span>
                <span className="text-xs text-default-500 tabular-nums whitespace-nowrap">
                  {activeTabLabel}合计{" "}
                  <strong className="font-semibold text-foreground">{formatFlow(activeMetricTotal)}</strong>
                </span>
              </div>

              <div className="flex items-center justify-between sm:justify-end gap-2 w-full sm:w-auto flex-shrink-0">
                <UserFilter
                  picked={picked}
                  users={allUsers.map((u) => ({ id: u.id, name: u.user }))}
                  onChange={setPicked}
                />
                <div className="fz-segment flex-shrink-0" title="点击切换高亮维度与排序，再次点击切换升序/降序">
                  {sortTabs.map((t) => {
                    const active = sortKey === t.key;
                    return (
                      <button
                        key={t.key}
                        data-active={active}
                        type="button"
                        className="inline-flex items-center gap-1 cursor-pointer"
                        onClick={() => handleSortTab(t.key)}
                      >
                        <span>{t.label}</span>
                        {active && (
                          <span className="text-[10px] opacity-80 leading-none">
                            {sortAsc ? "↑" : "↓"}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </CardHeader>
          <Divider />
          <CardBody className="p-3.5 sm:p-4 flex-1 flex flex-col justify-between gap-3">
            {visibleUsers.length === 0 ? (
              <div className="flex-1 flex items-center justify-center py-14">
                <p className="text-default-500 text-sm">暂无用户</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {visibleUsers.map((u) => {
                    const badge = expBadge(u);
                    const isUnlimited = !u.flow || u.flow === 99999;
                    const isMonthlyReset = Boolean(u.flowResetTime && u.flowResetTime > 0);
                    const remainLabel = isMonthlyReset ? "本月剩余" : "流量剩余";
                    const limitBytes = isUnlimited ? 0 : u.flow * BYTES_PER_GB;
                    const remainBytes = isUnlimited ? 0 : Math.max(0, limitBytes - u.usedFlow);
                    const usedPct = isUnlimited || limitBytes <= 0 ? 0 : Math.min((u.usedFlow / limitBytes) * 100, 100);
                    const sharePct =
                      activeMetricTotal > 0 ? Math.round(((u[sortKey] || 0) / activeMetricTotal) * 100) : 0;

                    const remainColor = isUnlimited
                      ? "text-emerald-600 dark:text-emerald-400"
                      : usedPct >= 90
                        ? "text-red-500"
                        : usedPct >= 75
                          ? "text-amber-500"
                          : "text-foreground";

                    const barColor = isUnlimited
                      ? "var(--fz-accent)"
                      : usedPct >= 90
                        ? "var(--fz-red)"
                        : usedPct >= 75
                          ? "var(--fz-orange)"
                          : "var(--fz-accent)";

                    const metrics: { key: SortKey; label: string; value: number }[] = [
                      { key: "todayFlow", label: "今日", value: u.todayFlow },
                      { key: "monthFlow", label: "本月", value: u.monthFlow },
                      { key: "usedFlow", label: "已用", value: u.usedFlow },
                    ];

                    return (
                      <div key={u.id} className="fz-subcard p-3 flex flex-col gap-2.5">
                        {/* 头部：圆角矩形头像 + 用户名 + 精美年月日到期徽章 */}
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div className="fz-avatar w-8 h-8 text-xs font-bold uppercase">
                              {u.user.slice(0, 1)}
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-foreground truncate leading-tight">
                                {u.user}
                              </p>
                              <p className="text-[11px] text-default-500 leading-tight mt-0.5 tabular-nums">
                                转发 {u.num === 99999 ? u.forwardCount : `${u.forwardCount}/${u.num}`}
                              </p>
                            </div>
                          </div>

                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium tabular-nums whitespace-nowrap flex-shrink-0 ${badge.cls}`}
                            title={u.expTime ? `到期时间：${formatYMD(u.expTime)}` : "永不过期"}
                          >
                            {badge.isDate && <CalendarIcon />}
                            <span>{badge.text}</span>
                          </span>
                        </div>

                        {/* 中段：今日 / 本月 / 已用 三格指标（联动高亮） */}
                        <div className="grid grid-cols-3 gap-1.5">
                          {metrics.map((m) => {
                            const isSelected = sortKey === m.key;
                            return (
                              <div
                                key={m.key}
                                className="fz-cell px-2 py-1.5 transition-all"
                                style={
                                  isSelected
                                    ? {
                                        background: "var(--fz-accent-soft)",
                                        boxShadow: "inset 0 0 0 1px var(--fz-accent)",
                                      }
                                    : undefined
                                }
                              >
                                <p
                                  className="text-[10.5px] leading-tight"
                                  style={
                                    isSelected
                                      ? { color: "var(--fz-accent-text)", fontWeight: 600 }
                                      : { color: "var(--fz-muted)" }
                                  }
                                >
                                  {m.label}
                                </p>
                                <p
                                  className="text-xs font-bold tabular-nums mt-0.5 truncate leading-tight"
                                  style={{ color: isSelected ? "var(--fz-strong)" : "var(--fz-text)" }}
                                  title={formatFlow(m.value)}
                                >
                                  {formatFlow(m.value)}
                                </p>
                              </div>
                            );
                          })}
                        </div>

                        {/* 底部：本月剩余/流量剩余 + 总量 + 进度条 */}
                        <div className="fz-cell px-2.5 py-2 space-y-1.5">
                          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[11px] tabular-nums">
                            <span className="text-default-500 truncate">
                              {remainLabel}{" "}
                              <strong className={`font-semibold ${remainColor}`}>
                                {isUnlimited ? "无限制" : formatFlow(remainBytes)}
                              </strong>
                            </span>
                            <span className="text-default-500 whitespace-nowrap">
                              总量{" "}
                              <strong className="font-semibold text-foreground">
                                {formatQuotaGB(u.flow)}
                              </strong>
                              {isMonthlyReset ? ` · ${u.flowResetTime}日重置` : ""}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div
                              className="flex-1 h-1.5 rounded-full overflow-hidden"
                              style={{ background: "var(--fz-fill)" }}
                            >
                              <div
                                className="h-full rounded-full transition-all duration-300"
                                style={{
                                  width: `${isUnlimited ? sharePct : usedPct}%`,
                                  background: barColor,
                                }}
                              />
                            </div>
                            <span className="text-[10.5px] text-default-500 tabular-nums whitespace-nowrap">
                              {isUnlimited ? `${activeTabLabel}占比 ${sharePct}%` : `已用 ${Math.round(usedPct)}%`}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* 超出 4 位时的轻提示与一键展开/收起 */}
                {picked.size === 0 && sortedUsers.length > DEFAULT_TOP_USERS && (
                  <div className="flex items-center justify-between pt-1 text-xs text-default-500">
                    <span>
                      {showAllUsers
                        ? `当前已展示全部 ${sortedUsers.length} 位用户`
                        : `当前展示${activeTabLabel}流量前 ${DEFAULT_TOP_USERS} 位，其余 ${hiddenCount} 位可通过上方筛选查看`}
                    </span>
                    <button
                      type="button"
                      className="text-primary hover:underline font-medium cursor-pointer"
                      onClick={() => setShowAllUsers((prev) => !prev)}
                    >
                      {showAllUsers ? "收起至前 4 位" : `展开全部 (${sortedUsers.length})`}
                    </button>
                  </div>
                )}
              </>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
