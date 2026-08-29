import { syncImporterForWorkspace } from "./runner.ts";
import { type DaemonRouteHandler, sendJson } from "../../daemon/http.ts";

/** Importer HTTP surface, mounted into the daemon via route registration
 *  (see lib/daemon/host.ts) — a non-Loop system task exposed on demand. */
export function createImporterRoutes(): DaemonRouteHandler {
  return async (request, response, url) => {
    if (request.method === "POST") {
      const importerSync = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/importers\/sync$/);
      if (importerSync) {
        const summary = await syncImporterForWorkspace(decodeURIComponent(importerSync[1]));
        sendJson(response, 200, { summary });
        return true;
      }
    }
    return false;
  };
}
