// Delivery action HTTP route — source assertion (brief Step 1) + functional
// confirmation of web.ts's error mapping (the route's catch-all: NotFound 404 /
// Conflict 409 / Validation 400, anything else 500). web.ts pulls next/server,
// so it loads through jiti; the module cache stays ON so web.ts and service.ts
// share one errors.ts evaluation and `instanceof` holds.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const ROUTE_PATH = new URL(
  "../../app/api/workspaces/[id]/work-items/[key]/delivery/[action]/route.ts",
  import.meta.url,
);

test("delivery action route validates the action slug and delegates to the service", async () => {
  const src = await readFile(ROUTE_PATH, "utf8");
  assert.match(src, /DELIVERY_ACTIONS/);
  assert.match(src, /applyDeliveryAction/);
  assert.match(src, /workItemErrorResponse/);
  assert.match(src, /400/);  // 未知 action
});

test("workItemErrorResponse maps the three work-item error classes to 404/409/400", async () => {
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const { workItemErrorResponse } = await jiti.import("./web.ts");
  const service = await jiti.import("./service.ts");

  const cases = [
    [service.WorkItemNotFoundError, 404],
    [service.WorkItemConflictError, 409],
    [service.WorkItemValidationError, 400],
    [Error, 500],
  ];
  for (const [ErrorClass, status] of cases) {
    const res = workItemErrorResponse(new ErrorClass("boom"));
    assert.equal(res.status, status, `${ErrorClass.name} -> ${status}`);
    const body = await res.json();
    assert.equal(body.error, "boom");
  }
});
