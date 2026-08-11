> **Related docs:** [Architecture](./architecture.md) · [Event-Driven Options](./event-driven-options.md) · [Event Catalog](./event-catalog.md) · [Interaction Logging Map](./interaction-logging-map.md) · [Event Instrumentation Blueprint](./event-instrumentation-blueprint.md)

# ERP Architecture Evolution Plan

> **Status:** In progress (Part A pilot shipped) · **Scope:** Evolve the existing Next.js monolith · **Owner:** Ajay
> **Last updated:** 2026-07-01

---

## 1. Context — why this change

Today the ERP is a **synchronous monolith**:

- One Next.js 16 app, one MariaDB (AWS RDS), accessed via raw `mysql2` in `lib/db.ts`.
- Every side-effect runs **inline** inside the HTTP request: a masters insert, its audit trail, any future approval/notification logic all happen in one blocking transaction.
- Cross-cutting concerns (auth, validation, rate limiting, logging, error shape) are **copy-pasted per route** (`app/api/v1/masters/*`, `app/api/v1/admin/*`). There is no Zod, no request ID, no central error format.

> **Already addressed (June–July 2026):**
> - The approval handler now uses a **Strategy pattern** — per-module logic lives in `lib/approvals/module-handlers.ts`; the route is a thin dispatcher. Adding a new module requires one new entry there, not a route edit.
> - `lib/constants.ts` provides typed `STATUS` and `APPROVAL_STATUS` constants eliminating raw string literals.
> - **Winston structured logger** (`lib/logger.ts`) is deployed and adopted across all API routes (masters, approvals, PO). Every log line includes `requestId`, `module`, `userId`, and relevant domain fields. Console transport uses a human-readable pretty format; file transports write JSON to `logs/app-*.log` and `logs/error-*.log` with daily rotation.
> - **S3 event pipeline** (`lib/events.ts` → `lib/s3.ts`) records `raw-events`, `processed-events`, and `failed-events` to a dedicated S3 bucket for all master and PO operations.
> - **API Gateway (Part A) — Step 1 & pilot done (2026-07-01):** `lib/gateway/with-gateway.ts` + `lib/gateway/errors.ts` ship the `withGateway` wrapper described in §4.2 (auth, opt-in RBAC via `resolveAccess()`, Zod validation, structured logging via `lib/logger.ts`, uniform `{error, code, requestId}` error shape). It intentionally skips rate limiting and the `middleware.ts` request-ID change for now — request IDs still come from `lib/request-context.ts`'s `createRequestContext()`, reused as-is rather than duplicated. `app/api/v1/masters/skus/route.ts` is the first (and so far only) route migrated, proving the pattern with zero behavior change; validation schemas live in `lib/validation/skus.ts`. Every other route (vendors, manufacturers, raw-materials, packing-materials, material-master, purchase-orders, approvals, admin) is still on the old manual-validation pattern — see the updated §6 rollout.
> - Remaining gaps: rolling `withGateway` out to the rest of the routes, rate limiting, centralised request IDs in `middleware.ts`, and all of Part B (event bus) are still open.

This is fine at today's size but creates two concrete problems as modules grow:

1. **Coupling of side-effects.** When a PO is raised, we will eventually need to: write audit history, trigger an approval, notify a vendor, invalidate a cache, update a dashboard. Doing all of that inline makes routes fragile and slow, and every new side-effect means editing the core write path.
2. **Inconsistent API surface.** Each route re-implements auth checks and validation slightly differently. There's no single place to enforce policy, shape errors, or trace a request.

**Goal:** introduce two capabilities *without* a rewrite and *without* new infrastructure:

- **(A) An in-app API Gateway layer** — one wrapper that every route opt=s into for auth, RBAC, validation, rate limiting, request IDs, logging, and uniform error responses.
- **(B) An event-driven backbone** — domain actions emit typed events; independent handlers react asynchronously. Start in-process; designed to swap to Redis/BullMQ later with no caller changes.

**Non-goals (deliberately deferred):** splitting into microservices, Kong, Kubernetes, per-service databases, Kafka. We revisit those only when real scale demands them (see §8).

---

## 2. Target shape (evolutionary)

```
                 ┌─────────────────────────────────────────┐
  HTTP request → │ middleware.ts  (auth gate, request-id)    │
                 └───────────────────┬───────────────────────┘
                                     │
                 ┌───────────────────▼───────────────────────┐
                 │ withGateway(handler, { schema, access })   │  ← API Gateway layer
                 │  • session + RBAC (resolveAccess)          │
                 │  • Zod validation                          │
                 │  • rate limit                              │
                 │  • structured logging + timing             │
                 │  • uniform error → JSON                    │
                 └───────────────────┬───────────────────────┘
                                     │ runs business logic
                 ┌───────────────────▼───────────────────────┐
                 │ service function (lib/services/*)          │
                 │  • DB writes via lib/db.ts                 │
                 │  • events.emit("sku.created", payload) ────┼──► event bus
                 └────────────────────────────────────────────┘
                                                                  │
                       ┌──────────────────────────────────────────┘
                       ▼                ▼                 ▼
                 audit handler    approval handler   notification handler
                 (session_history) (approvals)       (future)
```

Key principle: **the route never calls a side-effect directly.** It calls one service function, which does its own DB work and then *emits an event*. Everything else subscribes.

---

## 3. New directory layout

Add these under the project root (nothing existing moves yet):

```
lib/
  gateway/
    with-gateway.ts        # the route wrapper
    errors.ts              # ApiError class + error→response mapping
    rate-limit.ts          # in-memory limiter (swap to Redis later)
    context.ts             # builds RequestContext (session, requestId, access)
  events/
    types.ts               # the typed event catalogue (DomainEvent union)
    bus.ts                 # EventBus interface + in-process implementation
    index.ts               # singleton `events` + handler registration
    handlers/
      audit.ts             # writes session_history / generic audit
      approvals.ts         # raises approval rows when needed
      notifications.ts     # stub for now (logs); real impl later
  services/
    skus.ts                # business logic extracted from the route
    vendors.ts
    ...                    # one per master/domain as you migrate
  validation/
    masters.ts             # Zod schemas (sku, vendor, rm, pm, mfg)
```

`lib/db.ts`, `lib/auth.ts`, `lib/permissions.ts` stay exactly as they are — we build *on top* of them.

---

## 4. Part A — In-app API Gateway layer

### 4.1 What it centralizes

| Concern | Today | After |
|---|---|---|
| Auth (session) | `auth()` repeated per route | once, in `withGateway` |
| RBAC | manual role checks | declarative `{ access: { pageSlug, level } }` using existing `resolveAccess()` |
| Validation | manual `!x?.trim()` | Zod schema per route |
| Rate limiting | none | per-user/IP limiter |
| Request ID / tracing | none | generated in `middleware.ts`, logged everywhere |
| Error shape | ad-hoc `NextResponse.json` | one `{ error, code, requestId }` format |
| Logging | none | one structured log line per request w/ timing |

### 4.2 The wrapper (sketch)

`lib/gateway/with-gateway.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { resolveAccess, AccessLevel } from "@/lib/permissions";
import { ApiError, toErrorResponse } from "./errors";
import { checkRateLimit } from "./rate-limit";

type AccessRule = { pageSlug: string; level: Exclude<AccessLevel, "none"> };

export function withGateway<TBody>(opts: {
  schema?: z.ZodType<TBody>;
  access?: AccessRule;          // omit for public routes
  rateLimit?: { max: number; windowMs: number };
  handler: (args: {
    req: NextRequest;
    body: TBody;
    ctx: { userId: number; roles: string[]; requestId: string };
  }) => Promise<unknown>;
}) {
  return async (req: NextRequest) => {
    const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
    const started = performance.now();
    try {
      // 1. auth
      const session = await auth();
      if (opts.access && !session?.user)
        throw new ApiError(401, "unauthorized", "Sign in required");

      const userId = Number(session?.user?.id);
      const roles = session?.user?.roles ?? [];

      // 2. RBAC via existing resolveAccess()
      if (opts.access) {
        const level = await resolveAccess(userId, roles, opts.access.pageSlug);
        const ok =
          opts.access.level === "viewer"
            ? level === "viewer" || level === "editor"
            : level === "editor";
        if (!ok) throw new ApiError(403, "forbidden", "Insufficient access");
      }

      // 3. rate limit
      if (opts.rateLimit)
        await checkRateLimit(`${userId || req.headers.get("x-forwarded-for")}`, opts.rateLimit);

      // 4. validation
      let body = {} as TBody;
      if (opts.schema) {
        const json = await req.json().catch(() => ({}));
        const parsed = opts.schema.safeParse(json);
        if (!parsed.success)
          throw new ApiError(400, "validation_error", "Invalid request", parsed.error.flatten());
        body = parsed.data;
      }

      const data = await opts.handler({ req, body, ctx: { userId, roles, requestId } });

      console.log(JSON.stringify({ requestId, route: req.nextUrl.pathname, userId, ms: Math.round(performance.now() - started), ok: true }));
      return NextResponse.json({ data, requestId });
    } catch (err) {
      console.error(JSON.stringify({ requestId, route: req.nextUrl.pathname, ms: Math.round(performance.now() - started), ok: false, err: String(err) }));
      return toErrorResponse(err, requestId);
    }
  };
}
```

`lib/gateway/errors.ts`:

```ts
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export function toErrorResponse(err: unknown, requestId: string) {
  if (err instanceof ApiError)
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details, requestId },
      { status: err.status },
    );
  return NextResponse.json({ error: "Internal error", code: "internal", requestId }, { status: 500 });
}
```

`lib/gateway/rate-limit.ts` — start with an in-memory token bucket keyed by user/IP (a `Map`). It's per-process, which is fine for a single instance; the function signature stays identical when we move the counter into Redis later.

### 4.3 Middleware

`middleware.ts` already gates auth. Add a request-ID header so every downstream log and the client can correlate:

```ts
// inside the existing NextAuth middleware composition
const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
const res = NextResponse.next();
res.headers.set("x-request-id", requestId);
return res;
```

---

## 5. Part B — Event-driven backbone

### 5.1 Typed event catalogue

`lib/events/types.ts` — a discriminated union so handlers and emitters are type-checked:

```ts
export type DomainEvent =
  | { type: "sku.created";    payload: { skuId: number; skuCode: string; userId: number } }
  | { type: "sku.bulkImported"; payload: { count: number; userId: number } }
  | { type: "vendor.created"; payload: { vendorId: number; code: string; userId: number } }
  | { type: "po.statusChanged"; payload: { poId: number; from: string; to: string; userId: number } }
  | { type: "approval.raised";  payload: { approvalId: number; module: string; entityId: number } };
// extend per module as you migrate
```

### 5.2 The bus

`lib/events/bus.ts` — an interface plus an in-process implementation. **The interface is the contract; the implementation is swappable.**

```ts
import { DomainEvent } from "./types";

export type Handler<E extends DomainEvent = DomainEvent> = (e: E) => Promise<void>;

export interface EventBus {
  on<T extends DomainEvent["type"]>(type: T, handler: Handler<Extract<DomainEvent, { type: T }>>): void;
  emit(event: DomainEvent): Promise<void>;
}

export class InProcessBus implements EventBus {
  private handlers = new Map<string, Handler[]>();

  on(type: string, handler: Handler) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }

  async emit(event: DomainEvent) {
    const hs = this.handlers.get(event.type) ?? [];
    // fire-and-forget but capture failures so one handler can't break the request
    await Promise.allSettled(hs.map((h) => h(event as never))).then((rs) =>
      rs.forEach((r) => r.status === "rejected" && console.error("handler failed", event.type, r.reason)),
    );
  }
}
```

> **Important nuance for serverless/Next.js:** in-process handlers run inside the same request lifecycle. For genuinely background work (notifications, heavy reports) that must survive the response, the in-process bus is a *stepping stone* — see §5.5 for the Redis upgrade. For audit/approval writes that should complete before responding, in-process is correct.

`lib/events/index.ts` — wire up the singleton and register handlers once:

```ts
import { InProcessBus } from "./bus";
import { registerAuditHandlers } from "./handlers/audit";
import { registerApprovalHandlers } from "./handlers/approvals";

const g = globalThis as unknown as { __erpBus?: InProcessBus };
export const events = g.__erpBus ?? new InProcessBus();
if (!g.__erpBus) {
  registerAuditHandlers(events);
  registerApprovalHandlers(events);
  g.__erpBus = events;
}
```

### 5.3 Concrete first use-cases (grounded in your schema)

These map directly to tables that already exist:

1. **Audit trail** — `sku.created`, `vendor.created`, etc. → handler writes a generic audit row (extend `session_history` pattern or add an `audit_log` table). Removes audit logic from every route.
2. **Approvals** — when a masters change requires sign-off, emit `approval.raised` → handler inserts into `approvals` + `approval_items`. Your `approvals` table is already generic (`module`, `entity_id`, `field_name`/`old_value`/`new_value`), so it fits cleanly.
3. **PO status changes** — `po.statusChanged` (draft→raised→received…) → handlers can later drive notifications and dashboards without touching the PO write path.
4. **Notifications** — `notifications.ts` is a stub today (logs to console); becomes email/WhatsApp/in-app later with zero caller changes.

### 5.4 Service + event pattern

`lib/services/skus.ts` — business logic extracted from `app/api/v1/masters/skus/route.ts`:

```ts
import { execute } from "@/lib/db";
import { events } from "@/lib/events";
import { ApiError } from "@/lib/gateway/errors";

export async function createSku(input: { skuCode: string; name: string; brand?: string; category?: string }, userId: number) {
  try {
    const res = await execute(
      "INSERT INTO skus (sku_code, name, brand, category, created_by) VALUES (?,?,?,?,?)",
      [input.skuCode, input.name, input.brand ?? null, input.category ?? null, userId],
    );
    await events.emit({ type: "sku.created", payload: { skuId: res.insertId, skuCode: input.skuCode, userId } });
    return { id: res.insertId };
  } catch (e: any) {
    if (e?.code === "ER_DUP_ENTRY") throw new ApiError(409, "duplicate", "SKU code already exists");
    throw e;
  }
}
```

The route becomes a thin binding:

```ts
// app/api/v1/masters/skus/route.ts
import { withGateway } from "@/lib/gateway/with-gateway";
import { skuCreateSchema } from "@/lib/validation/masters";
import { createSku } from "@/lib/services/skus";

export const POST = withGateway({
  schema: skuCreateSchema,
  access: { pageSlug: "/masters", level: "editor" },
  rateLimit: { max: 60, windowMs: 60_000 },
  handler: ({ body, ctx }) => createSku(body, ctx.userId),
});
```

### 5.5 The upgrade path to Redis/BullMQ (later, not now)

Because callers only ever touch `events.emit(...)` and the `EventBus` interface, switching to durable async requires **no changes to services or routes**:

1. Add `ioredis` + `bullmq`, point at Redis (local Docker now, AWS ElastiCache in prod).
2. Implement `RedisBus implements EventBus` whose `emit` enqueues a BullMQ job.
3. Move handlers into a **worker process** (`npm run worker`) that consumes the queue.
4. Swap the singleton in `lib/events/index.ts` from `InProcessBus` to `RedisBus`.

That's the moment you get retries, durability, and true background processing. We defer it until a side-effect genuinely needs to outlive the request (real notifications, long reports).

---

## 6. Incremental rollout

No big-bang. Each step is shippable on its own.

- **Step 1 — Gateway scaffolding. ✅ Done (2026-07-01).** Added `lib/gateway/with-gateway.ts`, `lib/gateway/errors.ts`, and `lib/validation/skus.ts` (per-domain, not a shared `masters.ts`). Skipped the `middleware.ts` request-ID change — reused the existing `createRequestContext()` from `lib/request-context.ts` instead.
- **Step 2 — Migrate one route. ✅ Done (2026-07-01), partial.** Converted `app/api/v1/masters/skus/route.ts` to `withGateway`. Business logic stayed inline inside the route's `handler` callback rather than being extracted to a `lib/services/skus.ts` — the pilot deliberately touched only the route file. Behaviour confirmed identical (create/bulk/update/bulk_from_s3, same status codes, same approval-flow transaction handling). `lib/services/*` extraction remains a follow-up if/when a route's handler grows unwieldy.
- **Step 3 — Event bus + audit handler.** Add `lib/events/*`, emit `sku.created`, write an audit row in the handler. Verify the row appears and the response is unaffected if the handler throws.
- **Step 4 — Roll the pattern across masters.** vendors, raw-materials, packing-materials, manufacturers — one PR each, reusing the now-proven pattern.
- **Step 5 — Approvals via events.** Wire `approval.raised` into the `approvals`/`approval_items` tables for masters edits that need sign-off.
- **Step 6 — New modules adopt by default.** PO-tracking and every future module are built on the gateway + events from day one.
- **Step 7 (deferred) — Redis/BullMQ swap** when a background side-effect demands it (see §5.5).

---

## 7. Dependencies to add

- `zod` — request validation (Step 1).
- *(Deferred to Step 7)* `ioredis`, `bullmq`.

No new runtime infra is required for Steps 1–6.

---

## 8. When to go further (decision triggers)

Revisit the deferred items only when a trigger actually fires:

| Move | Trigger |
|---|---|
| Add Redis + BullMQ | A side-effect must run in the background / survive the response, OR you need retries & durability, OR you scale beyond one app instance (in-memory rate-limit & in-process bus stop being correct). |
| External gateway (Kong) | You split into ≥2 deployable services and need routing/auth at the edge across them. |
| Microservices / per-service DB | A single team/codebase/DB becomes the bottleneck — independent deploy cadence or scaling per domain is required. |
| Kafka | Event volume + replay/streaming needs exceed what BullMQ comfortably handles. |

Until then, the monolith with an in-app gateway and an in-process (then Redis-backed) event bus gives you the *decoupling benefits* of event-driven design without the *operational cost* of distributed systems.

---

## 9. Verification

For each migrated route:

1. **Build & lint:** `npm run build` and `npm run lint` pass.
2. **DB connectivity:** `npm run db:test` still green.
3. **Functional parity:** run `npm run dev`, exercise the relevant masters page — single create and bulk import — confirm rows land in MariaDB exactly as before.
4. **Gateway behaviour:**
   - Unauthenticated request → `401` with `{ error, code, requestId }`.
   - Authenticated but insufficient role → `403`.
   - Bad payload → `400` with Zod `details`.
   - Exceed `rateLimit.max` in the window → `429`.
5. **Event behaviour:** confirm the audit/approval row is written on success; force a handler to throw and confirm the **main request still succeeds** (handler failures are isolated and logged, never break the write).
6. **Tracing:** every response carries `x-request-id`; the same id appears in the server log line.
```