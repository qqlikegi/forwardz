import { useEffect, useState } from "react";
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Divider } from "@heroui/divider";
import toast from "react-hot-toast";

import { NumberInput, isValidNumber } from "@/components/number-input";
import { getLatencyPolicy, saveLatencyPolicy } from "@/api";

const DEFAULT_INTERVAL_SEC = 60;

const PRESETS: Array<{ value: number; label: string; tag: string }> = [
  { value: 10, label: "10 秒", tag: "超高频" },
  { value: 20, label: "20 秒", tag: "高频" },
  { value: 30, label: "30 秒", tag: "较快" },
  { value: 60, label: "1 分钟", tag: "默认" },
  { value: 180, label: "3 分钟", tag: "均衡" },
  { value: 600, label: "10 分钟", tag: "节能" },
  { value: 1800, label: "30 分钟", tag: "省电" },
  { value: 3600, label: "60 分钟", tag: "极省" },
  { value: 0, label: "关闭自动", tag: "仅手动" },
];

const formatIntervalLabel = (sec: number): string => {
  if (sec <= 0) return "已关闭自动";
  if (sec < 60) return `每 ${sec} 秒`;
  if (sec % 60 === 0) return `每 ${sec / 60} 分钟`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `每 ${m} 分 ${s} 秒`;
};

/** 隧道与转发 24h 延迟自动探测间隔配置：支持 10s–60m 预设或自定义秒数，底层 5 分钟分桶聚合省额度 */
export default function LatencyProbeSettings() {
  const [intervalSec, setIntervalSec] = useState<number>(DEFAULT_INTERVAL_SEC);
  const [original, setOriginal] = useState<number>(DEFAULT_INTERVAL_SEC);
  const [supported, setSupported] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);

  const load = async () => {
    try {
      const res = await getLatencyPolicy();
      if (res.code === 0 && res.data) {
        const v =
          res.data.intervalSec !== undefined && res.data.intervalSec !== null
            ? Number(res.data.intervalSec)
            : Number(res.data.intervalMin ?? 1) * 60;
        const safeV = Number.isFinite(v) ? v : DEFAULT_INTERVAL_SEC;
        setIntervalSec(safeV);
        setOriginal(safeV);
      } else {
        setSupported(false);
      }
    } catch {
      setSupported(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (!supported) return null;

  const valid = intervalSec === 0 || isValidNumber(intervalSec, 10, 3600);
  const changed = intervalSec !== original;
  const dailyRuns = intervalSec > 0 ? Math.floor(86400 / intervalSec) : 0;

  // 基于 5 分钟分桶聚合存储（每轮仅写 1 行 SQLite，亚分钟走 DO alarm，≥1m 走单 Cron）估算 CF Free 日额度占比
  const quotaHint = (() => {
    if (intervalSec === 0) {
      return "后台 0 探测、0 数据库写入；点击卡片「测速」或「诊断」仍可即时更新。";
    }
    if (!valid) {
      return "请输入 0（关闭）或 10–3600 秒之间的整数。";
    }
    if (intervalSec < 60) {
      const writesPct = Math.max(1, Math.round(((dailyRuns * 3) / 100000) * 100));
      const reqPct = Math.max(1, Math.round(((dailyRuns * 2) / 100000) * 100));
      return `已启用 5 分钟分桶聚合 + 单次快探（count=1）：CF Free 约占 ~${writesPct}% 写行 / ~${reqPct}% DO 请求，免费版可稳跑。`;
    }
    const writesPct = ((dailyRuns / 100000) * 100).toFixed(1);
    return `走统一单 Cron + 5 分钟分桶聚合：CF Free 仅占约 ${writesPct}% 写行，极度省额度。`;
  })();

  const handleSave = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      const res = await saveLatencyPolicy({ intervalSec });
      if (res.code === 0 && res.data) {
        const next = Number(res.data.intervalSec ?? intervalSec);
        setIntervalSec(next);
        setOriginal(next);
        toast.success(
          next === 0
            ? "已关闭自动探测，仅保留卡片手动「测速」与「诊断」采样"
            : `探测间隔已保存为${formatIntervalLabel(next)}`,
        );
      } else {
        toast.error(res.msg || "保存失败");
      }
    } catch {
      toast.error("保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="fz-card">
      <CardHeader className="px-5 py-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 w-full">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-[16px] font-semibold text-foreground">延迟自动探测间隔</h2>
              <span className="fz-cell !rounded-full px-2 py-0.5 text-[11px] font-medium text-default-500 tabular-nums">
                当前{formatIntervalLabel(original)}
              </span>
            </div>
            <p className="text-xs text-default-500 mt-0.5">
              控制隧道链路与转发落地 24h 延迟波形图的自动采样频率（默认 1 分钟），支持 10 秒高频监控，保存后即时生效
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 self-end sm:self-center">
            <Button
              size="sm"
              color="primary"
              className="whitespace-nowrap"
              onPress={handleSave}
              isLoading={saving}
              isDisabled={!valid || !changed || saving}
            >
              {saving ? "保存中..." : "保存间隔"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <Divider />
      <CardBody className="px-5 py-5 space-y-4">
        {/* 快捷预设档位 */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-default-600">常用频率预设</div>
          <div className="grid grid-cols-3 md:grid-cols-9 gap-2">
            {PRESETS.map((p) => {
              const active = intervalSec === p.value;
              return (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setIntervalSec(p.value)}
                  className={`px-2 py-2 text-center border transition-colors cursor-pointer ${
                    active
                      ? "bg-primary/15 border-primary text-primary font-semibold"
                      : "fz-cell hover:bg-[var(--fz-fill)] text-foreground"
                  }`}
                  style={{ borderRadius: "var(--fz-r-cell)" }}
                >
                  <div className="text-xs leading-tight whitespace-nowrap">{p.label}</div>
                  <div className={`text-[10px] mt-0.5 leading-tight ${active ? "text-primary/80" : "text-default-400"}`}>
                    {p.tag}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* 自定义输入 + 每日采样密度与 CF 额度预估 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
          <NumberInput
            label="自定义探测间隔（秒）"
            value={intervalSec}
            onValueChange={(v) => setIntervalSec(v)}
            min={0}
            max={3600}
            variant="bordered"
            description="支持 10–3600 秒（10秒–60分钟），填 0 表示关闭自动探测"
          />
          <div className="fz-cell px-3.5 py-3 space-y-1">
            <div className="text-xs font-medium text-default-600">采样密度与 CF Free 额度预估</div>
            <div className="text-sm font-semibold text-foreground tabular-nums">
              {intervalSec === 0
                ? "仅手动测速 / 诊断记录"
                : !valid
                  ? "请输入 0 或 10–3600 之间的整数"
                  : `${formatIntervalLabel(intervalSec)} · 约 ${dailyRuns.toLocaleString()} 次 / 天`}
            </div>
            <div className="text-[11px] text-default-500 leading-relaxed">{quotaHint}</div>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
