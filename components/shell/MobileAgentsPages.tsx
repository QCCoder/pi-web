"use client";

import { useState, type CSSProperties } from "react";
import type { SubagentProfile, SubagentScope, SubagentWritableScope } from "@/lib/subagents";
import {
  type MobileAgentsState,
  agentScopeDirectory,
  agentTargetPath,
  isWritableAgentScope,
  isValidAgentName,
} from "./useMobileAgents";
import {
  MobileCard,
  MobileEmpty,
  MobileErrorBanner,
  MobileNavBar,
  MobileNote,
  MobilePill,
  MobilePrimaryButton,
  MobileRow,
  MobileSection,
  MobileSwitch,
} from "./mobile-ui";

/**
 * 手机壳 Agents 三页（设置 tab › Agents 的推入子页族，2026-10 从「内嵌桌面
 * AgentsConfig 分栏」改为手机原生形态——与 Skill / 工作项同一套 mobile-ui 原语，
 * 「一页放不下就开详情页，不硬塞」）：
 *
 *   MobileAgentsList    列表子页（settings-sub 宿主，页头由壳的 MobileNavBar 出）：
 *                       内置子代理总开关 + 并发 → 按作用域优先级分组卡（项目 →
 *                       工作区 → 全局 → 内置，谁赢谁在上；组标题带目录 hint）。
 *   MobileAgentDetail   详情推入页：hero（名/描述/胶囊）→ 状态 → 指令（截断可展开）
 *                       → 工具与资源 → 运行 → 来源 → 创建副本 / 删除。
 *   MobileAgentEdit     编辑推入页（新建 / 编辑 / 复制共用）：保存到（仅新建）+
 *                       基本 + 指令 + 工具与资源 + 运行；保存成功由壳 replaceTop
 *                       成详情页（‹ 直接回列表，不经表单）。
 *
 * 数据与后端契约全在 useMobileAgents（与桌面 AgentsConfig 同一套 API）。文案与
 * MobileSkillsPages 同例直接中文（手机页不接 i18n）。
 */

const SCOPE_LABELS: Record<SubagentScope, string> = {
  project: "项目",
  workspace: "工作区",
  global: "全局",
  builtin: "内置",
};

const TOOL_OPTIONS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const THINKING_OPTIONS = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/* ---- 列表子页 -------------------------------------------------------------- */

export function MobileAgentsList({
  state,
  onOpenDetail,
  onOpenCreate,
}: {
  state: MobileAgentsState;
  onOpenDetail: (profile: SubagentProfile) => void;
  onOpenCreate: () => void;
}) {
  const [concurrencyDraft, setConcurrencyDraft] = useState<number | null>(null);
  const empty = !state.loading && state.profiles.length === 0;
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 28 }}>
      {state.loadError && <MobileErrorBanner>加载失败：{state.loadError}</MobileErrorBanner>}
      {state.settingsError && <MobileErrorBanner>保存失败：{state.settingsError}</MobileErrorBanner>}
      {state.deleteError && <MobileErrorBanner>删除失败：{state.deleteError}</MobileErrorBanner>}

      {!state.cwd && (
        <MobileEmpty
          title="没有锚定工作区"
          body="Agents 配置按工作区读取（项目层）与写入（全局层不受影响）；先在会话页进入一个工作区再回来管理。"
        />
      )}

      {state.loading && state.profiles.length === 0 && (
        <div style={{ padding: "40px 0", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>加载中…</div>
      )}

      {!state.cwd ? null : (
        <>
          <MobileSection title="内置子代理" />
          <MobileCard>
            <MobileRow
              first
              label="启用 Pi Web 内置子代理"
              sublabel="提供集成的 Agent 工具，停用冲突的 pi-subagents 扩展"
              trailing={(
                <MobileSwitch
                  checked={state.builtInEnabled}
                  onChange={() => { void state.toggleBuiltIn(!state.builtInEnabled); }}
                  disabled={state.settingsLoading || state.settingsSaving}
                  label={state.builtInEnabled ? "停用内置子代理" : "启用内置子代理"}
                />
              )}
            />
            <MobileRow
              label="并发子代理数"
              sublabel="每个父会话同时运行的最大任务数"
              trailing={(
            <label style={{ display: "flex", alignItems: "center", gap: 8, paddingRight: 14, fontSize: 13, color: "var(--text-muted)", flexShrink: 0 }}>
              <input
                aria-label="并发子代理数"
                type="number"
                min={1}
                max={32}
                value={concurrencyDraft ?? state.maxConcurrent}
                disabled={state.settingsLoading || state.settingsSaving}
                onChange={(event) => setConcurrencyDraft(Number(event.target.value))}
                onBlur={() => {
                  if (concurrencyDraft !== null) {
                    void state.changeMaxConcurrent(concurrencyDraft);
                    setConcurrencyDraft(null);
                  }
                }}
                style={{ width: 56, height: 32, padding: "0 6px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)", color: "var(--text)", font: "inherit", fontSize: 14, textAlign: "center" }}
              />
            </label>
              )}
            />
          </MobileCard>

          {state.groups.map((group) => {
            const directory = agentScopeDirectory(group.scope, state.profiles, state.cwd);
            return (
              <section key={group.scope} aria-label={SCOPE_LABELS[group.scope]}>
                <MobileSection
                  title={(
                    <>
                      {SCOPE_LABELS[group.scope]}
                      {directory && (
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", marginLeft: 6 }}>{directory}</span>
                      )}
                    </>
                  )}
                  trailing={<span style={{ fontSize: 11, color: "var(--text-dim)" }}>{group.profiles.length}</span>}
                />
                <MobileCard>
                  {group.profiles.map((profile, index) => {
                    const writable = isWritableAgentScope(profile.scope);
                    const overridden = state.overriddenBy(profile);
                    return (
                      <MobileRow
                        key={`${profile.scope}:${profile.name}`}
                        first={index === 0}
                        label={profile.displayName}
                        sublabel={profile.description || undefined}
                        onClick={() => onOpenDetail(profile)}
                        ariaLabel={`${profile.displayName} 详情`}
                        trailing={(
                          <>
                            {overridden && <MobilePill>被{SCOPE_LABELS[overridden]}覆盖</MobilePill>}
                            <MobileSwitch
                              checked={profile.enabled}
                              onChange={() => { void state.toggleEnabled(profile); }}
                              disabled={!writable || state.togglingKeys.has(`${profile.scope}:${profile.name}`)}
                              label={`${profile.enabled ? "停用" : "启用"} ${profile.displayName}`}
                            />
                          </>
                        )}
                      />
                    );
                  })}
                </MobileCard>
              </section>
            );
          })}

          {empty && !state.loadError && (
            <MobileEmpty
              title="还没有子代理配置"
              body="新建一个，或把配置文件放进 ~/.pi/agent/agents（全局）或项目 .pi/agents。"
              action={<MobilePrimaryButton onClick={onOpenCreate}>新建子代理</MobilePrimaryButton>}
            />
          )}

          {!empty && (
            <MobileNote>
              开关 = 是否允许父会话把任务派给它。同名配置按 项目 &gt; 工作区 &gt; 全局 &gt; 内置 覆盖——被覆盖的只读项标了被谁覆盖；新建走「编辑」页选择保存到全局还是项目。
            </MobileNote>
          )}
        </>
      )}
    </div>
  );
}

/* ---- 详情推入页 ------------------------------------------------------------ */

const PROMPT_PREVIEW_LENGTH = 140;

export function MobileAgentDetail({
  state,
  profile,
  onBack,
  backLabel,
  onEdit,
  onDuplicate,
  onDeleted,
}: {
  state: MobileAgentsState;
  profile: SubagentProfile;
  onBack: () => void;
  backLabel: string;
  onEdit: () => void;
  onDuplicate: () => void;
  /** 删除成功后回调（壳弹栈回列表）。 */
  onDeleted: () => void;
}) {
  const [promptExpanded, setPromptExpanded] = useState(false);
  const writable = isWritableAgentScope(profile.scope);
  const overridden = state.overriddenBy(profile);
  const deleting = state.deletingKeys.has(`${profile.scope}:${profile.name}`);

  const remove = async () => {
    if (!window.confirm(`删除 ${profile.displayName}？该配置文件将从磁盘移除。`)) return;
    const ok = await state.deleteProfile(profile);
    if (ok) onDeleted();
  };

  const runValue = (value: string | number | undefined, fallback: string) => (
    <span style={{ color: value === undefined || value === "" ? "var(--text-dim)" : "var(--text)", fontSize: 13 }}>{value === undefined || value === "" ? fallback : value}</span>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <MobileNavBar
        title={profile.displayName}
        onBack={onBack}
        backLabel={backLabel}
        actions={writable ? <MobilePrimaryButton onClick={onEdit}>编辑</MobilePrimaryButton> : undefined}
      />
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 28 }}>
        <div style={{ padding: "16px 20px 4px" }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 18, fontWeight: 600, color: "var(--text)", wordBreak: "break-all" }}>{profile.name}</div>
          <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.6, color: "var(--text-muted)", whiteSpace: "pre-wrap" }}>
            {profile.description || "（无描述）"}
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
            <MobilePill>{SCOPE_LABELS[profile.scope]}</MobilePill>
            {!writable && <MobilePill>只读</MobilePill>}
            {overridden && <MobilePill>被{SCOPE_LABELS[overridden]}覆盖</MobilePill>}
            {profile.model && <MobilePill tone="accent">{profile.model}</MobilePill>}
          </div>
        </div>

        {state.settingsError && <MobileErrorBanner>保存失败：{state.settingsError}</MobileErrorBanner>}
        {state.deleteError && <MobileErrorBanner>删除失败：{state.deleteError}</MobileErrorBanner>}

        <MobileSection title="状态" />
        <MobileCard>
          <MobileRow
            first
            label={profile.enabled ? "已启用" : "已停用"}
            sublabel={writable ? "允许父会话把任务派给它" : "此作用域在 Web 端只读，创建副本后可自定义"}
            trailing={(
              <MobileSwitch
                checked={profile.enabled}
                onChange={() => { void state.toggleEnabled(profile); }}
                disabled={!writable || state.togglingKeys.has(`${profile.scope}:${profile.name}`)}
                label={`${profile.enabled ? "停用" : "启用"} ${profile.displayName}`}
              />
            )}
          />
        </MobileCard>

        <MobileSection title="系统指令" />
        <MobileCard>
          <div style={{ padding: "12px 14px" }}>
            <p
              style={{
                margin: 0, fontFamily: "var(--font-mono)", fontSize: 12.5, lineHeight: 1.6, color: "var(--text)",
                whiteSpace: "pre-wrap", wordBreak: "break-word", overflow: "hidden",
                display: promptExpanded ? undefined : "-webkit-box",
                WebkitBoxOrient: promptExpanded ? undefined : "vertical",
                WebkitLineClamp: promptExpanded ? undefined : 4,
              }}
            >
              {profile.systemPrompt || "（空）"}
            </p>
            {profile.systemPrompt.length > PROMPT_PREVIEW_LENGTH && (
              <button
                type="button"
                onClick={() => setPromptExpanded((value) => !value)}
                style={{ marginTop: 8, padding: 0, border: 0, background: "transparent", color: "var(--accent)", fontSize: 12.5, cursor: "pointer" }}
              >
                {promptExpanded ? "收起" : "查看全部"}
              </button>
            )}
          </div>
        </MobileCard>

        <MobileSection title="工具与资源" />
        <MobileCard>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "12px 14px" }}>
            {profile.tools.map((tool) => (
              <span key={tool} style={{ display: "inline-flex", alignItems: "center", height: 24, padding: "0 9px", borderRadius: 999, background: "var(--bg-hover)", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{tool}</span>
            ))}
            {profile.tools.length === 0 && <span style={{ color: "var(--text-dim)", fontSize: 13 }}>无工具</span>}
          </div>
          <MobileRow label="加载技能" trailing={<span style={{ fontSize: 13, color: profile.loadSkills ? "var(--text)" : "var(--text-dim)" }}>{profile.loadSkills ? "开" : "关"}</span>} />
          <MobileRow label="加载扩展" trailing={<span style={{ fontSize: 13, color: profile.loadExtensions ? "var(--text)" : "var(--text-dim)" }}>{profile.loadExtensions ? "开" : "关"}</span>} />
        </MobileCard>

        <MobileSection title="运行" />
        <MobileCard>
          <MobileRow first label="模型" trailing={runValue(profile.model, "跟随父会话")} />
          <MobileRow label="思考级别" trailing={runValue(profile.thinking, "跟随父会话")} />
          <MobileRow label="最大轮次" trailing={runValue(profile.maxTurns, "—")} />
          <MobileRow label="继承父会话上下文" trailing={runValue(profile.inheritContext ? "开" : undefined, "关")} />
          <MobileRow label="默认在后台运行" trailing={runValue(profile.runInBackground ? "开" : undefined, "关")} />
        </MobileCard>

        <MobileSection title="来源" />
        <MobileCard>
          <MobileRow first label="作用域" hint={SCOPE_LABELS[profile.scope]} />
          <MobileRow
            label="位置"
            hint={<span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{profile.filePath ?? "内置配置"}</span>}
          />
          <MobileRow label="创建副本" sublabel="复制到可写作用域后自定义" onClick={onDuplicate} />
        </MobileCard>

        {writable && (
          <>
            <MobileSection title="危险区" />
            <MobileCard>
              <MobileRow
                first
                label={deleting ? "正在删除…" : "删除此子代理"}
                sublabel="从磁盘移除配置文件，不可恢复"
                onClick={deleting ? undefined : () => { void remove(); }}
                disabled={deleting}
              />
            </MobileCard>
          </>
        )}
      </div>
    </div>
  );
}

/* ---- 编辑推入页（新建 / 编辑 / 复制共用） ---------------------------------- */

export interface MobileAgentEditSeed {
  /** 编辑已有配置时传原配置（决定标题与目标路径展示）；null = 新建。 */
  editing: SubagentProfile | null;
  scope: SubagentWritableScope;
  draft: Omit<SubagentProfile, "scope" | "filePath">;
}

const editInputStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  height: 40,
  padding: "0 12px",
  border: "1px solid var(--border)",
  borderRadius: 10,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 15,
  outline: "none",
};

function CardField({ label, first = false, children }: { label: string; first?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ padding: "11px 14px", borderTop: first ? 0 : "1px solid var(--border)" }}>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

/** 筹片形态的原生 select（与工作项筛选同款：透明 select 盖满筹片，弹系统选择器）。 */
function ChipSelect({
  ariaLabel,
  value,
  options,
  onChange,
}: {
  ariaLabel: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const current = options.find((option) => option.value === value) ?? options[0];
  const active = value !== "" && value !== options[0]?.value;
  return (
    <label
      style={{
        position: "relative", display: "inline-flex", alignItems: "center", gap: 5,
        height: 32, padding: "0 10px 0 12px", borderRadius: 999, fontSize: 12.5,
        whiteSpace: "nowrap", cursor: "pointer", userSelect: "none",
        border: active ? "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))" : "1px solid var(--border)",
        background: active ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "var(--bg-panel)",
        color: active ? "var(--accent)" : "var(--text)",
        fontWeight: active ? 600 : 400,
      }}
    >
      <span>{current?.label ?? "—"}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ opacity: 0.7 }}>
        <polyline points="6 9 12 15 18 9" />
      </svg>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, appearance: "none", border: 0, margin: 0, padding: 0, cursor: "pointer", fontSize: 16 }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function ChipToggle({ label, active, onClick, disabled }: { label: string; active: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      style={{
        position: "relative", display: "inline-flex", alignItems: "center", gap: 5,
        height: 32, padding: "0 12px", borderRadius: 999, fontSize: 12.5,
        whiteSpace: "nowrap", cursor: disabled ? "default" : "pointer", userSelect: "none",
        opacity: disabled ? 0.5 : 1,
        border: active ? "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))" : "1px solid var(--border)",
        background: active ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "var(--bg-panel)",
        color: active ? "var(--accent)" : "var(--text)",
        fontWeight: active ? 600 : 400,
      }}
    >
      {label}
    </button>
  );
}

export function MobileAgentEdit({
  state,
  seed,
  onBack,
  backLabel,
  onSaved,
}: {
  state: MobileAgentsState;
  seed: MobileAgentEditSeed;
  onBack: () => void;
  backLabel: string;
  /** 保存成功（壳 replaceTop 成详情页）。 */
  onSaved: (saved: SubagentProfile) => void;
}) {
  const { editing } = seed;
  const [scope, setScope] = useState<SubagentWritableScope>(seed.scope);
  const [draft, setDraft] = useState<Omit<SubagentProfile, "scope" | "filePath">>({ ...seed.draft });
  const nameOk = isValidAgentName(draft.name);
  const update = <K extends keyof Omit<SubagentProfile, "scope" | "filePath">>(key: K, value: Omit<SubagentProfile, "scope" | "filePath">[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    const saved = await state.saveProfile(scope, { ...draft, name: draft.name.trim() });
    if (saved) onSaved(saved);
  };

  const segmentStyle = (active: boolean, disabled: boolean): CSSProperties => ({
    flex: 1, height: 34, border: 0, borderRadius: 9, fontSize: 13, cursor: disabled ? "default" : "pointer",
    background: active ? "var(--bg)" : "transparent", color: active ? "var(--text)" : "var(--text-muted)",
    boxShadow: active ? "0 1px 3px rgba(0,0,0,0.12)" : "none", fontWeight: active ? 600 : 400,
    opacity: disabled ? 0.45 : 1,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <MobileNavBar
        title={editing ? "编辑子代理" : "新建子代理"}
        onBack={onBack}
        backLabel={backLabel}
        actions={(
          <MobilePrimaryButton
            onClick={() => { void save(); }}
            disabled={!nameOk}
            busy={state.saving}
          >
            保存
          </MobilePrimaryButton>
        )}
      />
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 28 }}>
        {state.saveError && <MobileErrorBanner>保存失败：{state.saveError}</MobileErrorBanner>}
        {state.modelsError && <MobileErrorBanner>模型列表加载失败：{state.modelsError}</MobileErrorBanner>}
        {!nameOk && (
          <MobileErrorBanner>子代理 ID 只能含字母、数字、点、下划线和连字符，且以字母或数字开头。</MobileErrorBanner>
        )}

        {!editing && (
          <>
            <MobileSection title="保存到" />
            <MobileCard>
              <div role="radiogroup" aria-label="保存作用域" style={{ display: "flex", gap: 4, padding: 6, background: "var(--bg-subtle)", margin: 10, borderRadius: 11 }}>
                <button type="button" role="radio" aria-checked={scope === "global"} onClick={() => setScope("global")} disabled={state.saving} style={segmentStyle(scope === "global", state.saving)}>
                  全局
                </button>
                <button type="button" role="radio" aria-checked={scope === "project"} onClick={() => setScope("project")} disabled={state.saving} style={segmentStyle(scope === "project", state.saving)}>
                  项目
                </button>
              </div>
              <MobileRow label="写入路径" hint={<span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{agentTargetPath(scope, draft.name, state.profiles, state.cwd)}</span>} />
            </MobileCard>
          </>
        )}

        <MobileSection title="基本" />
        <MobileCard>
          {!editing && (
            <CardField label="子代理 ID（配置文件名）" first>
              <input
                aria-label="子代理 ID"
                value={draft.name}
                disabled={state.saving}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => update("name", event.target.value)}
                style={{ ...editInputStyle, fontFamily: "var(--font-mono)", fontSize: 14 }}
              />
            </CardField>
          )}
          <CardField label="显示名称" first={Boolean(editing)}>
            <input
              aria-label="显示名称"
              value={draft.displayName}
              disabled={state.saving}
              onChange={(event) => update("displayName", event.target.value)}
              style={editInputStyle}
            />
          </CardField>
          <CardField label="描述">
            <input
              aria-label="描述"
              value={draft.description}
              disabled={state.saving}
              onChange={(event) => update("description", event.target.value)}
              style={editInputStyle}
            />
          </CardField>
        </MobileCard>

        <MobileSection title="系统指令" />
        <MobileCard>
          <div style={{ padding: "11px 14px" }}>
            <textarea
              aria-label="系统指令"
              value={draft.systemPrompt}
              disabled={state.saving}
              rows={8}
              onChange={(event) => update("systemPrompt", event.target.value)}
              style={{ width: "100%", minWidth: 0, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg)", color: "var(--text)", fontSize: 14, lineHeight: 1.6, outline: "none", resize: "vertical", fontFamily: "var(--font-mono)" }}
            />
          </div>
        </MobileCard>

        <MobileSection title="工具与资源" />
        <MobileCard>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7, padding: "12px 14px" }}>
            {TOOL_OPTIONS.map((tool) => (
              <ChipToggle key={tool} label={tool} active={draft.tools.includes(tool)} disabled={state.saving} onClick={() => update("tools", draft.tools.includes(tool) ? draft.tools.filter((item) => item !== tool) : [...draft.tools, tool])} />
            ))}
          </div>
          <MobileRow
            label="加载技能"
            trailing={(
              <MobileSwitch checked={draft.loadSkills} disabled={state.saving} onChange={() => update("loadSkills", !draft.loadSkills)} label="加载技能" />
            )}
          />
          <MobileRow
            label="加载扩展"
            trailing={(
              <MobileSwitch checked={draft.loadExtensions} disabled={state.saving} onChange={() => update("loadExtensions", !draft.loadExtensions)} label="加载扩展" />
            )}
          />
        </MobileCard>

        <MobileSection title="运行" />
        <MobileCard>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7, padding: "12px 14px" }}>
            <ChipSelect
              ariaLabel="模型"
              value={draft.model ?? ""}
              onChange={(value) => update("model", value || undefined)}
              options={[
                { value: "", label: state.modelsLoading ? "加载模型…" : "跟随父会话" },
                ...state.modelOptions.map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name })),
              ]}
            />
            <ChipSelect
              ariaLabel="思考级别"
              value={draft.thinking ?? ""}
              onChange={(value) => update("thinking", (value || undefined) as typeof draft.thinking)}
              options={THINKING_OPTIONS.map((level) => ({ value: level, label: level || "跟随父会话" }))}
            />
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 32, padding: "0 8px 0 12px", borderRadius: 999, fontSize: 12.5, border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text)" }}>
              <span>最大轮次</span>
              <input
                aria-label="最大轮次"
                type="number"
                min={1}
                value={draft.maxTurns ?? ""}
                placeholder="—"
                disabled={state.saving}
                onChange={(event) => update("maxTurns", event.target.value ? Number(event.target.value) : undefined)}
                style={{ width: 52, height: 26, border: 0, borderRadius: 7, background: "var(--bg)", color: "var(--text)", font: "inherit", fontSize: 13, textAlign: "center", outline: "none" }}
              />
            </label>
          </div>
          <MobileRow
            label="继承父会话上下文"
            trailing={<MobileSwitch checked={draft.inheritContext} disabled={state.saving} onChange={() => update("inheritContext", !draft.inheritContext)} label="继承父会话上下文" />}
          />
          <MobileRow
            label="默认在后台运行"
            trailing={<MobileSwitch checked={draft.runInBackground} disabled={state.saving} onChange={() => update("runInBackground", !draft.runInBackground)} label="默认在后台运行" />}
          />
        </MobileCard>

        <MobileNote>
          {editing && isWritableAgentScope(editing.scope)
            ? `保存写入 ${agentTargetPath(editing.scope, editing.name, state.profiles, state.cwd)}。`
            : "同名配置会按 项目 > 工作区 > 全局 > 内置 覆盖低优先级作用域。"}
        </MobileNote>
      </div>
    </div>
  );
}
