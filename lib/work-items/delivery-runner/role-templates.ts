// Seam-repositioning Task 3（2026-10-26）：交付角色的默认剧本模板与播种。
// Task 2 之后角色会话的系统提示 = 引擎不变式合同 + `<ws>/.pi/agents/<role>.md`
// 剧本正文——本模块提供产品缺省剧本（四角色各一份：读什么 / 产什么 / 怎么
// 干 / 何时失败；只写干活内容——不变式六条归引擎、工作区专属事实不进通用
// 模板），并在交付配置保存成功后把它们播种进工作区 `.pi/agents/`：
// write-if-missing（writeFile flag "wx" 竞态安全——EEXIST → skipped，其它
// 错误照抛），不读不比既有内容、永不改写——落盘之日起文件归工作区，用户
// 怎么改都合法。frontmatter 的 seeded_from 记 "<role>@<ROLE_TEMPLATE_
// VERSION>"；模板升级时递增版本号，作日后「剧本与新版模板漂移」提示的依据
// （提示本身不在本模块）。模板同时可被 lib/subagents.ts 的 parseProfileFile
// 解析（name 合法、正文即 systemPrompt）——.pi/agents 本就是双用途目录。
//
// Final-fix A（2026-10-26）：播种**每角色只一次**，一次性记录在产品持有的
// `<ws>/.pi/delivery-seeded.json`（spec §6.2/§13.1「播种一次性、永不重建」）：
//   - roles.<role> 已记录 → skipped——**文件被用户删了也不重建**（删除即终局；
//     wx 只看文件在场，挡不住「删了再保存」的复活，记录才是真相源）。
//   - 未记录但 `<ws>/.pi/agents/<role>.md` 在场 → 收养记 "existing"（用户预
//     置，产品永不写）；wx 竞态撞上 EEXIST 同样按收养。
//   - 未记录且缺文件 → 写模板、记 "<role>@<ROLE_TEMPLATE_VERSION>"。
//   - 记录不可读/畸形 → fail-safe：**一字不写**、全角色 skipped、console.error
//     一次（「永不重建」的承诺压过播种——宁可一次不播，不可盲目重播）。
// 记录变更后经 writeAtomic 落盘（与 delivery.yaml 同一原子写；.pi 目录随
// mkdir recursive 已在场）。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DELIVERY_ROLES, type DeliveryRole } from "./roles.ts";
import { writeAtomic } from "../service.ts";

/** 模板版本：模板内容升级时递增；frontmatter seeded_from 与漂移提示的依据。 */
export const ROLE_TEMPLATE_VERSION = 1;

/** 播种记录 schemaVersion（记录形状变更时递增并迁移）。 */
export const DELIVERY_SEED_RECORD_SCHEMA_VERSION = 1;

/** 预置剧本的收养标记（区别于 "<role>@<version>" 的产品播种记录）。 */
const ADOPTED_EXISTING = "existing";

/** frontmatter 三键固定（name / description 一句 / seeded_from 带版本），正文
 *  由各角色给出——拼装集中一处，模板升级只改版本号与正文。 */
const roleTemplate = (role: DeliveryRole, description: string, body: string): string =>
  `---\nname: ${role}\ndescription: ${description}\nseeded_from: "${role}@${ROLE_TEMPLATE_VERSION}"\n---\n\n${body.trim()}\n`;

const DESIGNER_BODY = `
# 设计师剧本

你是本工作区的交付设计师：把一项需求整理成开发照着做、验证照着查的设计。

## 开工先读

- 通读工作区 README 与本需求涉及的各个仓库，弄清相关模块的结构与既有约定。
- 各仓怎么构建、怎么运行，以仓库自己的说明为准，不要凭记忆猜。

## 产出设计

把完整设计写进提交的 design_markdown，骨架至少三块：

1. 方案——做什么、怎么做、为什么这样做；有取舍就写清取舍。
2. 影响面——动到哪些仓库与模块、对外行为有什么变化、有什么兼容性考虑。
3. 步骤拆解——开发可以按序执行的实现步骤，每步尽量可独立自测。

## 验收条件

- acceptance_criteria 逐条列出，每条都具体到可核验（可执行的检查或可观察的行为）；「工作正常」这类无法核验的表述不算一条。

## 何时失败

- 需求不清、关键信息缺失或互相矛盾，现有材料也无法澄清 → 用失败结束并说明缺什么、卡在哪，不要硬编一个方案。
- 设计完成 → 提交 design_markdown 与 acceptance_criteria。
`;

const DEVELOPER_BODY = `
# 开发者剧本

你是本工作区的交付开发者：把已确认的设计落成各仓库里的提交。

## 开工先读

- 读本项已确认的 design.md 与验收条件——实现与自测都以它为准；发现设计有缺口，记进提交说明反馈。

## 实现与自测

- 在领取返回的 worktree 分支内实现并自测；涉及几个仓库就在几个分支上工作。
- 建议先给要改的行为写失败测试，再实现到测试通过；各仓怎么跑测试以仓库自己的说明为准。
- 自测逐条对验收条件，不满足就继续改。

## 提交

- 完成后在每个工作分支上 commit，提交说明写清楚做了什么。
- 用 delivery_submit_result 提交：candidates 里每个仓库一条 {repositoryId, commit}（commit = 该仓分支上的提交 sha）；notes 写变更说明与自测情况（跑了什么、结果如何）。

## 何时失败

- 设计无法实施（前提不成立、环境缺依赖、与仓库现状冲突）→ 用失败结束并说明具体阻塞点，不要硬造实现。
`;

const VERIFIER_BODY = `
# 验证者剧本

你是本工作区的交付验证者：对开发的候选实现逐项运行配置好的检查。

## 工作方式

- 领取返回的 checks 清单就是本轮全部检查项：逐项用 delivery_run_check 运行，一项不落；清单之外的检查不替工作区发明。
- 同名检查重跑会覆盖旧结果：环境问题（网络、依赖、磁盘等）导致的失败，处理环境后重跑同一项即可。
- 领取返回里没有检查清单（未配置检查）→ 如实说明后提交。

## 发现实现问题

- 检查暴露实现缺陷时不要自己动手修：把失败现象（哪项检查、什么输出、指向哪里）写进 notes，开发会在重做轮次处理。

## 提交

- 全部检查项都有结果后提交：只需 key，可选附 notes 汇总——检查结果由服务端从运行记录取用，不在参数里传。

## 何时失败

- 环境长期不可用、检查无法运行且重试无望 → 用失败结束并说明阻塞情况与已跑 / 未跑清单。
`;

const RELEASE_PREPARER_BODY = `
# 发布准备者剧本

你是本工作区的交付发布准备者：基于已登记的验证证据起草发布材料。

## 材料四要素

release_notes（必填）至少覆盖：

1. 变更摘要——这次发布包含什么、为什么。
2. 影响面——对外行为、接口、数据有什么变化，谁需要注意。
3. 验证结论引用——引用实际登记的检查与结果（哪项检查、什么结论）。
4. 回滚建议——rollback_notes（可选）建议尽量写：出问题回到哪个基线、回滚步骤与注意点。

## 证据纪律

- 只引用服务端实际登记的验证记录：登记里没有的检查、没出过的结论，一个字都不编。
- 材料里每句关于验证的话都要能落到登记记录上。

## 何时失败

- 证据不足以支撑发布说明（检查未登记、记录读不到）→ 用失败结束并说明缺哪些证据；宁可失败，不编结论。

## 提交

- 用 delivery_submit_result 提交：release_notes 必填，rollback_notes 可选。
`;

/** 四角色默认剧本（只读；播种后归工作区，引擎不再回看这份内容）。 */
export const ROLE_PROFILE_TEMPLATES: Readonly<Record<DeliveryRole, string>> = {
  designer: roleTemplate("designer", "交付设计师剧本：把需求整理成可实施、可核验的设计。", DESIGNER_BODY),
  developer: roleTemplate("developer", "交付开发者剧本：在领取的工作区分支内按设计实现并自测。", DEVELOPER_BODY),
  verifier: roleTemplate("verifier", "交付验证者剧本：逐项运行配置的检查并如实记录结果。", VERIFIER_BODY),
  "release-preparer": roleTemplate("release-preparer", "交付发布准备者剧本：基于已登记的验证证据起草发布材料。", RELEASE_PREPARER_BODY),
};

/** 播种结果：written / skipped 各为角色列表，按 DELIVERY_ROLES 序。 */
export interface SeedResult {
  written: DeliveryRole[];
  skipped: DeliveryRole[];
}

/** 播种记录的 roles 表（键 = 角色名，值 = "<role>@<版本>" | "existing"；
 *  未知键原样保留——产品只认 DELIVERY_ROLES，但不销毁人手写进记录的内容）。 */
type SeedRolesRecord = Record<string, string>;

/** 解析播种记录正文：合法 JSON 对象 + schemaVersion 恰 1 + roles 为纯字符串
 *  值表才算可读；其余（坏 JSON / 错版本 / 非法形状）→ null（fail-safe）。 */
function parseSeedRecordRoles(raw: string): SeedRolesRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as { schemaVersion?: unknown; roles?: unknown };
  if (record.schemaVersion !== DELIVERY_SEED_RECORD_SCHEMA_VERSION) return null;
  if (typeof record.roles !== "object" || record.roles === null || Array.isArray(record.roles)) {
    return null;
  }
  for (const value of Object.values(record.roles as Record<string, unknown>)) {
    if (typeof value !== "string") return null;
  }
  return record.roles as SeedRolesRecord;
}

/**
 * 把四份剧本模板**一次性**播种进 `<workspacePath>/.pi/agents/`（目录缺失先
 * recursive 建）。一次性记录在 `<ws>/.pi/delivery-seeded.json`：已记录角色
 * 直接 skipped（文件删了也不重建——删除即终局）；未记录且文件在场 → 收养记
 * "existing"、永不写；未记录且缺文件 → writeFile flag "wx" 写模板（EEXIST →
 * 按收养，其它错误照抛）、记 "<role>@<ROLE_TEMPLATE_VERSION>"。记录不可读 /
 * 畸形 → fail-safe：一字不写、全角色 skipped、console.error 一次（永不重建
 * 的承诺压过播种）。每次配置保存成功都会调用，记录齐后空转无害。
 */
export async function seedRoleProfileTemplates(workspacePath: string): Promise<SeedResult> {
  const root = resolve(workspacePath);
  const dir = join(root, ".pi", "agents");
  const recordPath = join(root, ".pi", "delivery-seeded.json");
  await mkdir(dir, { recursive: true });
  const written: DeliveryRole[] = [];
  const skipped: DeliveryRole[] = [];

  // 1) 读记录：缺文件（ENOENT）= 全新工作区 / 播种早于记录机制的旧库 → 空表
  //    起步；读盘异常（EACCES 等）或解析失败 → fail-safe 一字不写（永不重建 >
  //    播种），全角色 skipped，只报一条。
  let roles: SeedRolesRecord;
  try {
    const parsed = parseSeedRecordRoles(await readFile(recordPath, "utf8"));
    if (parsed === null) {
      console.error(
        `[delivery-runner] seed record at ${recordPath} is malformed; skipping role template seeding`,
      );
      return { written, skipped: [...DELIVERY_ROLES] };
    }
    roles = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      roles = {};
    } else {
      console.error(
        `[delivery-runner] seed record at ${recordPath} is unreadable; skipping role template seeding:`,
        error,
      );
      return { written, skipped: [...DELIVERY_ROLES] };
    }
  }

  // 2) 逐角色三态：已记录 → skipped（删除即终局）；在场未记录 → 收养；缺文件
  //    未记录 → wx 写模板。记录有变才回写（原子，与 delivery.yaml 同款）。
  let recordChanged = false;
  for (const role of DELIVERY_ROLES) {
    if (roles[role] !== undefined) {
      skipped.push(role);
      continue;
    }
    const profilePath = join(dir, `${role}.md`);
    let adoptExisting = false;
    try {
      await writeFile(profilePath, ROLE_PROFILE_TEMPLATES[role], { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
        adoptExisting = true; // 竞态或预置文件在场（本实现不预 stat，wx 自报）
      } else {
        throw error;
      }
    }
    if (adoptExisting) {
      roles[role] = ADOPTED_EXISTING;
      skipped.push(role);
      recordChanged = true;
      continue;
    }
    roles[role] = `${role}@${ROLE_TEMPLATE_VERSION}`;
    written.push(role);
    recordChanged = true;
  }
  if (recordChanged) {
    await writeAtomic(
      recordPath,
      `${JSON.stringify(
        { schemaVersion: DELIVERY_SEED_RECORD_SCHEMA_VERSION, roles },
        null,
        2,
      )}\n`,
    );
  }
  return { written, skipped };
}
