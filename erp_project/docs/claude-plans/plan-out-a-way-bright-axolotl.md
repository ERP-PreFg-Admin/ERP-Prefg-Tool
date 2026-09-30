# Background jobs on BullMQ + Redis — the way

## Context

All background-shaped work in the ERP runs **inside the HTTP request today**, and each of these limits comes from that:

- **Email has no retry.** `lib/mail/mailer.ts` has three senders (`sendMfgSelectionEmail`, `sendSplitPoEmail`, `sendInwardInvoiceEmail`). Each one calls `sendMail` once, and if that throws it logs and rethrows. When a send fails on invoice inward step 5 (`lib/invoice/invoice-inward.ts:526-556`), the only trace is an NDJSON line. Nothing records "mail still owed", so nothing can replay it.
- **Everything is capped to fit 300 s.** The status sweep has `MAX_PER_RUN=150`, the GRN sweep 40 and the document sweep 40. Gatepass summary and the facility-map sync are driven by the **browser**, one facility per request, and the code comments say so ("this repo has no queue or worker").
- **Scheduled sweeps don't exist.** A comment in `uniware-status/route.ts:109` refers to a "nightly job" that isn't there. The systemd-timer plan (`humble-munching-pillow.md` Part 1) was deferred.
- **Deploys kill in-flight work.** `docker rm -f erp` sends SIGKILL, so a send-mail loop that is halfway through simply stops.

The goal is one queue mechanism that retries email safely, takes the post-commit steps of PO processing out of the request, and replaces the deferred cron plan. It must keep MySQL as the record of what happened.

Current state: no `bullmq`, `ioredis` or `lib/cron`, and no `instrumentation.ts`. `@upstash/redis` is in `package.json`, but nothing imports it. It also **can't serve BullMQ**, because Upstash is HTTP/REST and BullMQ needs a raw TCP Redis connection.

---

## Decisions taken (defaults, override at the gates)

| # | Decision | Why |
|---|---|---|
| 1 | **Redis is transport. MySQL stays the record.** A job carries ids only. Its "is this still owed?" check reads the DB, not Redis. | If Redis is lost, we lose the queue but not the data. Anything that went missing can be rebuilt from DB state (see #4). |
| 2 | **Enqueue only after `commit()`, never inside a transaction** | An enqueue inside the transaction runs even when the transaction rolls back. Then a job goes looking for rows that don't exist. |
| 3 | **Every job is idempotent through a DB guard.** Before acting, the job re-reads the row and exits if the work is already done (the `email_sent_at IS NULL` pattern). A deterministic BullMQ `jobId` removes duplicate enqueues. | BullMQ delivers at least once. After a crash between the SES accept and the job completing, the job runs again. The DB guard is what stops a second email. |
| 4 | **The DB flag is the outbox.** A repeatable "reconcile" job re-enqueues rows that are still owed. For example: POs that are `raised` with no `email_sent_at` and older than N minutes. | This covers a commit that succeeds followed by an enqueue that fails, without a separate outbox table. |
| 5 | **Phase 1 runs the worker inside the Next process**, started from `instrumentation.ts`. A separate worker container is a later gate. | No build change is needed. The standalone image ships only `server.js`, and a second entrypoint needs its own bundling step. One process is how the box runs today. |
| 6 | **Redis runs as a container on the same EC2 box.** It is bound to a private docker network, with AOF on and `maxmemory-policy noeviction`. | Cost is zero and it matches the single-instance setup. BullMQ requires `noeviction`, because eviction deletes jobs silently. ElastiCache is the upgrade if the box ever becomes more than one. |
| 7 | **Each queue has a flag with an inline fallback** (`QUEUE_MAIL=on\|off`, and so on). With the flag off, the code runs exactly as it does today. | Rollback is an env change on the box, with no redeploy. It costs one extra branch per call site, and that branch is deleted once the phase is stable. |
| 8 | **User-watched, irreversible work stays synchronous.** This covers Uniware `createPurchaseOrder` inside the inward transaction, and gatepass create. | The user needs the outcome on screen. Uniware has no delete, so an automatic retry of a create is the worst possible behaviour. |

**Governing constraint:** a job may be retried at any moment, any number of times. If a job can't be made safe under that rule, it doesn't go on a queue.

---

## What goes on a queue, and in what order

| Queue | Jobs | Replaces | Phase |
|---|---|---|---|
| `mail` | PO selection mail, split PO mail, inward warehouse mail | inline loop in `send-mail/route.ts`, step 5 of `runInwardInvoice` | 1 |
| `po-post-commit` | inward `pushInvoicePdfToUniware` (docs step) | step 4 of `runInwardInvoice` | 2 |
| `sweeps` (job schedulers) | status sync, then GRN sync, then document sync, then mail reconcile | the deferred systemd timer plan, and the browser-driven loops later | 3 |
| `bulk` | `*_BULK` applyAndArchive, gatepass summary for all facilities | long approve requests, browser-driven facility loop | 4, gated |

Order of the mail queue: it has the highest value and the lowest risk, and it already has a DB guard in `email_sent_at`.

---

## Phases and gates

### Phase 0 — Infrastructure · gate: Redis hosting
- Redis container on test: `redis:7`, AOF on, `noeviction`, on a user-defined docker network `erp-net`, no host port. Not restarted by app deploys.
- The app container joins `erp-net`, and `REDIS_URL` goes into SSM `/erp-app/<env>`. This touches the inline rollout in `deploy.yml`, plus `redeploy-app.sh` and `bootstrap-instance.sh`. All three must change together, because they already drift.
- Change `docker rm -f erp` to `docker stop -t 30 erp` followed by `rm`. The worker gets SIGTERM, calls `worker.close()`, and finishes the job in hand.
- Local dev: `docker run -p 6379:6379 redis:7`, or simply leave the queue flags off.
- **Gate (Ajay):** Redis on the box, or ElastiCache (about ₹1–1.5k/month for t4g.micro, and it survives a box replacement). The default is on the box.
- **Exit:** from the running app container on test, `redis-cli ping` works, and `docker stop` shows a graceful shutdown in the logs.

### Phase 1 — Mail queue · gate: duplicate-mail guard for inward
- `bullmq` is the only new dependency; it brings `ioredis` with it. Use one `lib/queue/` module for the connection, the queues and the worker registration, and start it from `instrumentation.ts` (`NEXT_RUNTIME === "nodejs"` only).
- PO mail: the route enqueues one job per manufacturer or split, with `jobId = po-mail:<poId>`. The job re-checks `email_sent_at IS NULL` and exits if the PO is already stamped, then sends and stamps. Retries: 5, exponential backoff starting at 30 s. The route returns "queued", and the UI shows the Draft→Raised transition once the stamp lands.
- Inward mail: `runInwardInvoice` enqueues after commit and emits `{step:"email",status:"queued"}`.
- **Gate:** inward mail has **no DB guard today**. Nothing records that the warehouse was mailed. Option 1: add a nullable `invoice_mfg.warehouse_mailed_at` column (DDL on dev first, per rule). Option 2: accept an occasional duplicate warehouse mail on a crash-retry. The default is the column.
- Suppression, attachment limits and `lib/events` recording stay inside the senders, unchanged.
- Poison jobs: a job that exhausts its retries stays in the failed set and a `logger.error` goes to CloudWatch. Also check `isSuppressed` and bounce errors so that a permanent SES failure gets `UnrecoverableError` instead of 5 retries.
- **Exit on test:** block SES egress, or use a bad config set. The job fails, retries, and succeeds once it is restored, with exactly one email and one stamp. Also kill the container mid-job: the stalled job is picked up again after restart and is not sent twice.

### Phase 2 — PO post-commit steps
- The inward docs push becomes a `po-post-commit` job, keyed `inward-docs:<invoiceId>`. It is guarded by whatever `document-sync.ts` already uses to tell that a doc is present in Uniware.
- The Uniware create stays inside the transaction (decision #8). The existing orphan-on-commit-fail risk (`invoice-inward.ts:399-403`) is unchanged, and it is **not** a queue problem.
- **Exit:** an inward invoice returns to the user after the email/docs steps report `queued`, and both complete in the background.

### Phase 3 — Scheduled sweeps (supersedes the systemd-timer plan)
- Use BullMQ `upsertJobScheduler` for a single `sweeps` chain, run in business hours IST. The container is `TZ=Asia/Kolkata`; pass `tz` explicitly anyway.
- Keep the **order**: status sync runs before GRN sync, because status writes the `grn_count` that GRN reads. Run the chain as **one job** that calls them in sequence, rather than three independently scheduled jobs that can interleave. Concurrency is 1 on this queue.
- Status sync must first be extracted to `lib/uniware/status-sync.ts` (the Part 1 step 1 refactor, unchanged). GRN and doc sync are already callables.
- The job list lives in code and ships through CI, which was the reason the systemd plan put it in app code. The CRON_KEY route, the nginx deny and the host units from that plan are **no longer needed**.
- Mail reconcile (decision #4) goes on this schedule too.
- **Exit:** a full business day on test with every window firing and `truncated=false`. Then promote.

### Phase 4 — Heavier moves · gate: per-job, only when demanded
- `*_BULK` approvals: moving them means approve returns before the apply finishes, which changes what an approver sees. That is a UX decision (Ajay or the approvers), not engineering.
- All-facility gatepass summary: needs progress reporting (`job.updateProgress` plus a poll endpoint). Do it only if the browser loop is actually hurting.
- **Separate worker container:** move to it when PDF render or bulk jobs visibly slow page requests (watch p95 in the existing query-timing logs). It needs a second bundled entrypoint (tsup/esbuild in the Docker build stage), which is why it isn't in Phase 1.

---

## Risk register

| Risk | Absorbed by |
|---|---|
| Duplicate email on crash-retry | DB guard re-read inside the job (#3), and `warehouse_mailed_at` for inward |
| Commit succeeds, then enqueue fails, so the job is lost | DB-flag outbox and the reconcile sweep (#4) |
| Redis loses data or the box is replaced | AOF on, and #1 plus #4 rebuild any owed work from MySQL |
| Redis evicts jobs under memory pressure | `noeviction` is mandatory, and BullMQ warns at startup if it is not set |
| Enqueue inside a transaction produces ghost jobs | #2. Reviewed at every call site. Same rule as "no nested beginTransaction" |
| Retrying a non-idempotent Uniware create | Kept off the queue entirely (#8) |
| Worker hogs the event loop during PDF render, slowing pages | Worker concurrency 2 on `mail`; separate container at the Phase 4 gate |
| Deploy kills a job mid-send | `docker stop -t 30` plus `worker.close()`, and BullMQ's stalled-job recovery covers what is left |
| Queue fails silently with nobody noticing | `logger.error` on final failure, and failed-set count on `/api/health` or an admin endpoint. Alarm once a normal baseline is known |
| Instrumentation starts a worker in the build or Edge runtime | Guard on `NEXT_RUNTIME === "nodejs"` and on `REDIS_URL` being set |
| The flag-off branch rots | Delete the inline fallback once each phase has been stable on prod for two weeks |

**Rollback posture:** Phases 1–2 roll back by setting `QUEUE_<NAME>=off` on the box. Phase 3 rolls back by removing the scheduler, since the manual buttons still call the same callables. Redis can be stopped without data loss.

---

## Skipped on purpose

- Bull Board / dashboard UI: logs plus a failed count are enough until someone asks.
- Flow producers, priorities, rate-limiter groups: nothing needs them yet.
- `@upstash/redis`: unused and the wrong protocol. Report it as dead; removing it is Ajay's call.

---

## Verification

1. `npm test`: one unit test on the pure bits: job-id builders (deterministic, one per PO), the sweep chain order (status before GRN), and the payload Zod schemas.
2. Local: run Redis in Docker with `QUEUE_MAIL=on`. Send PO mail, see the job complete and `email_sent_at` stamped. Enqueue the same PO twice: one job, one mail.
3. Local, flag off: behaviour is byte-identical to today (same NDJSON steps, same response).
4. Test env: the Phase 1 exit checks (forced failure → retry → one mail; kill mid-job → recovered, no duplicate).
5. Test env: Phase 3, a full business day of sweep windows in CloudWatch before `workflow_dispatch` to prod.
6. `npm run lint:changed` and `npx tsc --noEmit --incremental false` and `npm run build` before every push.
