import { useEffect, useState } from "react";
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Divider } from "@heroui/divider";
import toast from "react-hot-toast";

import { NumberInput, isValidNumber } from "@/components/number-input";
import { getLatencyPolicy, saveLatencyPolicy } from "@/api";

const DEFAULT_INTERVAL_MIN = 15;

const PRESETS: Array<{ value: number; label: string; tag: string }> = [
  { value: 5, label: "5 分钟", tag: "高频" },
  { value: 10, label: "10 分钟", tag: "较快" },
  { value: 15, label: "15 分钟", tag: "默认" },
  { value: 30, label: "30 分钟", tag: "节能" },
  { value: 60, label: "60 分钟", tag: "极省" },
  { value: 0, label: "关闭自动", tag: "仅手动" },
];

/** 隧道与转发 24h 延迟自动探测间隔配置：支持预设档位或自定义分钟数，保存后立即生效 */
export default function LatencyProbeSettings() {
  const [intervalMin, setIntervalMin] = useState<number>(DEFAULT_INTERVAL_MIN);
  const [original, setOriginal] = useState<number>(DEFAULT_INTERVAL_MIN);
  const [supported, setSupported] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);

  const load = async () => {
    try {
      const res = await getLatencyPolicy();
      if (res.code === 0 && res.data) {
        const v = Number(res.data.intervalMin ?? DEFAULT_INTERVAL_MIN);
        setIntervalMin(v);
        setOriginal(v);
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

  const valid = intervalMin === 0 || isValidNumber(intervalMin, 5, 120);
  const changed = intervalMin !== original;

  const dailyRuns = intervalMin > 0 ? Math.floor(1440 / intervalMin) : 0;

  const handleSave = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      const res = await saveLatencyPolicy({ intervalMin });
      if (res.code === 0 && res.data) {
        const next = Number(res.data.intervalMin ?? intervalMin);
        setIntervalMin(next);
        setOriginal(next);
        toast.success(
          next === 0
            ? "已关闭自动探测，仅保留卡片手动「测速」与「诊断」采样"
            : `探测间隔已保存为每 ${next} 分钟一次`,
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
                {original === 0 ? "已关闭自动" : `当前每 ${original} 分钟`}
              </span>
            </div>
            <p className="text-xs text-default-500 mt-0.5">
              控制隧道链路与转发落地 24h 延迟波形图的自动采样频率（默认 15 分钟），保存后立即生效
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
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {PRESETS.map((p) => {
              const active = intervalMin === p.value;
              return (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setIntervalMin(p.value)}
                  className={`px-2.5 py-2 text-center border transition-colors cursor-pointer ${
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

        {/* 自定义输入 + 每日采样次数预估 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
          <NumberInput
            label="自定义探测间隔（分钟）"
            value={intervalMin}
            onValueChange={(v) => setIntervalMin(v)}
            min={0}
            max={120}
            variant="bordered"
            description="支持 5–120 分钟（默认 15 分钟），填 0 表示关闭自动探测"
          />
          <div className="fz-cell px-3.5 py-3 space-y-1">
            <div className="text-xs font-medium text-default-600">采样密度与开销预估</div>
            <div className="text-sm font-semibold text-foreground tabular-nums">
              {intervalMin === 0
                ? "仅手动测速 / 诊断记录"
                : !valid
                  ? "请输入 0 或 5–120 之间的整数"
                  : `约 ${dailyRuns} 次 / 天（24h 波形最多 ${dailyRuns} 个点）`}
            </div>
            <div className="text-[11px] text-default-500">
              {intervalMin === 0
                ? "后台 0 探测、0 数据库写入；点击卡片「测速」或「诊断」仍可即时更新。"
                : intervalMin <= 5
                  ? "波形最细腻，适合排查短时抖动；CF Free 版按 5 分钟步进触发。"
                  : intervalMin <= 15
                    ? "兼顾波形清晰度与低开销（推荐档位），CF Free 额度占比极低。"
                    : "极低数据库写入与节点探针消耗，适合大量转发或极省额度场景。"}
            </div>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
