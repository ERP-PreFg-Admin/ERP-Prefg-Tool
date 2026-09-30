# Daily ops digest — a 23:59 IST report mail

## Context

There is no push visibility into what the tool did today. Everything that would
answer "did the day go well?" exists — `activity_log` has every mutation with its
HTTP status, `purchase_orders.date` is already an IST calendar date, `approvals`
timestamps both ends — but it is all pull-only, behind `/observability`, which is
developer-only. Nobody finds out a PO batch 500'd or a manufacturer's mail bounced
until someone goes looking.

The ask: at 23:59 IST every day, mail a selected group a summary of the day — POs
processed, what failed, emails fired and their status.

Three things this runs into, and they shape the whole plan:

1. **There is no scheduler.** Not a cron, not a timer, not an EventBridge rule.
   Two plans exist for one and neither was built.
2. **There is no email record in MySQL.** The three senders in `lib/mail/mailer.ts`
   write no rows. A *failed* send leaves no database trace at all.
3. **Three different time bases** sit in the tables this reads, and one of them has
   already caused a 5½-hour bug (documented in `lib/queries/activity.ts:56-64`).

Outcome: one systemd timer installed once, a job registry in app code, and a
digest that is honest about what it cannot see.

---

## Decisions

| # | Decision | Consequence |
|---|---|---|
| 1 | **systemd timer + app-side job registry**, per `.claude/plans/humble-munching-pillow.md` Part 1 — *not* BullMQ | See "The two competing plans" below |
| 2 | Timer fires **hourly at UTC :29** (= IST :59); the app runs jobs whose `hours` include the current IST hour | One timer, never touched again; the digest is registered for IST hour 23 |
| 3 | **No `RandomizedDelaySec`** on this timer | Jitter past midnight makes `getHours()` return 0 and the digest silently never fires. Stagger test vs prod by a fixed UTC minute instead |
| 4 | Recipients live in **`entity_emails` under a new `entity_type = 'report'`** | Reuses the existing CRUD screen and `splitRecipients`. The new enum value is what keeps them off every PO mail — see risk table |
| 5 | Email counts come from **CloudWatch `MAILER` log lines** via the existing `filterLogEvents` | No schema, no AWS config change. Costs: nothing to report on local dev |
| 6 | The digest carries **counts and normalised routes only** — no PO numbers, manufacturer names, or user names | It is tenant-wide data pushed to an address list that has no `/observability` grant. See Governance |
| 7 | Every number reuses an **existing query** where one exists | `purchaseOrdersSql.statusCounts`, `businessSql.approvalsPending`, `observabilitySql.windowSummary` |

### The two competing plans

Both unbuilt, and the newer one explicitly retires the older:

- `.claude/plans/humble-munching-pillow.md` Part 1 — systemd timer, `CRON_KEY` route, `lib/cron/jobs.ts`.
- `.claude/plans/plan-out-a-way-bright-axolotl.md` — BullMQ + Redis. Its Phase 3 says *"The CRON_KEY route, the nginx deny and the host units from that plan are no longer needed."*

**Taking the systemd one.** BullMQ for a nightly email means a Redis container, a
new dependency, `instrumentation.ts`, worker lifecycle on SIGTERM, and a change to
how deploys stop the container — before one mail is sent. The queue plan's real
value is *email retry* and *taking work out of the request*, neither of which a
scheduled digest needs. Decide BullMQ on its own merits when mail retry is the
actual problem; the job registry moves onto `upsertJobScheduler` in an afternoon
if that day comes.

---

## The way

### Sequencing

**Phase 0 — make mail countable.** Smallest change, and it must land first because
the digest's email section cannot be verified until a day of tagged lines has
accrued. Three sites in `lib/mail/mailer.ts` capture `sendMail()`'s result, add
`mailOutcome` and `sesMessageId` to the log line, and tag the flow.
*Gate:* a send from **test** produces a CloudWatch line matching
`{ $.module = "MAILER" && $.mailOutcome = "sent" }`. Until that pattern returns a
hit, the rest of the email section is guesswork.
*Hard constraint:* nothing here may fail a send. Capture the result, log it, move on.

**Phase 1 — the digest callable, triggered by hand.**
`lib/reports/daily-digest.ts` exporting `runDailyDigest(ctx, day)`. Renders and
sends. No scheduler yet — invoke it from a throwaway `tsx` script locally and read
the mail.
*Gate:* every number reconciles against `/observability` for the same window. Do
this by eye, once, properly — it is the only time the two will be compared.

**Phase 2 — recipients.** The `'report'` enum value, the `selectByPurpose` query,
the dropdown option. DDL **to dev only, then stop** (prod DDL needs its own
go-ahead).
*Gate:* adding a report recipient and then sending a PO mail shows they are **not**
on it. This is the whole reason for the new enum value; prove it rather than assume it.

**Phase 3 — the scheduler.** `lib/cron/jobs.ts`, `app/api/v1/cron/run/route.ts`,
`CRON_KEY`, the systemd units, the nginx deny. Register the digest for hour 23.
*Gate:* on test, `systemctl list-timers` shows a sane next fire, and one real
23:59 IST run lands a mail.

**Phase 4 — promote.** `workflow_dispatch` to prod with `CRON_KEY` pushed to
`/erp-app/prod` in the same sitting. A missing key returns 503, so prod refuses to
run rather than running unauthenticated.

Phases 0–2 are independent of the scheduler and can ship on their own. If Phase 3
stalls, you still have a callable digest and someone can trigger it.

### The timezone trap — the most likely bug in this work

One report, one "day", **three time bases**:

| Source | Stored as | How the digest filters it |
|---|---|---|
| `purchase_orders.date` | `DATE`, **already IST** (every insert uses `SQL_TODAY_IST`) | Compare to `todayIST()` directly. No conversion — converting is the bug |
| `activity_log.created_on`, `approvals.raised_on`/`approved_on`, `invoice_mfg.created_at`, `purchase_orders.email_sent_at` | `DATETIME`, **UTC** (`NOW()` on a UTC session) | UTC window `[18:30 yesterday, 18:30 today)` |
| CloudWatch | epoch ms | Same two instants, as `Date` |

One helper, in `lib/date.ts` (**not** a new module — that file's header warns
against a second answer to "what is today"):

```ts
/** An IST calendar day as the UTC half-open instant range the DB stores. */
export function istDayWindowUtc(day: string): { from: Date; to: Date } {
  const from = new Date(`${day}T00:00:00+05:30`)
  return { from, to: new Date(from.getTime() + 86_400_000) }
}
```

`runDailyDigest` computes `day = todayIST()` **once** at entry, logs it, and passes
it everywhere. Nothing downstream calls `new Date()` again — a job that straddles
midnight while querying must not half-report two days.

### Governance

- **This is tenant-wide data leaving the app.** `/observability` is developer-only
  precisely because it cannot be scoped (see the header comment in
  `lib/services/business.ts:3-8`). The digest reads the same way, then mails it to
  an address list with no permission check behind it. That is the one genuinely new
  exposure here.
- **So: counts and normalised routes only.** No PO numbers, no manufacturer or
  vendor names, no user names, no recipient addresses. `observabilitySql.recentProblems`
  returns `user_name` and a real path — use `windowSummary` and the normalised
  `routeStats` instead, or strip the columns. A number cannot leak a record.
- **Suppression still applies.** Route recipients through `splitRecipients` with the
  `email_suppressions` set, exactly as `resolveRecipients` does, so a bounced
  address is dropped rather than re-bounced nightly forever.
- **No new permission, no new screen.** Recipients are managed at the existing
  `/po-tracking/po-procurement/entity-emails` page, which is already `editor` on
  `/po-tracking`.
- **No route deletions.** The cron route is new; nothing existing is removed.
- **DDL is dev-only in this plan.** The `entity_type` enum widen goes to dev and
  stops there.

### Risks

| Risk | Absorbed by |
|---|---|
| **A report recipient silently joins every manufacturer's PO mail.** `entityEmails.selectForMfg` matches `entity_type='employee'` with `entity_code='*'` and **does not filter on `purpose`** — so reusing `employee` + a purpose string would CC them on every PO email, including future manufacturers | The new `entity_type='report'`. Both existing recipient queries filter on `entity_type`, so they cannot reach it. This is why it is an enum widen and not a naming convention |
| **Timer jitter pushes the run past midnight** — `getHours()` returns 0, hour-23 job never fires, and the failure is silent | `RandomizedDelaySec` omitted. Test and prod staggered by fixed UTC minute (:25 → IST :55, :29 → IST :59), both safely inside IST hour 23 |
| Cron route is internet-reachable (nginx proxies `/`) | `CRON_KEY` + `crypto.timingSafeEqual` over hashes, **503 when the env var is unset** (fail closed), plus `location /api/v1/cron { allow 127.0.0.1; deny all; }`. The timer curls `127.0.0.1:3000` and never traverses nginx |
| Duplicate digest from a manual `systemctl start` while testing | Module-level `lastDigestDay` string, skip if already sent today. `// ponytail: in-process flag, resets on deploy; a DB stamp if duplicates ever matter` |
| CloudWatch unavailable or `filterLogEvents` hits `MAX_PAGES` (10) | Email section renders "unavailable" / "≥N" rather than throwing. An observability mail that dies because AWS is unhealthy is backwards — same contract as `lib/services/infra.ts` |
| Nothing to report on local dev (Gmail transport, no CloudWatch) | Accepted. Verified on test, per the email-observability plan's own finding that dev can never exercise this |
| One section throwing kills the whole mail | Per-section `try/catch`; a failed section renders as "unavailable" and the digest still goes |
| The mail itself fails and nobody knows | `logger.error` to CloudWatch. Deliberately **no** alert-on-the-alerter — that regress is infinite. A missing mail is its own signal |

### What the digest cannot see — state this in the mail itself

Not caveats to bury; a report that implies completeness it does not have is worse
than a smaller one:

- **GETs are not logged.** `logActivity()` skips them, so all read traffic and
  every list endpoint is absent. "Requests" means mutations.
- **Gatepasses have no table.** `lib/gatepass/*` imports zero DB modules — they
  live entirely in Unicommerce. The only trace is the `activity_log` row for
  `POST /api/v1/gatepass/create`, so the digest reports *attempts and their HTTP
  status*, not gatepasses raised.
- **Bulk-CSV per-row failures are in-memory only** (`skipped` / `skipReasons` in
  `lib/approvals/handlers/purchase-orders.ts:133-143`) and are discarded unless the
  whole batch failed. A partially-applied bulk upload reads as a success.
- **Split children are excluded** from PO counts — `MASTERS_ONLY` in `SUMMARY_WHERE`.
- **No SES delivery outcomes.** Send-side only, as chosen. Bounces and deliveries
  need Phases 0–2 of `docs/email-observability-plan.md` first.

---

## Changes

### 1. `lib/mail/mailer.ts` — make sends countable (Phase 0)

Three sites (~`:472`, `:591`, `:795`) currently discard `sendMail()`'s result. Each becomes:

```ts
const info = await getTransporter().sendMail({ ...sesOptions, from: fromHeader, ... })
logger.info({ ...ctx, message: "… sent successfully", mailOutcome: "sent",
              flow: "po_selection", sesMessageId: info.messageId, recipients: to.length })
```

and the catch path logs `mailOutcome: "failed"` with `flow` and `error`. Flows:
`po_selection`, `po_split`, `inward_invoice`, `ops_digest`. Constants per call site —
nothing computed, so nothing here can throw.

This also does the "log the messageId" half of `docs/email-observability-plan.md`
Phase 2 for free; update that doc's §1 gap note when it lands.

### 2. `lib/mail/mailer.ts` — a fourth sender

`sendOpsDigestEmail(day: string, html: string): Promise<boolean>`. There is no
generic `sendEmail()` helper and this plan does not add one — a fourth function
beside the other three matches the file. Reuse `poSection()` for the HTML tables.

### 3. `prisma/alter_entity_emails_report_type.sql` (new) — **dev only**

```sql
ALTER TABLE entity_emails
  MODIFY COLUMN entity_type ENUM('vendor','mfg','warehouse','employee','report') NOT NULL;
```

Header comment per convention: what, why, re-runnable. Mirror the enum in
`prisma/schema.prisma`. **Apply to dev, then stop** — prod needs its own go-ahead.
Recipients are `entity_type='report'`, `entity_code='daily_ops'`,
`recipient_type='to'|'cc'`.

### 4. `lib/queries/entity-emails.ts` — one query

```ts
/** Digest recipients. entity_type='report' is unreachable from selectForMfg and
 *  selectByWarehouseForEntity, which is what keeps these people off entity mail.
 *  Params: [entity_code] */
selectReportRecipients: `
  SELECT email, recipient_type FROM entity_emails
  WHERE entity_type = 'report' AND entity_code = ? AND status = 'active'
`,
```

Also: `'report'` into `lib/validation/entity-emails.ts`, and the dropdown in
`app/po-tracking/po-procurement/entity-emails/AddEntityEmailDialog.tsx`.

### 5. `lib/date.ts` — `istDayWindowUtc(day)`

As above. Pure, so `tests/unit/` can cover it.

### 6. `lib/reports/daily-digest.ts` (new) — the callable

`export async function runDailyDigest(ctx: RequestContext, day = todayIST())`.
Sections, each in its own `try/catch`, each reusing existing SQL:

| Section | Source | Reuse |
|---|---|---|
| POs raised today by display status | `purchaseOrdersSql.statusCounts` with `dateFrom = dateTo = day`, `UNRESTRICTED` | **Existing.** `buildStatusCountParams(null,null,null,day,day,null,null,false,UNRESTRICTED)` |
| POs mailed today | `purchase_orders.email_sent_at` in the UTC window | one small query |
| Emails fired / failed by flow | `filterLogEvents({ from, to, pattern: '{ $.module = "MAILER" }' })` | **Existing** `lib/aws/cloudwatch.ts` |
| Approvals raised + decided today, and what is still pending | `approvals.raised_on` / `approved_on`; `businessSql.approvalsPending` | partly existing |
| Invoices inwarded today | `invoice_mfg.created_at` + `uniware_status` | one small query |
| Mutations, 4xx, 5xx, slow | `observabilitySql.windowSummary` with `[from, to]` | **Existing, unchanged** |
| Uniware sweeps + gatepass attempts | `activity_log` by path prefix, with status | one small query |

Use `DISPLAY_STATUS_EXPR` via `statusCounts` — never re-write the CASE. A PO raised
today but not yet mailed correctly reads as **Draft**, which is exactly the number
worth seeing at 23:59.

### 7. `lib/cron/jobs.ts` (new) — the registry

```ts
// ORDER IS EXECUTION ORDER. hours are IST — the container runs TZ=Asia/Kolkata.
export const CRON_JOBS = [
  { name: "daily-digest", hours: [23], run: runDailyDigest },
]
```

The Uniware sweeps from the deferred plan are **not** added here. That plan's step 1
(extracting `runStatusSync` out of its route) is a separate change with its own
ordering constraint; registering them is one array entry once someone wants it.

### 8. `app/api/v1/cron/run/route.ts` (new)

Exactly as designed in `humble-munching-pillow.md` §3 — deliberately **not**
`withGateway` (no user, no session, no page slug): `runtime = "nodejs"`, 503 when
`CRON_KEY` is unset, `timingSafeEqual` over hashes, module-level `running` flag → 409,
per-job `try/catch`, one `logger.info` per job with name/ms/result.

### 9. Deploy — `deploy/push-secrets.mjs`, `deploy/bootstrap-instance.sh`

`"CRON_KEY"` into the `KEYS` array (~line 36); `openssl rand -hex 32` into `.env`;
`node deploy/push-secrets.mjs test`.

Units appended after the `certbot-renew.timer` block (~line 155), copying its shape.
Note the two deviations from the deferred plan:

```ini
[Timer]
# UTC :29 = IST :59. NO RandomizedDelaySec: jitter past midnight moves the IST
# hour to 0 and the hour-23 job silently never runs. Test uses :25 (IST :55) so
# the two boxes don't hit the Uniware tenant together — deterministic, not random.
OnCalendar=*-*-* *:29:00
```

And in the nginx `server` block (~line 106), above `location /`:
`location /api/v1/cron { allow 127.0.0.1; deny all; }`

### 10. `tests/unit/daily-digest.test.ts` (new)

Not a suite — the two things that fail silently rather than loudly:

1. `istDayWindowUtc("2026-09-28")` → `from` is `2026-09-27T18:30:00Z`, `to` is
   `2026-09-28T18:30:00Z`. The half-open boundary is the whole point.
2. `CRON_JOBS`: names unique, every `hours` entry 0–23, `daily-digest` on 23.

Pure modules only — `lib/reports/daily-digest.ts` itself reaches `lib/db` and
`lib/mail/mailer`, so it cannot be imported by a unit test. Keep the window math in
`lib/date.ts` for exactly that reason.

---

## Verification

**Local**

1. `npm test` — window math and registry checks pass.
2. `CRON_KEY=x npm run dev`:
   - `curl -X POST localhost:3000/api/v1/cron/run` → **401**
   - with `-H "x-cron-key: x"` → **200**, body lists only jobs due this IST hour
   - unset `CRON_KEY` → **503**, not 200
3. Temporarily widen `hours` to the current hour, confirm the digest renders and
   sends (Gmail transport locally; the email section will correctly say unavailable).
4. `npm run lint:changed` and `npx tsc --noEmit --incremental false` — the
   `--incremental false` matters, a stale `tsbuildinfo` reports clean on a file
   `next build` then rejects.

**On test**

5. Push to main (CI deploys to test). Over SSM with `AWS_PROFILE=erp` and
   `MSYS_NO_PATHCONV=1`:
   - `systemctl list-timers erp-cron.timer` — next fire is a `:25`/`:29` past the hour
   - `systemctl start erp-cron.service; journalctl -u erp-cron.service -n 50` —
     curl returned 200, body in the journal
6. **The enum guard, explicitly:** add a `report` recipient, then send a real PO mail
   from PO Procurement. Confirm that address is **not** on it. This is the one failure
   that would be invisible and embarrassing.
7. `curl -X POST https://dev.erp.mcaffeine.com/api/v1/cron/run` → **403** from nginx.
8. **Reconcile, once, by eye:** open `/observability` with a 24h window on the day the
   first digest arrives and check the mutation count, 4xx/5xx and PO statuses agree.
9. Leave it two nights. Confirm it fired at 23:59 IST both times and that the day
   boundary is right — specifically that a PO raised at 23:30 IST appears in **that
   night's** mail and not the next one. That is the assertion the whole timezone
   section exists to protect.

**Promote**

10. `workflow_dispatch` → prod, with `CRON_KEY` pushed to `/erp-app/prod` first, and
    the `entity_type` DDL applied to prod under its own go-ahead.

---

## Out of scope

- **BullMQ / Redis.** See "The two competing plans". Revisit when mail *retry* is the
  problem, not the schedule.
- **SES delivery outcomes** (delivered / bounced / complained per mail). Needs
  Phases 0–2 of `docs/email-observability-plan.md`. The `sesMessageId` logging in
  Phase 0 here is the prerequisite half, done early.
- **An `email_log` table.** Explicitly rejected by the email-observability plan in
  favour of AWS. If CloudWatch counts prove too coarse, that decision reopens — and
  the old table design is recoverable from that doc's git history.
- **Registering the Uniware sweeps** on the new timer. One array entry, after the
  `runStatusSync` extraction, whenever wanted.
- **Per-user activity breakdown**, weekly/monthly rollups, an in-app archive of past
  digests, and configurable sections. Add a section when someone asks for it.
- **Alerting on a digest that failed to send.** The logs are in CloudWatch; a metric
  filter and alarm is the follow-up once a normal run is known.
