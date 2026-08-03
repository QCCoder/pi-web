"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceCapability, WorkspaceSummary } from "@/lib/workspaces/types";
import type { LoopJob, LoopProduceFormat, LoopRun } from "@/lib/loop/types";
import { nextScheduledMs } from "@/lib/loop/schedule";
import { CapabilityToggle } from "./CapabilityToggle";

const LOOP_CAPABILITY: WorkspaceCapability = "loop";

interface JobForm {
  name: string;
  description: string;
  prompt: string;
  schedule: string;
  watchlist: string;
  pushTarget: string;
  produceFormat: LoopProduceFormat;
  enabled: boolean;
}

const EMPTY_FORM: JobForm = {
  name: "",
  description: "",
  prompt: "",
  schedule: "15:05",
  watchlist: "watchlist",
  pushTarget: "",
  produceFormat: "card",
  enabled: true,
};

const POLL_INTERVAL_MS = 4000;
const POLL_BUDGET_MS = 120_000;

async function responseJson<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

function formatTime(value: string | number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formFromJob(job: LoopJob): JobForm {
  return {
    name: job.name,
    description: job.description,
    prompt: job.prompt,
    schedule: job.schedule,
    watchlist: job.watchlist,
    pushTarget: job.pushTarget,
    produceFormat: job.produceFormat,
    enabled: job.enabled,
  };
}

/**
 * Loop settings panel: toggle the `loop` capability, create/edit/delete
 * scheduled jobs, trigger a manual run, and view run history. Embedded in the
 * Workspace settings view, reusing the workspace-* classes scoped there.
 */
export function LoopConfig({
  workspace,
  onWorkspaceChanged,
}: {
  workspace: WorkspaceSummary;
  onWorkspaceChanged: () => void;
}) {
  const enabled = workspace.capabilities.includes(LOOP_CAPABILITY);
  const [jobs, setJobs] = useState<LoopJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<JobForm>(EMPTY_FORM);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runningJob, setRunningJob] = useState<string | null>(null);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [runsByJob, setRunsByJob] = useState<Record<string, LoopRun[]>>({});
  const mountedRef = useRef(true);

  const base = `/api/workspaces/${encodeURIComponent(workspace.id)}/loop`;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadJobs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await responseJson<{ jobs: LoopJob[] }>(await fetch(`${base}/jobs`));
      setJobs(data.jobs);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    if (enabled) void loadJobs();
    else setJobs([]);
  }, [enabled, loadJobs]);

  const loadRuns = useCallback(
    async (name: string) => {
      try {
        const data = await responseJson<{ runs: LoopRun[] }>(
          await fetch(`${base}/runs?job=${encodeURIComponent(name)}`),
        );
        if (mountedRef.current) {
          setRunsByJob((current) => ({ ...current, [name]: data.runs }));
        }
      } catch {
        // keep last known history on error
      }
    },
    [base],
  );

  const pollRuns = useCallback(
    (name: string) => {
      const startedAt = Date.now();
      const tick = async () => {
        if (!mountedRef.current) return;
        await loadRuns(name);
        if (Date.now() - startedAt < POLL_BUDGET_MS) {
          setTimeout(() => void tick(), POLL_INTERVAL_MS);
        } else if (mountedRef.current) {
          setRunningJob((current) => (current === name ? null : current));
        }
      };
      setTimeout(() => void tick(), POLL_INTERVAL_MS);
    },
    [loadRuns],
  );

  const toggleCapability = useCallback(
    async (next: boolean) => {
      setToggling(true);
      setError(null);
      try {
        const capabilities = workspace.capabilities.filter((capability) => capability !== LOOP_CAPABILITY);
        if (next) capabilities.push(LOOP_CAPABILITY);
        await responseJson(
          await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expectedUpdatedAt: workspace.updatedAt, capabilities }),
          }),
        );
        onWorkspaceChanged();
      } catch (toggleError) {
        setError(toggleError instanceof Error ? toggleError.message : String(toggleError));
      } finally {
        setToggling(false);
      }
    },
    [onWorkspaceChanged, workspace],
  );

  const openNew = useCallback(() => {
    setForm(EMPTY_FORM);
    setEditingName(null);
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((job: LoopJob) => {
    setForm(formFromJob(job));
    setEditingName(job.name);
    setFormOpen(true);
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const isEdit = Boolean(editingName);
      const url = isEdit
        ? `${base}/jobs/${encodeURIComponent(editingName as string)}`
        : `${base}/jobs`;
      await responseJson(
        await fetch(url, {
          method: isEdit ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        }),
      );
      setFormOpen(false);
      setEditingName(null);
      await loadJobs();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }, [base, editingName, form, loadJobs]);

  const remove = useCallback(
    async (job: LoopJob) => {
      if (!window.confirm(`删除任务「${job.name}」？运行历史会保留。`)) return;
      setError(null);
      try {
        await responseJson(
          await fetch(`${base}/jobs/${encodeURIComponent(job.name)}`, { method: "DELETE" }),
        );
        await loadJobs();
      } catch (removeError) {
        setError(removeError instanceof Error ? removeError.message : String(removeError));
      }
    },
    [base, loadJobs],
  );

  const toggleEnabled = useCallback(
    async (job: LoopJob, next: boolean) => {
      setError(null);
      try {
        await responseJson(
          await fetch(`${base}/jobs/${encodeURIComponent(job.name)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...formFromJob(job), enabled: next }),
          }),
        );
        await loadJobs();
      } catch (toggleError) {
        setError(toggleError instanceof Error ? toggleError.message : String(toggleError));
      }
    },
    [base, loadJobs],
  );

  const runNow = useCallback(
    async (job: LoopJob) => {
      setError(null);
      setRunningJob(job.name);
      setExpandedJob(job.name);
      if (!runsByJob[job.name]) void loadRuns(job.name);
      try {
        await responseJson(
          await fetch(`${base}/jobs/${encodeURIComponent(job.name)}/run`, { method: "POST" }),
        );
        pollRuns(job.name);
      } catch (runError) {
        setError(runError instanceof Error ? runError.message : String(runError));
        setRunningJob((current) => (current === job.name ? null : current));
      }
    },
    [base, loadRuns, pollRuns, runsByJob],
  );

  const toggleExpand = useCallback(
    (job: LoopJob) => {
      setExpandedJob((current) => (current === job.name ? null : job.name));
      if (expandedJob !== job.name && !runsByJob[job.name]) void loadRuns(job.name);
    },
    [expandedJob, loadRuns, runsByJob],
  );

  const setField = useCallback(<K extends keyof JobForm>(key: K, value: JobForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  }, []);

  return (
    <section className="workspace-settings-section">
      <div className="repository-section-header">
        <h3>定时任务 (Loop)</h3>
        <CapabilityToggle enabled={enabled} loading={toggling} onToggle={(next) => void toggleCapability(next)} />
      </div>
      <div className="workspace-summary-card">
        <div className="workspace-rail-meta" style={{ marginBottom: 8 }}>
          启用后，pi-web 进程内的调度器会按 Asia/Shanghai 每日 <code>HH:MM</code> 触发任务：
          开一个独立 automation 会话跑提示词 → 把产物通过飞书推送。
          {enabled ? " 当前已启用。" : " 当前未启用。"}
        </div>

        {error && <div className="workspace-error">{error}</div>}

        {!enabled ? (
          <div className="workspace-rail-meta">启用 loop 能力后即可创建与管理定时任务。</div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <button className="workspace-action" onClick={openNew}>+ 新建任务</button>
              {loading && <span className="workspace-rail-meta" style={{ alignSelf: "center" }}>加载中…</span>}
            </div>

            {formOpen && (
              <div className="workspace-form-card" style={{ marginBottom: 12 }}>
                <div className="workspace-form-grid">
                  <label className="workspace-field">
                    <span>名称（slug）</span>
                    <input
                      value={form.name}
                      onChange={(event) => setField("name", event.target.value)}
                      placeholder="daily-briefing"
                      disabled={Boolean(editingName)}
                      spellCheck={false}
                    />
                  </label>
                  <label className="workspace-field">
                    <span>显示名 / 卡片标题</span>
                    <input
                      value={form.description}
                      onChange={(event) => setField("description", event.target.value)}
                      placeholder="每日盘后简报"
                    />
                  </label>
                  <label className="workspace-field">
                    <span>定时 HH:MM（Asia/Shanghai）</span>
                    <input
                      value={form.schedule}
                      onChange={(event) => setField("schedule", event.target.value)}
                      placeholder="15:05"
                      spellCheck={false}
                    />
                  </label>
                  <label className="workspace-field">
                    <span>推送格式</span>
                    <select
                      value={form.produceFormat}
                      onChange={(event) => setField("produceFormat", event.target.value as LoopProduceFormat)}
                    >
                      <option value="card">卡片（markdown）</option>
                      <option value="text">纯文本</option>
                    </select>
                  </label>
                  <label className="workspace-field">
                    <span>自选清单（automations/ 下的文件名，不含 .md）</span>
                    <input
                      value={form.watchlist}
                      onChange={(event) => setField("watchlist", event.target.value)}
                      placeholder="watchlist"
                      spellCheck={false}
                    />
                  </label>
                  <label className="workspace-field">
                    <span>推送目标 receive_id（留空用工作区默认）</span>
                    <input
                      value={form.pushTarget}
                      onChange={(event) => setField("pushTarget", event.target.value)}
                      placeholder="ou_xxxxxxxx / chat_id"
                      spellCheck={false}
                    />
                  </label>
                  <label className="workspace-field" style={{ gridColumn: "1 / -1" }}>
                    <span>做什么（自然语言提示词）</span>
                    <textarea
                      value={form.prompt}
                      onChange={(event) => setField("prompt", event.target.value)}
                      placeholder={"例如：总结今日 A 股大盘：上证/深成/创业板收盘点位与涨跌幅、成交额、领涨领跌板块、一句话点评。产出为可直接阅读的 Markdown。"}
                    />
                  </label>
                  <label className="skill-selection-item" style={{ gridColumn: "1 / -1", padding: "8px 10px" }}>
                    <input
                      type="checkbox"
                      checked={form.enabled}
                      onChange={(event) => setField("enabled", event.target.checked)}
                    />
                    <span><strong>启用调度</strong><small>关闭后任务保留但不触发</small></span>
                  </label>
                </div>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
                  <button className="workspace-action" onClick={() => setFormOpen(false)}>取消</button>
                  <button
                    className="workspace-action"
                    disabled={saving || !form.name.trim() || !form.prompt.trim() || !form.schedule.trim()}
                    onClick={() => void save()}
                  >
                    {saving ? "保存中…" : editingName ? "保存修改" : "创建任务"}
                  </button>
                </div>
              </div>
            )}

            <div className="repository-list">
              {jobs.length === 0 && !formOpen && (
                <div className="workspace-summary-card">尚未创建任务。点「新建任务」开始。</div>
              )}
              {jobs.map((job) => {
                const next = nextScheduledMs(new Date(), job.schedule);
                const expanded = expandedJob === job.name;
                const runs = runsByJob[job.name] ?? [];
                const isRunning = runningJob === job.name;
                return (
                  <div key={job.name} className="workspace-summary-card" style={{ padding: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <strong>{job.description || job.name}</strong>
                      <code className="workspace-rail-meta">{job.name}</code>
                      <span className="workspace-rail-meta">
                        每天 {job.schedule} · {next ? `下次 ${formatTime(next)}` : "时间无效"}
                      </span>
                      {!job.enabled && <span className="workspace-rail-meta">（已暂停）</span>}
                      <span style={{ marginLeft: "auto", display: "flex", gap: 5, flexWrap: "wrap" }}>
                        <CapabilityToggle
                          enabled={job.enabled}
                          loading={false}
                          onToggle={(nextEnabled) => void toggleEnabled(job, nextEnabled)}
                        />
                        <button className="workspace-action" onClick={() => openEdit(job)}>编辑</button>
                        <button
                          className="workspace-action"
                          disabled={isRunning}
                          onClick={() => void runNow(job)}
                        >
                          {isRunning ? "运行中…" : "立即运行"}
                        </button>
                        <button className="workspace-action" onClick={() => toggleExpand(job)}>
                          {expanded ? "收起历史" : "运行历史"}
                        </button>
                        <button className="workspace-action" onClick={() => void remove(job)}>删除</button>
                      </span>
                    </div>
                    <div className="workspace-rail-meta" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>
                      {job.prompt}
                    </div>
                    {expanded && (
                      <div style={{ marginTop: 10 }}>
                        {runs.length === 0 ? (
                          <div className="workspace-rail-meta">暂无运行记录。</div>
                        ) : (
                          runs.map((run) => (
                            <div className="work-item-event" key={run.id}>
                              <time>{formatTime(run.startedAt)}</time>
                              <div>
                                <strong style={{ color: run.status === "success" ? "#16a34a" : "#ef4444" }}>
                                  {run.status === "success" ? "成功" : "失败"}
                                </strong>
                                {run.triggeredBy === "manual" && (
                                  <span style={{ color: "var(--text-dim)", marginLeft: 6 }}>手动</span>
                                )}
                                {run.push && (
                                  <span
                                    style={{
                                      color: run.push.ok ? "#16a34a" : "#ef4444",
                                      marginLeft: 6,
                                      fontSize: 11,
                                    }}
                                  >
                                    推送{run.push.ok ? "成功" : "失败"}
                                    {!run.push.ok && run.push.error ? `：${run.push.error}` : ""}
                                  </span>
                                )}
                                {run.error && (
                                  <div style={{ color: "var(--text-dim)", marginTop: 3 }}>{run.error}</div>
                                )}
                                {run.output && (
                                  <details style={{ marginTop: 4 }}>
                                    <summary className="workspace-rail-meta">产物预览</summary>
                                    <pre
                                      style={{
                                        whiteSpace: "pre-wrap",
                                        wordBreak: "break-word",
                                        fontSize: 11,
                                        maxHeight: 220,
                                        overflow: "auto",
                                        margin: "6px 0 0",
                                      }}
                                    >
                                      {run.output}
                                    </pre>
                                  </details>
                                )}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
