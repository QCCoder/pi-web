/**
 * Workspace extension that registers the `subagent` tool.
 *
 * The tool delegates a task to a specialized subagent running as its OWN
 * first-class session (own context window, own model/tools), linked to this
 * conversation as a child. Internal steps stay isolated in that child session;
 * only streamed status + the final result return here. The child session is
 * fully viewable — open it from the tool result to inspect the whole run live.
 *
 * Modes:
 *   - single:  { agent, task }
 *   - parallel:{ tasks: [{ agent, task, cwd? }] }
 *
 * Security model (aligned with the official pi subagent example):
 *   - Default `agentScope` is "user" — only `~/.pi/agent/agents` loads.
 *   - Project-local agents (`.pi/agents`) are repo-controlled prompts; they load
 *     only when the model passes `agentScope: "project"|"both"`, and each
 *     invocation of a project agent is confirmed via `ctx.ui.confirm` unless the
 *     model passes `confirmProjectAgents: false`.
 *
 * This is the reusable "real subagent" capability. The Loop runtime (and any
 * workspace with the `subagent` capability) consumes it; nothing here is
 * loop-specific.
 */
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { resolveProject } from "../worktree.ts";
import { discoverAgents, formatAgentList, type AgentConfig, type AgentScope } from "./agents.ts";
import {
  isFailedResult,
  runParallel,
  runWorker,
  type DisplayItem,
  type ModelSpec,
  type UsageStats,
  type WorkerDetails,
  type WorkerResult,
} from "./worker.ts";

const MAX_PARALLEL = 8;
const CONCURRENCY = 4;
const PER_TASK_CAP = 50 * 1024;

function truncateOutput(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= PER_TASK_CAP) return text;
  return `${text.slice(0, PER_TASK_CAP)}\n\n[output truncated; open the child session to see the full run]`;
}

function workerOutput(result: WorkerResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.output || "(no output)";
  }
  return result.output || "(no output)";
}

function availableAgentsText(agents: AgentConfig[]): string {
  const { text, remaining } = formatAgentList(agents);
  return `Available agents:\n${text}${remaining > 0 ? `\n... +${remaining} more` : ""}`;
}

/** Per-agent view rendered by the frontend (web equivalent of the official
 *  TUI renderResult). Kept stable across streaming partials and final result. */
export interface ResultView {
  agent: string;
  task: string;
  source: string;
  status: "running" | "completed" | "failed";
  childSessionId: string;
  usage: UsageStats;
  displayItems: DisplayItem[];
  model?: string;
  turns: number;
  errorMessage?: string;
  stopReason?: string;
}

/** Details shape carried on every subagent tool result and streaming update. */
export interface SubagentDetails {
  mode: "single" | "parallel";
  agentScope: AgentScope;
  results: ResultView[];
}

function viewFromResult(r: WorkerResult): ResultView {
  return {
    agent: r.agent,
    task: r.task,
    source: r.source,
    status: isFailedResult(r) ? "failed" : "completed",
    childSessionId: r.childSessionId,
    usage: r.usage,
    displayItems: r.displayItems,
    model: r.model,
    turns: r.turns,
    ...(r.errorMessage ? { errorMessage: r.errorMessage } : {}),
    ...(r.stopReason ? { stopReason: r.stopReason } : {}),
  };
}

function viewFromDetails(d: WorkerDetails): ResultView {
  return {
    agent: d.agent,
    task: d.task,
    source: d.source,
    status: d.status,
    childSessionId: d.childSessionId,
    usage: d.usage,
    displayItems: d.displayItems,
    model: d.model,
    turns: d.turns,
  };
}

/**
 * If any requested agents are project-sourced, ask the user to approve them via
 * the extension UI. Returns the set of approved agent names, or null if the user
 * declined (caller should abort with a message).
 */
async function approveProjectAgents(
  ctx: ExtensionContext,
  agents: AgentConfig[],
  requestedNames: Iterable<string>,
  projectAgentsDir: string | null,
): Promise<Set<string> | null> {
  const requested = new Set(requestedNames);
  const projectAgents = agents.filter((a) => a.source === "project" && requested.has(a.name));
  // Built-in "general" has filePath "<builtin>" and is safe; only real project
  // files (those that live in .pi/agents) need confirmation.
  const needsConfirm = projectAgents.filter((a) => a.filePath !== "<builtin>");
  if (needsConfirm.length === 0) return requested;

  const names = needsConfirm.map((a) => a.name).join(", ");
  const dir = projectAgentsDir ?? "(unknown)";
  const ok = await ctx.ui.confirm(
    "Run project-local subagents?",
    `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled prompts that can read files and run bash. Only continue for trusted repositories.`,
  );
  if (!ok) return null;
  return requested;
}

export function createSubagentExtension(_workspaceId: string, workspacePath: string, extraAgentDirs?: string[]): InlineExtension {
  return {
    name: "pi-subagent",
    factory: (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description: [
          "Delegate a task to a specialized subagent that runs as its OWN session with a fresh context window, linked to this conversation as a child.",
          "Modes: single {agent, task} or parallel {tasks:[{agent,task,cwd?}]}.",
          `Default agentScope is "user" (only ~/.pi/agent/agents). Set agentScope:"both" to also load project-local .pi/agents — those run only after user approval.`,
          "Each subagent's full run is viewable: open its child session from the result. Internal steps stay isolated from this conversation.",
        ].join(" "),
        promptGuidelines: [
          "Use the subagent tool to isolate a self-contained sub-task so it does not pollute this conversation's context.",
          "The subagent has NOT seen this conversation — pass a concrete, fully-specified task.",
          "Prefer parallel mode for independent sub-tasks; use single mode when tasks depend on each other.",
        ],
        parameters: Type.Object({
          agent: Type.Optional(Type.String({ description: "Name of the subagent to invoke (single mode)" })),
          task: Type.Optional(Type.String({ description: "Self-contained task to delegate (single mode)" })),
          tasks: Type.Optional(
            Type.Array(
              Type.Object({
                agent: Type.String({ description: "Name of the subagent to invoke" }),
                task: Type.String({ description: "Self-contained task to delegate" }),
                cwd: Type.Optional(Type.String({ description: "Working directory (defaults to this workspace)" })),
              }),
              { description: "Multiple {agent,task} to run concurrently (parallel mode)" },
            ),
          ),
          agentScope: Type.Optional(
            StringEnum(["user", "project", "both"] as const, {
              description: 'Which agent directories to load. Default "user". Use "both" to include project-local .pi/agents.',
              default: "user",
            }),
          ),
          confirmProjectAgents: Type.Optional(
            Type.Boolean({
              description: "Prompt before running project-local agents. Default: true.",
              default: true,
            }),
          ),
          cwd: Type.Optional(Type.String({ description: "Working directory for the subagent (defaults to this workspace)" })),
        }),

        execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
          const agentScope: AgentScope = (params.agentScope as AgentScope | undefined) ?? "user";
          const confirmProjectAgents = params.confirmProjectAgents ?? true;

          // Resolve the project root once (worktree → main repo) so all worktrees
          // of one repo share the same project agents dir.
          const { projectRoot } = await resolveProject(workspacePath);
          const discovery = discoverAgents(projectRoot, agentScope, extraAgentDirs);
          const agents = discovery.agents;
          const findAgent = (name: string): AgentConfig | undefined => agents.find((a) => a.name === name);
          const defaultCwd = params.cwd ?? ctx.cwd;
          const parentSessionFile = ctx.sessionManager.getSessionFile() ?? "";
          const parentModel: ModelSpec | undefined = ctx.model
            ? { provider: ctx.model.provider, modelId: ctx.model.id }
            : undefined;

          // Collect requested agent names for the project-agent approval gate.
          const requestedNames = new Set<string>();
          if (params.tasks) for (const t of params.tasks) requestedNames.add(t.agent);
          if (params.agent) requestedNames.add(params.agent);

          if (confirmProjectAgents && (agentScope === "project" || agentScope === "both") && ctx.hasUI) {
            const approved = await approveProjectAgents(ctx, agents, requestedNames, discovery.projectAgentsDir);
            if (!approved) {
              return {
                content: [{ type: "text" as const, text: "Canceled: project-local agents not approved." }],
                details: { mode: "single" as const, agentScope, results: [] },
              };
            }
          }

          const streamSingle = onUpdate
            ? (partial: { text: string; details: WorkerDetails }) =>
                onUpdate({
                  content: [{ type: "text" as const, text: partial.text }],
                  details: { mode: "single" as const, agentScope, results: [viewFromDetails(partial.details)] },
                })
            : undefined;

          const streamParallel = onUpdate
            ? (partial: { text: string; details: { mode: "parallel"; results: WorkerResult[] } }) =>
                onUpdate({
                  content: [{ type: "text" as const, text: partial.text }],
                  details: {
                    mode: "parallel" as const,
                    agentScope,
                    results: partial.details.results.map((r) =>
                      r.exitCode === -1 && r.childSessionId
                        ? { agent: r.agent, task: r.task, source: r.source, status: "running" as const, childSessionId: r.childSessionId, usage: r.usage, displayItems: r.displayItems }
                        : viewFromResult(r),
                    ),
                  },
                })
            : undefined;

          // ---- parallel mode ----
          if (params.tasks && params.tasks.length > 0) {
            if (params.tasks.length > MAX_PARALLEL) {
              return {
                content: [{ type: "text" as const, text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL}.` }],
                details: { mode: "parallel" as const, agentScope, results: [] },
              };
            }
            const missing = params.tasks.filter((t) => !findAgent(t.agent));
            if (missing.length > 0) {
              return {
                content: [{ type: "text" as const, text: `Unknown agent(s): ${missing.map((m) => m.agent).join(", ")}.\n${availableAgentsText(agents)}` }],
                details: { mode: "parallel" as const, agentScope, results: [] },
              };
            }

            const results = await runParallel(
              params.tasks.map((t) => ({ agent: findAgent(t.agent) as AgentConfig, task: t.task, cwd: t.cwd ?? defaultCwd })),
              CONCURRENCY,
              { parentSessionFile, parentModel, signal },
              streamParallel,
            );

            const succeeded = results.filter((r) => !isFailedResult(r)).length;
            const summary = results
              .map((r) => {
                const status = isFailedResult(r)
                  ? `failed${r.stopReason && r.stopReason !== "error" ? ` (${r.stopReason})` : ""}`
                  : "completed";
                return `### [${r.agent}] ${status} — session ${r.childSessionId}\n\n${truncateOutput(workerOutput(r))}`;
              })
              .join("\n\n---\n\n");

            return {
              content: [{ type: "text" as const, text: `Parallel: ${succeeded}/${results.length} succeeded\n\n${summary}` }],
              details: {
                mode: "parallel" as const,
                agentScope,
                results: results.map(viewFromResult),
              },
            };
          }

          // ---- single mode ----
          if (params.agent && params.task) {
            const agent = findAgent(params.agent);
            if (!agent) {
              return {
                content: [{ type: "text" as const, text: `Unknown agent "${params.agent}".\n${availableAgentsText(agents)}` }],
                details: { mode: "single" as const, agentScope, results: [] },
              };
            }
            const result = await runWorker({
              agent,
              task: params.task,
              cwd: defaultCwd,
              parentSessionFile,
              parentModel,
              signal,
              onUpdate: streamSingle,
            });
            if (isFailedResult(result)) {
              return {
                content: [{ type: "text" as const, text: `Agent ${result.stopReason || "failed"}: ${workerOutput(result)}` }],
                details: { mode: "single" as const, agentScope, results: [viewFromResult(result)] },
                isError: true,
              };
            }
            return {
              content: [{ type: "text" as const, text: `${result.output || "(no output)"}\n\n_Subagent session: ${result.childSessionId}_` }],
              details: { mode: "single" as const, agentScope, results: [viewFromResult(result)] },
            };
          }

          // ---- no/invalid params ----
          return {
            content: [
              {
                type: "text" as const,
                text: `Provide {agent, task} for a single subagent, or {tasks:[...]} for parallel.\n${availableAgentsText(agents)}`,
              },
            ],
            details: { mode: "single" as const, agentScope, results: [] },
          };
        },
      });
    },
  };
}
