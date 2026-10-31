"use client";

import { useMemo, useState } from "react";
import type { SkillInfo, SkillInstallScope } from "@/lib/api-types";
import {
  MobileCard,
  MobileEmpty,
  MobileErrorBanner,
  MobileIconButton,
  MobileNavBar,
  MobileNote,
  MobilePageTitle,
  MobilePill,
  MobilePrimaryButton,
  MobileRow,
  MobileSearchField,
  MobileSecondaryButton,
  MobileSection,
  MobileSwitch,
} from "./mobile-ui";
import {
  type MobileSkillsState,
  displaySkillPath,
  shortVersion,
  shortenPath,
  skillSourceLabel,
} from "./useMobileSkills";

/**
 * 手机壳 Skill tab 的三页（2026-10 底部 tab 改版，用户反馈「Skill 页面布局不好看，
 * 一页放不下就开详情页，不要硬塞」后从 SkillsConfig 内嵌分栏改为手机原生形态）：
 *
 *   MobileSkillsList    tab 根页：标题行（作用域 + 检查更新角标 + 安装）/ 本地筛选 /
 *                       按来源分组的卡片列表（行 = 名 + 描述 + 有更新徽章 + 开关；
 *                       点文字区进详情）。
 *   MobileSkillDetail   推入页：描述 / 启用开关 / 来源·路径·版本（检查 / 更新）/
 *                       skills.sh 链接 / 项目 skill 可查看 SKILL.md。
 *   MobileSkillInstall  推入页：作用域（全局 / 项目）+ skills.sh 搜索 + 结果安装。
 *
 * 数据与后端契约全在 useMobileSkills（与桌面 SkillsConfig 同一套 API）。
 */

const SOURCE_LABEL_TEXT: Record<ReturnType<typeof skillSourceLabel>, string> = {
  project: "项目",
  global: "全局",
  path: "路径",
};

function splitPackage(pkg: string): { repo: string; skill?: string } {
  const at = pkg.indexOf("@");
  if (at <= 0) return { repo: pkg };
  return { repo: pkg.slice(0, at), skill: pkg.slice(at + 1) };
}

export function MobileSkillsList({
  state,
  onOpenDetail,
  onOpenInstall,
}: {
  state: MobileSkillsState;
  onOpenDetail: (skill: SkillInfo) => void;
  onOpenInstall: () => void;
}) {
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  const groups = useMemo(() => {
    if (!query) return state.groups;
    return state.groups
      .map((group) => ({
        ...group,
        skills: group.skills.filter((skill) =>
          skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query)),
      }))
      .filter((group) => group.skills.length > 0);
  }, [state.groups, query]);

  const empty = !state.loading && state.skills.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <MobilePageTitle
        title="Skill"
        actions={(
          <>
            <MobileIconButton
              label={state.checkingAll ? "正在检查更新" : "检查全部更新"}
              onClick={() => { void state.checkAllUpdates(); }}
              badge={state.updatesAvailable}
              disabled={state.checkingAll || state.skills.length === 0}
            >
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={state.checkingAll ? { animation: "spin 0.9s linear infinite" } : undefined}>
                <path d="M21 12a9 9 0 1 1-3.8-7.4" /><path d="M21 3v5h-5" />
              </svg>
            </MobileIconButton>
            <MobileIconButton label="安装 Skill" onClick={onOpenInstall}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </MobileIconButton>
          </>
        )}
      />

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 24 }}>
        {!empty && (
          <MobileSearchField value={filter} onChange={setFilter} placeholder="筛选已安装 Skill" />
        )}
        {state.loadError && <MobileErrorBanner>加载失败：{state.loadError}</MobileErrorBanner>}
        {state.toggleError && <MobileErrorBanner>保存失败：{state.toggleError}</MobileErrorBanner>}
        {state.updateError && <MobileErrorBanner>更新检查失败：{state.updateError}</MobileErrorBanner>}
        {!state.projectResourcesLoaded && (
          <MobileNote>该项目尚未信任，项目级 Skill 未加载——在聊天里信任项目后再回来。</MobileNote>
        )}

        {state.loading && state.skills.length === 0 && (
          <div style={{ padding: "40px 0", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>加载中…</div>
        )}

        {empty && !state.loadError && (
          <MobileEmpty
            title="还没有安装 Skill"
            body="从 skills.sh 搜索并安装，或把 SKILL.md 放进 ~/.pi/agent/skills（全局）或项目 .pi/skills。"
            action={<MobilePrimaryButton onClick={onOpenInstall}>去安装</MobilePrimaryButton>}
          />
        )}

        {!empty && query && groups.length === 0 && (
          <MobileEmpty title="没有匹配的 Skill" body={`没有名称或描述包含「${filter.trim()}」的已安装 Skill。`} />
        )}

        {groups.map((group) => (
          <section key={group.id} aria-label={group.title}>
            <MobileSection title={group.title} trailing={<span style={{ fontSize: 11, color: "var(--text-dim)" }}>{group.skills.length}</span>} />
            <MobileCard>
              {group.skills.map((skill, index) => {
                const enabled = state.isEnabled(skill);
                const update = state.updateStateFor(skill);
                return (
                  <MobileRow
                    key={skill.filePath}
                    first={index === 0}
                    mono
                    label={skill.name}
                    sublabel={skill.description || "（无描述）"}
                    onClick={() => onOpenDetail(skill)}
                    ariaLabel={`${skill.name} 详情`}
                    trailing={(
                      <>
                        {update?.state === "update-available" && <MobilePill tone="accent">有更新</MobilePill>}
                        <MobileSwitch
                          checked={enabled}
                          onChange={() => { void state.toggleSkill(skill); }}
                          disabled={state.toggleBusy.has(skill.filePath)}
                          label={`${enabled ? "停用" : "启用"} ${skill.name}`}
                        />
                      </>
                    )}
                  />
                );
              })}
            </MobileCard>
          </section>
        ))}

        {!empty && (
          <MobileNote>
            开关 = 是否允许模型调用该 Skill（写入 SKILL.md frontmatter，全局生效）。没有卸载——停用即可。
          </MobileNote>
        )}
      </div>
    </div>
  );
}

export function MobileSkillDetail({
  state,
  skill,
  cwd,
  onBack,
  backLabel,
  onOpenFile,
}: {
  state: MobileSkillsState;
  skill: SkillInfo;
  cwd: string;
  onBack: () => void;
  backLabel: string;
  /** 项目 skill 的 SKILL.md 走文件查看器（工作区根内，文件 API 可达）；全局 skill 不提供。 */
  onOpenFile?: (filePath: string) => void;
}) {
  const enabled = state.isEnabled(skill);
  const source = skillSourceLabel(skill);
  const update = state.updateStateFor(skill);
  const install = skill.install;
  const key = install ? `${install.scope}\0${install.package}` : null;
  const checking = key ? state.checkingKeys.has(key) : false;
  const updating = key ? state.updatingKeys.has(key) : false;
  const canOpenFile = Boolean(onOpenFile) && source === "project" && Boolean(cwd) && skill.filePath.startsWith(cwd);

  const versionText = (() => {
    if (!install) return null;
    const current = shortVersion(update?.currentVersion ?? install.versionHash);
    if (!update) return current || "未知";
    switch (update.state) {
      case "update-available": return `${current} → ${shortVersion(update.latestVersion)}`;
      case "up-to-date": return `${current} · 已是最新`;
      case "unsupported": return `${current} · 不支持检查`;
      case "error": return `${current} · 检查失败`;
      default: return current;
    }
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <MobileNavBar title={skill.name} onBack={onBack} backLabel={backLabel} />
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 28 }}>
        <div style={{ padding: "16px 20px 4px" }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 18, fontWeight: 600, color: "var(--text)", wordBreak: "break-all" }}>{skill.name}</div>
          <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.6, color: "var(--text-muted)", whiteSpace: "pre-wrap" }}>
            {skill.description || "（无描述）"}
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
            <MobilePill>{SOURCE_LABEL_TEXT[source]}</MobilePill>
            {install?.skillsShUrl && <MobilePill tone="accent">skills.sh</MobilePill>}
            {update?.state === "update-available" && <MobilePill tone="accent">有更新</MobilePill>}
          </div>
        </div>

        {state.toggleError && <MobileErrorBanner>保存失败：{state.toggleError}</MobileErrorBanner>}
        {state.updateError && <MobileErrorBanner>{state.updateError}</MobileErrorBanner>}

        <MobileSection title="状态" />
        <MobileCard>
          <MobileRow
            first
            label={enabled ? "已启用" : "已停用"}
            sublabel="允许模型调用（全局 frontmatter）"
            trailing={(
              <MobileSwitch
                checked={enabled}
                onChange={() => { void state.toggleSkill(skill); }}
                disabled={state.toggleBusy.has(skill.filePath)}
                label={`${enabled ? "停用" : "启用"} ${skill.name}`}
              />
            )}
          />
        </MobileCard>

        <MobileSection title="来源" />
        <MobileCard>
          <MobileRow first label="位置" hint={<span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{displaySkillPath(skill, cwd)}</span>} />
          {install && (
            <MobileRow label="包" hint={<span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{install.package}</span>} />
          )}
          {install?.skillsShUrl && (
            <MobileRow
              label="skills.sh"
              sublabel={install.skillsShUrl.replace(/^https?:\/\//, "")}
              onClick={() => { window.open(install.skillsShUrl, "_blank", "noopener,noreferrer"); }}
              ariaLabel="在 skills.sh 查看"
            />
          )}
          {install && (
            <MobileRow
              label="版本"
              sublabel={versionText ?? undefined}
              trailing={(
                update?.state === "update-available" ? (
                  <MobilePrimaryButton onClick={() => { void state.updateSkill(skill); }} busy={updating}>
                    {updating ? "更新中…" : "更新"}
                  </MobilePrimaryButton>
                ) : install.canCheckForUpdates ? (
                  <MobileSecondaryButton onClick={() => { void state.checkSkillUpdate(skill); }} busy={checking}>
                    {checking ? "检查中…" : "检查更新"}
                  </MobileSecondaryButton>
                ) : (
                  <span style={{ fontSize: 12, color: "var(--text-dim)" }}>不可检查</span>
                )
              )}
            />
          )}
        </MobileCard>

        {canOpenFile && (
          <>
            <MobileSection title="文件" />
            <MobileCard>
              <MobileRow first label="查看 SKILL.md" sublabel={shortenPath(skill.filePath)} onClick={() => onOpenFile?.(skill.filePath)} />
            </MobileCard>
          </>
        )}

        <MobileNote>
          {install
            ? "更新会重新执行 skills add 拉取最新版本；本地改动会被覆盖。"
            : "手动放置的 Skill 没有安装记录，不支持在线更新。"}
        </MobileNote>
      </div>
    </div>
  );
}

export function MobileSkillInstall({
  state,
  cwd,
  onBack,
  backLabel,
}: {
  state: MobileSkillsState;
  cwd: string;
  onBack: () => void;
  backLabel: string;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SkillInstallScope>("global");
  const projectAvailable = state.projectInstallAvailable && state.projectResourcesLoaded;
  const effectiveScope: SkillInstallScope = scope === "project" && !projectAvailable ? "global" : scope;
  const targetPath = effectiveScope === "global" ? "~/.pi/agent/skills/" : `${shortenPath(cwd)}/.pi/skills/`;

  const segmentStyle = (active: boolean, disabled: boolean): React.CSSProperties => ({
    flex: 1, height: 34, border: 0, borderRadius: 9, fontSize: 13, cursor: disabled ? "default" : "pointer",
    background: active ? "var(--bg)" : "transparent", color: active ? "var(--text)" : "var(--text-muted)",
    boxShadow: active ? "0 1px 3px rgba(0,0,0,0.12)" : "none", fontWeight: active ? 600 : 400,
    opacity: disabled ? 0.45 : 1,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <MobileNavBar title="安装 Skill" onBack={onBack} backLabel={backLabel} />
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 28 }}>
        <MobileSection title="安装到" />
        <MobileCard>
          <div role="radiogroup" aria-label="安装作用域" style={{ display: "flex", gap: 4, padding: 6, background: "var(--bg-subtle)", margin: 10, borderRadius: 11 }}>
            <button type="button" role="radio" aria-checked={effectiveScope === "global"} onClick={() => setScope("global")} style={segmentStyle(effectiveScope === "global", false)}>
              全局
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={effectiveScope === "project"}
              disabled={!projectAvailable}
              onClick={() => setScope("project")}
              title={!state.projectInstallAvailable ? "没有锚定工作区" : !state.projectResourcesLoaded ? "项目未信任" : undefined}
              style={segmentStyle(effectiveScope === "project", !projectAvailable)}
            >
              项目
            </button>
          </div>
          <MobileRow label="目标目录" hint={<span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{targetPath}</span>} />
        </MobileCard>

        <MobileSection title="搜索 skills.sh" />
        <MobileSearchField
          value={query}
          onChange={setQuery}
          placeholder="名称 / 关键字，回车搜索"
          onSubmit={() => { void state.searchSkills(query); }}
          autoFocus
          trailing={(
            <MobilePrimaryButton onClick={() => { void state.searchSkills(query); }} disabled={!query.trim()} busy={state.searching}>
              {state.searching ? "搜索中" : "搜索"}
            </MobilePrimaryButton>
          )}
        />
        {state.searchError && <MobileErrorBanner>搜索失败：{state.searchError}</MobileErrorBanner>}
        {state.installError && <MobileErrorBanner>安装失败：{state.installError}</MobileErrorBanner>}

        {state.searchResults && state.searchResults.length === 0 && (
          <MobileEmpty title="没有找到" body="换个关键字试试，或直接在 skills.sh 上浏览。" />
        )}

        {state.searchResults && state.searchResults.length > 0 && (
          <>
            <MobileSection title="结果" trailing={<span style={{ fontSize: 11, color: "var(--text-dim)" }}>{state.searchResults.length}</span>} />
            <MobileCard>
              {state.searchResults.map((result, index) => {
                const parts = splitPackage(result.package);
                const installed = state.isInstalled(result.package, effectiveScope);
                const busy = state.installingPkg === result.package;
                return (
                  <MobileRow
                    key={result.package}
                    first={index === 0}
                    mono
                    label={parts.skill ?? parts.repo}
                    sublabel={`${parts.repo}${result.installs ? ` · ${result.installs} 次安装` : ""}`}
                    onClick={() => { window.open(result.url, "_blank", "noopener,noreferrer"); }}
                    ariaLabel={`在 skills.sh 查看 ${result.package}`}
                    trailing={(
                      installed ? (
                        <MobilePill>已安装</MobilePill>
                      ) : (
                        <MobilePrimaryButton
                          onClick={() => { void state.installSkill(result.package, effectiveScope); }}
                          busy={busy}
                          disabled={state.installingPkg !== null && !busy}
                        >
                          {busy ? "安装中…" : "安装"}
                        </MobilePrimaryButton>
                      )
                    )}
                  />
                );
              })}
            </MobileCard>
          </>
        )}

        <MobileNote>
          安装执行 <span style={{ fontFamily: "var(--font-mono)" }}>npx skills add</span>，可能需要几十秒；完成后列表自动刷新。
          点结果行可在 skills.sh 查看详情。
        </MobileNote>
      </div>
    </div>
  );
}
