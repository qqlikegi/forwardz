import { useEffect, useState } from "react";
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Divider } from "@heroui/divider";
import toast from "react-hot-toast";

import { NumberInput, isValidNumber } from "@/components/number-input";
import { getFlowPolicy, saveFlowPolicy } from "@/api";

interface FlowPolicyForm {
  intervalMin: number;
  thresholdMb: number;
  minKb: number;
}

const DEFAULT_FORM: FlowPolicyForm = {
  intervalMin: 10,
  thresholdMb: 1024,
  minKb: 64,
};

/** 节点流量上报策略：定时 + 流量阈值双触发 + 微小噪点过滤，保存后实时下发所有在线节点 */
export default function FlowPolicySettings() {
  const [form, setForm] = useState<FlowPolicyForm>(DEFAULT_FORM);
  const [original, setOriginal] = useState<FlowPolicyForm>(DEFAULT_FORM);
  const [onlineNodes, setOnlineNodes] = useState<number>(0);
  const [supported, setSupported] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);

  const load = async () => {
    try {
      const res = await getFlowPolicy();
      if (res.code === 0 && res.data) {
        const next: FlowPolicyForm = {
          intervalMin: Number(res.data.intervalMin ?? DEFAULT_FORM.intervalMin),
          thresholdMb: Number(res.data.thresholdMb ?? DEFAULT_FORM.thresholdMb),
          minKb: Number(res.data.minKb ?? DEFAULT_FORM.minKb),
        };
        setForm(next);
        setOriginal(next);
        setOnlineNodes(Number(res.data.onlineNodes ?? 0));
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

  const valid =
    isValidNumber(form.intervalMin, 1, 60) &&
    isValidNumber(form.thresholdMb, 0, 102400) &&
    isValidNumber(form.minKb, 0, 10240);

  const changed =
    form.intervalMin !== original.intervalMin ||
    form.thresholdMb !== original.thresholdMb ||
    form.minKb !== original.minKb;

  const handleSave = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      const res = await saveFlowPolicy(form);
      if (res.code === 0 && res.data) {
        const next: FlowPolicyForm = {
          intervalMin: Number(res.data.intervalMin ?? form.intervalMin),
          thresholdMb: Number(res.data.thresholdMb ?? form.thresholdMb),
          minKb: Number(res.data.minKb ?? form.minKb),
        };
        setForm(next);
        setOriginal(next);
        const pushed = Number(res.data.pushedNodes ?? 0);
        setOnlineNodes(pushed);
        toast.success(
          pushed > 0
            ? `策略已保存，已实时下发至 ${pushed} 台在线节点生效`
            : "策略已保存，节点上线后将自动同步生效",
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
              <h2 className="text-[16px] font-semibold text-foreground">节点流量上报策略</h2>
              <span className="fz-cell !rounded-full px-2 py-0.5 text-[11px] font-medium text-default-500 tabular-nums">
                在线 {onlineNodes} 台
              </span>
            </div>
            <p className="text-xs text-default-500 mt-0.5">
              定时 + 流量阈值双触发合并上报并过滤微小噪点，保存后实时下发全部在线节点
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 self-end sm:self-center">
            <Button
              size="sm"
              color="primary"
              className="whitespace-nowrap"
              onPress={handleSave}
              isLoading={saving}
              isDisabled={!valid || saving}
            >
              {saving ? "保存中..." : changed ? "保存并下发" : "重新下发"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <Divider />
      <CardBody className="px-5 py-5 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <NumberInput
            label="定时上报间隔（分钟）"
            value={form.intervalMin}
            onValueChange={(v) => setForm((p) => ({ ...p, intervalMin: v }))}
            min={1}
            max={60}
            variant="bordered"
            description="默认 10 分钟；越大越省数据库写入"
          />
          <NumberInput
            label="流量快报阈值（MB）"
            value={form.thresholdMb}
            onValueChange={(v) => setForm((p) => ({ ...p, thresholdMb: v }))}
            min={0}
            max={102400}
            variant="bordered"
            description="默认 1024 MB（1 GB），达到立即上报；0 为关闭"
          />
          <NumberInput
            label="微小噪点过滤（KB）"
            value={form.minKb}
            onValueChange={(v) => setForm((p) => ({ ...p, minKb: v }))}
            min={0}
            max={10240}
            variant="bordered"
            description="默认 64 KB；低于此值先在节点累加，满 1 小时兜底"
          />
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
          <p>· 双触发规则：任意节点距上次上报满「间隔分钟」，或累计未报流量达到「快报阈值」，即立即批量写入一次面板。</p>
          <p>· 零丢数保障：被噪点过滤暂存的小流量会一直在节点内存中累加，满 1 小时或节点升级/停止前会自动全量补报。</p>
          <p>· 需节点端版本 ≥ 1.04 生效（旧版 1.03 节点会自动忽略该策略字段，兼容不受影响）。</p>
        </div>
      </CardBody>
    </Card>
  );
}
