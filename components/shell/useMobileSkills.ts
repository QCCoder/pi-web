"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  SkillInfo,
  SkillInstallScope,
  SkillSearchResult,
  SkillUpdateResult,
  SkillsResponse,
} from "@/lib/api-types";

/**
 * 手机壳 Skill tab 的数据层（2026-10 底部 tab 改版）。与桌面 `SkillsConfig`
 * 走**同一套后端契约**（列表 / 启停 / skills.sh 搜索 / 安装 / 检查更新 /
 * 更新），只把 UI 拆成「列表页 → 推入详情页 / 推入安装页」的手机形态。
 *
 * 生效面只有全局一档（2026-10 收敛，工作区 skills 白名单已拆除）：
 *   - 列表：GET /api/skills?cwd=…（全局 + 当前 cwd 的项目 skill，全量）。
 *   - 启停：PATCH /api/skills { filePath, disableModelInvocation } —— 写
 *     SKILL.md frontmatter，全局生效；「停用」= 从模型视野抹掉（不进 system
 *     prompt 索引）。工作区专属能力走 project 安装（安装位置即作用域）。
 *   - 更新：POST /api/skills/check（单个传 package+scope，全部则省略）→
 *     updateStatuses[`${scope}\0${package}`]；POST /api/skills/update 后重拉。
 *   - 安装：POST /api/skills/search { query } → skills.sh 结果；
 *     POST /api/skills/install { package, scope, cwd } → 重拉。
 *     project 档位仅在锚定工作区时开放（见 projectInstallAvailable）。
 *   - 无卸载端点（与桌面一致：停用 = frontmatter 开关）。
 */

export type SkillSourceLabel = "project" | "global" | "path";

/** 与 SkillsConfig.sourceLabel 逐字同构（分组归属用它，不看 baseDir）。 */
export function skillSourceLabel(skill: SkillInfo): SkillSourceLabel {
  const src = skill.sourceInfo?.source;
  const scope = skill.sourceInfo?.scope;
  if (scope === "user" || src === "user") return "global";
  if (scope === "project" || src === "project") return "project";
  return "path";
}

export interface SkillGroup {
  id: string;
  title: string;
  skills: SkillInfo[];
}

/** 分组顺序与 SkillsConfig 一致（空组省略，组内启用项排前）。 */
export function groupSkills(skills: SkillInfo[], isEnabled: (skill: SkillInfo) => boolean): SkillGroup[] {
  const defs: { id: string; title: string; match: (skill: SkillInfo) => boolean }[] = [
    { id: "project-sh", title: "项目 · skills.sh", match: (s) => skillSourceLabel(s) === "project" && Boolean(s.install?.skillsShUrl) },
    { id: "project", title: "项目", match: (s) => skillSourceLabel(s) === "project" && !s.install?.skillsShUrl },
    { id: "global-sh", title: "全局 · skills.sh", match: (s) => skillSourceLabel(s) === "global" && Boolean(s.install?.skillsShUrl) },
    { id: "global", title: "全局", match: (s) => skillSourceLabel(s) === "global" && !s.install?.skillsShUrl },
    { id: "path", title: "路径", match: (s) => skillSourceLabel(s) === "path" },
  ];
  const byEnabled = (a: SkillInfo, b: SkillInfo) => Number(isEnabled(b)) - Number(isEnabled(a));
  return defs
    .map((def) => ({ id: def.id, title: def.title, skills: skills.filter(def.match).sort(byEnabled) }))
    .filter((group) => group.skills.length > 0);
}

export function skillUpdateKey(scope: SkillInstallScope, pkg: string): string {
  return `${scope}\0${pkg}`;
}

export function shortVersion(hash?: string): string {
  return hash ? hash.slice(0, 8) : "";
}

export function shortenPath(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+/, "~");
}

/** 详情页路径展示：项目 skill 在 cwd 下 → ./relative；否则 ~ 缩写。 */
export function displaySkillPath(skill: SkillInfo, cwd: string): string {
  if (skillSourceLabel(skill) === "project" && cwd && skill.filePath.startsWith(cwd)) {
    return `.${skill.filePath.slice(cwd.length)}`;
  }
  return shortenPath(skill.filePath);
}

interface Options {
  cwd: string;
  /** project 安装档位门控：锚定工作区时开放（安装位置即作用域）。 */
  projectInstallAvailable: boolean;
}

export function useMobileSkills({ cwd, projectInstallAvailable }: Options) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projectResourcesLoaded, setProjectResourcesLoaded] = useState(true);
  const [toggleBusy, setToggleBusy] = useState<Set<string>>(() => new Set());
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [updateStatuses, setUpdateStatuses] = useState<Record<string, SkillUpdateResult>>({});
  const [checkingAll, setCheckingAll] = useState(false);
  const [checkingKeys, setCheckingKeys] = useState<Set<string>>(() => new Set());
  const [updatingKeys, setUpdatingKeys] = useState<Set<string>>(() => new Set());
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<SkillSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [installingPkg, setInstallingPkg] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [newlyInstalled, setNewlyInstalled] = useState<Set<string>>(() => new Set());

  const loadSkills = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`);
      const data = (await res.json()) as Partial<SkillsResponse> & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSkills(data.skills ?? []);
      setProjectResourcesLoaded(data.projectResourcesLoaded ?? true);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const isEnabled = useCallback((skill: SkillInfo) => !skill.disableModelInvocation, []);

  const toggleSkill = useCallback(async (skill: SkillInfo) => {
    setToggleError(null);
    const busyKey = skill.filePath;
    setToggleBusy((prev) => new Set(prev).add(busyKey));
    try {
      const next = !skill.disableModelInvocation;
      setSkills((prev) => prev.map((s) => (s.filePath === skill.filePath ? { ...s, disableModelInvocation: next } : s)));
      const res = await fetch("/api/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: skill.filePath, disableModelInvocation: next }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !data.success) {
        setSkills((prev) => prev.map((s) => (s.filePath === skill.filePath ? { ...s, disableModelInvocation: !next } : s)));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
    } catch (error) {
      setToggleError(error instanceof Error ? error.message : String(error));
    } finally {
      setToggleBusy((prev) => {
        const next = new Set(prev);
        next.delete(busyKey);
        return next;
      });
    }
  }, []);

  const contextScope: SkillInstallScope = "project";

  const applyUpdates = useCallback((updates: SkillUpdateResult[]) => {
    setUpdateStatuses((prev) => {
      const next = { ...prev };
      for (const update of updates) next[skillUpdateKey(update.scope, update.package)] = update;
      return next;
    });
  }, []);

  const checkAllUpdates = useCallback(async () => {
    setCheckingAll(true);
    setUpdateError(null);
    try {
      const res = await fetch("/api/skills/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, contextScope }),
      });
      const data = (await res.json()) as { updates?: SkillUpdateResult[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      applyUpdates(data.updates ?? []);
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCheckingAll(false);
    }
  }, [cwd, contextScope, applyUpdates]);

  const checkSkillUpdate = useCallback(async (skill: SkillInfo) => {
    if (!skill.install) return;
    const key = skillUpdateKey(skill.install.scope, skill.install.package);
    setCheckingKeys((prev) => new Set(prev).add(key));
    setUpdateError(null);
    try {
      const res = await fetch("/api/skills/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, package: skill.install.package, scope: skill.install.scope, contextScope }),
      });
      const data = (await res.json()) as { updates?: SkillUpdateResult[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      applyUpdates(data.updates ?? []);
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCheckingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [cwd, contextScope, applyUpdates]);

  const updateSkill = useCallback(async (skill: SkillInfo) => {
    if (!skill.install) return;
    const key = skillUpdateKey(skill.install.scope, skill.install.package);
    setUpdatingKeys((prev) => new Set(prev).add(key));
    setUpdateError(null);
    try {
      const res = await fetch("/api/skills/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, package: skill.install.package, scope: skill.install.scope, contextScope }),
      });
      const data = (await res.json()) as { success?: boolean; skill?: SkillInfo; error?: string };
      if (!res.ok || !data.success) throw new Error(data.error ?? `HTTP ${res.status}`);
      await loadSkills();
      const version = data.skill?.install?.versionHash;
      setUpdateStatuses((prev) => ({
        ...prev,
        [key]: { package: skill.install!.package, scope: skill.install!.scope, state: "up-to-date", currentVersion: version, latestVersion: version },
      }));
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdatingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [cwd, contextScope, loadSkills]);

  const searchSkills = useCallback(async (query: string) => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setSearchError(null);
    try {
      const res = await fetch("/api/skills/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      const data = (await res.json()) as { results?: SkillSearchResult[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSearchResults(data.results ?? []);
    } catch (error) {
      setSearchResults(null);
      setSearchError(error instanceof Error ? error.message : String(error));
    } finally {
      setSearching(false);
    }
  }, []);

  const installSkill = useCallback(async (pkg: string, scope: SkillInstallScope) => {
    setInstallingPkg(pkg);
    setInstallError(null);
    try {
      const res = await fetch("/api/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ package: pkg, scope, cwd }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !data.success) throw new Error(data.error ?? `HTTP ${res.status}`);
      setNewlyInstalled((prev) => new Set(prev).add(`${scope}:${pkg}`));
      await loadSkills();
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : String(error));
    } finally {
      setInstallingPkg(null);
    }
  }, [cwd, loadSkills]);

  /** 已安装包集合（按安装作用域），供安装页标「已安装」。 */
  const installedPackages = useMemo(() => {
    const sets: Record<SkillInstallScope, Set<string>> = { global: new Set(), project: new Set() };
    for (const skill of skills) {
      if (skill.install) sets[skill.install.scope].add(skill.install.package);
    }
    return sets;
  }, [skills]);

  const isInstalled = useCallback(
    (pkg: string, scope: SkillInstallScope) => installedPackages[scope].has(pkg) || newlyInstalled.has(`${scope}:${pkg}`),
    [installedPackages, newlyInstalled],
  );

  const updateStateFor = useCallback((skill: SkillInfo): SkillUpdateResult | null => {
    if (!skill.install) return null;
    return updateStatuses[skillUpdateKey(skill.install.scope, skill.install.package)] ?? null;
  }, [updateStatuses]);

  const updatesAvailable = useMemo(
    () => skills.filter((skill) => updateStateFor(skill)?.state === "update-available").length,
    [skills, updateStateFor],
  );

  const groups = useMemo(() => groupSkills(skills, isEnabled), [skills, isEnabled]);

  return {
    skills,
    groups,
    loading,
    loadError,
    reload: loadSkills,
    projectResourcesLoaded,
    projectInstallAvailable,
    isEnabled,
    toggleSkill,
    toggleBusy,
    toggleError,
    updateStateFor,
    updatesAvailable,
    checkAllUpdates,
    checkingAll,
    checkSkillUpdate,
    checkingKeys,
    updateSkill,
    updatingKeys,
    updateError,
    searchSkills,
    searchResults,
    searching,
    searchError,
    clearSearch: () => { setSearchResults(null); setSearchError(null); },
    installSkill,
    installingPkg,
    installError,
    isInstalled,
  };
}

export type MobileSkillsState = ReturnType<typeof useMobileSkills>;
