"use client";

import { useCallback, useEffect, useState } from "react";
import type { WorkItemRecord } from "@/lib/work-items/types";
import { responseJson } from "./work-item-api";
import type { DeliveryExecutionState, ExecutionActionResult } from "./WorkItemExecution";

/**
 * 交付自动执行状态（Phase-2 Task 9）的宿主侧 hook：仅 managed 项（item.delivery
 * 存在）且非回收站时拉取 GET delivery-execution；选中项 revision 变化（任一
 * mutation 成功 → invalidate → 快照新 revision）一并重拉；三个动作成功后显式补拉。
 * 非 managed / 回收站 / 未选中 → execution 为 null，不拉不显。
 *
 * 2026-10 手机原生工作项页（MobileWorkItemDetailPage）从 WorkItemsPage 的同款
 * 内联逻辑抽出；桌面页仍持有自己的一份——两处语义必须一致（停止 / 重新检查并
 * 恢复 / 恢复自动领取 三条路由与 409 文案原样透传）。
 */
export function useDeliveryExecution({
  workspaceId,
  item,
  trashed = false,
  invalidate,
}: {
  workspaceId: string;
  /** 当前选中记录（null = 未选中）。 */
  item: WorkItemRecord | null;
  /** 回收站命中：不拉执行状态。 */
  trashed?: boolean;
  /** 动作成功后刷新共享快照。 */
  invalidate: () => void;
}): {
  execution: DeliveryExecutionState | null;
  busy: boolean;
  stop: () => Promise<ExecutionActionResult>;
  recover: () => Promise<ExecutionActionResult>;
  resumeAutomation: () => Promise<ExecutionActionResult>;
} {
  const [execution, setExecution] = useState<DeliveryExecutionState | null>(null);
  const [busy, setBusy] = useState(false);

  const executionItemKey = item && !trashed && item.delivery ? item.key : null;
  const revision = item?.revision;

  const fetchExecutionState = useCallback(async (key: string): Promise<DeliveryExecutionState | null> => {
    try {
      return await responseJson<DeliveryExecutionState>(
        await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(key)}/delivery-execution`,
        ),
      );
    } catch {
      // runtime/ 是 advisory 运行态——读失败按「无」处理，不打断详情。
      return null;
    }
  }, [workspaceId]);

  useEffect(() => {
    if (!executionItemKey) {
      setExecution(null);
      return;
    }
    // 取消守卫：切项时在飞旧响应不得覆盖新选中项的执行状态。
    let cancelled = false;
    void fetchExecutionState(executionItemKey).then((state) => {
      if (!cancelled) setExecution(state);
    });
    return () => {
      cancelled = true;
    };
  }, [executionItemKey, revision, fetchExecutionState]);

  /** 停止执行（POST delivery-execution/stop）：定向杀角色会话 + 记中断。 */
  const stop = useCallback(async (): Promise<ExecutionActionResult> => {
    if (!executionItemKey) return { ok: false, error: "当前没有可停止的执行" };
    setBusy(true);
    try {
      await responseJson(
        await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(executionItemKey)}/delivery-execution/stop`,
          { method: "POST" },
        ),
      );
      invalidate();
      setExecution(await fetchExecutionState(executionItemKey));
      return { ok: true };
    } catch (stopError) {
      return { ok: false, error: stopError instanceof Error ? stopError.message : String(stopError) };
    } finally {
      setBusy(false);
    }
  }, [executionItemKey, fetchExecutionState, invalidate, workspaceId]);

  /** 重新检查并恢复（POST delivery-execution/recover，manual）：409 = 探测到残留
   *  命令进程——服务端 error 已含 pid 清单，原样映射成内联提示。 */
  const recover = useCallback(async (): Promise<ExecutionActionResult> => {
    if (!executionItemKey) return { ok: false, error: "没有待恢复的执行中断" };
    setBusy(true);
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(executionItemKey)}/delivery-execution/recover`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ manual: true }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: body.error ?? `恢复被拒绝（HTTP ${response.status}）` };
      }
      invalidate();
      setExecution(await fetchExecutionState(executionItemKey));
      return { ok: true };
    } catch (recoverError) {
      return { ok: false, error: recoverError instanceof Error ? recoverError.message : String(recoverError) };
    } finally {
      setBusy(false);
    }
  }, [executionItemKey, fetchExecutionState, invalidate, workspaceId]);

  /** 恢复自动领取（POST /delivery/resume {key}）：清暂停标记 + 重置失败窗口。 */
  const resumeAutomation = useCallback(async (): Promise<ExecutionActionResult> => {
    if (!executionItemKey) return { ok: false, error: "没有暂停的自动领取" };
    setBusy(true);
    try {
      await responseJson(
        await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/delivery/resume`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: executionItemKey }),
        }),
      );
      invalidate();
      setExecution(await fetchExecutionState(executionItemKey));
      return { ok: true };
    } catch (resumeError) {
      return { ok: false, error: resumeError instanceof Error ? resumeError.message : String(resumeError) };
    } finally {
      setBusy(false);
    }
  }, [executionItemKey, fetchExecutionState, invalidate, workspaceId]);

  return { execution, busy, stop, recover, resumeAutomation };
}
