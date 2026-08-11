# Admin Panel & Per-User Data Scoping

> **Related docs:** [Authentication & Permissions](./authentication-and-permissions.md) · [Database Schema](./database-schema.md) · [API Reference](./api-reference.md)

`/admin` replaces the old developer-only `/settings` permission screens with a four-tab admin section. It also introduces a **third** access dimension: page permissions answer *"can you open this screen"*, entity scope answers *"whose rows do you see on it"*.

| Tab | Route | Answers | Writes |
|-----|-------|---------|--------|
| **Users** | `/admin` | Accounts and roles | `POST`/`PATCH /api/v1/admin/users` → `users` + `user_roles` |
| **Permissions** | `/admin/permissions` | Which screens | `/api/v1/admin/permissions` (role) · `/api/v1/admin/user-permissions` (per user) |
| **Data Access** | `/admin/data-access` | Which rows | `PUT /api/v1/admin/entity-scope` → `user_entity_scope` |
| **Activity** | `/admin/activity` | What happened | read-only (`activity_log` ∪ `session_history`) |

Every tab reads server-side (`page.tsx` → `lib/queries/*`), the same way masters pages do; the API routes are mutations only. Access is guarded **once**, in `app/admin/layout.tsx`.

> `/admin` has no parent slug, so `lib/permissions.ts`' parent-walk cannot fall back to `/` — the section is **deny-by-default**. `prisma/add_activity_log.sql` and `scripts/seed-permissions.ts` both seed `developer` + `admin` → `/admin` `editor`, because without those rows the admin panel is closed to everyone, including developers, with no way to open it from the UI.

---

## The Role Taxonomy (`lib/roles.ts`)

Roles used to be **free text**: `user_roles.role` and `page_permissions.role` are plain `VARCHAR(100)`, and the list the admin UI offered was *derived* by unioning those two tables. A typo in the Users dialog silently created a permanent new role that then showed up for everyone. `lib/roles.ts` replaces that with a declared list.

**14 roles** = 4 domains × 3 designations, plus 2 system roles:

| | Head | Lead | Executive |
|---|---|---|---|
| Raw Material | `rm_head` | `rm_lead` | `rm_executive` |
| Packing Material | `pm_head` | `pm_lead` | `pm_executive` |
| Production | `production_head` | `production_lead` | `production_executive` |
| Cost | `cost_head` | `cost_lead` | `cost_executive` |

System roles (no designation — they gate the tool, not a position in the org): `developer`, `admin`.

The key is a single lowercase string on purpose: `user_roles` has a composite PK of `(user_id, role)`, the JWT carries `roles: string[]`, and `resolveAccess` matches on the string — so encoding the designation *into* the key means no schema change, no new column, and each of the fourteen is independently grantable.

**What a role does not do:** nothing in the app branches on a role name — there is no `if (role === ...)` anywhere. A role's only power is the `page_permissions` rows attached to it. `approver: true` on Head is descriptive: it documents why the four `*_head` roles are seeded `editor` on `/approvals`, and drives a UI hint. The actual gate is still the page permission.

Derived helpers (all computed from the role keys a user holds, so nothing can disagree with what `resolveAccess` reads): `designationsOf`, `domainsOf`, `roleLabel`, `APPROVER_ROLES`, `ROLE_KEYS` (for `z.enum` validation on the users and permissions routes), and `isKnownRole` — false for any legacy string still sitting in a schema that hasn't had the migration applied, which the Users table flags rather than rendering as if it were real.

### Migrating an existing schema

`prisma/migrate_role_taxonomy.sql` is idempotent and does four things:

1. Remaps users on retired roles (`"cost creator"` → `cost_executive`, `"production executive"` → `production_executive`, …). `INSERT IGNORE` + `DELETE` rather than `UPDATE`, because `user_roles`' PK is `(user_id, role)` and updating a row to a role the user already holds would violate it. Note the live schema held role names **with spaces** while `seed-permissions.ts` had historically seeded underscored variants nobody held — every statement matches both spellings.
2. Deletes every role outside the taxonomy. Users keep their account and their per-user overrides; they just hold no role until one is assigned in `/admin`.
3. Clears `page_permissions` for every role except `developer`/`admin` — deliberately, because access is granted from the tool now. This also drops the old `"production head"` grants, whose name collides with the new `production_head` role and would otherwise carry 11 inherited grants forward invisibly. `user_page_permissions` is untouched.
4. Re-seeds the one org rule: the four Heads get `editor` on `/approvals`.

`scripts/_check-role-taxonomy.ts` asserts nothing outside the taxonomy survived (via `usersSql.selectRoleStringsInUse`, which exists only for that check).

## The Page List (`lib/pages.ts`)

The canonical list of permission-controlled slugs — one source of truth for the Permissions grid, sidebar lock resolution (`app/layout.tsx`'s `SIDEBAR_SLUGS = NAV_SLUGS`) and breadcrumb labels (`components/TopBar.tsx`). Adding a page means adding one row here, so a new page can't be lockable in one place and invisible in another.

`section` groups the grid (General · Masters · Production · Planned); `nav: false` marks slugs that gate a route but aren't sidebar destinations (the module placeholders with no page yet). Because `lib/permissions.ts` walks a slug up its parents, a child listed here with no row of its own inherits its parent's grant — only slugs needing a *more specific* grant than their parent need seeding.

---

## Permissions Tab

Three stacked pieces, all "pick one thing, edit its pages down a list":

1. **`UserAccessTable`** — the roster: every user, the roles and designation they hold, and what those resolve to across all page slugs. It answers the question that comes first — *"who can reach what"* — without making an admin select each user in turn. Everything is derived, not stored: designation from the role key, counts from replaying `resolveAccess` over every slug. Selecting a row drives the overrides panel through `?user=`.
2. **Role permissions** → `page_permissions`.
3. **Per-user overrides** → `user_page_permissions`.

The role panel used to be a role × page matrix; with 14 roles that meant 15 columns × 23 pages of dropdowns and horizontal scrolling to set one cell, so it's now a role picker plus a vertical page list — the same shape as the other two panels.

Both editable panels use one 4-state control:

| Control value | Stored as |
|---|---|
| **Inherit** | *no row at all* — a `DELETE` |
| **None** | `access_level = 'none'` |
| **Viewer** | `access_level = 'viewer'` |
| **Editor** | `access_level = 'editor'` |

**Inherit is a DELETE, not `'none'`.** An explicit `none` row stops `lib/permissions.ts` walking up to the parent slug — a different and stronger statement than having no row. Each change is its own request; the row updates optimistically and rolls back if the API rejects it.

### Resolved effect + provenance (`app/admin/authority.ts`)

The stored value alone can't answer the question the page exists for: "Inherit" is not an outcome. `authority.ts` is a display-side mirror of `resolveAccess` that resolves both **what the user ends up with** and **which grant decided it**:

```ts
resolveForDisplay(slug, overrideAt, roleAt) // → { effect, layer, from }
```

| Effect | Meaning |
|---|---|
| `editor` / `viewer` | Reachable |
| `blocked` | An explicit `none` — a deliberate stop |
| `absent` | No grant anywhere |

It must track `lib/permissions.ts` exactly, **including the part that surprises people**: the walk checks override *then* role at each slug level before moving up. So a role grant on `/masters/vendors` beats an override on `/masters` — depth wins before layer does. Any change to `resolveAccess` belongs here too.

Two independent visual encodings, deliberately not conflated: **colour = the effect**, **left-rail border style = the provenance** (solid where the row is configured here, dashed where it's inheriting). So a glance down a column reads access levels and a glance down the rail reads which rows are actually configured versus coasting on a parent.

### Self-lockout guards (`lib/admin-guards.ts`)

There is no recovery path from the UI — the only screen that can restore `/admin` access is inside `/admin`, and `/admin` has no parent to inherit a grant from. So both permission-writing routes call:

| Guard | Refuses |
|-------|---------|
| `assertNotSelfLockout` | Any change to `/admin` below `editor` that affects a role the caller holds, or the caller's own user id → `400 self_lockout` |
| `assertNotSelfScope` | **Any** entity-scope change to the caller's own row → `400 self_scope`. Widening is blocked too — self-granting data access shouldn't be a one-click action for the person doing it. |

---

## Data Access Tab — Entity Scope

### The one rule: absence of rows means UNRESTRICTED

A user with no `user_entity_scope` rows for an entity type sees **every** entity of that type, exactly as before the feature existed. Rows present = allow-list. That's why there is no "all" marker row: an admin narrows access by adding rows and widens it by deleting them — and existing users kept working the day this shipped.

Every helper in `lib/scope.ts` preserves that: an unrestricted dimension compiles to a predicate that is always true, so adding scope to a query can never change results for an unscoped user.

```sql
CREATE TABLE user_entity_scope (
  user_id     INT NOT NULL,
  entity_type ENUM('mfg','vendor','warehouse') NOT NULL,
  entity_id   INT NOT NULL,  -- master_mfgs.id | master_vendors.id | master_warehouse.id
  created_at  DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by  INT NULL,
  PRIMARY KEY (user_id, entity_type, entity_id),
  CONSTRAINT fk_user_entity_scope_user FOREIGN KEY (user_id) REFERENCES users (id)
)
```

No FK on `entity_id` — it points at three different tables depending on `entity_type`, so the constraint can't be expressed. A stale row after a deleted manufacturer is harmless: it grants access to nothing.

**Warehouses are the awkward dimension.** They're stored here by `master_warehouse.id`, but `purchase_orders.destination` and `invoice_mfg.destination` are unindexed `VARCHAR` copies of `master_warehouse.name` with no FK (the only join anywhere is `ON wh.name = po.destination`). `lib/scope.ts` therefore resolves warehouse ids to **names** once per request, and all warehouse predicates compare names.

### Using `lib/scope.ts`

`getUserScope(userId)` is wrapped in React's `cache()` — one DB round trip per request, shared across the root layout, the page and its nested components.

```ts
export type UserScope = {
  mfgIds: number[] | null          // null = unrestricted, never an empty array
  vendorIds: number[] | null
  warehouseNames: string[] | null  // resolved from ids, because `destination` stores the name
}
```

Three ways to apply it, by call site:

```ts
// 1. Lists (server pages, exports) — filter in SQL
const scope = await getUserScope(userId)
const sql   = `SELECT ... WHERE 1=1 ${scopeClause("po.mfg_id")}`
await query(sql, [...scopeParams(scope.mfgIds)])

// 2. Single records and writes — assert, don't filter
assertInScope(scope, "mfg", mfgId)   // throws 403 out_of_scope

// 3. Globally cached lists — post-filter
filterByScope(mfgOptions, "id", scope.mfgIds)
```

Why the three differ:

- `scopeClause` emits `AND (? IS NULL OR col IN (?))` and **must** go through `query()` (text protocol) so mysql2 expands the array. The `? IS NULL` flag has to be a separate param from the list — an array in the flag slot expands to `(1,2,3) IS NULL` and fails to parse. Unrestricted passes `[null, [0]]`: the flag short-circuits the predicate, and the dummy list exists only because `IN ()` is a syntax error.
- `execute()` uses prepared statements and does **not** expand array params, and an id arriving from a URL or request body needs a hard 403 rather than an empty result — hence `assertInScope`.
- `lib/cached-reference-data.ts` uses `unstable_cache` with no user in the key, so it cannot filter internally — hence `filterByScope`.

`lib/po-guard.ts`' `assertPoInScope(userId, poId)` exists separately to avoid an import cycle (`lib/queries/purchase-orders.ts` imports `scopeParams`, so `lib/scope.ts` must not import the query file back). **Every `/api/v1/purchase-orders/[id]/**` route needs it:** the PO list is filtered in SQL, but ids are sequential integers — without the guard, a user scoped to manufacturer 1 can still read, receive, cancel, split, mail or PDF-export manufacturer 7's PO by guessing its id.

The sidebar drops out-of-scope manufacturers **entirely** rather than locking them — a lock icon would still disclose the name.

### Deliberately not scoped yet

Don't assume a screen is scoped because `lib/scope.ts` exists — grep for the call. Known gaps:

- **The approvals queue** — `approvalsSql.listPending` stores only module + `entity_id`, and bulk modules store `entity_id = user_id`.
- **BOM master** — no `mfg_id`; linkage is via `master_recipe_mfg`.
- **The supplier-invoice list.**

`scripts/_check-entity-scope.ts` exercises the helpers and the scoped queries.

---

## Activity Tab

`activity_log` answers *"what did this user do"* — which nothing did before. The app already logged three unrelated things (`session_history` for login/logout, `history_masters_edits` for master edits, `history_pos` for PO field changes), and Winston writes to files/stdout that no admin can read.

**Written from exactly one place** — `logActivity` in `lib/gateway/with-gateway.ts` — so every API mutation is captured with no per-route instrumentation:

- Fire-and-forget. An audit-row failure must never fail the request it's describing (same contract as `lib/events.ts`); the insert's rejection is logged as a warning.
- **GETs are skipped** — every page load and dropdown fetch would land a row for no audit value.
- Both the success and the error path log, so a `4xx`/`5xx` is recorded with the status it returned.
- `request_id` ties the row back to its Winston log lines.
- No FK on `user_id`: it's `NULL` for requests that 401 before a session resolves, and this is the highest-volume table in the app (`session_history.session_id` already set the no-FK precedent).
- `created_on` is **IST** — written as `CONVERT_TZ(NOW(), '+00:00', '+05:30')` because the DB session runs in UTC, matching `history_masters_edits`.

The feed (`lib/queries/activity.ts`) is a `UNION ALL` of `activity_log` (API mutations) and `session_history` (logins/logouts) so both appear on one timeline, filtered by user / method / path / date range and paginated **in SQL** — the page reads `?user`, `?method`, `?q`, `?from`, `?to`, `?page`, `?size` and fetches only the visible slice. Because the filters use `? IS NULL OR` they must go through `query()`, not `execute()`.

---

## Users Tab

| | |
|---|---|
| Reads | `usersSql.selectAll` — users with roles rolled up (`GROUP_CONCAT`) and last successful login (`MAX(session_history.event_at)` where `event = 'login'`) |
| Writes | `POST /api/v1/admin/users` (create) · `PATCH /api/v1/admin/users` (update). Roles are replaced wholesale inside one transaction. |
| Roles offered | `lib/roles.ts`, validated with `z.enum(ROLE_KEYS)` — not free text |

- **Creating a user emails nothing.** The row *is* the whitelist: `lib/auth.ts`' `signIn` callback looks the person up by `email` + `status`, so they can sign in with Google the moment the row exists. The email is lowercased on insert because `signIn` looks it up verbatim — a stray capital would silently lock the person out.
- **Email is only editable on create.** Changing it would orphan the person's Google login while leaving all their audit rows attached to the old identity.
- **There is deliberately no DELETE.** `users.id` is referenced by `approvals`, `sessions`, `session_history`, `master_*` and `invoice_mfg`. Deactivation is `status = 'inactive'`, which `signIn` already refuses.
- `users.email` is `UNIQUE`, surfaced as a `409 duplicate` the dialog can show rather than a generic 500.
- **A user with no roles is the quiet failure the table exists to surface** — the account signs in fine and then reaches nothing. It renders as a warning, not an empty cell. The layout header counts the same two silent failures for the whole section: users with no roles, and roles with no grants.

---

## Files

| Path | Role |
|------|------|
| `lib/roles.ts` | The declared role taxonomy and its derived helpers |
| `lib/pages.ts` | The canonical page-slug list (`PAGES`, `NAV_SLUGS`, `PAGE_LABELS`, `PAGE_SECTIONS`) |
| `lib/scope.ts` | `getUserScope`, `scopeClause`/`scopeParams`, `inScope`/`assertInScope`, `filterByScope` |
| `lib/po-guard.ts` | `assertPoInScope` — the by-id guard for every PO route |
| `lib/admin-guards.ts` | `assertNotSelfLockout`, `assertNotSelfScope` |
| `lib/queries/users.ts` | `users` + `user_roles` |
| `lib/queries/entity-scope.ts` | `user_entity_scope` + the admin picker's entity lists |
| `lib/queries/activity.ts` | `activity_log` insert + the UNION feed |
| `app/admin/authority.ts` | Display-side mirror of `resolveAccess` (effect + provenance + visual language) |
| `app/admin/**` | The four tabs (server `page.tsx` + client component each) |
| `app/api/v1/admin/{users,permissions,user-permissions,entity-scope}/route.ts` | The mutations |
| `prisma/add_user_entity_scope.sql`, `add_activity_log.sql`, `migrate_role_taxonomy.sql` | Migrations |
| `scripts/_check-admin-panel.ts`, `_check-admin-authority.ts`, `_check-role-taxonomy.ts`, `_check-entity-scope.ts` | Verification scripts |
