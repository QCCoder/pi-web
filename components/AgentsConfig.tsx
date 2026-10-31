"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import type {
  DeliveryRolePromptPreview,
  DeliveryRolesResponse,
  SubagentProfilesResponse,
  SubagentSettingsResponse,
} from "@/lib/api-types";
import { sendAgentCommand } from "@/lib/agent-client";
import type { ModelsData } from "@/lib/models-cache";
import {
  overridingSubagentScope,
  SUBAGENT_SCOPE_ORDER,
} from "@/lib/subagent-profile-precedence";
import { subagentScopeDirectory, subagentTargetPath } from "@/lib/subagent-scope-paths";
import type { SubagentProfile, SubagentScope, SubagentWritableScope } from "@/lib/subagents";
import {
  getLastSettingsSelection,
  setLastSettingsSelection,
} from "@/lib/settings-navigation";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigEmptyState,
  ConfigField,
  ConfigFooter,
  ConfigListAction,
  ConfigPanelShell,
  ConfigSidebar,
  ConfigSidebarGroupLabel,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSectionTitle,
  ConfigSplitView,
  ConfigStatusDot,
  ConfigSwitch,
} from "./SettingsUi";
import { ModelSelector } from "./ModelSelector";

const TOOL_OPTIONS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const THINKING_OPTIONS = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type EditableProfile = Omit<SubagentProfile, "scope" | "filePath">;
type EditorMode = "view" | "edit" | "create";

const EMPTY_PROFILE: EditableProfile = {
  name: "custom-agent",
  displayName: "Custom agent",
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

const inputStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  height: 34,
  padding: "0 9px",
  border: "1px solid var(--border)",
  borderRadius: 5,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
};

const disabledInputStyle: CSSProperties = {
  background: "var(--bg-panel)",
  color: "var(--text-dim)",
  cursor: "default",
};

function editableProfile(profile: SubagentProfile): EditableProfile {
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

function profileKey(profile: Pick<SubagentProfile, "scope" | "name">): string {
  return `${profile.scope}:${profile.name}`;
}

function duplicateProfileName(name: string, profiles: readonly SubagentProfile[]): string {
  const existing = new Set(profiles.map((profile) => profile.name.toLowerCase()));
  const base = `${name}-copy`;
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate.toLowerCase())) candidate = `${base}-${suffix++}`;
  return candidate;
}

function isWritableScope(scope: SubagentScope): scope is SubagentWritableScope {
  return scope === "global" || scope === "project";
}

function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function displayProfilePath(profile: SubagentProfile, cwd: string): string | null {
  if (!profile.filePath) return null;
  if ((profile.scope === "project" || profile.scope === "workspace") && profile.filePath.startsWith(cwd)) {
    const relative = profile.filePath.slice(cwd.length).replace(/^[/\\]/, "");
    return `./${relative}`;
  }
  return shortenPath(profile.filePath);
}

export function AgentsConfig({
  cwd,
  sessionId = null,
  workspaceId = null,
  onClose,
  onReloaded,
  embedded = false,
}: {
  cwd: string;
  sessionId?: string | null;
  /** 登记工作区 id（可选，final-arch step-6 Task 3）。交付感知（不变式锁定段
   *  + 组合预览）只在宿主显式给出时启用：本组件只有 cwd（路径，且可能来自
   *  会话而非登记工作区），不发明「路径→id」查找。宿主未传时面板整体不渲染，
   *  行为与从前一致。 */
  workspaceId?: string | null;
  onClose?: () => void;
  onReloaded?: () => void;
  embedded?: boolean;
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<SubagentProfile[]>([]);
  const [modelOptions, setModelOptions] = useState<ModelsData["modelList"]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(() => getLastSettingsSelection("agents", cwd));
  const [draft, setDraft] = useState<EditableProfile>(EMPTY_PROFILE);
  const [mode, setMode] = useState<EditorMode>("view");
  const [targetScope, setTargetScope] = useState<SubagentWritableScope>("global");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 保存冲突（spec §13.5.1）：PUT 返回 409 → 内联提示 + 重载（重新拉列表取新哈希）。
  const [conflict, setConflict] = useState<string | null>(null);
  const [builtInEnabled, setBuiltInEnabled] = useState(false);
  const [maxConcurrent, setMaxConcurrent] = useState(10);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [reloading, setReloading] = useState(false);

  const selected = useMemo(
    () => profiles.find((profile) => profileKey(profile) === selectedKey) ?? null,
    [profiles, selectedKey],
  );
  const modelSelectorOptions = useMemo(() => modelOptions.map((model) => ({
    provider: model.provider,
    modelId: model.id,
    name: model.name,
  })), [modelOptions]);

  const loadProfiles = useCallback(async (preferredKey?: string) => {
    setLoading(true);
    setError(null);
    setConflict(null);
    try {
      const response = await fetch(`/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      const data = await response.json() as Partial<SubagentProfilesResponse> & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      const next = data.profiles ?? [];
      setProfiles(next);
      const rememberedKey = preferredKey ?? getLastSettingsSelection("agents", cwd);
      const chosen = next.find((profile) => profileKey(profile) === rememberedKey)
        ?? next.find((profile) => profile.scope === "project")
        ?? next.find((profile) => profile.scope === "global")
        ?? next[0]
        ?? null;
      setSelectedKey(chosen ? profileKey(chosen) : null);
      if (chosen) {
        setDraft(editableProfile(chosen));
        setMode(isWritableScope(chosen.scope) ? "edit" : "view");
        if (isWritableScope(chosen.scope)) setTargetScope(chosen.scope);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
        const response = await fetch("/api/subagents/settings", {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await response.json() as Partial<SubagentSettingsResponse> & { error?: string };
        if (!response.ok || data.error || typeof data.enabled !== "boolean") {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        setBuiltInEnabled(data.enabled);
        if (typeof data.maxConcurrent === "number") setMaxConcurrent(data.maxConcurrent);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setSettingsError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) setSettingsLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (selectedKey) setLastSettingsSelection("agents", selectedKey, cwd);
  }, [cwd, selectedKey]);

  useEffect(() => {
    const controller = new AbortController();
    setModelsLoading(true);
    setModelsError(null);
    void (async () => {
      try {
        const response = await fetch(`/api/models?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal });
        const data = await response.json() as Partial<ModelsData> & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setModelOptions(data.modelList ?? []);
        setModelsError(data.modelError ?? null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setModelsError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) setModelsLoading(false);
      }
    })();
    return () => controller.abort();
  }, [cwd]);

  // 交付感知（final-arch step-6 Task 3，spec §13.5）：workspaceId 在场才拉
  // GET …/delivery/roles（只读投影，失败静默降级 = 无交付感知）。绑定判定：
  // profile 被 roles.<r>.profile 显式绑定，或与角色同名（缺省同名绑定）——
  // 两种都算「这份剧本是交付角色 r 的剧本」。角色徽标（backlog-clearing
  // fix round 1）：deliveryRoleByProfileKey + 列表侧栏渲染（agents-id-tag
  // 小标）；选中详情侧的交付角色感知在下方 deliveryRoleForSelected。
  const [deliveryRoles, setDeliveryRoles] = useState<DeliveryRolesResponse["roles"] | null>(null);
  const [deliveryPreview, setDeliveryPreview] = useState<DeliveryRolePromptPreview | null>(null);
  const [deliveryPreviewLoading, setDeliveryPreviewLoading] = useState(false);

  // 角色徽标（backlog-clearing fix round 1）：project 作用域剧本 → 绑定的交付
  // 角色（判定与 deliveryRoleForSelected 同源：explicit 显式绑定 ∨ 与角色同名
  // 缺省绑定）。roles 未拉到（无 workspaceId / 拉取失败）→ 空表 = 零徽标。
  const deliveryRoleByProfileKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of deliveryRoles ?? []) {
      if (!row.profile?.name) continue;
      if (!row.profile.explicit && row.role !== row.profile.name) continue;
      map.set(`project:${row.profile.name}`, row.role);
    }
    return map;
  }, [deliveryRoles]);

  useEffect(() => {
    if (!workspaceId) {
      setDeliveryRoles(null);
      return;
    }
    let cancelled = false;
    void fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/delivery/roles`)
      .then(async (response) => (response.ok ? response.json() : { roles: [] }) as Partial<DeliveryRolesResponse>)
      .then((data) => {
        if (!cancelled) setDeliveryRoles(data.roles ?? []);
      })
      .catch(() => {
        if (!cancelled) setDeliveryRoles(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // 当前选中剧本对应的交付角色（非创建态 + project 作用域 + 绑定命中）与
  // 组合预览拉取在下方 creating 声明之后（deliveryRoleForSelected memo 依赖
  // creating，组合预览 effect 依赖 memo 结果——顺序即 TDZ 约束）。

  const selectProfile = (profile: SubagentProfile) => {
    setSelectedKey(profileKey(profile));
    setDraft(editableProfile(profile));
    setMode(isWritableScope(profile.scope) ? "edit" : "view");
    if (isWritableScope(profile.scope)) setTargetScope(profile.scope);
    setError(null);
    setConflict(null);
  };

  const beginCreate = () => {
    let name = "custom-agent";
    let suffix = 2;
    while (profiles.some((profile) => profile.name === name)) name = `custom-agent-${suffix++}`;
    setSelectedKey(null);
    setDraft({ ...EMPTY_PROFILE, name, displayName: name });
    setMode("create");
    setTargetScope("global");
    setError(null);
  };

  const beginDuplicate = () => {
    if (!selected) return;
    const name = duplicateProfileName(selected.name, profiles);
    setSelectedKey(null);
    setDraft({
      ...editableProfile(selected),
      name,
      displayName: t("agents.copyName", { name: selected.displayName }),
    });
    setMode("create");
    setTargetScope(isWritableScope(selected.scope) ? selected.scope : "global");
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setConflict(null);
    setSavedOk(false);
    try {
      // 哈希乐观并发（spec §13.5.1）：编辑既有 profile 时携带列表态 contentHash；
      // 创建 / 改名 / 换作用域 / global 不带（服务端对这些本就不设防）。
      const expectedContentHash = !creating && selected
        && selected.scope === targetScope && selected.name === draft.name
        && selected.contentHash
        ? selected.contentHash
        : undefined;
      const response = await fetch("/api/subagents/profiles", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          scope: targetScope,
          profile: draft,
          ...(expectedContentHash ? { expectedContentHash } : {}),
        }),
      });
      const data = await response.json() as { profile?: SubagentProfile; error?: string };
      if (response.status === 409) {
        setConflict(t("agents.conflictModified"));
        return;
      }
      if (!response.ok || data.error || !data.profile) throw new Error(data.error ?? `HTTP ${response.status}`);
      await loadProfiles(profileKey(data.profile));
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 2000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selected || !isWritableScope(selected.scope)) return;
    if (!window.confirm(t("agents.deleteConfirm", { name: selected.displayName }))) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/subagents/profiles", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, scope: selected.scope, name: selected.name }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      await loadProfiles();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const editing = mode !== "view";
  const creating = mode === "create";
  // 当前选中剧本对应的交付角色（final-arch step-6 Task 3）：project 作用域 +
  // 绑定命中——roles.<r>.profile 显式指向该名，或与角色同名（缺省同名绑定）。
  // 无 workspaceId（deliveryRoles null）→ 恒 null（交付感知整体不启用）。
  const deliveryRoleForSelected = useMemo(() => {
    if (!deliveryRoles || creating || selected?.scope !== "project") return null;
    const binding = deliveryRoles.find((row) =>
      row.profile.name === selected.name
      && (row.profile.explicit || row.role === selected.name),
    );
    return binding?.role ?? null;
  }, [creating, deliveryRoles, selected]);

  // 组合预览（GET …/delivery/roles/[role]/preview）：invariant 与 composed 和
  // launch 同一函数产出（previewRolePrompt）——预览即真相。切换角色即重取。
  useEffect(() => {
    if (!workspaceId || !deliveryRoleForSelected) {
      setDeliveryPreview(null);
      setDeliveryPreviewLoading(false);
      return;
    }
    const controller = new AbortController();
    setDeliveryPreviewLoading(true);
    void (async () => {
      try {
        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/delivery/roles/${encodeURIComponent(deliveryRoleForSelected)}/preview`,
          { signal: controller.signal },
        );
        const data = await response.json() as { preview?: DeliveryRolePromptPreview; error?: string };
        if (controller.signal.aborted) return;
        setDeliveryPreview(response.ok ? data.preview ?? null : null);
      } catch {
        if (!controller.signal.aborted) setDeliveryPreview(null);
      } finally {
        if (!controller.signal.aborted) setDeliveryPreviewLoading(false);
      }
    })();
    return () => controller.abort();
  }, [deliveryRoleForSelected, workspaceId]);
  const readOnlySelected = Boolean(selected && !isWritableScope(selected.scope));
  const disabled = !editing || saving || toggling;
  const dirty = useMemo(() => {
    if (!selected || creating) return false;
    return JSON.stringify(editableProfile(selected)) !== JSON.stringify(draft);
  }, [selected, creating, draft]);
  const displayedScope = creating ? targetScope : selected?.scope;
  const overriddenBy = useMemo(
    () => (selected && !creating ? overridingSubagentScope(selected, profiles) : null),
    [selected, creating, profiles],
  );
  const scopeLabel = (scope: SubagentScope) => t(`agents.scope.${scope}`);
  const displayedPath = creating
    ? subagentTargetPath(targetScope, draft.name, profiles, cwd)
    : selected
      ? displayProfilePath(selected, cwd) ?? t("agents.builtinPath")
      : "";
  const fullPath = creating ? displayedPath : selected?.filePath ?? displayedPath;
  const selectedModelAvailable = !draft.model || modelOptions.some((model) => `${model.provider}/${model.id}` === draft.model);
  const selectedModel = (() => {
    if (!draft.model) return null;
    const separator = draft.model.indexOf("/");
    return separator < 0
      ? { provider: "", modelId: draft.model }
      : { provider: draft.model.slice(0, separator), modelId: draft.model.slice(separator + 1) };
  })();
  const controlStyle = disabled ? { ...inputStyle, ...disabledInputStyle } : inputStyle;
  const update = <K extends keyof EditableProfile>(key: K, value: EditableProfile[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const toggleTool = (tool: string, checked: boolean) => {
    update("tools", checked ? [...draft.tools, tool] : draft.tools.filter((item) => item !== tool));
  };

  const toggleEnabled = async (enabled: boolean) => {
    if (creating) {
      update("enabled", enabled);
      return;
    }
    if (!selected || !isWritableScope(selected.scope)) return;
    setToggling(true);
    setError(null);
    try {
      const response = await fetch("/api/subagents/profiles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, scope: selected.scope, name: selected.name, enabled }),
      });
      const data = await response.json() as { profile?: SubagentProfile; error?: string };
      if (!response.ok || data.error || !data.profile) throw new Error(data.error ?? `HTTP ${response.status}`);
      const saved = data.profile;
      setProfiles((current) => current.map((profile) => profileKey(profile) === profileKey(saved) ? saved : profile));
      setDraft((current) => ({ ...current, enabled: saved.enabled }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setToggling(false);
    }
  };

  const toggleBuiltInSubagents = async (enabled: boolean) => {
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const response = await fetch("/api/subagents/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await response.json() as Partial<SubagentSettingsResponse> & { error?: string };
      if (!response.ok || data.error || typeof data.enabled !== "boolean") {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      setBuiltInEnabled(data.enabled);
      setReloadNeeded(Boolean(sessionId));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSettingsSaving(false);
    }
  };

  const updateMaxConcurrent = async (value: number) => {
    setMaxConcurrent(value);
    setSettingsError(null);
    try {
      const response = await fetch("/api/subagents/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxConcurrent: value }),
      });
      const data = await response.json() as Partial<SubagentSettingsResponse> & { error?: string };
      if (!response.ok || data.error || typeof data.maxConcurrent !== "number") throw new Error(data.error ?? `HTTP ${response.status}`);
      setMaxConcurrent(data.maxConcurrent);
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const reloadSession = async () => {
    if (!sessionId) return;
    setReloading(true);
    setSettingsError(null);
    try {
      await sendAgentCommand(sessionId, { type: "reload" });
      setReloadNeeded(false);
      onReloaded?.();
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReloading(false);
    }
  };

  return (
    <ConfigPanelShell embedded={embedded} title={t("common.agents")} subtitle={shortenPath(cwd)} closeLabel={t("agents.close")} onClose={onClose ?? (() => {})}>
      <ConfigSplitView>
        <ConfigSidebar>
          <ConfigSidebarList>
              {loading ? (
                <div style={{ padding: 10, color: "var(--text-dim)", fontSize: 12 }}>{t("agents.loading")}</div>
              ) : SUBAGENT_SCOPE_ORDER.map((scope) => {
                const scopedProfiles = profiles.filter((profile) => profile.scope === scope);
                if (scopedProfiles.length === 0) return null;
                const hint = subagentScopeDirectory(scope, profiles, cwd);
                return (
                  <div key={scope} className="config-sidebar-group">
                    <ConfigSidebarGroupLabel>
                      {scopeLabel(scope)}
                      {hint && <span className="agents-group-path">{hint}</span>}
                    </ConfigSidebarGroupLabel>
                    {scopedProfiles.map((profile) => {
                      const overriding = overridingSubagentScope(profile, profiles);
                      const overriddenLabel = overriding
                        ? t("agents.overriddenBy", { scope: scopeLabel(overriding) })
                        : null;
                      // 角色徽标（backlog-clearing fix round 1）：绑定了交付角色
                      // 的 project 剧本在名旁出一枚小角色标（复用 agents-id-tag）。
                      const deliveryRole = profile.scope === "project"
                        ? deliveryRoleByProfileKey.get(profileKey(profile))
                        : undefined;
                      return (
                        <ConfigSidebarItem
                          key={profileKey(profile)}
                          active={selectedKey === profileKey(profile) && !creating}
                          onClick={() => selectProfile(profile)}
                          title={overriddenLabel ?? undefined}
                        >
                          <ConfigStatusDot active={profile.enabled} />
                          <ConfigSidebarText className={`is-grow${profile.enabled && !overriding ? "" : " is-muted"}`}>{profile.displayName}</ConfigSidebarText>
                          {deliveryRole !== undefined && <span className="agents-id-tag">{deliveryRole}</span>}
                          {overriddenLabel && <span className="agents-overridden-label">{overriddenLabel}</span>}
                        </ConfigSidebarItem>
                      );
                    })}
                  </div>
                );
              })}
          </ConfigSidebarList>
          <ConfigListAction
                active={creating}
                onClick={beginCreate}
              >
                {t("agents.new")}
          </ConfigListAction>
          <div className="agents-sidebar-footer">
            <div className="agents-sidebar-footer-row">
              <span title={t("agents.builtInDescription")}>{t("agents.builtInShort")}</span>
              <ConfigSwitch
                checked={builtInEnabled}
                disabled={settingsLoading || reloading}
                loading={settingsSaving}
                label={t("agents.builtInTitle")}
                onChange={(enabled) => void toggleBuiltInSubagents(enabled)}
              />
            </div>
            <div className="agents-sidebar-footer-row">
              <span title={t("agents.maxConcurrentDescription")}>{t("agents.maxConcurrent")}</span>
              <input
                aria-label={t("agents.maxConcurrent")}
                className="agents-concurrency-input"
                type="number"
                min={1}
                max={32}
                value={maxConcurrent}
                disabled={settingsLoading || settingsSaving}
                onChange={(event) => setMaxConcurrent(Number(event.target.value))}
                onBlur={() => void updateMaxConcurrent(maxConcurrent)}
              />
            </div>
            {reloadNeeded && sessionId && (
              <div className="agents-sidebar-reload">
                <span>{t("agents.reloadRequired")}</span>
                <ConfigButton size="small" onClick={() => void reloadSession()} disabled={reloading || settingsSaving}>
                  {reloading ? t("agents.reloading") : t("agents.reloadSession")}
                </ConfigButton>
              </div>
            )}
          </div>
        </ConfigSidebar>

        <ConfigDetail>
          <ConfigDetailStack className="is-fill">
              {!selected && !creating ? (
                <ConfigEmptyState>{t("agents.empty")}</ConfigEmptyState>
              ) : (
                <ConfigDetailStack>
                  <ConfigDetailHeader>
                    <ConfigDetailHeaderInfo>
                      {displayedScope && (
                        <span className={`config-scope-tag${displayedScope === "project" ? " is-project" : ""}`}>
                          {scopeLabel(displayedScope)}
                        </span>
                      )}
                      {!creating && <span className="agents-id-tag">{draft.name}</span>}
                      <span
                        className={`agents-status-pill${draft.enabled ? " is-on" : " is-off"}`}
                        title={fullPath}
                      >
                        {draft.enabled ? t("agents.statusEnabled") : t("agents.statusDisabled")}
                      </span>
                      {overriddenBy && (
                        <span className="agents-overridden-label">{t("agents.overriddenBy", { scope: scopeLabel(overriddenBy) })}</span>
                      )}
                      <span title={fullPath} className="config-detail-path">
                        {displayedPath}
                      </span>
                    </ConfigDetailHeaderInfo>
                    <ConfigDetailActions>
                      {selected && (mode === "view" || mode === "edit") && !readOnlySelected && <ConfigButton size="small" onClick={beginDuplicate} disabled={saving || toggling}>{t("agents.duplicate")}</ConfigButton>}
                      {selected && isWritableScope(selected.scope) && mode === "edit" && <ConfigButton variant="danger" size="small" onClick={() => void remove()} disabled={saving || toggling}>{t("agents.delete")}</ConfigButton>}
                      {!readOnlySelected && (
                        <ConfigSwitch checked={draft.enabled} disabled={disabled} label={draft.enabled ? t("agents.disable") : t("agents.enable")} onChange={(checked) => void toggleEnabled(checked)} />
                      )}
                    </ConfigDetailActions>
                  </ConfigDetailHeader>

                  {readOnlySelected && selected && (
                    <div className="agents-readonly-notice">
                      <span>{t("agents.readonlyNotice", { scope: scopeLabel(selected.scope) })}</span>
                      <ConfigButton size="small" onClick={beginDuplicate} disabled={saving || toggling}>{t("agents.duplicate")}</ConfigButton>
                    </div>
                  )}

                  {/* 查看态标题块：显示名 + 描述（可写配置的编辑走「基本」段，不重复渲染）。 */}
                  {mode === "view" && selected && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <div style={{ color: "var(--text)", fontSize: 15, fontWeight: 600, lineHeight: 1.35 }}>{selected.displayName}</div>
                      {selected.description && (
                        <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.55 }}>{selected.description}</p>
                      )}
                    </div>
                  )}

                  {creating && (
                    <>
                      <ConfigSectionTitle>{t("agents.saveScope")}</ConfigSectionTitle>
                      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
                        <div role="radiogroup" aria-label={t("agents.saveScope")} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 3, padding: 3, minWidth: 180, border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-panel)" }}>
                          {(["global", "project"] as const).map((scope) => (
                            <button
                              key={scope}
                              type="button"
                              role="radio"
                              aria-checked={targetScope === scope}
                              onClick={() => setTargetScope(scope)}
                              disabled={saving}
                              style={{ height: 28, border: "none", borderRadius: 4, background: targetScope === scope ? "var(--bg-selected)" : "transparent", color: targetScope === scope ? "var(--text)" : "var(--text-muted)", cursor: saving ? "default" : "pointer", fontSize: 11, fontWeight: targetScope === scope ? 600 : 400 }}
                            >
                              {scopeLabel(scope)}
                            </button>
                          ))}
                        </div>
                        <span title={displayedPath} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                          {t("agents.targetPath")}：{displayedPath}
                        </span>
                      </div>
                    </>
                  )}

                  {mode === "edit" && (
                    <>
                      <ConfigSectionTitle>{t("agents.basic")}</ConfigSectionTitle>
                      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1fr) minmax(0, 1.5fr)", gap: 12 }}>
                        <Field label={t("agents.displayName")}>
                          <input aria-label={t("agents.displayName")} value={draft.displayName} disabled={disabled} onChange={(event) => update("displayName", event.target.value)} style={controlStyle} />
                        </Field>
                        <Field label={t("agents.description")}>
                          <input aria-label={t("agents.description")} value={draft.description} disabled={disabled} onChange={(event) => update("description", event.target.value)} style={controlStyle} />
                        </Field>
                      </div>
                    </>
                  )}

                  {creating && (
                    <>
                      <ConfigSectionTitle>{t("agents.basic")}</ConfigSectionTitle>
                      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }}>
                        <Field label={t("agents.name")}>
                          <input aria-label={t("agents.name")} value={draft.name} disabled={disabled} onChange={(event) => update("name", event.target.value)} style={inputStyle} />
                        </Field>
                        <Field label={t("agents.displayName")}>
                          <input aria-label={t("agents.displayName")} value={draft.displayName} disabled={disabled} onChange={(event) => update("displayName", event.target.value)} style={controlStyle} />
                        </Field>
                      </div>
                      <Field label={t("agents.description")}>
                        <input aria-label={t("agents.description")} value={draft.description} disabled={disabled} onChange={(event) => update("description", event.target.value)} style={controlStyle} />
                      </Field>
                    </>
                  )}

                  <ConfigSectionTitle>{t("agents.prompt")}</ConfigSectionTitle>
                  {/* 交付角色剧本（workspaceId 在场 + 绑定命中）：system prompt 编辑区上方
                      锁定渲染引擎不变式——launch 时逐字前置，本编辑器改不到它（灰底只读，
                      出处链到设计稿 §4.3）。 */}
                  {deliveryRoleForSelected && deliveryPreview && (
                    <div className="agents-delivery-invariant" role="group" aria-label={t("agents.deliveryInvariant")}>
                      <div className="agents-delivery-invariant-head">
                        <span>🔒 {t("agents.deliveryInvariant")}</span>
                        <a
                          href="docs/superpowers/specs/2026-10-26-delivery-engine-final-architecture-design.md#43"
                          target="_blank"
                          rel="noreferrer"
                          title={t("agents.deliveryInvariantHint")}
                        >
                          §4.3
                        </a>
                      </div>
                      <pre className="agents-delivery-invariant-body">{deliveryPreview.invariant}</pre>
                    </div>
                  )}
                  {deliveryPreviewLoading && deliveryRoleForSelected && (
                    <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("agents.loading")}</span>
                  )}
                  {mode === "view" ? (
                    <pre className="agents-prompt-readonly">{draft.systemPrompt}</pre>
                  ) : (
                    <textarea className="agents-system-prompt" aria-label={t("agents.prompt")} value={draft.systemPrompt} disabled={disabled} onChange={(event) => update("systemPrompt", event.target.value)} style={{ ...controlStyle, height: 195, minHeight: 195, maxHeight: "60vh", padding: 9, overflow: "auto", resize: disabled ? "none" : "vertical", lineHeight: 1.5 }} />
                  )}
                  {/* 组合预览（交付角色剧本，折叠段）：composed 与 launch 的
                      appendSystemPrompt 同一函数产出——AGENTS.md（pi 从 cwd 注入，
                      不在内）▸ 不变式（锁定）▸ 剧本正文，预览即真相。 */}
                  {deliveryRoleForSelected && deliveryPreview && (
                    <details className="agents-delivery-composed">
                      <summary title={t("agents.deliveryComposedHint")}>{t("agents.deliveryComposed")}</summary>
                      <pre className="agents-delivery-composed-body">{deliveryPreview.composed}</pre>
                    </details>
                  )}

                  <ConfigSectionTitle>{t("agents.capabilities")}</ConfigSectionTitle>
                  <Field label={t("agents.tools")}>
                    {mode === "view" ? (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {draft.tools.map((tool) => <span key={tool} className="agents-static-chip">{tool}</span>)}
                        {draft.tools.length === 0 && <span style={{ color: "var(--text-dim)", fontSize: 12 }}>—</span>}
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {TOOL_OPTIONS.map((tool) => (
                          <button
                            key={tool}
                            type="button"
                            className="agents-chip"
                            aria-pressed={draft.tools.includes(tool)}
                            disabled={disabled}
                            onClick={() => toggleTool(tool, !draft.tools.includes(tool))}
                          >
                            {tool}
                          </button>
                        ))}
                      </div>
                    )}
                  </Field>
                  <Field label={t("agents.resources")}>
                    {mode === "view" ? (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {draft.loadSkills && <span className="agents-static-chip">{t("agents.loadSkills")}</span>}
                        {draft.loadExtensions && <span className="agents-static-chip">{t("agents.loadExtensions")}</span>}
                        {!draft.loadSkills && !draft.loadExtensions && <span style={{ color: "var(--text-dim)", fontSize: 12 }}>—</span>}
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        <button type="button" className="agents-chip" aria-pressed={draft.loadSkills} disabled={disabled} onClick={() => update("loadSkills", !draft.loadSkills)}>{t("agents.loadSkills")}</button>
                        <button type="button" className="agents-chip" aria-pressed={draft.loadExtensions} disabled={disabled} onClick={() => update("loadExtensions", !draft.loadExtensions)}>{t("agents.loadExtensions")}</button>
                      </div>
                    )}
                  </Field>

                  <ConfigSectionTitle>{t("agents.run")}</ConfigSectionTitle>
                  {mode === "view" ? (
                    <dl className="agents-kv-grid">
                      <dt>{t("agents.model")}</dt>
                      <dd className={draft.model ? undefined : "is-dim"}>{draft.model ?? t("agents.inherit")}</dd>
                      <dt>{t("agents.thinking")}</dt>
                      <dd className={draft.thinking ? undefined : "is-dim"}>{draft.thinking ?? t("agents.inherit")}</dd>
                      <dt>{t("agents.maxTurns")}</dt>
                      <dd className={draft.maxTurns ? undefined : "is-dim"}>{draft.maxTurns ?? "—"}</dd>
                      <dt>{t("agents.inheritContext")}</dt>
                      <dd className={draft.inheritContext ? undefined : "is-dim"}>{draft.inheritContext ? t("agents.on") : t("agents.off")}</dd>
                      <dt>{t("agents.background")}</dt>
                      <dd className={draft.runInBackground ? undefined : "is-dim"}>{draft.runInBackground ? t("agents.on") : t("agents.off")}</dd>
                    </dl>
                  ) : (
                    <>
                      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1.5fr) minmax(120px, 0.75fr) minmax(100px, 0.5fr)", gap: 12 }}>
                        <Field label={t("agents.model")}>
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            <ModelSelector
                              options={modelSelectorOptions}
                              value={selectedModel}
                              onChange={(provider, modelId) => update("model", `${provider}/${modelId}`)}
                              onClear={() => update("model", undefined)}
                              emptyLabel={modelsLoading ? t("agents.modelsLoading") : t("agents.inherit")}
                              selectedLabel={draft.model && !selectedModelAvailable ? t("agents.modelUnavailable", { model: draft.model }) : undefined}
                              disabled={disabled || modelsLoading || (modelOptions.length === 0 && !draft.model)}
                              ariaLabel={t("agents.model")}
                              variant="field"
                              placement="auto"
                            />
                            {modelsError && <span style={{ color: "#ef4444", fontSize: 10 }}>{modelsError}</span>}
                          </div>
                        </Field>
                        <Field label={t("agents.thinking")}>
                          <select aria-label={t("agents.thinking")} value={draft.thinking ?? ""} disabled={disabled} onChange={(event) => update("thinking", (event.target.value || undefined) as EditableProfile["thinking"])} style={controlStyle}>
                            {THINKING_OPTIONS.map((value) => <option key={value || "default"} value={value}>{value || t("agents.inherit")}</option>)}
                          </select>
                        </Field>
                        <Field label={t("agents.maxTurns")}>
                          <input aria-label={t("agents.maxTurns")} type="number" min={1} value={draft.maxTurns ?? ""} disabled={disabled} onChange={(event) => update("maxTurns", event.target.value ? Number(event.target.value) : undefined)} style={controlStyle} />
                        </Field>
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        <button type="button" className="agents-chip" aria-pressed={draft.inheritContext} disabled={disabled} onClick={() => update("inheritContext", !draft.inheritContext)}>{t("agents.inheritContext")}</button>
                        <button type="button" className="agents-chip" aria-pressed={draft.runInBackground} disabled={disabled} onClick={() => update("runInBackground", !draft.runInBackground)}>{t("agents.background")}</button>
                      </div>
                    </>
                  )}

                  {!creating && (
                    <>
                      <ConfigSectionTitle>{t("agents.source")}</ConfigSectionTitle>
                      <dl className="agents-kv-grid">
                        <dt>{t("agents.source")}</dt>
                        <dd>{displayedScope ? scopeLabel(displayedScope) : "—"}</dd>
                        <dt>{t("agents.location")}</dt>
                        <dd style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{displayedPath || "—"}</dd>
                      </dl>
                    </>
                  )}
                </ConfigDetailStack>
              )}
          </ConfigDetailStack>
        </ConfigDetail>
      </ConfigSplitView>
      <ConfigFooter status={(settingsError || error || conflict || (dirty && !saving && !savedOk)) && (
        <span role="status" style={{ display: "inline-flex", alignItems: "center", gap: 8, color: settingsError || error || conflict ? "#ef4444" : "var(--text-dim)" }}>
          {settingsError || error || conflict || t("agents.unsaved")}
          {conflict && !settingsError && !error && (
            <ConfigButton size="small" onClick={() => void loadProfiles()} disabled={saving}>
              {t("agents.conflictReload")}
            </ConfigButton>
          )}
        </span>
      )}>
        {editing && (
          <ConfigButton
            variant="primary"
            onClick={() => void save()}
            disabled={saving || savedOk || toggling || !draft.name.trim()}
            className={savedOk ? "is-success" : undefined}
          >
            {savedOk && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="config-button-success-icon">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            <span>{savedOk ? t("i18n.saved") : saving ? t("agents.saving") : t("agents.save")}</span>
          </ConfigButton>
        )}
      </ConfigFooter>
    </ConfigPanelShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <ConfigField label={label}>{children}</ConfigField>;
}
