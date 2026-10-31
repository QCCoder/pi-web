import type { SubagentProfile, SubagentScope } from "./subagents";

const SUBAGENT_SCOPE_PRIORITY: Record<SubagentScope, number> = {
  builtin: 0,
  global: 1,
  workspace: 2,
  project: 3,
};

/** 作用域按优先级高→低（UI 分组顺序 = 谁赢谁在上）。 */
export const SUBAGENT_SCOPE_ORDER: readonly SubagentScope[] = ["project", "workspace", "global", "builtin"];

export function isSubagentProfileOverridden(
  profile: Pick<SubagentProfile, "name" | "scope">,
  profiles: readonly Pick<SubagentProfile, "name" | "scope">[],
): boolean {
  const name = profile.name.toLowerCase();
  const priority = SUBAGENT_SCOPE_PRIORITY[profile.scope];
  return profiles.some((candidate) =>
    candidate.name.toLowerCase() === name
    && SUBAGENT_SCOPE_PRIORITY[candidate.scope] > priority
  );
}

/** 覆盖该配置的最高作用域（无覆盖返回 null）——「被 X 覆盖」文案的数据出处。 */
export function overridingSubagentScope(
  profile: Pick<SubagentProfile, "name" | "scope">,
  profiles: readonly Pick<SubagentProfile, "name" | "scope">[],
): SubagentScope | null {
  const name = profile.name.toLowerCase();
  const priority = SUBAGENT_SCOPE_PRIORITY[profile.scope];
  let overriding: SubagentScope | null = null;
  for (const candidate of profiles) {
    if (candidate.name.toLowerCase() !== name) continue;
    if (SUBAGENT_SCOPE_PRIORITY[candidate.scope] <= priority) continue;
    if (overriding === null || SUBAGENT_SCOPE_PRIORITY[candidate.scope] > SUBAGENT_SCOPE_PRIORITY[overriding]) {
      overriding = candidate.scope;
    }
  }
  return overriding;
}
