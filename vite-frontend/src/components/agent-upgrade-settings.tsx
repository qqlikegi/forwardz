import { useEffect, useRef, useState } from "react";
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Chip } from "@heroui/chip";
import { Divider } from "@heroui/divider";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/modal";
import { Switch } from "@heroui/switch";
import toast from "react-hot-toast";

import { getAgentUpgradeInfo, upgradeAgents } from "@/api";

interface NodeUpgradeState {
  status:
    | "idle"
    | "started"
    | "downloading"
    | "verifying"
    | "restarting"
    | "success"
    | "up_to_date"
    | "unsupported"
    | "offline"
    | "failed";
  message: string;
  fromVersion?: string;
  toVersion?: string;
  updatedAt: number;
}

interface UpgradeNodeItem {
  id: number;
  name: string;
  status: number;
  version: string;
  supportsRemoteUpgrade: boolean;
  needsUpgrade: boolean;
  upgradeState: NodeUpgradeState | null;
}

interface UpgradeInfoData {
  repo: string;
  latestVersion: string;
  releaseUrl: string;
  publishedAt: string;
  fetchError?: string;
  nodes: UpgradeNodeItem[];
}

const ACTIVE_STATUSES = new Set(["started", "downloading", "verifying", "restarting"]);

/** 节点端远程一键更新：通过加密 WebSocket 触发在线节点自动下载、校验并重启升级至最新 Release */
export default function AgentUpgradeSettings() {
  const [info, setInfo] = useState<UpgradeInfoData | null>(null);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [forceUpgrade, setForceUpgrade] = useState(false);
  const [singleTarget, setSingleTarget] = useState<UpgradeNodeItem | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const pollCountRef = useRef<number>(0);

  const stopPolling = () => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollCountRef.current = 0;
  };

  const fetchInfo = async (refresh = false, quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await getAgentUpgradeInfo(refresh);
      if (res.code === 0 && res.data) {
        const data = res.data as UpgradeInfoData;
        setInfo(data);
        const anyActive = data.nodes.some(
          (n) => n.upgradeState && ACTIVE_STATUSES.has(n.upgradeState.status),
        );
        if (!anyActive && pollTimerRef.current !== null) {
          stopPolling();
        }
        if (refresh && !quiet) {
          if (data.fetchError) {
            toast.error(`检查更新受限：${data.fetchError}`);
          } else if (data.latestVersion) {
            const needCount = data.nodes.filter((n) => n.status === 1 && n.needsUpgrade).length;
            toast.success(
              needCount > 0
                ? `最新版本 v${data.latestVersion}，有 ${needCount} 台在线节点可更新`
                : `已是最新版本 v${data.latestVersion}`,
            );
          } else {
            toast.success("节点版本状态已刷新");
          }
        }
      } else if (refresh && !quiet) {
        toast.error(res.msg || "检查更新失败");
      } else {
        setSupported(false);
      }
    } catch {
      if (refresh && !quiet) {
        toast.error("检查更新失败，请稍后重试");
      } else if (!quiet) {
        setSupported(false);
      }
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  const startPolling = () => {
    stopPolling();
    pollTimerRef.current = window.setInterval(() => {
      pollCountRef.current += 1;
      if (pollCountRef.current > 45) {
        stopPolling();
        return;
      }
      fetchInfo(false, true);
    }, 2000);
  };

  useEffect(() => {
    fetchInfo(false, false);
    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!supported) return null;

  const nodes = info?.nodes ?? [];
  const onlineNodes = nodes.filter((n) => n.status === 1);
  const upgradableCount = onlineNodes.filter(
    (n) => n.supportsRemoteUpgrade && (forceUpgrade || n.needsUpgrade || !info?.latestVersion),
  ).length;
  const legacyOnlineCount = onlineNodes.filter((n) => !n.supportsRemoteUpgrade).length;
  const anyActive = nodes.some((n) => n.upgradeState && ACTIVE_STATUSES.has(n.upgradeState.status));

  const runUpgrade = async (nodeIds?: number[]) => {
    setConfirmOpen(false);
    setSingleTarget(null);
    setUpgrading(true);
    try {
      const res = await upgradeAgents({
        nodeIds,
        force: forceUpgrade,
      });
      if (res.code === 0 && res.data) {
        const results = (res.data.results ?? []) as Array<{ status: string; name: string }>;
        const started = results.filter((r) => r.status === "started").length;
        const upToDate = results.filter((r) => r.status === "up_to_date").length;
        const unsupported = results.filter((r) => r.status === "unsupported").length;
        const failed = results.filter((r) => r.status === "failed").length;

        const parts: string[] = [];
        if (started > 0) parts.push(`已下发升级 ${started} 台`);
        if (upToDate > 0) parts.push(`已是最新 ${upToDate} 台`);
        if (unsupported > 0) parts.push(`旧版需手动 zf 升级 ${unsupported} 台`);
        if (failed > 0) parts.push(`失败 ${failed} 台`);
        toast.success(parts.join("，") || "操作完成", { duration: 5000 });

        await fetchInfo(false, true);
        if (started > 0) startPolling();
      } else {
        toast.error(res.msg || "触发更新失败");
      }
    } catch {
      toast.error("触发更新失败，请重试");
    } finally {
      setUpgrading(false);
    }
  };

  const renderStatusChip = (n: UpgradeNodeItem) => {
    const st = n.upgradeState;
    if (st && st.status !== "idle") {
      const colorMap: Record<
        string,
        "primary" | "success" | "warning" | "danger" | "default"
      > = {
        started: "primary",
        downloading: "primary",
        verifying: "primary",
        restarting: "warning",
        success: "success",
        up_to_date: "success",
        unsupported: "warning",
        offline: "default",
        failed: "danger",
      };
      return (
        <Chip size="sm" variant="flat" color={colorMap[st.status] ?? "default"}>
          {st.message}
        </Chip>
      );
    }
    if (n.status !== 1) {
      return (
        <Chip size="sm" variant="flat" color="default">
          离线
        </Chip>
      );
    }
    if (!n.supportsRemoteUpgrade) {
      return (
        <Chip size="sm" variant="flat" color="warning">
          需先手动 zf 升至 1.04+
        </Chip>
      );
    }
    if (info?.latestVersion && n.version === info.latestVersion) {
      return (
        <Chip size="sm" variant="flat" color="success">
          已是最新
        </Chip>
      );
    }
    if (n.needsUpgrade) {
      return (
        <Chip size="sm" variant="flat" color="primary">
          可更新至 {info?.latestVersion}
        </Chip>
      );
    }
    return (
      <Chip size="sm" variant="flat" color="default">
        在线
      </Chip>
    );
  };

  return (
    <>
      <Card className="fz-card">
        <CardHeader className="px-5 py-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 w-full">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-[16px] font-semibold text-foreground">节点端远程更新</h2>
                {info?.latestVersion && (
                  <Chip size="sm" color="primary" variant="flat" className="h-5 text-[11px]">
                    最新 v{info.latestVersion}
                  </Chip>
                )}
              </div>
              <p className="text-xs text-default-500 mt-0.5">
                通过加密通道远程触发在线节点下载、校验并重启升级，无需逐台 SSH
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 self-end sm:self-center">
              <Button
                size="sm"
                variant="flat"
                className="whitespace-nowrap"
                onPress={() => fetchInfo(true, false)}
                isLoading={loading}
                isDisabled={upgrading}
              >
                检查更新
              </Button>
              <Button
                size="sm"
                color="primary"
                className="whitespace-nowrap"
                onPress={() => {
                  setSingleTarget(null);
                  setConfirmOpen(true);
                }}
                isLoading={upgrading || anyActive}
                isDisabled={onlineNodes.length === 0 || upgrading}
              >
                {anyActive ? "更新中..." : "一键更新全部"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <Divider />
        <CardBody className="px-5 py-5 space-y-4">
          {info?.fetchError && (
            <p className="text-xs text-warning-600 dark:text-warning-400">
              查询 GitHub 最新版本受限（{info.fetchError}），仍可直接点击更新让节点自动拉取最新 Release。
            </p>
          )}

          {nodes.length === 0 ? (
            <p className="text-sm text-default-500">暂无节点</p>
          ) : (
            <div className="space-y-2">
              {nodes.map((n) => (
                <div
                  key={n.id}
                  className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-3 rounded-lg border border-default-200 dark:border-default-100"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                        n.status === 1 ? "bg-success-500" : "bg-default-400"
                      }`}
                    />
                    <span className="font-medium text-sm truncate">{n.name}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap justify-end flex-shrink-0">
                    <Chip
                      size="sm"
                      variant="bordered"
                      className="font-mono text-xs tabular-nums min-w-[56px] text-center"
                    >
                      {n.version ? `v${n.version}` : "未知版本"}
                    </Chip>
                    {renderStatusChip(n)}
                    {n.status === 1 && n.supportsRemoteUpgrade && (
                      <Button
                        size="sm"
                        variant="light"
                        color="primary"
                        isDisabled={
                          upgrading ||
                          Boolean(n.upgradeState && ACTIVE_STATUSES.has(n.upgradeState.status))
                        }
                        onPress={() => {
                          setSingleTarget(n);
                          setConfirmOpen(true);
                        }}
                      >
                        更新
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pt-1">
            <div className="text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
              <p>· 安全机制：节点仅从官方仓库下载匹配架构的程序，先试运行 -V 校验通过后再备份 .bak 并替换重启。</p>
              {legacyOnlineCount > 0 && (
                <p className="text-warning-600 dark:text-warning-400">
                  · 当前有 {legacyOnlineCount} 台在线节点版本低于 1.04，请先 SSH 执行一次 zf → 更新到 1.04 后即可永久使用网页一键更新。
                </p>
              )}
            </div>
            <Switch size="sm" isSelected={forceUpgrade} onValueChange={setForceUpgrade}>
              <span className="text-xs text-default-500 whitespace-nowrap">强制重装同版本</span>
            </Switch>
          </div>
        </CardBody>
      </Card>

      <Modal isOpen={confirmOpen} onOpenChange={setConfirmOpen} placement="center">
        <ModalContent>
          <ModalHeader>
            {singleTarget ? `确认更新节点「${singleTarget.name}」` : "确认一键更新所有在线节点"}
          </ModalHeader>
          <ModalBody className="text-sm space-y-2">
            {singleTarget ? (
              <p>
                将向节点 <strong>{singleTarget.name}</strong>（当前 v{singleTarget.version || "未知"}）下发更新指令
                {info?.latestVersion ? `，目标版本 v${info.latestVersion}` : ""}。
              </p>
            ) : (
              <p>
                当前在线 <strong>{onlineNodes.length}</strong> 台节点，其中{" "}
                <strong>{upgradableCount}</strong> 台符合远程更新条件
                {info?.latestVersion ? `（目标版本 v${info.latestVersion}）` : ""}。
              </p>
            )}
            <p className="text-default-500 text-xs">
              升级过程中节点会先校验新文件完整性，替换并重启约中断 1–3 秒，转发配置会自动恢复，未上报流量会在重启前自动刷盘。
            </p>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button
              color="primary"
              onPress={() => runUpgrade(singleTarget ? [singleTarget.id] : undefined)}
            >
              立即更新
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
