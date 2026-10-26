// final-arch step-6 Task 1（2026-10-26）：交付初始化（只补缺、只建议、永不启用、
// 永不执行命令）+ 就绪清单投影。spec §13.2/§13.3/§13.5.1——「Nth project」的
// 故事：新建与导入一视同仁，重跑幂等：
//
//   initializeDelivery(workspacePath, input) 六步：
//     1. 仓库：触发一次扫描登记（syncRepositoriesFromScan——与仓库列表同一对
//        账；不走 listWorkspaceRepositories 的 TTL 缓存与每仓 git 子进程，init
//        只需要对账结果）。
//     2. delivery.yaml：缺失才写 v2 默认（enabled 恒 false——启用是人的手；
//        stages 按输入、verification 只在 input.checks 给定时写入——经
//        parseDeliveryRunnerConfig 校验，integrate 开着没命令在这里就 400）。
//        已存在一字不动（action「config: 已存在，未改动」，enabled:true 永不翻）。
//     3. 剧本播种：seedRoleProfileTemplates（一次性记录、缺文件才写、永不改写
//        ——written/skipped 折进动作清单）。
//     4. from（同布局目录 = .pi/ 在场）：四活角色目标缺文件才复制（剥 frontmatter
//        seeded_from 换 copied_from——带版本源透传出处、无 seeded_from 的块首插
//        copied_from: <role>、无 frontmatter 原文；本轮播种刚写的不复制）；
//        integrate.sh 缺文件才复制；AGENTS.md / delivery.yaml 永不复制——from
//        的 checks 剥 repositoryId 只进响应 suggestedChecks 供人确认。
//     5. 工具链探测：登记活跃 code 仓 × 根 marker 文件 → 检查命令草稿，只进
//        响应 suggestedChecks（带 repositoryId——仓已登记），从不落盘执行。
//     6. 就绪清单：写后投影（下方 deliveryReadiness 同一装配）。
//
//   deliveryReadiness(workspacePath)：五类缺项只读投影（非门禁——enabled 不受
//   它约束）：no-checks / missing-profile:<role> / capabilities-missing /
//   check-repo-unregistered / integrate-no-command，kind 序即展示序。
//   strict 解析拒绝的配置（手写 yaml integrate 开着没命令等）按宽容读兜住——
//   投影常驻显示，宁可报缺项不可炸面板。
//
// 响应类型单一定义处 = api-types（浏览器镜像；attention 同款 type-only 引用）。
// capability 门（assertAutomationCapable）由路由层在写入前调用——本模块纯服务层。
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  DeliveryInitResponse,
  DeliveryReadinessItem,
  DeliveryReadinessResponse,
  DeliverySuggestedCheck,
} from "../api-types.ts";
import {
  DEFAULT_DELIVERY_RUNNER_CONFIG,
  deliveryConfigPath,
  parseDeliveryRunnerConfig,
  readDeliveryRunnerConfig,
  writeDeliveryRunnerConfig,
  type DeliveryCheckConfig,
  type DeliveryRunnerConfig,
  type DeliveryRoleConfig,
} from "../work-items/delivery-runner/config.ts";
import { WorkItemValidationError } from "../work-items/errors.ts";
import { DELIVERY_ROLES, type DeliveryRole } from "../work-items/delivery-runner/roles.ts";
import {
  ROLE_TEMPLATE_VERSION,
  seedRoleProfileTemplates,
} from "../work-items/delivery-runner/role-templates.ts";
import {
  readWorkspaceManifest,
  syncRepositoriesFromScan,
  withWorkspaceWriteLock,
  workspaceRepositoryPath,
} from "./service.ts";
import type { WorkspaceManifest } from "./types.ts";

export interface DeliveryInitInput {
  /** 同布局源目录（.pi/ 在场）：复制角色剧本 / integrate.sh，checks 只作草稿。 */
  from?: string;
  /** 首次写默认配置时落盘的验证命令（人向导里确认过的；不给 = 配置无 verification 键）。 */
  checks?: DeliveryCheckConfig[];
  integrate?: { enabled?: boolean; command?: string };
  acceptance?: { enabled?: boolean };
  /** stages.review 开关（先审后跑）。 */
  stagesReview?: boolean;
}

const isEnoent = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";
const isEexist = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException)?.code === "EEXIST";

/** 工具链探测映射（计划默认 1）：仓根 marker 文件 → 检查命令草稿。探测结果只
 *  进响应 suggestedChecks（模块级 Maven、切 JDK 之类由人改），从不落盘执行。 */
const TOOLCHAIN_MARKERS: ReadonlyArray<readonly [marker: string, command: string]> = [
  ["pom.xml", "mvn -q test"],
  ["package.json", "npm test"],
  ["pyproject.toml", "pytest"],
  ["go.mod", "go test ./..."],
  ["Cargo.toml", "cargo test"],
];

/** 自动化能力要求（与 assertAutomationCapable 同一双写常量——config.ts 的表是
 *  私有的，这里是投影只读复述，判定仍以门为准）。 */
const AUTOMATION_CAPABILITIES = ["work-items", "workflows"] as const;

/** 剧本名解析（role-session.ts resolveRoleProfileName 同式——刻意不引 role-session：
 *  它捎带 session-host 宿主重模块，投影只需要这一行纯函数）。 */
const configuredProfileName = (role: DeliveryRole, roleConfig?: DeliveryRoleConfig): string =>
  roleConfig?.profile ?? role;

/** 路由薄壳的输入校验：形状不对 → Validation（400）；checks 元素的业务校验
 *  交给 parseDeliveryRunnerConfig（错误文案精确到 verification.checks[i]）。 */
export function parseInitInput(value: unknown): DeliveryInitInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkItemValidationError("request body must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.from !== undefined && (typeof record.from !== "string" || !record.from.trim())) {
    throw new WorkItemValidationError("from must be a non-empty string");
  }
  if (record.checks !== undefined && !Array.isArray(record.checks)) {
    throw new WorkItemValidationError("checks must be an array");
  }
  const integrate = parseStageToggle(record.integrate, "integrate");
  const acceptance = parseStageToggle(record.acceptance, "acceptance");
  if (record.stagesReview !== undefined && typeof record.stagesReview !== "boolean") {
    throw new WorkItemValidationError("stagesReview must be a boolean");
  }
  return {
    ...(record.from !== undefined ? { from: record.from } : {}),
    ...(record.checks !== undefined ? { checks: record.checks as DeliveryCheckConfig[] } : {}),
    ...(integrate ? { integrate } : {}),
    ...(acceptance ? { acceptance } : {}),
    ...(record.stagesReview !== undefined ? { stagesReview: record.stagesReview } : {}),
  };
}

function parseStageToggle(
  value: unknown,
  field: string,
): { enabled?: boolean; command?: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkItemValidationError(`${field} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
    throw new WorkItemValidationError(`${field}.enabled must be a boolean`);
  }
  if (
    record.command !== undefined &&
    (typeof record.command !== "string" || !record.command.trim())
  ) {
    throw new WorkItemValidationError(`${field}.command must be a non-empty string`);
  }
  return {
    ...(record.enabled !== undefined ? { enabled: record.enabled } : {}),
    ...(record.command !== undefined ? { command: record.command } : {}),
  };
}

/**
 * 交付初始化：只补缺、只建议——重跑幂等（每步要么「缺失才写」要么纯跳过）。
 * 永不翻 enabled、永不执行任何命令；探测与 from 草稿只进响应 suggestedChecks。
 */
export async function initializeDelivery(
  workspacePath: string,
  input: DeliveryInitInput,
): Promise<DeliveryInitResponse> {
  const actions: string[] = [];

  // 1) 仓库：触发一次扫描登记（扫描为事实——新目录自动登记、消失目录自动停用）。
  const scanChanged = await withWorkspaceWriteLock(workspacePath, async () => {
    const manifest = await readWorkspaceManifest(workspacePath);
    return syncRepositoriesFromScan(workspacePath, manifest);
  });
  actions.push(scanChanged ? "repositories: 扫描登记更新" : "repositories: 扫描对账完成（无变更）");

  // 2) delivery.yaml：缺失才写默认（草稿经 parse 校验——integrate 开着没命令
  //    在这里就 Validation → 400）；已存在一字不动。
  const existingConfig = await readDeliveryRunnerConfig(workspacePath);
  if (existingConfig !== null) {
    actions.push("config: 已存在，未改动");
  } else {
    const integrateCommand = input.integrate?.command?.trim();
    const config = parseDeliveryRunnerConfig({
      ...DEFAULT_DELIVERY_RUNNER_CONFIG,
      stages: {
        review: { enabled: input.stagesReview === true },
        integrate: {
          enabled: input.integrate?.enabled === true,
          ...(integrateCommand ? { command: integrateCommand } : {}),
        },
        acceptance: { enabled: input.acceptance?.enabled === true },
      },
      ...(input.checks !== undefined ? { verification: { checks: input.checks } } : {}),
    });
    await writeDeliveryRunnerConfig(workspacePath, config);
    actions.push("config: 写入默认 delivery.yaml（enabled: false）");
  }

  // 3) 剧本播种（一次性记录在 .pi/delivery-seeded.json；written/skipped 折进动作）。
  const seeded = await seedRoleProfileTemplates(workspacePath);
  if (seeded.written.length > 0) actions.push(`profiles: 播种 ${seeded.written.join("、")}`);
  if (seeded.skipped.length > 0) {
    actions.push(`profiles: 跳过（已播种或已存在）${seeded.skipped.join("、")}`);
  }

  // 4) from 复制（复制即新所有者——源改动不传播）。
  const fromChecks =
    input.from === undefined
      ? []
      : await copyFromSource(workspacePath, input.from, seeded.written, actions);

  // 5) 工具链探测草稿（对账后重新读 manifest——扫描刚登记的仓立即参与探测）。
  const manifest = await readWorkspaceManifest(workspacePath);
  const probeDrafts = await probeToolchainChecks(workspacePath, manifest);
  const suggestedChecks = [...fromChecks, ...probeDrafts];

  // 6) 就绪清单（写后投影——反映 init 结束时的真实状态）。
  const finalConfig = existingConfig ?? (await readDeliveryRunnerConfig(workspacePath));
  const readiness = await projectReadinessItems(workspacePath, finalConfig, manifest);

  return {
    actions,
    ...(suggestedChecks.length > 0 ? { suggestedChecks } : {}),
    readiness,
  };
}

/** frontmatter 的 seeded_from 行剥换 copied_from（spec §13.3「复制即新所有者」）：
 *  源行 `seeded_from: "<role>@<v>"` → `copied_from: "<role>@<v>"`（值原样保留
 *  ——真实出处，漂移提示依据）；无 seeded_from 行但有 frontmatter → 块首插
 *  `copied_from: <role>`（无版本 = 非模板出身）；无 frontmatter → 原文复制。
 *  其余 frontmatter 与正文一字不动（块级替换，不做 YAML 重排）。 */
function withCopiedFromMarker(source: string, role: DeliveryRole): string {
  const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|$)/);
  if (!match) return source;
  const block = match[1];
  const marked = /^seeded_from:/m.test(block)
    ? block.replace(/^seeded_from:/m, "copied_from:")
    : `copied_from: ${role}\n${block}`;
  return `---\n${marked}\n---${source.slice(match[0].length)}`;
}

/** from 复制：四活角色剧本（目标缺文件才写——wx 竞态安全，本轮播种刚写的不复
 *  制）+ integrate.sh 骨架（缺文件才写、可执行位 755）+ from 的 delivery.yaml
 *  checks 剥 repositoryId 作草稿（宽容解析——坏 yaml 只是没有草稿，不炸 init）。 */
async function copyFromSource(
  workspacePath: string,
  from: string,
  seedWritten: DeliveryRole[],
  actions: string[],
): Promise<DeliverySuggestedCheck[]> {
  const fromPi = join(resolve(from), ".pi");
  let piStat;
  try {
    piStat = await stat(fromPi);
  } catch {
    throw new WorkItemValidationError(`from must be a directory with a .pi/ layout: ${from}`);
  }
  if (!piStat.isDirectory()) {
    throw new WorkItemValidationError(`from must be a directory with a .pi/ layout: ${from}`);
  }

  let copied = 0;
  const seedWrittenSet = new Set(seedWritten);
  const agentsDir = join(workspacePath, ".pi", "agents");
  for (const role of DELIVERY_ROLES) {
    if (seedWrittenSet.has(role)) continue; // 播种本轮刚写——模板优先，不复制
    let source: string;
    try {
      source = await readFile(join(fromPi, "agents", `${role}.md`), "utf8");
    } catch (error) {
      if (isEnoent(error)) continue; // 源没这个角色 → 跳过
      throw error;
    }
    try {
      await mkdir(agentsDir, { recursive: true });
      await writeFile(join(agentsDir, `${role}.md`), withCopiedFromMarker(source, role), {
        flag: "wx",
      });
    } catch (error) {
      if (isEexist(error)) continue; // 目标在场 → 永不覆盖
      throw error;
    }
    actions.push(`from: 复制 ${role}.md`);
    copied += 1;
  }

  try {
    const script = await readFile(join(fromPi, "scripts", "integrate.sh"));
    try {
      await mkdir(join(workspacePath, ".pi", "scripts"), { recursive: true });
      await writeFile(join(workspacePath, ".pi", "scripts", "integrate.sh"), script, {
        flag: "wx",
        mode: 0o755,
      });
      actions.push("from: 复制 integrate.sh");
      copied += 1;
    } catch (error) {
      if (!isEexist(error)) throw error;
    }
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }

  const drafts: DeliverySuggestedCheck[] = [];
  let rawConfig: string | null = null;
  try {
    rawConfig = await readFile(join(fromPi, "delivery.yaml"), "utf8");
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  if (rawConfig !== null) {
    try {
      const doc = parseYaml(rawConfig) as { verification?: { checks?: unknown } } | null;
      const checks = doc?.verification?.checks;
      if (Array.isArray(checks)) {
        for (const entry of checks) {
          if (typeof entry !== "object" || entry === null) continue;
          const { name, command } = entry as { name?: unknown; command?: unknown };
          if (
            typeof name === "string" && name.trim() &&
            typeof command === "string" && command.trim()
          ) {
            // repositoryId 刻意剥除：仓绑定是项目事实，待面板重绑。
            drafts.push({ name, command });
          }
        }
      }
    } catch {
      // 草稿参考：源 yaml 坏 → 宽容跳过（不炸 init）。
    }
  }

  if (copied === 0) actions.push("from: 无可复制项，未复制");
  return drafts;
}

/** 工具链探测：登记活跃 code 仓的根 marker 文件 → 草稿（name = 仓别名，
 *  repositoryId = manifest 条目 id；knowledge 仓不探测）。只读盘探测，不执行。 */
async function probeToolchainChecks(
  workspacePath: string,
  manifest: WorkspaceManifest,
): Promise<DeliverySuggestedCheck[]> {
  const drafts: DeliverySuggestedCheck[] = [];
  for (const repository of manifest.repositories) {
    if (repository.status !== "active" || repository.kind !== "code") continue;
    const { absolutePath } = workspaceRepositoryPath(workspacePath, repository);
    for (const [marker, command] of TOOLCHAIN_MARKERS) {
      try {
        await access(join(absolutePath, marker));
      } catch {
        continue;
      }
      drafts.push({ name: repository.alias, repositoryId: repository.id, command });
    }
  }
  return drafts;
}

/** strict 解析拒绝的配置（integrate 开着没命令等手写状态）按宽容读兜住——
 *  投影只判定「integrate 已启用而无可用命令」，不抛。 */
async function integrateEnabledWithoutCommand(workspacePath: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(deliveryConfigPath(workspacePath), "utf8");
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch {
    return false;
  }
  const integrate = (
    doc as { stages?: { integrate?: { enabled?: unknown; command?: unknown } } } | null
  )?.stages?.integrate;
  return (
    integrate?.enabled === true &&
    !(typeof integrate.command === "string" && integrate.command.trim().length > 0)
  );
}

/** 就绪五类缺项（kind 序即展示序；init 与 deliveryReadiness 同一装配）。 */
async function projectReadinessItems(
  workspacePath: string,
  config: DeliveryRunnerConfig | null,
  manifest: WorkspaceManifest,
): Promise<DeliveryReadinessItem[]> {
  const items: DeliveryReadinessItem[] = [];

  // 1. no-checks：配置缺失或 verification.checks 空（空数组 = 等同无配置）。
  if (!config?.verification || config.verification.checks.length === 0) {
    items.push({ kind: "no-checks", detail: "建议在设置中配置验证命令或运行初始化" });
  }

  // 2. missing-profile:<role>：同名或 roles.<role>.profile 指向的剧本文件不存在。
  for (const role of DELIVERY_ROLES) {
    const name = configuredProfileName(role, config?.roles[role]);
    let exists = true;
    try {
      await access(join(workspacePath, ".pi", "agents", `${name}.md`));
    } catch {
      exists = false;
    }
    if (!exists) {
      items.push({
        kind: `missing-profile:${role}`,
        detail: name === role
          ? `角色 ${role} 缺少剧本（.pi/agents/${role}.md）——运行初始化播种或自行创建`
          : `角色 ${role} 配置的剧本 ${name} 不存在（roles.${role}.profile → .pi/agents/${name}.md）`,
      });
    }
  }

  // 3. capabilities-missing：detail 列出缺哪些。
  const missing = AUTOMATION_CAPABILITIES.filter(
    (capability) => !manifest.capabilities.includes(capability),
  );
  if (missing.length > 0) {
    items.push({
      kind: "capabilities-missing",
      detail: `工作区缺少能力: ${missing.join(", ")}（在设置中开启后才能跑交付自动化）`,
    });
  }

  // 4. check-repo-unregistered：配置的 repositoryId 不在登记活跃仓（缺省 = 候选
  //    首仓、claim 侧解析，不在此列）。
  if (config?.verification) {
    const activeIds = new Set(
      manifest.repositories.filter((repo) => repo.status === "active").map((repo) => repo.id),
    );
    for (const check of config.verification.checks) {
      if (check.repositoryId !== undefined && !activeIds.has(check.repositoryId)) {
        items.push({
          kind: "check-repo-unregistered",
          detail: `检查「${check.name}」指向的仓库未登记（repositoryId: ${check.repositoryId}）`,
        });
      }
    }
  }

  // 5. integrate-no-command：strict 解析必拒该状态——只可能藏在解析失败/缺失的
  //    配置里，宽容直读 yaml 判定。
  if (config === null && (await integrateEnabledWithoutCommand(workspacePath))) {
    items.push({
      kind: "integrate-no-command",
      detail: "stages.integrate 已启用但未配置命令——在设置中补命令或关闭该阶段",
    });
  }

  return items;
}

/**
 * 就绪清单（只读、非门禁）：五类缺项 + 当前内置模板版本（漂移提示依据）。
 * 设置面板常驻显示；enabled 与否不受它约束。
 */
export async function deliveryReadiness(workspacePath: string): Promise<DeliveryReadinessResponse> {
  const manifest = await readWorkspaceManifest(workspacePath);
  let config: DeliveryRunnerConfig | null;
  try {
    config = await readDeliveryRunnerConfig(workspacePath);
  } catch (error) {
    // 手写坏配置不炸面板：按无可用配置投影（no-checks 等缺项照常报出）。
    if (error instanceof WorkItemValidationError) {
      config = null;
    } else {
      throw error;
    }
  }
  return {
    items: await projectReadinessItems(workspacePath, config, manifest),
    currentTemplateVersion: ROLE_TEMPLATE_VERSION,
  };
}
