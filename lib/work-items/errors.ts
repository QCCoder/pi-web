/** Shared work-item error classes. Leaf module: service, delivery-types and
 *  future delivery-flow services all throw these (web.ts maps them to HTTP
 *  statuses via instanceof, so every thrower must share the exact classes). */
export class WorkItemValidationError extends Error {}
export class WorkItemConflictError extends Error {}
export class WorkItemNotFoundError extends Error {}
