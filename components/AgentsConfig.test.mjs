import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AgentsConfig.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
const modelSelectorSource = await readFile(new URL("./ModelSelector.tsx", import.meta.url), "utf8");

test("keeps same-name profiles selectable by scope and orders groups by precedence", () => {
  assert.match(source, /return `\$\{profile\.scope\}:\$\{profile\.name\}`/);
  assert.match(source, /import \{\n  overridingSubagentScope,\n  SUBAGENT_SCOPE_ORDER,\n\} from "@\/lib\/subagent-profile-precedence"/);
  assert.match(source, /SUBAGENT_SCOPE_ORDER\.map\(\(scope\)/);
  assert.match(source, /profile\.scope === scope/);
});

test("uses the shared enabled status treatment", () => {
  assert.match(source, /<ConfigStatusDot active=\{profile\.enabled\}/);
  // 停用或被高优先级覆盖的行都淡显——侧栏第一眼读出「这份配置现在用不用得上」。
  assert.match(source, /className=\{`is-grow\$\{profile\.enabled && !overriding \? "" : " is-muted"\}`\}/);
  assert.match(cssSource, /\.config-sidebar-text\.is-muted \{[\s\S]*?color: var\(--text-dim\)/);
});

test("offers a persisted built-in sub-agent switch with explicit session reload", () => {
  assert.match(source, /fetch\("\/api\/subagents\/settings"/);
  assert.match(source, /JSON\.stringify\(\{ enabled \}\)/);
  assert.match(source, /<ConfigSwitch[\s\S]*?checked=\{builtInEnabled\}[\s\S]*?t\("agents\.builtInTitle"\)/);
  assert.match(source, /sendAgentCommand\(sessionId, \{ type: "reload" \}\)/);
  assert.match(source, /reloadNeeded && sessionId/);
  assert.match(source, /<input\s+aria-label=\{t\("agents\.maxConcurrent"\)\}\s+className="agents-concurrency-input"/);
  // 总开关 + 并发是全局设置，住侧栏页脚——不再占详情上方的整条横幅。
  assert.equal((source.match(/agents-feature-setting/g) ?? []).length, 0);
  assert.match(source, /className="agents-sidebar-footer"/);
  assert.match(cssSource, /\.agents-sidebar-footer \{[\s\S]*?border-top: 1px solid var\(--border\)/);
});

test("marks profiles shadowed by a higher-precedence source and names the winner", () => {
  assert.match(source, /overridingSubagentScope\(profile, profiles\)/);
  assert.match(source, /t\("agents\.overriddenBy", \{ scope: scopeLabel\(overriding\) \}\)/);
  assert.match(cssSource, /\.agents-overridden-label \{[\s\S]*?white-space: nowrap;/);
});

test("treats global and project profiles as directly editable", () => {
  assert.match(source, /scope === "global" \|\| scope === "project"/);
  assert.match(source, /setMode\(isWritableScope\(profile\.scope\) \? "edit" : "view"\)/);
  assert.match(source, /selected && isWritableScope\(selected\.scope\) && mode === "edit"/);
});

test("offers both writable scopes when creating a profile", () => {
  assert.match(source, /\{creating && \(/);
  assert.match(source, /\["global", "project"\] as const/);
  // 只读作用域不是一种编辑模式——「只读」是视图态提示（readonlyNotice），不存在 override 分支。
  assert.doesNotMatch(source, /beginOverride|mode === "override"/);
});

test("uses the shared sidebar action for new profiles", () => {
  assert.match(source, /<ConfigListAction[\s\S]*?active=\{creating\}[\s\S]*?onClick=\{beginCreate\}/);
  assert.match(source, /t\("agents\.new"\)[\s\S]*?<\/ConfigListAction>/);
});

test("sends the selected scope for saves and the source scope for deletes", () => {
  // 保存体携带可选 expectedContentHash（spec §13.5.1 乐观并发——创建/改名/换作用
  // 域/global 时不带）。
  assert.match(source, /JSON\.stringify\(\{\s*cwd,\s*scope: targetScope,\s*profile: draft,\s*\.\.\.\(expectedContentHash \? \{ expectedContentHash \} : \{\}\),\s*\}\)/);
  assert.match(source, /selected\.scope === targetScope && selected\.name === draft\.name/);
  assert.match(source, /JSON\.stringify\(\{ cwd, scope: selected\.scope, name: selected\.name \}\)/);
  // 409 → 内联冲突提示 + 重载（重新拉列表取新哈希），不当普通错误吞掉。
  assert.match(source, /response\.status === 409/);
  assert.match(source, /setConflict\(t\("agents\.conflictModified"\)\)/);
});

test("shows a Skills-style path row and keeps the header enabled switch for writable profiles", () => {
  assert.match(source, /function displayProfilePath\(profile: SubagentProfile, cwd: string\)/);
  assert.match(source, /profile\.scope === "project" \|\| profile\.scope === "workspace"/);
  // 全局目录从已加载配置反推（adopt-pi-home 后不再是 ~/.pi/agent），不再硬编码路径模板。
  assert.match(source, /subagentTargetPath\(targetScope, draft\.name, profiles, cwd\)/);
  assert.match(source, /subagentScopeDirectory\(scope, profiles, cwd\)/);
  assert.doesNotMatch(source, /`~\/\.pi\/agent\/agents\//);
  assert.match(source, /<ConfigSwitch checked=\{draft\.enabled\} disabled=\{disabled\}/);
  assert.doesNotMatch(source, /agents-readonly-status/);
  assert.doesNotMatch(source, /<Toggle label=\{t\("agents\.enabled"\)\}/);
});

test("persists existing profile toggles immediately without submitting unsaved fields", () => {
  assert.match(source, /const toggleEnabled = async \(enabled: boolean\)/);
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /JSON\.stringify\(\{ cwd, scope: selected\.scope, name: selected\.name, enabled \}\)/);
  assert.match(source, /setDraft\(\(current\) => \(\{ \.\.\.current, enabled: saved\.enabled \}\)\)/);
  assert.doesNotMatch(source, /method: "PATCH"[\s\S]*?profile: draft/);
});

test("reuses the ChatInput model selector with scoped models", () => {
  assert.match(source, /fetch\(`\/api\/models\?cwd=\$\{encodeURIComponent\(cwd\)\}`/);
  assert.match(source, /import \{ ModelSelector \} from "\.\/ModelSelector"/);
  assert.match(source, /<ModelSelector[\s\S]*?options=\{modelSelectorOptions\}[\s\S]*?variant="field"/);
  assert.match(modelSelectorSource, /filterModelOptions\(sortedOptions, filter\)/);
  assert.match(modelSelectorSource, /modelsByProvider\.map/);
  assert.match(modelSelectorSource, /event\.key !== "Escape" \|\| !open[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)/);
  assert.match(source, /agents\.modelUnavailable/);
  assert.doesNotMatch(source, /placeholder="provider\/modelId"/);
});

test("renders the stable agent id as a mono tag outside create mode", () => {
  assert.match(source, /\{!creating && <span className="agents-id-tag">\{draft\.name\}<\/span>\}/);
  assert.match(source, /\{creating && \([\s\S]*?<input aria-label=\{t\("agents\.name"\)\}/);
  assert.doesNotMatch(source, /disabled=\{disabled \|\| !creating\}/);
  assert.match(cssSource, /\.agents-id-tag \{[\s\S]*?font-family: var\(--font-mono\)/);
});

test("renders read-only scopes as readable content with duplicate as the way out", () => {
  // 内置 / 工作区配置：一行说明 + 「创建副本」，而不是整张灰掉的表单。
  assert.match(source, /const readOnlySelected = Boolean\(selected && !isWritableScope\(selected\.scope\)\)/);
  assert.match(source, /readOnlySelected && selected && \(/);
  assert.match(source, /t\("agents\.readonlyNotice", \{ scope: scopeLabel\(selected\.scope\) \}\)/);
  assert.match(source, /className="agents-readonly-notice"[\s\S]*?onClick=\{beginDuplicate\}/);
  assert.match(source, /<pre className="agents-prompt-readonly">\{draft\.systemPrompt\}<\/pre>/);
  assert.match(source, /<span key=\{tool\} className="agents-static-chip">\{tool\}<\/span>/);
  assert.match(source, /<dl className="agents-kv-grid">/);
  // 只读态下不渲染可用/停用开关（无法切换），只读胶囊也不在页头重复「创建副本」。
  assert.match(source, /\{!readOnlySelected && \(\s*<ConfigSwitch checked=\{draft\.enabled\}/);
  assert.match(cssSource, /\.agents-prompt-readonly \{[\s\S]*?font-family: var\(--font-mono\)/);
  assert.match(cssSource, /\.agents-readonly-notice \{[\s\S]*?border: 1px solid var\(--border\)/);
});

test("keeps form controls for editable profiles and uses toggle chips for tools and resources", () => {
  assert.match(source, /<input aria-label=\{t\("agents\.displayName"\)\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /<input aria-label=\{t\("agents\.description"\)\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /<textarea className="agents-system-prompt"[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /className="agents-chip"\s*aria-pressed=\{draft\.tools\.includes\(tool\)\}/);
  assert.match(source, /className="agents-chip" aria-pressed=\{draft\.loadSkills\}/);
  assert.match(source, /className="agents-chip" aria-pressed=\{draft\.loadExtensions\}/);
  assert.match(source, /className="agents-chip" aria-pressed=\{draft\.inheritContext\}/);
  assert.match(source, /className="agents-chip" aria-pressed=\{draft\.runInBackground\}/);
  assert.match(source, /<select aria-label=\{t\("agents\.thinking"\)\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /<input aria-label=\{t\("agents\.maxTurns"\)[\s\S]*?disabled=\{disabled\}/);
  assert.match(cssSource, /\.agents-chip\[aria-pressed="true"\] \{/);
  // 详情正文分段：系统指令 / 工具与资源 / 运行 / 来源。
  assert.match(source, /<ConfigSectionTitle>\{t\("agents\.prompt"\)\}<\/ConfigSectionTitle>/);
  assert.match(source, /<ConfigSectionTitle>\{t\("agents\.capabilities"\)\}<\/ConfigSectionTitle>/);
  assert.match(source, /<ConfigSectionTitle>\{t\("agents\.run"\)\}<\/ConfigSectionTitle>/);
  assert.match(source, /<ConfigSectionTitle>\{t\("agents\.source"\)\}<\/ConfigSectionTitle>/);
});

test("shows disabled controls with a gray background", () => {
  const disabledStyle = source.match(/const disabledInputStyle: CSSProperties = \{([\s\S]*?)\n\};/)?.[1] ?? "";
  assert.match(source, /<textarea[^>]*aria-label=\{t\("agents\.prompt"\)\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /height: 195,[\s\S]*?minHeight: 195,[\s\S]*?maxHeight: "60vh"[\s\S]*?resize: disabled \? "none" : "vertical"/);
  assert.doesNotMatch(source, /agents-system-prompt[^\n]*fontFamily/);
  assert.match(disabledStyle, /background: "var\(--bg-panel\)"/);
  assert.match(disabledStyle, /color: "var\(--text-dim\)"/);
  assert.match(modelSelectorSource, /background: locked \? "var\(--bg-panel\)" : "var\(--bg\)"/);
});

test("keeps a larger resize corner when system instructions need a scrollbar", () => {
  assert.match(source, /<textarea className="agents-system-prompt" aria-label=\{t\("agents\.prompt"\)\}/);
  assert.match(cssSource, /.agents-system-prompt \{[\s\S]*?scrollbar-width: auto;/);
  assert.match(cssSource, /\.agents-system-prompt::-webkit-scrollbar \{[\s\S]*?width: 14px;[\s\S]*?height: 14px;/);
  assert.match(cssSource, /\.agents-system-prompt::-webkit-scrollbar-thumb \{[\s\S]*?border: 5px solid transparent;/);
});

test("duplicates any selected profile through the existing create flow", () => {
  assert.match(source, /function duplicateProfileName\(name: string, profiles: readonly SubagentProfile\[\]\)/);
  assert.match(source, /while \(existing\.has\(candidate\.toLowerCase\(\)\)\) candidate = `\$\{base\}-\$\{suffix\+\+\}`/);
  assert.match(source, /const beginDuplicate = \(\) =>/);
  assert.match(source, /\.\.\.editableProfile\(selected\),[\s\S]*?name,[\s\S]*?displayName: t\("agents\.copyName"/);
  assert.match(source, /setMode\("create"\)/);
  assert.match(source, /setTargetScope\(isWritableScope\(selected\.scope\) \? selected\.scope : "global"\)/);
  assert.match(source, /onClick=\{beginDuplicate\}[^>]*>[\s\S]*?t\("agents\.duplicate"\)/);
});

test("places duplicate and delete immediately before the enabled switch", () => {
  assert.match(source, /onClick=\{beginDuplicate\}[\s\S]*?onClick=\{\(\) => void remove\(\)\}[\s\S]*?<ConfigSwitch checked=\{draft\.enabled\}/);
});

test("confirms deletion and limits it to writable profiles", () => {
  assert.match(source, /window\.confirm\(t\("agents\.deleteConfirm", \{ name: selected\.displayName \}\)\)/);
  assert.match(source, /selected && isWritableScope\(selected\.scope\) && mode === "edit"/);
  assert.match(source, /method: "DELETE"/);
});

// final-arch step-6 Task 3：交付感知（不变式锁定段 + 组合预览）——只在宿主
// 显式传 workspaceId 时启用（组件只有 cwd，不发明「路径→id」查找）；数据与
// launch 同源（GET …/delivery/roles 与 …/roles/[role]/preview）。
test("delivery awareness is gated on an explicit workspaceId prop and never invents a lookup", () => {
  assert.match(source, /workspaceId = null/);
  assert.match(source, /workspaceId\?: string \| null;/);
  // 角色摘要拉取以 workspaceId 为门（null → 清态，不发请求）。
  const rolesEffect = source.match(/if \(!workspaceId\) \{\s*\n\s*setDeliveryRoles\(null\);[\s\S]*?\}, \[workspaceId\]\);/);
  assert.ok(rolesEffect, "roles fetch effect gated on workspaceId");
  // 绑定判定：显式 roles.<r>.profile 或同名缺省——两种都算交付角色剧本。
  assert.match(source, /row\.profile\.name === selected\.name/);
  assert.match(source, /row\.profile\.explicit \|\| row\.role === selected\.name/);
});

test("delivery role profiles show the locked invariant panel above the prompt editor with the spec link", () => {
  // 锁定段在 prompt 编辑区上方、agents.prompt 标题之后；出处链 §4.3。
  const promptIdx = source.indexOf("<ConfigSectionTitle>{t(\"agents.prompt\")}</ConfigSectionTitle>");
  const invariantIdx = source.indexOf("agents-delivery-invariant");
  assert.ok(promptIdx >= 0 && invariantIdx > promptIdx, "invariant panel renders after the prompt section title");
  assert.match(source, /agents-delivery-invariant-body">\{deliveryPreview\.invariant\}/);
  assert.match(source, /2026-10-26-delivery-engine-final-architecture-design\.md#43/);
});

test("delivery role profiles get a composed preview section produced by the same function as launch", () => {
  assert.match(source, /agents-delivery-composed/);
  assert.match(source, /agents-delivery-composed-body">\{deliveryPreview\.composed\}/);
  // composed 数据来自 preview 路由（previewRolePrompt 与 launch 同一函数）。
  assert.match(source, /delivery\/roles\/\$\{encodeURIComponent\(deliveryRoleForSelected\)\}\/preview/);
  assert.match(cssSource, /\.agents-delivery-invariant \{[\s\S]*?background: var\(--bg-panel\)/);
  assert.match(cssSource, /\.agents-delivery-composed-body \{[\s\S]*?font-family: var\(--font-mono\)/);
});
