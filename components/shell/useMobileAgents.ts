"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SubagentProfilesResponse, SubagentSettingsResponse } from "@/lib/api-types";
import type { ModelsData } from "@/lib/models-cache";
import { overridingSubagentScope, SUBAGENT_SCOPE_ORDER } from "@/lib/subagent-profile-precedence";
import { subagentScopeDirectory, subagentTargetPath } from "@/lib/subagent-scope-paths";
import type { SubagentProfile, SubagentScope, SubagentWritableScope } from "@/lib/subagents";

/**
 * 手机壳 Agents 三页（MobileAgentsPages）的数据层，与桌面 AgentsConfig 走同一套
 * API（/api/subagents/profiles + /api/subagents/settings + /api/models）。
 * 分组顺序 = SUBAGENT_SCOPE_ORDER（项目 > 工作区 > 全局 > 内置，谁赢谁在上）；
 * cwd 为空（无锚定工作区）时不发请求、分组为空。
 */

export function agentProfileKey(profile: Pick<SubagentProfile, "scope" | "name">): string {
  return `${profile.scope}:${profile.name}`;
}

export function isWritableAgentScope(scope: SubagentScope): scope is SubagentWritableScope {
  return scope === "global" || scope === "project";
}

/** 目录 hint / 写入路径与桌面同一出处（lib/subagent-scope-paths：global 目录从已加载配置反推）。 */
export const agentScopeDirectory = subagentScopeDirectory;
export const agentTargetPath = subagentTargetPath;

const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME_RE.test(name.trim());
}

/** 与桌面 AgentsConfig 相同的新建默认值（lib 可写属性集）。 */
export function emptyAgentDraft(name: string): Omit<SubagentProfile, "scope" | "filePath"> {
  return {
    name,
    displayName: name,
    description: "",
    systemPrompt: "",
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    loadSkills: false,
    loadExtensions: false,
    promptMode: "append",
    inheritContext: false,
    runInBackground: false,
    enabled: true,
  };
}

export function duplicateAgentName(name: string, profiles: readonly SubagentProfile[]): string {
  const existing = new Set(profiles.map((profile) => profile.name.toLowerCase()));
  const base = `${name}-copy`;
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate.toLowerCase())) candidate = `${base}-${suffix++}`;
  return candidate;
}

/** 可编辑投影（scope/filePath 之外全量拷贝，可选字段仅在存在时带上）。 */
export function editableAgentDraft(profile: SubagentProfile): Omit<SubagentProfile, "scope" | "filePath"> {
  return {
    name: profile.name,
    displayName: profile.displayName,
    description: profile.description,
    systemPrompt: profile.systemPrompt,
    tools: [...profile.tools],
    loadSkills: profile.loadSkills,
    loadExtensions: profile.loadExtensions,
    promptMode: profile.promptMode,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.thinking ? { thinking: profile.thinking } : {}),
    ...(profile.maxTurns ? { maxTurns: profile.maxTurns } : {}),
    inheritContext: profile.inheritContext,
    runInBackground: profile.runInBackground,
    enabled: profile.enabled,
  };
}

export interface AgentScopeGroup {
  scope: SubagentScope;
  profiles: SubagentProfile[];
}

export function groupAgentsByScope(profiles: readonly SubagentProfile[]): AgentScopeGroup[] {
  return SUBAGENT_SCOPE_ORDER
    .map((scope) => ({ scope, profiles: profiles.filter((profile) => profile.scope === scope) }))
    .filter((group) => group.profiles.length > 0);
}

export function useMobileAgents({ cwd }: { cwd: string }) {
  const [profiles, setProfiles] = useState<SubagentProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [builtInEnabled, setBuiltInEnabled] = useState(false);
  const [maxConcurrent, setMaxConcurrent] = useState(10);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [togglingKeys, setTogglingKeys] = useState<Set<string>>(() => new Set());

  const [modelOptions, setModelOptions] = useState<ModelsData["modelList"]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deletingKeys, setDeletingKeys] = useState<Set<string>>(() => new Set());
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const loadProfiles = useCallback(async () => {
    if (!cwd) {
      setProfiles([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      const data = await res.json() as Partial<SubagentProfilesResponse> & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setProfiles(data.profiles ?? []);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    const controller = new AbortController();
    setSettingsLoading(true);
    setSettingsError(null);
    void (async () => {
      try {
        const res = await fetch("/api/subagents/settings", { cache: "no-store", signal: controller.signal });
        const data = await res.json() as Partial<SubagentSettingsResponse> & { error?: string };
        if (!res.ok || data.error || typeof data.enabled !== "boolean") {
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        setBuiltInEnabled(data.enabled);
        if (typeof data.maxConcurrent === "number") setMaxConcurrent(data.maxConcurrent);
      } catch (error) {
        if (controller.signal.aborted) return;
        setSettingsError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!controller.signal.aborted) setSettingsLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!cwd) {
      setModelOptions([]);
      setModelsLoading(false);
      return;
    }
    const controller = new AbortController();
    setModelsLoading(true);
    setModelsError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/models?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal });
        const data = await res.json() as Partial<ModelsData> & { error?: string };
        if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
        setModelOptions(data.modelList ?? []);
        setModelsError(data.modelError ?? null);
      } catch (error) {
        if (controller.signal.aborted) return;
        setModelsError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!controller.signal.aborted) setModelsLoading(false);
      }
    })();
    return () => controller.abort();
  }, [cwd]);

  const groups = useMemo(() => groupAgentsByScope(profiles), [profiles]);

  const overriddenBy = useCallback(
    (profile: SubagentProfile): SubagentScope | null => overridingSubagentScope(profile, profiles),
    [profiles],
  );

  const toggleEnabled = useCallback(async (profile: SubagentProfile) => {
    if (!isWritableAgentScope(profile.scope) || !cwd) return;
    const key = agentProfileKey(profile);
    setSettingsError(null);
    setDeleteError(null);
    setTogglingKeys((prev) => new Set(prev).add(key));
    try {
      const res = await fetch("/api/subagents/profiles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, scope: profile.scope, name: profile.name, enabled: !profile.enabled }),
      });
      const data = await res.json() as { profile?: SubagentProfile; error?: string };
      if (!res.ok || data.error || !data.profile) throw new Error(data.error ?? `HTTP ${res.status}`);
      const saved = data.profile;
      setProfiles((prev) => prev.map((item) => agentProfileKey(item) === key ? saved : item));
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setTogglingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [cwd]);

  const toggleBuiltIn = useCallback(async (enabled: boolean) => {
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const res = await fetch("/api/subagents/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json() as Partial<SubagentSettingsResponse> & { error?: string };
      if (!res.ok || data.error || typeof data.enabled !== "boolean") {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setBuiltInEnabled(data.enabled);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSettingsSaving(false);
    }
  }, []);

  const changeMaxConcurrent = useCallback(async (value: number) => {
    setMaxConcurrent(value);
    setSettingsError(null);
    try {
      const res = await fetch("/api/subagents/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxConcurrent: value }),
      });
      const data = await res.json() as Partial<SubagentSettingsResponse> & { error?: string };
      if (!res.ok || data.error || typeof data.maxConcurrent !== "number") throw new Error(data.error ?? `HTTP ${res.status}`);
      setMaxConcurrent(data.maxConcurrent);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const saveProfile = useCallback(async (
    scope: SubagentWritableScope,
    profile: Omit<SubagentProfile, "scope" | "filePath">,
  ): Promise<SubagentProfile | null> => {
    if (!cwd) throw new Error("没有锚定工作区，无法保存");
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/subagents/profiles", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, scope, profile }),
      });
      const data = await res.json() as { profile?: SubagentProfile; error?: string };
      if (!res.ok || data.error || !data.profile) throw new Error(data.error ?? `HTTP ${res.status}`);
      const saved = data.profile;
      setProfiles((prev) => {
        const key = agentProfileKey(saved);
        const exists = prev.some((item) => agentProfileKey(item) === key);
        return exists
          ? prev.map((item) => agentProfileKey(item) === key ? saved : item)
          : [...prev, saved];
      });
      return saved;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setSaving(false);
    }
  }, [cwd]);

  const deleteProfile = useCallback(async (profile: SubagentProfile): Promise<boolean> => {
    if (!isWritableAgentScope(profile.scope) || !cwd) return false;
    const key = agentProfileKey(profile);
    setDeleteError(null);
    setDeletingKeys((prev) => new Set(prev).add(key));
    try {
      const res = await fetch("/api/subagents/profiles", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, scope: profile.scope, name: profile.name }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setProfiles((prev) => prev.filter((item) => agentProfileKey(item) !== key));
      return true;
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setDeletingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [cwd]);

  return {
    cwd,
    profiles,
    groups,
    loading,
    loadError,
    builtInEnabled,
    maxConcurrent,
    settingsLoading,
    settingsSaving,
    settingsError,
    togglingKeys,
    modelOptions,
    modelsLoading,
    modelsError,
    saving,
    saveError,
    deletingKeys,
    deleteError,
    overriddenBy,
    toggleEnabled,
    toggleBuiltIn,
    changeMaxConcurrent,
    saveProfile,
    deleteProfile,
  };
}

export type MobileAgentsState = ReturnType<typeof useMobileAgents>;
