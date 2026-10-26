// final-arch step-6 Task 2（2026-10-26）：AGENTS.md 的 delivery managed 块（spec
// §13.1/§13.5.1）。机制与 repositories / knowledge 块同构（service.ts 的
// updateManagedRepositoryInstructions 同款 anchor-replace）：标记
// `<!-- workspace-managed:delivery:start/end -->` 之间由产品改写、标记外一字不
// 碰；无标记 no-op（绝不创建）；用户删掉标记 → 静默停止同步、永不重建。
//
// 块内容（注入 system prompt，短小、纯 markdown）：
//   ## Delivery automation
//   - status: enabled|disabled
//   - <role>: profile <name> (exists|missing), model <effective|default>   ×四活角色
//   - checks: <name> (<仓别名|id>), …   /   - checks: none
//   - stages: review on/off · integrate on/off(command) · acceptance on/off
//
// 角色投影复用 summarizeRoles（role-preview.ts——有效模型解析与 launch 同一优
// 先级：config 覆写 › 剧本 frontmatter › 默认）；checks 的仓别名从 manifest 解
// 析（纯展示，读不到 manifest 就回退原 id）。导入方向：config.ts 已引
// work-items/service 的 writeAtomic，本模块同向（config.ts 不引本模块，无环）。
// 调用方 = delivery 配置保存与 init 路由（写成功后同步，失败记日志不挡保存）。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readWorkspaceManifest } from "./service.ts";
import {
  readDeliveryRunnerConfig,
  type DeliveryRunnerConfig,
} from "../work-items/delivery-runner/config.ts";
import {
  summarizeRoles,
  type RoleSummary,
} from "../work-items/delivery-runner/role-preview.ts";
import { writeAtomic } from "../work-items/service.ts";

export const DELIVERY_MANAGED_START = "<!-- workspace-managed:delivery:start -->";
export const DELIVERY_MANAGED_END = "<!-- workspace-managed:delivery:end -->";

/** 标记间整段匹配（repositories 块同一写法：非贪婪、跨行）。 */
const DELIVERY_MANAGED_BLOCK_RE = new RegExp(
  `${DELIVERY_MANAGED_START}[\\s\\S]*?${DELIVERY_MANAGED_END}`,
);

/** 模型展示：effective（provider 可缺省）拼 `provider/modelId`；缺省 → "default"。 */
function renderModel(model: RoleSummary["model"]): string {
  const effective = model.effective;
  if (!effective) return "default";
  return effective.provider ? `${effective.provider}/${effective.modelId}` : effective.modelId;
}

/** 渲染带标记的完整块（templates.ts 的 renderWorkspaceRepositories 同款——
 *  替换串自带标记，反复更新成立）。 */
export function renderDeliveryManagedBlock(
  config: DeliveryRunnerConfig | null,
  roles: readonly RoleSummary[],
  repositoryAliasById: ReadonlyMap<string, string> = new Map(),
): string {
  const lines: string[] = [`- status: ${config?.enabled ? "enabled" : "disabled"}`];
  for (const role of roles) {
    lines.push(
      `- ${role.role}: profile ${role.profile.name} (${role.profile.exists ? "exists" : "missing"}), `
        + `model ${renderModel(role.model)}`,
    );
  }
  const checks = config?.verification?.checks ?? [];
  lines.push(checks.length === 0
    ? "- checks: none"
    : `- checks: ${checks.map((check) => check.repositoryId === undefined
      ? check.name
      : `${check.name} (${repositoryAliasById.get(check.repositoryId) ?? check.repositoryId})`).join(", ")}`
  );
  const stages = config?.stages;
  const integrate = stages?.integrate;
  lines.push(
    `- stages: review ${stages?.review?.enabled ? "on" : "off"}`
      + ` · integrate ${integrate?.enabled ? `on (${integrate.command ?? ""})` : "off"}`
      + ` · acceptance ${stages?.acceptance?.enabled ? "on" : "off"}`,
  );
  return `${DELIVERY_MANAGED_START}\n## Delivery automation\n\n${lines.join("\n")}\n${DELIVERY_MANAGED_END}`;
}

/**
 * delivery 配置保存 / init 之后同步 AGENTS.md 的 delivery managed 块：
 * AGENTS.md 缺失 → no-op；无标记 → no-op（文件字节不动）；有标记 → 重渲染替换。
 * 配置读取失败（手写坏 yaml 等）按调用方兜错的原则原样抛出——路由侧 try/catch
 * 记日志、不打死保存。哈希谓词用 include 判位（replace 无匹配时字符串原样）。
 */
export async function updateManagedDeliveryInstructions(workspacePath: string): Promise<void> {
  const agentsPath = join(workspacePath, "AGENTS.md");
  let current: string;
  try {
    current = await readFile(agentsPath, "utf8");
  } catch {
    return; // no AGENTS.md to maintain — never created here
  }
  if (!current.includes(DELIVERY_MANAGED_START) || !current.includes(DELIVERY_MANAGED_END)) {
    return; // markers absent or removed by the user → silently stop
  }
  const config = await readDeliveryRunnerConfig(workspacePath);
  let repositoryAliasById = new Map<string, string>();
  try {
    const manifest = await readWorkspaceManifest(workspacePath);
    repositoryAliasById = new Map(manifest.repositories.map((repo) => [repo.id, repo.alias]));
  } catch {
    // 别名是纯展示：读不到 manifest 就回退原 id，不挡块同步。
  }
  const rendered = renderDeliveryManagedBlock(config, summarizeRoles(workspacePath, config), repositoryAliasById);
  // 函数式替换：渲染串里的 `$&`/`$'` 等是字面内容（integrate 命令），不能吃进
  // replace 的特殊替换语义。
  const next = current.replace(DELIVERY_MANAGED_BLOCK_RE, () => rendered);
  if (next === current) return;
  await writeAtomic(agentsPath, next);
}
