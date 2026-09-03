"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import { summarizeCron } from "@/lib/loops/cron-summary";
import { MarkdownBody } from "./MarkdownBody";
import type { LoopDocsBundle, WriteTarget } from "@/lib/loops/manage";

/** 右栏（桌面）/ overview 栈页（移动）共用的 loop 配置目标。
 *  useAppShellState 持有，生命周期镜像 workItemDetail。 */
export type LoopConfigTarget = { kind: "loop"; name: string } | { kind: "new" };

interface Props {
  workspace: WorkspaceSummary;
  target: LoopConfigTarget;
  /** 删除成功 / ×：由 shell 清 loopConfig / 弹栈。 */
  onClose: () => void;
  /** 创建成功后打开新 loop 的配置视图。 */
  onOpenLoop: (name: string) => void;
  /** create/delete/frontmatter 保存后触发——桌面借此 bump loopsRefreshKey。 */
  onChanged?: () => void;
}

const sectionTitle: CSSProperties = { fontSize: 13, fontWeight: 600, margin: "16px 0 6px" };
const box: CSSProperties = { display: "grid", gap: 8, padding: 10, border: "1px solid var(--border)", borderRadius: 8 };
const input: CSSProperties = { width: "100%", padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontSize: 12 };
const textarea: CSSProperties = { ...input, minHeight: 180, resize: "vertical", fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap" };
const linkButton: CSSProperties = { fontSize: 12, color: "var(--accent)", background: "none", border: "none", padding: 0, cursor: "pointer" };
const primaryButton: CSSProperties = { ...linkButton, fontWeight: 600, justifySelf: "start" };
const dangerButton: CSSProperties = { fontSize: 12, color: "#b91c1c", background: "none", border: "1px solid #b91c1c", borderRadius: 6, padding: "4px 10px", cursor: "pointer", justifySelf: "start" };
const errorText: CSSProperties = { color: "#b91c1c", fontSize: 12 };
const muted: CSSProperties = { color: "var(--text-muted)", fontSize: 12 };
const chip: CSSProperties = { fontSize: 12, padding: "2px 10px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", cursor: "pointer" };
const chipActive: CSSProperties = { ...chip, borderColor: "var(--accent)", color: "var(--accent)" };
const summaryStyle: CSSProperties = { cursor: "pointer", color: "var(--text-muted)", fontSize: 12 };

const DOC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const CON_LABEL: Record<"constraints" | "budget", string> = {
  constraints: "loop-constraints.md（绑定约束）",
  budget: "loop-budget.md（token/轮数预算总帽）",
};

interface PutResult { ok: boolean; error?: string }

export function LoopsConfig(props: Props) {
  if (props.target.kind === "new") return <LoopCreateForm {...props} />;
  return (
    <LoopConfigDetail
      workspace={props.workspace}
      name={props.target.name}
      onClose={props.onClose}
      onChanged={props.onChanged}
    />
  );
}

function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      {label}
      {children}
    </label>
  );
}

/** 统一 PUT（唯一写入口）。409 冲突 → confirm 后无 baseMtime 强制覆盖（spec §6）。 */
function usePut(api: (suffix: string) => string) {
  return useCallback(
    async (loopName: string, target: WriteTarget, content: string, baseMtimeMs?: number): Promise<PutResult> => {
      const send = async (mtime?: number) =>
        fetch(api(`/${encodeURIComponent(loopName)}/docs`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target, content, baseMtimeMs: mtime }),
        });
      const first = await send(baseMtimeMs);
      if (first.ok) return { ok: true };
      const body = (await first.json().catch(() => ({}))) as { error?: string };
      if (first.status === 409) {
        if (window.confirm(`${body.error ?? "文件已被其它编辑修改"}\n\n用当前编辑覆盖？`)) {
          const second = await send(undefined);
          if (second.ok) return { ok: true };
          const b2 = (await second.json().catch(() => ({}))) as { error?: string };
          return { ok: false, error: b2.error ?? `保存失败（HTTP ${second.status}）` };
        }
        return { ok: false, error: body.error ?? "已取消——磁盘上有新版本" };
      }
      return { ok: false, error: body.error ?? `保存失败（HTTP ${first.status}）` };
    },
    [api],
  );
}

function LoopCreateForm({ workspace, onOpenLoop, onChanged }: Props) {
  const [form, setForm] = useState({ name: "", cron: "*/30 9-22 * * 1-5", timezone: "", level: "L1", maxMinutes: 30, pattern: "" });
  const [showPattern, setShowPattern] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          cron: form.cron.trim(),
          timezone: form.timezone.trim() || undefined,
          level: form.level,
          maxMinutes: Number(form.maxMinutes) || undefined,
          pattern: form.pattern.trim() || undefined,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { name?: string; error?: string };
      if (!response.ok || !body.name) {
        setError(body.error ?? `创建失败（HTTP ${response.status}）`);
        return;
      }
      onChanged?.();
      onOpenLoop(body.name);
    } catch (cause) {
      // fix(review optional): try/finally 无 catch 时网络拒绝逃逸为 unhandled rejection
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [form, onChanged, onOpenLoop, workspace.id]);

  return (
    <div style={{ padding: "14px 16px", fontSize: 12 }}>
      <div style={box}>
        <strong style={{ fontSize: 13 }}>新建 Loop</strong>
        <Field label="名称（slug，如 dev-loop）">
          <input style={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label={<>cron（5 字段 Vixie）—— {summarizeCron(form.cron) ?? "（未识别形态，按原文保存）"}</>}>
          <input style={{ ...input, fontFamily: "var(--font-mono)" }} value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
        </Field>
        <Field label="时区（缺省 = 系统本地）">
          <input style={input} placeholder="Asia/Shanghai" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
        </Field>
        <Field label="level —— 新 loop 一律 L1（report-only）起步；L2/L3 由人手动晋级">
          <select style={input} value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })}>
            <option value="L1">L1</option>
            <option value="L2">L2</option>
            <option value="L3">L3</option>
          </select>
        </Field>
        <Field label="max_minutes（单轮超时）">
          <input style={input} type="number" min={1} value={form.maxMinutes} onChange={(e) => setForm({ ...form, maxMinutes: Number(e.target.value) })} />
        </Field>
        <button style={linkButton} onClick={() => setShowPattern(!showPattern)}>
          {showPattern ? "▾" : "▸"} pattern（高级，缺省 = 名称）
        </button>
        {showPattern && (
          <Field label="pattern（对应 .agents/skills/<pattern>/ 的 SKILL）">
            <input style={input} value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} />
          </Field>
        )}
        {error && <div style={errorText}>{error}</div>}
        <button disabled={busy || !form.name.trim() || !form.cron.trim()} style={primaryButton} onClick={() => void submit()}>
          创建（脚手架五件套 + SKILL 骨架 + .lastrun=now，首轮等自然槽）
        </button>
        <div style={muted}>创建后请在配置视图改写 LOOP.md 指针正文与知识文档；SKILL.md 骨架在 .agents/skills/&lt;pattern&gt;/，按本 loop 职责手改。</div>
      </div>
    </div>
  );
}

function LoopConfigDetail({
  workspace,
  name,
  onClose,
  onChanged,
}: {
  workspace: WorkspaceSummary;
  name: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const api = useCallback(
    (suffix: string) => `/api/workspaces/${encodeURIComponent(workspace.id)}/loops${suffix}`,
    [workspace.id],
  );
  const put = usePut(api);

  const [bundle, setBundle] = useState<LoopDocsBundle | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fm, setFm] = useState({ cron: "", timezone: "", level: "L1", maxMinutes: 30 });
  const [bodyDraft, setBodyDraft] = useState<string | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);
  const [docDraft, setDocDraft] = useState<string | null>(null);
  const [docPreview, setDocPreview] = useState(false);
  const [newDocName, setNewDocName] = useState("");
  const [conDraft, setConDraft] = useState<{ constraints: string | null; budget: string | null }>({ constraints: null, budget: null });
  const [delError, setDelError] = useState<string | null>(null);

  // fix(review F2): refresh 的 useCallback deps 必须保持 [api, name]——把 bundle/selectedDoc 加进 deps 会让
  // 每次状态变更都重建 refresh 并触发 useEffect 重 fetch。因此用 refs 快照“上次已加载 bundle + 当前选中
  // 文档”，在 refresh 内配合 functional setState：只收敛不携带未保存编辑的草稿，保留携带编辑的草稿。
  const bundleRef = useRef<LoopDocsBundle | null>(null);
  const selectedDocRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const prev = bundleRef.current;
    try {
      const response = await fetch(api(`/${encodeURIComponent(name)}/docs`));
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setLoadError(body.error ?? `加载失败（HTTP ${response.status}）`);
        return;
      }
      const data = (await response.json()) as LoopDocsBundle;
      bundleRef.current = data;
      setBundle(data);
      setLoadError(null); // fix(review F1): 成功路径必须清 loadError——render 在 loadError 上 early-return，残留错误会永久砖死视图
      setFm({
        cron: data.frontmatter.cron,
        timezone: data.frontmatter.timezone,
        level: data.frontmatter.level,
        maxMinutes: data.frontmatter.maxMinutes,
      });
      // fix(review F2): 草稿仅在与新旧服务器内容都不同（= 携带未保存用户编辑）时保留，否则收敛回服务器内容。
      setBodyDraft((cur) => (cur === null || cur === prev?.loopBody || cur === data.loopBody ? null : cur));
      setSelectedDoc((current) => {
        const next = current && data.docs.some((d) => d.name === current) ? current : null;
        selectedDocRef.current = next;
        return next;
      });
      setDocDraft((cur) => {
        const sel = selectedDocRef.current;
        const oldC = prev?.docs.find((d) => d.name === sel)?.content;
        const newC = data.docs.find((d) => d.name === sel)?.content;
        return cur === null || cur === oldC || cur === newC ? null : cur;
      });
      setNewDocName("");
      setConDraft((cur) => {
        const next = { ...cur };
        for (const k of ["constraints", "budget"] as const) {
          const oldC = prev?.constitution[k]?.content;
          const newC = data.constitution[k]?.content ?? data.constitutionTemplates[k];
          const v = cur[k];
          if (v === null || v === oldC || v === newC) next[k] = null;
        }
        return next;
      });
    } catch (cause) {
      setLoadError(String(cause));
    }
  }, [api, name]);

  useEffect(() => { void refresh(); }, [refresh]);

  const saveFrontmatter = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(api(`/${encodeURIComponent(name)}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cron: fm.cron, timezone: fm.timezone, level: fm.level, max_minutes: Number(fm.maxMinutes) }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `保存失败（HTTP ${response.status}）`);
        return;
      }
      await refresh();
      onChanged?.();
    } catch (cause) {
      // fix(review optional): try/finally 无 catch 时网络拒绝逃逸为 unhandled rejection
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [api, fm, name, onChanged, refresh]);

  const saveBody = useCallback(async () => {
    if (!bundle || bodyDraft === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await put(name, { kind: "body" }, bodyDraft, bundle.loopBodyMtimeMs);
      if (!result.ok) { setError(result.error ?? "保存失败"); return; }
      await refresh();
    } catch (cause) {
      // fix(review optional): try/finally 无 catch 时网络拒绝逃逸为 unhandled rejection
      setError(String(cause));
    } finally { setBusy(false); }
  }, [bundle, bodyDraft, name, put, refresh]);

  const selectedDocEntry = bundle?.docs.find((d) => d.name === selectedDoc) ?? null;

  const saveDoc = useCallback(async () => {
    if (!selectedDocEntry || docDraft === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await put(name, { kind: "doc", file: selectedDocEntry.name }, docDraft, selectedDocEntry.mtimeMs);
      if (!result.ok) { setError(result.error ?? "保存失败"); return; }
      await refresh();
    } catch (cause) {
      // fix(review optional): try/finally 无 catch 时网络拒绝逃逸为 unhandled rejection
      setError(String(cause));
    } finally { setBusy(false); }
  }, [docDraft, name, put, refresh, selectedDocEntry]);

  const createDoc = useCallback(async () => {
    // fix(review F3): 重名守卫——输入既有文档名直接拒绝，否则 PUT 会静默覆盖该文档全部内容
    if (bundle?.docs.some((d) => d.name === newDocName)) return;
    if (!DOC_NAME_RE.test(newDocName) || newDocName === "LOOP.md" || newDocName === "STATE.md") return;
    setBusy(true);
    setError(null);
    try {
      const result = await put(name, { kind: "doc", file: newDocName }, `# ${newDocName.replace(/\.md$/, "")}\n\n`);
      if (!result.ok) { setError(result.error ?? "创建失败"); return; }
      setSelectedDoc(newDocName);
      selectedDocRef.current = newDocName; // fix(review F2): ref 与 state 同步，refresh 的草稿判定读它
      setDocDraft(null); // fix(review F2): 选中已切换到新文档，旧草稿不属于它（与 chip 点击弃草稿一致）
      setDocPreview(false);
      await refresh();
    } catch (cause) {
      // fix(review optional): try/finally 无 catch 时网络拒绝逃逸为 unhandled rejection
      setError(String(cause));
    } finally { setBusy(false); }
  }, [bundle, name, newDocName, put, refresh]);

  const saveConstitution = useCallback(async (which: "constraints" | "budget") => {
    if (!bundle) return;
    const draft = conDraft[which];
    const existing = bundle.constitution[which];
    const value = draft ?? existing?.content ?? bundle.constitutionTemplates[which];
    setBusy(true);
    setError(null);
    try {
      const result = await put(name, { kind: "constitution", file: which }, value, existing?.mtimeMs);
      if (!result.ok) { setError(result.error ?? "保存失败"); return; }
      await refresh();
    } catch (cause) {
      // fix(review optional): try/finally 无 catch 时网络拒绝逃逸为 unhandled rejection
      setError(String(cause));
    } finally { setBusy(false); }
  }, [bundle, conDraft, name, put, refresh]);

  const doDelete = useCallback(async () => {
    if (!bundle) return;
    setDelError(null);
    if (bundle.running) {
      setDelError("轮正在跑——请先在总览 Loops 区块「停止」，再删除。");
      return;
    }
    const boundNote = bundle.boundItems.length > 0
      ? `\n\n${bundle.boundItems.length} 个工作项绑定到该 loop（${bundle.boundItems.join("、")}）——删除后绑定按未绑定处理。`
      : "";
    if (!window.confirm(`删除 loop "${name}"（整个 loops/${name}/ 目录）？git 历史保留审计。${boundNote}`)) return;
    setBusy(true);
    try {
      let response = await fetch(api(`/${encodeURIComponent(name)}`), { method: "DELETE" });
      if (response.status === 409) {
        const body = (await response.json().catch(() => ({}))) as { error?: string; running?: boolean; boundItems?: string[] };
        if (body.running) { setDelError(body.error ?? "轮正在跑"); return; }
        if (body.boundItems?.length
          && window.confirm(`${body.error}\n\n${body.boundItems.join("、")} 删除后按未绑定处理，仍要删除？`)) {
          response = await fetch(api(`/${encodeURIComponent(name)}`), {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirmBound: true }),
          });
        } else {
          setDelError("已取消");
          return;
        }
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setDelError(body.error ?? `删除失败（HTTP ${response.status}）`);
        return;
      }
      onChanged?.();
      onClose();
    } catch (cause) {
      // fix(review optional): try/finally 无 catch 时网络拒绝逃逸为 unhandled rejection
      setDelError(String(cause));
    } finally { setBusy(false); }
  }, [api, bundle, name, onChanged, onClose]);

  if (loadError) return <div style={{ ...errorText, padding: 16 }}>{loadError}</div>;
  if (!bundle) return <div style={{ ...muted, padding: 16 }}>加载中…</div>;

  return (
    <div style={{ padding: "0 16px 24px", fontSize: 12, display: "grid", gap: 2 }}>
      {/* 头部状态 */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "10px 0" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 13 }}>{name}</span>
        <span style={{ padding: "1px 6px", borderRadius: 4, background: "var(--bg-hover)" }}>{bundle.frontmatter.level}</span>
        <span style={{ color: bundle.running ? "#15803d" : bundle.paused ? "var(--text-dim)" : "var(--text-muted)" }}>
          {bundle.running ? "● 运行中" : bundle.paused ? "已暂停" : "空闲"}
        </span>
        <span style={muted}>pattern: {bundle.frontmatter.pattern}</span>
      </div>

      {/* 1. frontmatter（沿用既有 PATCH 路由） */}
      <h3 style={sectionTitle}>frontmatter</h3>
      <div style={box}>
        <Field label={<>cron —— {summarizeCron(fm.cron) ?? fm.cron}</>}>
          <input style={{ ...input, fontFamily: "var(--font-mono)" }} value={fm.cron} onChange={(e) => setFm({ ...fm, cron: e.target.value })} />
        </Field>
        <Field label="timezone">
          <input style={input} value={fm.timezone} onChange={(e) => setFm({ ...fm, timezone: e.target.value })} />
        </Field>
        <Field label="level（L2/L3 晋级是人的手）">
          <select style={input} value={fm.level} onChange={(e) => setFm({ ...fm, level: e.target.value })}>
            <option value="L1">L1</option>
            <option value="L2">L2</option>
            <option value="L3">L3</option>
          </select>
        </Field>
        <Field label="max_minutes">
          <input style={input} type="number" min={1} value={fm.maxMinutes} onChange={(e) => setFm({ ...fm, maxMinutes: Number(e.target.value) })} />
        </Field>
        <button disabled={busy} style={primaryButton} onClick={() => void saveFrontmatter()}>保存 frontmatter</button>
      </div>

      {/* 2. 合同指针正文 */}
      <h3 style={sectionTitle}>合同指针正文（LOOP.md body）</h3>
      <details>
        <summary style={summaryStyle}>编辑指针步骤（frontmatter 字节保留；每轮开场读取）</summary>
        <div style={{ ...box, marginTop: 6 }}>
          <textarea style={textarea} value={bodyDraft ?? bundle.loopBody} onChange={(e) => setBodyDraft(e.target.value)} />
          <button disabled={busy || bodyDraft === null || bodyDraft === bundle.loopBody} style={primaryButton} onClick={() => void saveBody()}>
            保存正文
          </button>
        </div>
      </details>

      {/* 3. 知识文档（不硬编码文件名） */}
      <h3 style={sectionTitle}>知识文档（人写 · agent 只读 · 任意命名）</h3>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {bundle.docs.map((doc) => (
          <button
            key={doc.name}
            style={selectedDoc === doc.name ? chipActive : chip}
            onClick={() => { setSelectedDoc(doc.name); selectedDocRef.current = doc.name; setDocDraft(null); setDocPreview(false); }}
          >
            {doc.name}
          </button>
        ))}
        <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          <input style={{ ...input, width: 140 }} placeholder="新文档名.md" value={newDocName} onChange={(e) => setNewDocName(e.target.value)} />
          {/* fix(review F3): 重名时禁用新建，避免静默覆盖既有文档 */}
          <button disabled={busy || !DOC_NAME_RE.test(newDocName) || newDocName === "LOOP.md" || newDocName === "STATE.md" || (bundle?.docs.some((d) => d.name === newDocName) ?? false)} style={linkButton} onClick={() => void createDoc()}>
            ＋新建
          </button>
        </span>
      </div>
      {selectedDocEntry && (
        <div style={{ ...box, marginTop: 6 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <strong>{selectedDocEntry.name}</strong>
            <button style={linkButton} onClick={() => setDocPreview(!docPreview)}>{docPreview ? "编辑" : "预览"}</button>
          </div>
          {docPreview ? (
            <MarkdownBody cwd={`${workspace.path}/loops/${name}`}>{docDraft ?? selectedDocEntry.content}</MarkdownBody>
          ) : (
            <textarea style={textarea} value={docDraft ?? selectedDocEntry.content} onChange={(e) => setDocDraft(e.target.value)} />
          )}
          <button disabled={busy || docDraft === null || docDraft === selectedDocEntry.content} style={primaryButton} onClick={() => void saveDoc()}>
            保存
          </button>
        </div>
      )}

      {/* 4. STATE.md 只读 */}
      <h3 style={sectionTitle}>STATE.md（只读 · loop 运行状态）</h3>
      <details>
        <summary style={summaryStyle}>展开查看</summary>
        <pre style={{ ...box, whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", margin: "6px 0 0" }}>{bundle.stateMd || "（空）"}</pre>
      </details>

      {/* 5. 宪法文件（根共享） */}
      <h3 style={sectionTitle}>宪法文件（根共享 · 所有 loop 生效 · agent 禁改）</h3>
      {(["constraints", "budget"] as const).map((which) => {
        const existing = bundle.constitution[which];
        const draft = conDraft[which];
        const value = draft ?? existing?.content ?? bundle.constitutionTemplates[which];
        return (
          <details key={which} style={{ marginBottom: 4 }}>
            <summary style={summaryStyle}>
              {CON_LABEL[which]}{existing ? "" : "（缺失——已预填模板，保存即创建）"}
            </summary>
            <div style={{ ...box, marginTop: 6 }}>
              <textarea style={textarea} value={value} onChange={(e) => setConDraft({ ...conDraft, [which]: e.target.value })} />
              <button disabled={busy || draft === null || draft === value} style={primaryButton} onClick={() => void saveConstitution(which)}>
                保存
              </button>
            </div>
          </details>
        );
      })}

      {/* 6. 危险区 */}
      <h3 style={{ ...sectionTitle, color: "#b91c1c" }}>危险区</h3>
      <div style={{ ...box, borderColor: "#b91c1c55" }}>
        <div>
          删除 loop（整个 loops/{name}/ 目录；SKILL 与宪法不动；git 历史保留审计）
          {bundle.boundItems.length > 0 && (
            <div style={muted}>绑定工作项：{bundle.boundItems.join("、")}（删除后按未绑定处理）</div>
          )}
        </div>
        {delError && <div style={errorText}>{delError}</div>}
        <button disabled={busy || bundle.running} style={dangerButton} onClick={() => void doDelete()}>删除 loop</button>
      </div>

      {error && <div style={{ ...errorText, marginTop: 8 }}>{error}</div>}
    </div>
  );
}
