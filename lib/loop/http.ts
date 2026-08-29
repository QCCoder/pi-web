import { seedExecutionSession } from "./seed.ts";
import type { LoopRuntime, WorkspaceResolver, TriggerCommand } from "./types.ts";
import { type DaemonRouteHandler, readJsonBody, sendJson } from "../daemon/http.ts";

/** Loop engine HTTP surface, mounted into the daemon via route registration
 *  (see lib/daemon/host.ts). The engine keeps its own routes in its own
 *  directory — the daemon core never imports loop internals beyond the deps
 *  injected here. */
export interface LoopRouteDeps {
  runtime: LoopRuntime;
  workspaces: WorkspaceResolver;
}

export function createLoopRoutes(deps: LoopRouteDeps): DaemonRouteHandler {
  const { runtime, workspaces } = deps;
  return async (request, response, url) => {
    if (request.method === "GET") {
      const loops = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/loops$/);
      if (loops) {
        sendJson(response, 200, { loops: await runtime.listLoops(decodeURIComponent(loops[1])) });
        return true;
      }
      const run = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/runs\/([^/]+)$/);
      if (run) {
        sendJson(response, 200, {
          run: await runtime.getRun(decodeURIComponent(run[1]), decodeURIComponent(run[2])),
        });
        return true;
      }
      return false;
    }
    if (request.method === "POST") {
      if (url.pathname === "/v1/triggers") {
        sendJson(response, 202, await runtime.trigger(await readJsonBody(request) as TriggerCommand));
        return true;
      }
      // Independent abort: destroy the orchestrator session and mark the run
      // failed.
      const abort = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/runs\/([^/]+)\/abort$/);
      if (abort) {
        sendJson(response, 200, {
          run: await runtime.abortRun(decodeURIComponent(abort[1]), decodeURIComponent(abort[2])),
        });
        return true;
      }
      // v3 seeding: the work-item "按合同执行" button. Same deterministic
      // seeder the engine uses after a selection round (guard + skill prompt +
      // bookkeeping), exposed so the human entry path is byte-identical to the
      // cron path. skillId defaults to the workspace's first enabled loop id
      // (convention: loop id === skill name).
      const seedRoute = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/seed$/);
      if (seedRoute) {
        const workspaceId = decodeURIComponent(seedRoute[1]);
        const input = await readJsonBody(request) as { key?: string; mode?: string; skillId?: string };
        if (!input.key || !/^(?:REQ|BUG)-\d+$/i.test(input.key)) {
          sendJson(response, 400, { error: "key must look like REQ-0001 or BUG-0001" });
          return true;
        }
        if (input.mode !== undefined && input.mode !== "execute" && input.mode !== "adopt") {
          sendJson(response, 400, { error: "mode must be execute or adopt" });
          return true;
        }
        const workspace = await workspaces.get(workspaceId);
        let skillId = input.skillId;
        if (!skillId) {
          const loops = await runtime.listLoops(workspaceId);
          const enabled = loops.find((loop) => loop.enabled);
          if (!enabled) {
            sendJson(response, 409, { error: "workspace has no enabled loop to seed from" });
            return true;
          }
          skillId = enabled.id;
        }
        const result = await seedExecutionSession({
          workspaceId,
          workspacePath: workspace.path,
          skillId,
          key: input.key.toUpperCase(),
          mode: input.mode,
        });
        sendJson(response, 200, { seed: result });
        return true;
      }
      return false;
    }
    return false;
  };
}
