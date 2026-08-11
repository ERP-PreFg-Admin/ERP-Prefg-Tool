# Read/write DB split for production (RDS read replica)

## Context

The app currently runs all queries — reads and writes — through a single `mysql2` pool in `lib/db.ts` against one RDS MariaDB instance (`mcaff-dwh`). As production load grows, heavy read paths (paginated master-data lists, CSV/Excel exports, reports, the sheet-viewer) compete with the write path (approvals, PO creation, master edits) for the same connections and the same instance's CPU/IO. Splitting reads onto an RDS **read replica** offloads that contention without touching the write path's correctness guarantees.

This is an **opt-in, additive** change, not a flip of the default: `query()` keeps behaving exactly as it does today (hits the primary), and a new `queryReplica()` is added for call sites that are provably safe to read from a replica. This avoids the main risk of read-replica splits — replication lag causing a read to miss a write that just happened a moment earlier (see the `hasPending` double-submit guard in `CLAUDE.md`'s approval flow, which must never read a replica).

**External dependency:** the replica must be provisioned on the `mcaff-dwh` RDS instance, which lives in AWS account `157320387454` — the same account we're already blocked on for VPC peering access (see `deploy/setup-commands.md` history). This plan's code changes can be built and merged independently, but the replica pool stays inert (falls back to primary) until someone with RDS console access on that account creates the replica and hands over its endpoint.

## Design

### 1. `lib/env.ts` — add an optional replica host

```ts
export const DB_HOST_REPLICA = process.env.DB_HOST_REPLICA || DB_HOST  // falls back to primary if unset
```
Not run through `required()` — this is optional infra, absence just means replica reads silently go to primary. No behavior change until the env var is set.

### 2. `lib/db.ts` — second pool + `queryReplica()`

Add a second `mysql.createPool(...)` using `DB_HOST_REPLICA` (identical config to the existing pool — same user/password/pool size/timezone/keepalive settings, since a read replica accepts the same credentials as the primary in RDS). Add:

```ts
export async function queryReplica<T = Record<string, unknown>>(sql: string, params?: any[]): Promise<T[]> {
  return withRetry(async () => {
    const [rows] = await replicaPool.query(sql, params)
    return rows as T[]
  })
}
```
Reuse the existing `withRetry` helper — no new retry logic needed. `execute()` and `pool` (used for transactions) are untouched; writes and transactional reads never move.

### 3. Which call sites migrate to `queryReplica()`

Only reads that are **not** immediately downstream of a write in the same user action. Good first candidates (verified via grep — these are pure list/export reads with no adjacent write in the request):
- `app/api/v1/masters/skus/export/route.ts`, `.../material-master/export/route.ts`, `.../recipe-master/export/route.ts` — CSV/Excel export queries
- The paginated list `GET` handlers in `app/api/v1/masters/*/route.ts` (skus, vendors, manufacturers, raw-materials, packing-materials, recipe-master, material-master) — these call `lib/queries/*.ts`'s `selectPaginated`-style queries with no preceding write
- `app/api/v1/reports/*` and `app/sheet-viewer` data fetches, if/when they hit `lib/db.ts` directly

**Never migrate:**
- `approvalsSql.hasPending` calls (8 call sites found: `masters/skus`, `masters/vendors` (×2), `masters/manufacturers` (×2), `masters/material-master` (×2), `masters/recipe-master`, `purchase-orders/[id]`) — these are double-submit guards checked immediately before an insert; a stale replica read would let a duplicate pending approval through.
- Anything inside `lib/master-routes/material-utils.ts` — already reads via `conn.execute` on the open transaction, correctly pinned to primary.
- Any read that immediately follows a write in the same handler (e.g. re-fetching a row right after `applyAndArchive` to return updated state).

Document this rule directly above `queryReplica` in `lib/db.ts` and add one line to `CLAUDE.md`'s Database Access section: *"`query()` = primary (default, safe). `queryReplica()` = opt-in for reads that can tolerate replication lag — never use it for a read that must see a write from earlier in the same request."*

### 4. Infra rollout (blocked on account 157320387454 access)

1. Whoever has RDS console access on that account: RDS → `mcaff-dwh` → **Actions → Create read replica**. Same instance class as primary is a reasonable start; can right-size later based on read load.
2. Note the replica's endpoint hostname.
3. Add `DB_HOST_REPLICA` to SSM Parameter Store (`/erp/prod/DB_HOST_REPLICA`) the same way the other 15 secrets were added (`deploy/setup-commands.md` step 4), and to local `.env` for dev parity.
4. Add a CloudWatch alarm on the replica's `ReplicaLag` metric (namespace `AWS/RDS`, e.g. threshold >10s) so a lagging replica surfaces before it causes visible staleness.

### 5. Rollout order

1. Ship the `lib/db.ts`/`lib/env.ts` code change first — it's a no-op until `DB_HOST_REPLICA` is set (replica pool just points back at primary), so this can merge and deploy immediately without any infra dependency.
2. Migrate the export routes first (lowest risk — exports are inherently "point in time" snapshots, staleness is barely noticeable).
3. Migrate paginated list `GET` handlers next.
4. Once the replica exists and `DB_HOST_REPLICA` is set in SSM, redeploy — reads on migrated routes start actually hitting the replica with zero further code changes.

## Verification

- Before the replica exists: run `npm run build` and hit a migrated export/list endpoint locally — should behave identically to today (replica pool resolves to the primary host).
- After `DB_HOST_REPLICA` is set: add a temporary log line (or check `SHOW PROCESSLIST` / RDS Performance Insights on both instances) to confirm export/list queries are landing on the replica's connections, not the primary's.
- Regression-test the approval double-submit guard specifically: submit two edits to the same SKU back-to-back and confirm the second one gets a `409` (proves `hasPending` is still reading fresh data from primary).
- Watch the `ReplicaLag` CloudWatch metric for a few days after rollout before migrating more call sites.
