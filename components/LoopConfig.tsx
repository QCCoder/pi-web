"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AutonomyLevel, CronTriggerDefinition, LoopDefinition, LoopRun } from "@/lib/loop/types";
import type { WorkspaceCapability, WorkspaceSummary } from "@/lib/workspaces/types";
import { CapabilityToggle } from "./CapabilityToggle";
import styles from "./LoopConfig.module.css";

interface AgentEntry { filename: string; content: string; isNew: boolean; deleted?: boolean }
interface EditLoopForm {
  name: string; description: string; autonomy: AutonomyLevel;
  enabled: boolean; cronEnabled: boolean;
  cronExpression: string; timezone: string; instructions: string;
  agents: AgentEntry[];
}

const LOOP_CAPABILITY: WorkspaceCapability = "loop";
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const STEPS = ["基本信息", "触发方式", "执行契约"] as const;

interface CreateLoopForm {
  id: string; name: string; description: string; autonomy: AutonomyLevel;
  manualTrigger: boolean; cronEnabled: boolean; cronExpression: string; timezone: string;
  goal: string; executionRules: string; verificationRules: string; gateRules: string; improveRules: string;
}

const EMPTY_CREATE_FORM: CreateLoopForm = {
  id: "", name: "", description: "", autonomy: "L1",
  manualTrigger: true, cronEnabled: true, cronExpression: "0 9 * * 1-5", timezone: "Asia/Shanghai",
  goal: "", executionRules: "",
  verificationRules: "检查 Maker 的结果是否完整、准确，并且每个结论都有可追溯证据。",
  gateRules: "涉及外部发送、删除、发布或不可逆操作时，必须等待人工确认。",
  improveRules: "记录本轮失败、误报、缺失信息和人工纠正，提出下一轮改进建议。",
};

async function responseJson<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

export function LoopConfig({ workspace, onWorkspaceChanged, mode = "dashboard", onOpenLoops, onOpenSession }: {
  workspace: WorkspaceSummary;
  onWorkspaceChanged: () => void;
  mode?: "dashboard" | "settings";
  onOpenLoops?: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const enabled = workspace.capabilities.includes(LOOP_CAPABILITY);
  const base = `/api/workspaces/${encodeURIComponent(workspace.id)}/loop`;
  const [loops, setLoops] = useState<LoopDefinition[]>([]);
  const [runs, setRuns] = useState<Record<string, LoopRun>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createStep, setCreateStep] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState<CreateLoopForm>(EMPTY_CREATE_FORM);
  const [editing, setEditing] = useState<LoopDefinition | null>(null);
  const [editForm, setEditForm] = useState<EditLoopForm | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    if (!createOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !creating) setCreateOpen(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [createOpen, creating]);
  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !saving) { setEditing(null); setEditForm(null); } };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing, saving]);

  const load = useCallback(async () => {
    if (!enabled) return;
    setLoading(true); setError(null);
    try {
      const value = await responseJson<{ loops: LoopDefinition[] }>(await fetch(`${base}/loops`));
      setLoops(value.loops);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally { setLoading(false); }
  }, [base, enabled]);
  useEffect(() => { void load(); }, [load]);

  const pollRun = useCallback((loopId: string, runId: string) => {
    const poll = async () => {
      if (!mounted.current) return;
      try {
        const { run } = await responseJson<{ run: LoopRun }>(await fetch(`${base}/runs/${encodeURIComponent(runId)}`));
        if (!mounted.current) return;
        setRuns((current) => ({ ...current, [loopId]: run }));
        if (!TERMINAL.has(run.status) && run.status !== "waiting_for_confirmation" && run.status !== "waiting_for_gate") {
          setTimeout(() => void poll(), 1500);
        }
      } catch (pollError) { setError(pollError instanceof Error ? pollError.message : String(pollError)); }
    };
    setTimeout(() => void poll(), 500);
  }, [base]);

  const trigger = useCallback(async (loop: LoopDefinition) => {
    setError(null);
    try {
      const receipt = await responseJson<{ runId: string }>(await fetch(`${base}/loops/${encodeURIComponent(loop.id)}/trigger`, { method: "POST" }));
      pollRun(loop.id, receipt.runId);
    } catch (triggerError) { setError(triggerError instanceof Error ? triggerError.message : String(triggerError)); }
  }, [base, pollRun]);

  const decide = useCallback(async (loopId: string, runId: string, decision: "approve" | "reject") => {
    setError(null);
    try {
      const { run } = await responseJson<{ run: LoopRun }>(await fetch(`${base}/runs/${encodeURIComponent(runId)}/gate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }),
      }));
      setRuns((current) => ({ ...current, [loopId]: run }));
      if (decision === "approve") pollRun(loopId, runId);
    } catch (decisionError) { setError(decisionError instanceof Error ? decisionError.message : String(decisionError)); }
  }, [base, pollRun]);

  const toggle = useCallback(async (next: boolean) => {
    setToggling(true); setError(null);
    try {
      const capabilities = workspace.capabilities.filter((capability) => capability !== LOOP_CAPABILITY);
      if (next) capabilities.push(LOOP_CAPABILITY);
      await responseJson(await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedUpdatedAt: workspace.updatedAt, capabilities }),
      }));
      onWorkspaceChanged();
    } catch (toggleError) { setError(toggleError instanceof Error ? toggleError.message : String(toggleError)); }
    finally { setToggling(false); }
  }, [onWorkspaceChanged, workspace]);

  const setCreateField = useCallback(<K extends keyof CreateLoopForm>(key: K, value: CreateLoopForm[K]) => {
    setCreateForm((current) => ({ ...current, [key]: value }));
  }, []);
  const openCreate = () => { setCreateForm(EMPTY_CREATE_FORM); setCreateStep(0); setError(null); setCreateOpen(true); };
  const closeCreate = () => { if (!creating) setCreateOpen(false); };
  const stepValid = createStep === 0
    ? Boolean(createForm.id.trim() && createForm.name.trim() && createForm.goal.trim())
    : createStep === 1
      ? Boolean(!createForm.cronEnabled || (createForm.cronExpression.trim() && createForm.timezone.trim()))
      : Boolean(createForm.executionRules.trim() && createForm.verificationRules.trim() && createForm.improveRules.trim());

  const createLoop = useCallback(async () => {
    setCreating(true); setError(null);
    try {
      await responseJson(await fetch(`${base}/loops`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(createForm),
      }));
      setCreateOpen(false); setCreateForm(EMPTY_CREATE_FORM); setCreateStep(0); await load();
    } catch (createError) { setError(createError instanceof Error ? createError.message : String(createError)); }
    finally { setCreating(false); }
  }, [base, createForm, load]);

  const setEditField = useCallback(<K extends keyof EditLoopForm>(key: K, value: EditLoopForm[K]) => {
    setEditForm((current) => (current ? { ...current, [key]: value } : current));
  }, []);
  const setAgentContent = useCallback((index: number, content: string) => {
    setEditForm((current) => current ? { ...current, agents: current.agents.map((agent, i) => i === index ? { ...agent, content } : agent) } : current);
  }, []);
  const setAgentFilename = useCallback((index: number, filename: string) => {
    setEditForm((current) => current ? { ...current, agents: current.agents.map((agent, i) => i === index ? { ...agent, filename } : agent) } : current);
  }, []);
  const addAgent = useCallback(() => {
    setEditForm((current) => current ? { ...current, agents: [...current.agents, { filename: "", content: "", isNew: true }] } : current);
  }, []);
  const removeAgent = useCallback((index: number) => {
    setEditForm((current) => {
      if (!current) return current;
      const target = current.agents[index];
      if (!target) return current;
      const agents = target.isNew
        ? current.agents.filter((_, i) => i !== index)
        : current.agents.map((agent, i) => i === index ? { ...agent, deleted: true } : agent);
      return { ...current, agents };
    });
  }, []);
  const openEdit = useCallback(async (loop: LoopDefinition) => {
    setEditLoading(true); setError(null);
    try {
      const res = await fetch(`${base}/loops/${encodeURIComponent(loop.id)}`);
      const value = await res.json().catch(() => ({})) as { loop?: LoopDefinition; instructions?: string; agents?: Record<string, string>; error?: string };
      if (!res.ok) throw new Error(value.error ?? `HTTP ${res.status}`);
      const cron = loop.triggers.find((trigger): trigger is CronTriggerDefinition => trigger.type === "cron");
      setEditForm({
        name: loop.name, description: loop.description, autonomy: loop.autonomy, enabled: loop.enabled,
        cronEnabled: Boolean(cron),
        cronExpression: cron ? cron.expression : "0 9 * * 1-5",
        timezone: cron ? cron.timezone : "Asia/Shanghai",
        instructions: value.instructions ?? "",
        agents: Object.entries(value.agents ?? {}).map(([filename, content]) => ({ filename, content, isNew: false })),
      });
      setEditing(loop);
    } catch (editError) { setError(editError instanceof Error ? editError.message : String(editError)); }
    finally { setEditLoading(false); }
  }, [base]);
  const closeEdit = () => { if (!saving) { setEditing(null); setEditForm(null); } };
  const saveEdit = useCallback(async () => {
    if (!editing || !editForm) return;
    setSaving(true); setError(null);
    try {
      const agentMap: Record<string, string | null> = {};
      for (const agent of editForm.agents) {
        if (agent.deleted) { if (!agent.isNew) agentMap[agent.filename] = null; continue; }
        const filename = agent.filename.trim();
        if (filename) agentMap[filename] = agent.content;
      }
      const body = {
        name: editForm.name, description: editForm.description, autonomy: editForm.autonomy,
        enabled: editForm.enabled, cronEnabled: editForm.cronEnabled,
        cronExpression: editForm.cronExpression, timezone: editForm.timezone,
        instructions: editForm.instructions, agents: agentMap,
      };
      const res = await fetch(`${base}/loops/${encodeURIComponent(editing.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const value = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(value.error ?? `HTTP ${res.status}`);
      setEditing(null); setEditForm(null); await load();
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : String(saveError)); }
    finally { setSaving(false); }
  }, [base, editing, editForm, load]);
  const toggleEnabled = useCallback(async (loop: LoopDefinition, next: boolean) => {
    setError(null);
    try {
      const res = await fetch(`${base}/loops/${encodeURIComponent(loop.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: next }),
      });
      const value = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(value.error ?? `HTTP ${res.status}`);
      await load();
    } catch (toggleError) { setError(toggleError instanceof Error ? toggleError.message : String(toggleError)); }
  }, [base, load]);
  const removeLoop = useCallback(async (loop: LoopDefinition) => {
    setDeleting(true); setError(null);
    try {
      const res = await fetch(`${base}/loops/${encodeURIComponent(loop.id)}`, { method: "DELETE" });
      const value = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(value.error ?? `HTTP ${res.status}`);
      setConfirmDelete(null); await load();
    } catch (removeError) { setError(removeError instanceof Error ? removeError.message : String(removeError)); }
    finally { setDeleting(false); }
  }, [base, load]);

  if (mode === "settings") {
    return <section className={styles.settingsCard}>
      <div className={styles.settingsHeader}><h3>Loop Runtime</h3><CapabilityToggle enabled={enabled} loading={toggling} onToggle={(next) => void toggle(next)} /></div>
      <div className={styles.muted}>独立 <code>pi-loop</code> Host 负责触发和运行；定义保存在工作区的 <code>loops/</code> 目录。</div>
      {error && <div className={styles.error}>{error}</div>}
      {enabled && !error && <div className={styles.muted} style={{ marginTop: 8 }}>Host：{loading ? "检查中…" : "运行中"} · 已发现 {loops.length} 个 Loop</div>}
      {enabled && onOpenLoops && <button className={styles.secondaryButton} style={{ marginTop: 10 }} onClick={onOpenLoops}>打开 Loops</button>}
    </section>;
  }

  return <section className={styles.dashboard}>
    <header className={styles.header}>
      <div><h2>Loops</h2><p>让重复工作按固定机制运行，并在证据和人工审核中逐轮变好。</p></div>
      <button className={styles.primaryButton} onClick={openCreate}>＋ 新建 Loop</button>
    </header>
    <div className={styles.toolbar}>
      <span>{loops.length} 个 Loop · 运行由本机 Loop Host 托管</span>
      <button className={styles.ghostButton} onClick={() => void load()} disabled={loading}>{loading ? "读取中…" : "刷新"}</button>
    </div>
    {error && <div className={styles.error}>{error}</div>}
    {!enabled ? <div className={styles.empty}><strong>Loop 尚未启用</strong>请先到工作区设置中启用 Loop Runtime。</div>
      : loops.length === 0 && !loading ? <div className={styles.empty}><strong>还没有 Loop</strong>点击右上角“新建 Loop”，创建第一个可手动或定时运行的任务。</div>
      : <div className={styles.loopList}>{loops.map((loop) => {
        const run = runs[loop.id];
        return <article key={loop.id} className={`${styles.loopCard} ${loop.enabled ? "" : styles.loopCardDisabled}`}>
          <div className={styles.loopTop}>
            <div><div className={styles.loopName}>{loop.name}</div><div className={styles.loopMeta}>{loop.id} · {loop.autonomy} · {loop.description || "无说明"}</div></div>
            <button className={styles.secondaryButton} disabled={!loop.enabled || Boolean(run && !TERMINAL.has(run.status))} onClick={() => void trigger(loop)}>运行一轮</button>
          </div>
          <div className={styles.triggers}>{loop.triggers.map((item) => <span className={styles.tag} key={item.id}>{item.type === "cron" ? `◷ ${item.expression} · ${item.timezone}` : `▶ ${item.type}`}</span>)}</div>
          <div className={styles.loopCardActions}>
            <button className={styles.ghostButton} onClick={() => void openEdit(loop)} disabled={editLoading}>编辑</button>
            <button className={styles.ghostButton} onClick={() => void toggleEnabled(loop, !loop.enabled)}>{loop.enabled ? "停用" : "启用"}</button>
            {confirmDelete === loop.id ? (<>
              <span className={styles.confirmText}>删除整个 Loop 目录（含 STATE.md / agents/ / audit/）？</span>
              <button className={styles.dangerButton} disabled={deleting} onClick={() => void removeLoop(loop)}>{deleting ? "删除中…" : "确认删除"}</button>
              <button className={styles.ghostButton} onClick={() => setConfirmDelete(null)}>取消</button>
            </>) : (<button className={styles.dangerButton} onClick={() => setConfirmDelete(loop.id)}>删除</button>)}
          </div>
          {run && <div className={styles.runPanel}>
            <div className={styles.runMetaRow}>
              <span className={styles.runMeta}>ROUND {run.id} · {run.status}{run.verdict ? ` · ${run.verdict}` : ""}</span>
              {run.sessionId && onOpenSession && (
                <button className={styles.ghostButton} onClick={() => { if (run.sessionId) onOpenSession(run.sessionId); }}>查看会话</button>
              )}
            </div>
            {run.gateRequest && <div className={styles.gate}>需要决定：{run.gateRequest}</div>}
            {run.plan && <div className={styles.plan}><strong>{run.plan.summary}</strong><ol>{run.plan.steps.map((step) => <li key={step.id}>{step.id}: {step.maker} → {step.verifier}{step.gate ? ` → gate: ${step.gate}` : ""}</li>)}</ol></div>}
            {(run.status === "waiting_for_confirmation" || run.status === "waiting_for_gate") && <div className={styles.actions}>
              <button className={styles.primaryButton} onClick={() => void decide(loop.id, run.id, "approve")}>确认并继续</button>
              <button className={styles.secondaryButton} onClick={() => void decide(loop.id, run.id, "reject")}>拒绝</button>
            </div>}
            {run.error && <div className={styles.error}>{run.error}</div>}
          </div>}
        </article>;
      })}</div>}

    {createOpen && createPortal(<div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCreate(); }}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="create-loop-title">
        <header className={styles.dialogHeader}><div><h2 id="create-loop-title">新建 Loop</h2><p>把任务规则留在工作区，Loop Host 只负责可靠地运行它。</p></div><button className={styles.closeButton} onClick={closeCreate} aria-label="关闭">×</button></header>
        <div className={styles.steps}>{STEPS.map((label, index) => <div key={label} className={`${styles.step} ${index === createStep ? styles.stepActive : ""} ${index < createStep ? styles.stepDone : ""}`}><span className={styles.stepNumber}>{index < createStep ? "✓" : index + 1}</span>{label}</div>)}</div>
        <div className={styles.dialogBody}>
          {createStep === 0 && <>
            <h3 className={styles.sectionTitle}>这个 Loop 是做什么的？</h3><p className={styles.sectionHint}>先定义稳定身份和目标，具体执行规则放到最后一步。</p>
            <div className={styles.formGrid}>
              <label className={styles.field}><span>名称</span><input autoFocus value={createForm.name} onChange={(e) => setCreateField("name", e.target.value)} placeholder="每日项目检查" /></label>
              <label className={styles.field}><span>Loop ID</span><input value={createForm.id} onChange={(e) => setCreateField("id", e.target.value)} placeholder="daily-review" spellCheck={false} /><code>小写字母、数字和连字符</code></label>
              <label className={`${styles.field} ${styles.fieldWide}`}><span>一句话说明（可选）</span><input value={createForm.description} onChange={(e) => setCreateField("description", e.target.value)} placeholder="每天检查状态，只报告值得处理的问题" /></label>
              <label className={`${styles.field} ${styles.fieldWide}`}><span>目标</span><textarea value={createForm.goal} onChange={(e) => setCreateField("goal", e.target.value)} placeholder="这一轮最终要解决什么问题？什么结果才算有价值？" /></label>
            </div>
            <h3 className={styles.sectionTitle} style={{ marginTop: 20 }}>Autonomy Level</h3><p className={styles.sectionHint}>从 L1 开始最安全，之后根据审计证据逐步升级。</p>
            <div className={styles.choiceGrid}>{([['L1','只报告','输出结果，不自动执行外部动作'],['L2','辅助执行','准备动作，关键节点需要审核'],['L3','无人值守','仅用于已经长期验证的低风险动作']] as const).map(([level,title,desc]) => <button type="button" key={level} className={`${styles.choiceCard} ${createForm.autonomy === level ? styles.choiceSelected : ""}`} onClick={() => setCreateField("autonomy", level)}><strong>{level} · {title}</strong><span>{desc}</span></button>)}</div>
          </>}
          {createStep === 1 && <>
            <h3 className={styles.sectionTitle}>什么时候启动一轮？</h3><p className={styles.sectionHint}>手动运行始终可用（点「运行一轮」即可）；下面选择是否额外定时触发。</p>
            <label className={styles.triggerCard}><input type="checkbox" checked={createForm.cronEnabled} onChange={(e) => setCreateField("cronEnabled", e.target.checked)} /><span><strong>定时运行</strong><span>由常驻 Loop Host 按 Cron 自动触发</span></span></label>
            {createForm.cronEnabled && <div className={styles.scheduleBox}>
              <div className={styles.presets}><button type="button" className={styles.presetButton} onClick={() => setCreateField("cronExpression", "0 9 * * *")}>每天 09:00</button><button type="button" className={styles.presetButton} onClick={() => setCreateField("cronExpression", "0 9 * * 1-5")}>工作日 09:00</button><button type="button" className={styles.presetButton} onClick={() => setCreateField("cronExpression", "0 18 * * 1-5")}>工作日 18:00</button></div>
              <div className={styles.formGrid}><label className={styles.field}><span>Cron</span><input value={createForm.cronExpression} onChange={(e) => setCreateField("cronExpression", e.target.value)} spellCheck={false} /><code>分　时　日　月　周</code></label><label className={styles.field}><span>时区</span><input value={createForm.timezone} onChange={(e) => setCreateField("timezone", e.target.value)} spellCheck={false} /></label></div>
            </div>}
          </>}
          {createStep === 2 && <>
            <h3 className={styles.sectionTitle}>一轮应该怎样执行？</h3><p className={styles.sectionHint}>Maker 负责产出，Checker 独立验证；机器判断不了的地方交给 Human Gate。</p>
            {([['M','Maker · 怎么做','executionRules','说明输入、步骤、工具和最终产出。'],['C','Checker · 怎么验','verificationRules','写清楚验收标准、证据要求和失败条件。'],['G','Human Gate · 何时停下','gateRules','可留空。说明哪些判断或外部动作必须由人确认。'],['↻','Improve · 如何变好','improveRules','说明每轮记录什么证据，以及允许提出哪些改进。']] as const).map(([badge,label,key,placeholder]) => <div className={styles.contractCard} key={key}><div className={styles.contractLabel}><span className={styles.contractBadge}>{badge}</span>{label}</div><textarea value={createForm[key]} onChange={(e) => setCreateField(key, e.target.value)} placeholder={placeholder} /></div>)}
          </>}
        </div>
        <footer className={styles.dialogFooter}><button className={styles.ghostButton} onClick={closeCreate}>取消</button><div className={styles.footerRight}>{createStep > 0 && <button className={styles.secondaryButton} onClick={() => setCreateStep((step) => step - 1)}>上一步</button>}{createStep < 2 ? <button className={styles.primaryButton} disabled={!stepValid} onClick={() => setCreateStep((step) => step + 1)}>下一步</button> : <button className={styles.primaryButton} disabled={!stepValid || creating} onClick={() => void createLoop()}>{creating ? "创建中…" : "创建 Loop"}</button>}</div></footer>
      </div>
    </div>, document.body)}
    {editing && editForm && createPortal(<div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeEdit(); }}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="edit-loop-title">
        <header className={styles.dialogHeader}><div><h2 id="edit-loop-title">编辑 Loop</h2><p>改身份、触发器和 LOOP.md 契约；STATE.md 与 agents/ 不受影响。</p></div><button className={styles.closeButton} onClick={closeEdit} aria-label="关闭">×</button></header>
        <div className={styles.dialogBody}>
          <h3 className={styles.sectionTitle}>基本设置</h3>
          <div className={styles.formGrid}>
            <label className={styles.field}><span>名称</span><input value={editForm.name} onChange={(e) => setEditField("name", e.target.value)} /></label>
            <label className={styles.field}><span>Loop ID</span><input value={editing.id} disabled spellCheck={false} /><code>不可更改</code></label>
            <label className={`${styles.field} ${styles.fieldWide}`}><span>一句话说明</span><input value={editForm.description} onChange={(e) => setEditField("description", e.target.value)} /></label>
          </div>
          <label className={`${styles.field} ${styles.toggleRow}`}><input type="checkbox" checked={editForm.enabled} onChange={(e) => setEditField("enabled", e.target.checked)} /><span>启用（关闭后 Host 不再自动触发，仍可手动运行）</span></label>
          <h3 className={styles.sectionTitle} style={{ marginTop: 20 }}>Autonomy Level</h3>
          <div className={styles.choiceGrid}>{([['L1','只报告','输出结果，不自动执行外部动作'],['L2','辅助执行','准备动作，关键节点需要审核'],['L3','无人值守','仅用于已经长期验证的低风险动作']] as const).map(([level,title,desc]) => <button type="button" key={level} className={`${styles.choiceCard} ${editForm.autonomy === level ? styles.choiceSelected : ""}`} onClick={() => setEditField("autonomy", level)}><strong>{level} · {title}</strong><span>{desc}</span></button>)}</div>
          <h3 className={styles.sectionTitle} style={{ marginTop: 20 }}>触发方式</h3>
          <p className={styles.sectionHint}>手动运行始终可用；下面选择是否额外定时触发。</p>
          <label className={styles.triggerCard}><input type="checkbox" checked={editForm.cronEnabled} onChange={(e) => setEditField("cronEnabled", e.target.checked)} /><span><strong>定时运行</strong><span>由常驻 Loop Host 按 Cron 自动触发</span></span></label>
          {editForm.cronEnabled && <div className={styles.scheduleBox}>
            <div className={styles.presets}><button type="button" className={styles.presetButton} onClick={() => setEditField("cronExpression", "0 9 * * *")}>每天 09:00</button><button type="button" className={styles.presetButton} onClick={() => setEditField("cronExpression", "0 10 * * 1-5")}>工作日 10:00</button><button type="button" className={styles.presetButton} onClick={() => setEditField("cronExpression", "0 18 * * 1-5")}>工作日 18:00</button></div>
            <div className={styles.formGrid}><label className={styles.field}><span>Cron</span><input value={editForm.cronExpression} onChange={(e) => setEditField("cronExpression", e.target.value)} spellCheck={false} /><code>分　时　日　月　周</code></label><label className={styles.field}><span>时区</span><input value={editForm.timezone} onChange={(e) => setEditField("timezone", e.target.value)} spellCheck={false} /></label></div>
          </div>}
          <h3 className={styles.sectionTitle} style={{ marginTop: 20 }}>契约（LOOP.md）</h3>
          <p className={styles.sectionHint}>控制器 playbook 的原文，保存即覆盖磁盘上的 LOOP.md。</p>
          <label className={styles.field}><span>LOOP.md</span><textarea className={styles.codeArea} value={editForm.instructions} onChange={(e) => setEditField("instructions", e.target.value)} spellCheck={false} /></label>
          <h3 className={styles.sectionTitle} style={{ marginTop: 20 }}>子代理（agents/*.md）</h3>
          <p className={styles.sectionHint}>各角色的 system prompt；LOOP.md 里用 <code>{`cat agents/xxx.md`}</code> 引用。文件名：小写字母/数字/连字符 + .md。</p>
          {editForm.agents.map((agent, index) => agent.deleted ? null : (
            <div className={styles.agentCard} key={`agent-${index}`}>
              <div className={styles.agentHeader}>
                <input className={styles.agentNameInput} value={agent.filename} disabled={!agent.isNew} onChange={(e) => setAgentFilename(index, e.target.value)} placeholder="scanner.md" spellCheck={false} />
                <button className={styles.dangerButton} onClick={() => removeAgent(index)}>删除</button>
              </div>
              <textarea className={styles.codeArea} value={agent.content} onChange={(e) => setAgentContent(index, e.target.value)} spellCheck={false} />
            </div>
          ))}
          <button className={styles.secondaryButton} onClick={addAgent} style={{ marginTop: 10 }}>＋ 新增子代理</button>
        </div>
        <footer className={styles.dialogFooter}><button className={styles.ghostButton} onClick={closeEdit}>取消</button><div className={styles.footerRight}><button className={styles.primaryButton} disabled={saving} onClick={() => void saveEdit()}>{saving ? "保存中…" : "保存"}</button></div></footer>
      </div>
    </div>, document.body)}
  </section>;
}
