// Seam-repositioning Task 2（2026-10-26）：角色会话装配终形——引擎不变式合同 +
// 工作区剧本正文。四段角色专属合同（designer/developer/verifier/release-
// preparer）删除：角色差异全部下沉到 `<ws>/.pi/agents/<profile>.md` 剧本（默认
// 剧本名 = 角色名，config.roles[role].profile 可覆写；正文经 appendSystemPrompt
// 注入，frontmatter 的 model 作模型覆写来源），引擎只保留对四角色一致的回合
// 不变式（AGENT_INVARIANT_CONTRACT，spec §4.3.1 六条：领取纪律 / 写域隔离 /
// submit-fail-ask 终态 / 证据规则 / 人工动作边界 / 项目事实出处）。开场 prompt
// 单一通用四步（列池 → 领指派项 → 按剧本工作 → submit/fail/ask 结束）；领取
// 上下文（需求、上游产物、worktree 或检查清单）由 delivery_claim_task 的返回
// 带给会话——不进系统提示。final-arch step-2 Task 3（2026-10-26）：上一轮
// delivery_ask_human 的人工答复随任务包回场——LaunchRoleOptions.clarifications
//（dispatcher 自池条目透传，只含已答）进开场 prompt 的「人的答复」段（按
// askedAt 升序、仅已答；无已答则整段不出），下一轮从人的决定起步。
//
// dispatcher 判定该起角色会话时调 launchRoleSession：两步创建序
// （sessionId 到手 → grantRole → delivery 执行登记 → 命名 → 开场 prompt），
// 会话本身 fire-and-forget——不 await 轮结束，结束钩子（wrapper onDestroy）+
// 心跳续约兜底。模型优先级：config.roles[role].model ?? 剧本 frontmatter
// model ?? 会话默认；剧本缺场（缺文件/非法名）→ warn 一条后仅以不变式开场，
// 读盘异常 → error 记录当缺场——「配了剧本却读不到」不打死整个 launch。
//
// 结束钩子（onDestroy）：记录本会话遗留的所有未清 claim → revokeRole → 清
// delivery 执行登记 → 停心跳。领取集 = launch key 快路径 + 全活动项扫描兜底
// （fix-round 1 裁定：不变式限定「只领取指派项」，扫描兜住违约领取——对每个
// claim.sessionId 匹配的项 recordInterruption，服务幂等，先到者清 claim）。
// claim 已清 / 他人会话 / 二次触发都只做无条件的 revoke/clear，不动记录。
// 结束钩子/心跳/登记 role 无关（claim.sessionId 匹配，不问角色）。
//
// 心跳：20s 一拍续约 claim.lastSeenAt（heartbeatActiveClaim——sessionId 匹配
// 才写，不 bump revision、不产生事件、不进 git），interval unref 且随会话结束
// 清零。宿主关停路径另有兜底：background.ts 对 kind="delivery" 的登记写
// claim.recordInterruption("host shutdown")（与本钩子竞写安全——服务幂等）。
import type { CreateSessionInput, CreateSessionResult } from "../../session-host/facade.ts";
import { createSession, destroySession, sendCommand } from "../../session-host/facade.ts";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFrontmatter } from "../../frontmatter.ts";
import { getRpcSession } from "../../session-host/registry.ts";
import {
  clearDeliveryExecutionMark,
  markDeliveryExecutionActive,
} from "../../session-host/background.ts";
import { heartbeatActiveClaim, recordInterruption } from "./claim.ts";
import { readClaim, type ClaimState } from "./attempts.ts";
import { grantRole, revokeRole } from "./role-grants.ts";
import { listWorkItems, readWorkItem } from "../service.ts";
import type { DeliveryClarification } from "../delivery-types.ts";
import type { DeliveryRunnerConfig, DeliveryRoleConfig } from "./config.ts";
import type { DeliveryRole } from "./pool.ts";
import type { RoleWorktree } from "./worktrees.ts";

/** 交付回合不变式（spec §4.3.1 六条，四角色一致）：领取纪律 / 写域隔离 /
 *  submit-fail-ask 终态 / 证据规则 / 人工动作边界 / 项目事实出处。role 与 key
 *  是仅有的内插位；工具名不加反引号（库内 prompt 习语）。 */
export const AGENT_INVARIANT_CONTRACT: (ctx: { role: DeliveryRole; key: string }) => string = ({ role, key }) =>
  `# 交付回合不变式（${role} · ${key}）

1. 先 delivery_claim_task 成功才动手；本轮只领指派项 ${key}，不可领取即说明并结束。
2. 只在 claim 返回的 worktree / 目录内写，其余一律只读；不合并、不推送、不碰受保护分支——集成与发布是引擎与人的事。
3. 本轮以 submit / fail / ask 三者之一结束；结束时不得留进行中的领取。
4. 自述不是证据；检查只经 delivery_run_check 触发。
5. 确认、验收、发布登记没有工具——那是人的手。
6. 项目事实（gate 命令、构建环境、分支纪律）查工作区 AGENTS.md 与你的剧本。`;

/** 工作区角色剧本：frontmatter 的 model 覆写 + 正文 body（随 appendSystemPrompt
 *  注入——角色差异的唯一载体）。seededFrom（Task 4 增）透出 frontmatter 的
 *  seeded_from（Task 3 模板播种标记，spec §13.3 漂移提示依据）——装配不消费，
 *  只读投影（role-preview.ts）用它标「模板 vN」。 */
export interface RoleProfile {
  model?: { provider?: string; modelId: string };
  seededFrom?: string;
  body: string;
}

/** 剧本名解析：config.roles[role].profile 显式优先，缺省 = 角色名（约定同名
 *  剧本 .pi/agents/&lt;role&gt;.md）。 */
export function resolveRoleProfileName(role: DeliveryRole, roleConfig?: DeliveryRoleConfig): string {
  return roleConfig?.profile ?? role;
}

/** 会话系统提示装配：不变式合同在前，剧本正文在后（空白正文按缺席——仅不变式，
 *  无尾分隔符）。 */
export function composeRoleSystemPrompt(
  ctx: { role: DeliveryRole; key: string },
  profile?: RoleProfile,
): string {
  const parts = [AGENT_INVARIANT_CONTRACT(ctx), profile?.body].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0,
  );
  return parts.join("\n\n");
}

/** 开场任务包携带的澄清（final-arch step-2 Task 3）：上一轮 delivery_ask_human
 *  的条目子集——只保留问答与时间序所需的字段。 */
export type OpeningClarification = Pick<
  DeliveryClarification,
  "question" | "answer" | "askedAt"
>;

/** 开场指令（四角色单一通用文案，仅首行 role 字样不同）：列池 → 领指派项 →
 *  按剧本工作（上下文以领取返回为准）→ submit/fail/ask 结束。context.
 *  clarifications 含已答条目时，在四步之后追加「人的答复」段（按 askedAt 升序，
 *  每条一行问一行答；未答条目省略；无已答则整段不出——prompt 与无 context
 *  时逐字节相同）。 */
export function openingPromptFor(
  role: DeliveryRole,
  task: { key: string; title: string },
  context?: { clarifications?: ReadonlyArray<OpeningClarification> },
): string {
  const steps = [
    `你是本工作区的交付 ${role} 会话，请开始本轮工作：`,
    "1. 调用 delivery_list_ready_tasks 列出当前就绪池；",
    `2. 用 delivery_claim_task 领取本轮目标 ${task.key} ${task.title}——本轮只领取这一项；若它已不可领取（被领走/门禁变化），说明原因后结束本轮，不要领取其他工作项；`,
    "3. 依据领取返回的上下文（需求、上游产物、worktree 或检查清单）按你的剧本完成本阶段工作；",
    "4. 用 delivery_submit_result 提交后即结束本轮；需要人的决定时用 delivery_ask_human 提问后结束；无法推进时用 delivery_fail_task 说明原因（环境/依赖阻塞带 blocked=true）后结束。",
  ];
  // 上一轮 ask 的人工答复随任务包回场（ISO askedAt 字典序 = 时间序；空白答复
  // 视同未答——dispatcher 只滤 undefined，此处是最后一道语义滤网）。
  const answered = (context?.clarifications ?? [])
    .filter((c) => c.answer !== undefined && c.answer.trim() !== "")
    .sort((a, b) => a.askedAt.localeCompare(b.askedAt));
  const section = answered.length === 0
    ? ""
    : `\n\n## 人的答复（按时间）${
      answered.map((c) => `\nQ: ${c.question}\nA: ${c.answer}`).join("")
    }`;
  return `${steps.join("\n")}${section}`;
}

/** claim 心跳周期（spec §5.2 轻量续约；四角色共用）。 */
export const DESIGNER_HEARTBEAT_INTERVAL_MS = 20_000;

export interface LaunchDeps {
  createSession?: (input: CreateSessionInput) => Promise<CreateSessionResult>;
  sendCommand?: (sessionId: string, command: { type: string; [key: string]: unknown }) => Promise<unknown>;
  destroySession?: (sessionId: string) => void;
  /** 结束钩子注册（默认 getRpcSession(...).onDestroy）。返回 false = 会话已不在
   *  （武装前就消失了）——launch 立即走收尾而不是等一个永不到来的 destroy。 */
  onSessionDestroy?: (sessionId: string, cb: () => void | Promise<void>) => boolean;
  grantRole?: typeof grantRole;
  revokeRole?: typeof revokeRole;
  markActive?: typeof markDeliveryExecutionActive;
  clearActive?: typeof clearDeliveryExecutionMark;
  /** 读工作项目录与当前 claim（默认 readWorkItem + readClaim）；失败 = null。 */
  resolveItem?: (
    workspacePath: string,
    key: string,
  ) => Promise<{ path: string; claim: ClaimState | null } | null>;
  /** 扫描工作区全部活动项的当前 claim（结束钩子兜底——不变式限定只领指派项，
   *  扫描兜住违约领取）。默认 listWorkItems + 逐项读，单项读失败 = claim null。 */
  scanClaims?: (workspacePath: string) => Promise<Array<{ key: string; claim: ClaimState | null }>>;
  heartbeat?: typeof heartbeatActiveClaim;
  record?: typeof recordInterruption;
  /** 读工作区角色剧本 `<ws>/.pi/agents/<profile>.md`（默认 readRoleProfile）：
   *  frontmatter 的 model 覆写 + 正文 body。返回 undefined = 剧本缺场（launch
   *  侧 warn 后仅以不变式开场）。 */
  readProfile?: (
    workspacePath: string,
    profile: string,
  ) => RoleProfile | undefined | Promise<RoleProfile | undefined>;
  now?: () => Date;
}

const defaultOnSessionDestroy = (sessionId: string, cb: () => void | Promise<void>): boolean => {
  const wrapper = getRpcSession(sessionId);
  if (!wrapper) return false;
  wrapper.onDestroy(() => void cb());
  return true;
};

const defaultResolveItem: NonNullable<LaunchDeps["resolveItem"]> = async (workspacePath, key) => {
  const detail = await readWorkItem(workspacePath, key);
  return { path: detail.path, claim: readClaim(detail.path) };
};

/** profile 名门（与 subagents assertProfileName 同款）：合法才允许拼路径，把
 *  `../escape` 之类的配置笔误/穿越形态挡在读盘之前。 */
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 读工作区角色剧本（`<workspacePath>/.pi/agents/<profile>.md`——subagents 的
 * project 作用域目录）：frontmatter 的 `model:` 字段按现行拆分规则解析
 * （`provider/modelId` 首个 `/` 双非空 → {provider, modelId}，裸 → {modelId}；
 * 非字符串/空 → 缺席），body = frontmatter 之后全文 trim（无 frontmatter 即
 * 全文）。文件缺失 / 名字不合法 → undefined（静默——launch 侧 warn 兜底）。
 * 刻意只读工作区目录（不走 resolveSubagentProfile——它跨 user/project 作用域，
 * 有同名歧义）；解析复用 `parseFrontmatter`（subagents 同一习语）。
 */
export function readRoleProfile(workspacePath: string, profile: string): RoleProfile | undefined {
  const name = profile.trim();
  if (!PROFILE_NAME_RE.test(name)) return undefined;
  const filePath = join(resolve(workspacePath), ".pi", "agents", `${name}.md`);
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch {
    return undefined; // 缺文件 = 无剧本，不是错误
  }
  const { data, rest } = parseFrontmatter(source);
  const modelValue = typeof data?.model === "string" ? data.model.trim() : "";
  const slash = modelValue.indexOf("/");
  const model =
    modelValue === ""
      ? undefined
      : slash > 0 && slash < modelValue.length - 1
        ? { provider: modelValue.slice(0, slash), modelId: modelValue.slice(slash + 1) }
        : { modelId: modelValue };
  // seeded_from（Task 3 播种标记）只透出非空字符串；缺席/空串 → 键省略。
  const seededFromValue = typeof data?.seeded_from === "string" ? data.seeded_from.trim() : "";
  return {
    ...(model ? { model } : {}),
    ...(seededFromValue ? { seededFrom: seededFromValue } : {}),
    body: rest.trim(),
  };
}

/** 工作区全部活动项的当前 claim 扫描：结束钩子兜底与 T7 dispatcher 清道夫
 *  共用同一习语（listWorkItems → 逐项 readWorkItem → readClaim）；单项读失败
 *  = claim null，fs 容错不阻塞扫描。 */
export const scanActiveItemClaims: NonNullable<LaunchDeps["scanClaims"]> = async (workspacePath) => {
  const { items } = await listWorkItems(workspacePath);
  const entries: Array<{ key: string; claim: ClaimState | null }> = [];
  for (const item of items) {
    try {
      const detail = await readWorkItem(workspacePath, item.key);
      entries.push({ key: item.key, claim: readClaim(detail.path) });
    } catch {
      entries.push({ key: item.key, claim: null }); // fs-tolerant：单项读失败不阻塞兜底扫描
    }
  }
  return entries;
};

export interface LaunchRoleOptions {
  workspaceId: string;
  workspacePath: string;
  /** 本次拉起的角色（池条目所处阶段决定——dispatcher 透传 entry.role）。 */
  role: DeliveryRole;
  task: { key: string; title: string };
  /** 领取上下文（dispatcher 透传空对象）。装配当前不消费——worktree/检查清单
   *  由 delivery_claim_task 的返回带给会话，不进系统提示；类型保留以稳调用面。 */
  claim: { worktrees?: RoleWorktree[] };
  /** 上一轮 delivery_ask_human 的人工答复（dispatcher 自池条目透传，只含已答
   *  ——未答项被池谓词挡在 ready 外）——openingPromptFor 据此追加「人的答复」
   *  段，下一轮从人的决定起步。 */
  clarifications?: OpeningClarification[];
  config: DeliveryRunnerConfig;
  deps?: LaunchDeps;
}

/**
 * 拉起一个角色会话（四角色通用）并返回 sessionId（不 await 轮结束）。
 * 两步创建序：createSession 不带 command → grantRole → markDeliveryExecutionActive
 * → set_session_name（`${role} · ${key}`）→ prompt；任何装配失败都会收尾
 * （revoke/clear/destroy）后重抛。结束钩子/心跳/登记 role 无关（claim.sessionId
 * 匹配，不问角色）。
 */
export async function launchRoleSession(opts: LaunchRoleOptions): Promise<string> {
  const d = {
    createSession: opts.deps?.createSession ?? createSession,
    sendCommand: opts.deps?.sendCommand ?? sendCommand,
    destroySession: opts.deps?.destroySession ?? destroySession,
    onSessionDestroy: opts.deps?.onSessionDestroy ?? defaultOnSessionDestroy,
    grantRole: opts.deps?.grantRole ?? grantRole,
    revokeRole: opts.deps?.revokeRole ?? revokeRole,
    markActive: opts.deps?.markActive ?? markDeliveryExecutionActive,
    clearActive: opts.deps?.clearActive ?? clearDeliveryExecutionMark,
    resolveItem: opts.deps?.resolveItem ?? defaultResolveItem,
    scanClaims: opts.deps?.scanClaims ?? scanActiveItemClaims,
    heartbeat: opts.deps?.heartbeat ?? heartbeatActiveClaim,
    record: opts.deps?.record ?? recordInterruption,
    readProfile: opts.deps?.readProfile ?? readRoleProfile,
    now: opts.deps?.now ?? (() => new Date()),
  };
  const { workspacePath, task, role } = opts;
  // 剧本与模型解析：剧本名 = config.roles[role].profile ?? 角色名；读 `<ws>/
  //  .pi/agents/<profile>.md`——正文进系统提示，frontmatter model 作模型来源。
  //  模型优先级：显式 config model ?? 剧本 model ?? 会话默认。剧本缺场（缺文件/
  //  非法名）→ warn 一条后仅以不变式开场；读盘异常 → error 记录当缺场——
  //  「配了剧本却读不到」不该把整个 launch 打死。
  const roleConfig = opts.config.roles[role];
  const profileName = resolveRoleProfileName(role, roleConfig);
  let profile: RoleProfile | undefined;
  try {
    profile = (await d.readProfile(workspacePath, profileName)) ?? undefined;
  } catch (error) {
    console.error(`[delivery-runner] ${role} profile read failed (${profileName}):`, error);
    profile = undefined;
  }
  if (profile === undefined) {
    console.warn(
      `[delivery-runner] ${role} has no profile at .pi/agents/${profileName}.md; running with invariant contract only`,
    );
  }
  const model = roleConfig?.model ?? profile?.model;

  // 1. 建会话（不带 command——sessionId 到手才能 grant/登记/命名）；系统提示 =
  //    不变式合同 + 剧本正文，模型覆写走 StartSessionOptions.model。
  const created = await d.createSession({
    cwd: workspacePath,
    appendSystemPrompt: composeRoleSystemPrompt({ role, key: task.key }, profile),
    ...(model ? { model } : {}),
  });
  const sessionId = created.sessionId;

  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };
  // 结束钩子：幂等（单飞守卫）。遗留领取集 = launch key 快路径 ∪ 全活动项扫描
  // 兜底（fix-round 1：不变式限定只领指派项，扫描兜住违约领取——本会话 sessionId
  // 名下的每个未清 claim 都记中断），随后 revoke/clear/停心跳。
  let ended = false;
  const handleEnd = async (): Promise<void> => {
    if (ended) return;
    ended = true;
    stopHeartbeat();
    const ownedKeys = new Set<string>();
    try {
      const item = await d.resolveItem(workspacePath, task.key);
      if (item != null && item.claim !== null && item.claim.sessionId === sessionId) ownedKeys.add(task.key);
    } catch (error) {
      console.error(`[delivery-runner] read claim on session end failed for ${task.key}:`, error);
    }
    try {
      for (const entry of await d.scanClaims(workspacePath)) {
        if (entry.claim !== null && entry.claim.sessionId === sessionId) ownedKeys.add(entry.key);
      }
    } catch (error) {
      // 扫描失败不吞掉快路径的记录，也不阻塞 revoke/clear 收尾。
      console.error("[delivery-runner] claim scan on session end failed:", error);
    }
    for (const key of ownedKeys) {
      await d.record(workspacePath, key, sessionId, "session ended with active claim").catch((error) => {
        console.error(`[delivery-runner] record interruption failed for ${key}:`, error);
      });
    }
    d.revokeRole(sessionId);
    d.clearActive(sessionId);
  };

  try {
    // 2. 角色授权（delivery_* 工具的身份门）。
    d.grantRole(sessionId, { role, workspacePath });
    // 3. delivery 执行登记（宿主关停据此写 claim 中断）。
    d.markActive(sessionId, { workspacePath, itemKey: task.key });
    // 4. 命名（省略代次——generation 此刻未知，领取后才产生）。
    await d.sendCommand(sessionId, { type: "set_session_name", name: `${role} · ${task.key}` });
  } catch (error) {
    // 装配失败：结束钩子可能尚未武装，显式收尾后销毁已建会话再抛。
    await handleEnd().catch(() => {});
    d.destroySession(sessionId);
    throw error;
  }

  // 6a. 结束钩子 + 心跳先于开场 prompt 武装——prompt 发送失败/会话在武装窗口内
  // 消失都由它们兜底。会话已不在（onSessionDestroy 返回 false）= 立即收尾。
  const registered = d.onSessionDestroy(sessionId, handleEnd);
  // 6b. 心跳续约：claim.sessionId 匹配才写 lastSeenAt（服务侧保证不 bump
  // revision/不产事件）；无 claim 的拍次是廉价 no-op。
  heartbeatTimer = setInterval(() => {
    void (async () => {
      try {
        const item = await d.resolveItem(workspacePath, task.key);
        if (item !== null) await d.heartbeat(workspacePath, item.path, sessionId);
      } catch (error) {
        console.error(`[delivery-runner] claim heartbeat failed for ${task.key}:`, error);
      }
    })();
  }, DESIGNER_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
  if (!registered) {
    await handleEnd();
    return sessionId;
  }

  // 5. 开场指令。send 只等受理（fire-and-forget），轮结束由结束钩子兜底；
  //    上一轮 ask 的已答澄清随任务包进「人的答复」段。
  try {
    await d.sendCommand(sessionId, {
      type: "prompt",
      message: openingPromptFor(role, task, { clarifications: opts.clarifications }),
    });
  } catch (error) {
    await handleEnd().catch(() => {});
    d.destroySession(sessionId);
    throw error;
  }
  return sessionId;
}
