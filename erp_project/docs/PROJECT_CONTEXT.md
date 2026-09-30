# Project Context — Claude session memory export

Exported 2026-09-30, before moving to a new laptop. It holds everything Claude learned
across past sessions: how Ajay wants the work done, plus project facts you can't get
from the code or git history.

- **`CLAUDE.md` wins on code facts.** Some entries below are dated snapshots, e.g. *Project State*
  (2026-06-30) says MariaDB and "reject → draft". Both are now wrong: the engine is MySQL 8.0, and a
  rejection sets `rejected`.
- Plans that lived in `~/.claude/plans/` are copied to [`docs/claude-plans/`](claude-plans/).
  Some memories cite plan files that had already been deleted before this export
  (`enumerated-gathering-tulip`, `go-through-my-whole-crystalline-clover`,
  `production-planning-module-fg-crispy-neumann`, `plan-how-to-populate-mighty-hummingbird`,
  `looking-at-the-present-humble-rabin`, `i-want-to-change-iterative-church`). Those are gone.
- Gitignored, local-only things this file can't carry: `.env`, `check_uniware_apis/` (Uniware
  probe scripts and FINDINGS), and `C:\Users\AJAY SINGH\Desktop\Unicommerce playing\Downloads\`.
  Copy them across by hand.

## Restoring on the new laptop

1. Clone the repo. Copy `.env`, `check_uniware_apis/` and the Unicommerce Downloads folder over manually.
2. Recreate AWS CLI profiles (`~/.aws/`): **`erp`** = account `157320387454` with SSM on `/erp-app/*`.
3. To give Claude its memory back, copy the `## ` sections below into
   `~/.claude/projects/<project-slug>/memory/` as one file each, or just tell Claude
   "read docs/PROJECT_CONTEXT.md". The slug is the project path with separators turned
   into `-`. On the old laptop it was `c--Users-AJAY-SINGH-Desktop-ERP-Project`.

---

# Part 1 — How Ajay wants the work done

## feedback-approval-rejection-flow

_Approval rejection flow — remarks mandatory, record moves to a distinct 'rejected' status (not draft), stays directly re-editable by the submitter_


In the ERP approval workflow, when an approval is **rejected**:
- Rejection remarks are **mandatory** — UI must validate non-empty before submitting; API returns 400 if missing
- The record moves to a dedicated **`rejected`** status (added 2026-07-09 as its own ENUM value alongside `active`/`inactive`/`in_review`/`draft` on every approval-flow entity table)
- `rejected` behaves exactly like the old draft-as-rejection-marker did: fields stay editable, only by the original submitter, and resubmitting moves it to `in_review` again
- `draft` is no longer used as a rejection marker for SKU/RM/PM/Vendor/Mfg — it's freed up for a true "not yet submitted" meaning if ever needed. For BOM and PO, `draft` still means "created but not yet submitted for approval" (a separate, legitimate lifecycle stage) — `rejected` is additive there, not a replacement.
- Only `in_review` rows are locked from editing; `rejected` rows are editable immediately (same rule that used to apply to `draft`)

**Why:** Originally chose to reuse `draft` for rejected records (avoid a "rejected badge + acknowledge" pattern that would block editing). Later reversed after the user asked explicitly for a distinct `rejected` status/badge rather than reusing `draft` — but kept the re-editable behavior since that part worked well.

**How to apply:** Any time an approval/workflow rejection is planned in this project, use mandatory remarks + a dedicated `rejected` status (editable by the original submitter) as the rejected outcome. See [[project_state]] for where the ENUM migrations for this landed.

---

## feedback-delete-uniware-downloads

_Uniware sync must clean up its own temp files, but never touch Ajay's Unicommerce Downloads folder_


Two separate rules, and they were easy to conflate on 2026-08-19:

**1. The sync path cleans up after itself.** Any Uniware Vendor Item Master
import must delete the CSVs *it* creates or stages once the import has committed.
Nothing is left in S3 or on disk. Ajay asked for this as a standing rule.

**2. Do NOT delete anything under
`C:\Users\AJAY SINGH\Desktop\Unicommerce playing\Downloads\`.** Ajay uses those
export folders for testing. He said so explicitly after I proposed removing them.
They are his working input, not build output.

**Why it matters:** the export is a full vendor × facility × item dump (~12k rows
of real product names and vendor codes), so it *looks* like something to tidy
away — but it is also the only local copy of a run that takes ~18 sequential
Unicommerce export jobs to reproduce. Deleting it costs him a long re-run.

**How to apply:** build cleanup into the sync's own temp handling; treat the
Downloads folder as read-only input. Deleting outside the repo is destructive and
irreversible — confirm exact paths before ever removing anything there, and
default to not removing.

Relates to [[project-warehouse-entity-structure]] — the export is keyed on
Unicommerce facility codes, which are per (warehouse, legal entity).

---

## feedback-dev-schema-first

_Apply schema migrations to the dev schema first and stop; prod needs a separate explicit go-ahead each time_


Run a DDL migration against `DB_NAME_TEST` (`mcaff_prefg_dev`) **only**, then stop and
report. Do not touch `DB_NAME_PROD` in the same step, even when the plan says "run on
both schemas" and the plan was approved.

**Why:** 2026-09-09 — I batched an `ALTER TABLE … MODIFY COLUMN mtrl_type ENUM(…)` across
dev and prod in one command because the approved plan's Phase 0 said "apply to both". Ajay
interrupted it: *"first chnage schema of dev then i will tell about prod."* Approving a plan
that mentions prod is not the same as authorising the prod write at that moment — he wants
to see it land on dev, and probably exercise it, before prod moves.

**How to apply:**
- One schema per command, dev first, then report what the column looks like after.
- Ask (or wait) before the prod leg, every time — it is not a once-per-session unlock.
- The `prisma/*.sql` file still documents "run on both schemas"; that is the record of
  intent, not permission to do it unprompted.

Related: [[feedback-plan-before-implement]] governs when to start; this governs how far a
single approval reaches on prod data.

---

## feedback-improve-dont-add-ui

_Design work means improving existing tables/components in place — never adding new sections, summary panels, or visualisations_


When Ajay asks for design/UI work, improve the **existing** tables and components
in place. Do not add new sections, hero panels, summary strips, or data
visualisations alongside them — even when they'd answer the page's question more
directly.

Rejected twice now:
- A redesigned PO table (`/frontend-design`, rolled back to the plainer look).
- A "Market Position" band section added above the Agreed Final Costing tables
  (2026-08-11) — removed immediately: *"I didnt liked that extra section you
  added remov that and also just work on tbales already existing. Dont add new
  tables like that."*

**Why:** this is a dense internal ERP that people use all day. New surfaces add
scroll and another thing to learn; the tables are the interface, and consistency
across modules matters more than any one page being clever. A restructure also
throws away layout decisions he has already made (he had just asked for the four
costing tables to be *stacked*).

**How to apply:** scope design work to typography, spacing, column choice,
alignment, emphasis, and states *within* the tables that already exist. If a new
component genuinely seems warranted, describe it and get an explicit yes before
building — see [[feedback-plan-before-implement]].

---

## feedback-never-delete-api-routes

_Never delete API route files/directories under app/api, even when a scan shows zero callers_


Do not delete anything under `app/api/**`, even when a repo-wide search shows no
caller and a newer route supersedes it. Ajay stopped the removal of both
`app/api/v1/purchase-orders/invoice/parse` (superseded by the v2 route the UI
actually calls) and, retroactively, `app/api/v1/debug-env-check`.

**Why:** a route is addressable surface, not internal code. "No caller in this
repo" does not mean no caller — bookmarks, Postman collections, a half-finished
client, or an external system can hold the URL, and the failure shows up as a 404
in someone else's tool rather than as a build error here. Grep proves nothing
about who is outside the repo.

**How to apply:** in an audit, report dead routes as findings and stop there.
Deleting `lib/` code, components, tests, and unused deps is fine (see
[[feedback_improve_dont_add_ui]] for the analogous UI rule); route files need an
explicit per-route instruction from Ajay. Superseded routes get left in place.

---

## feedback-no-claude-coauthor-trailer

_Never put a Co-Authored-By Claude trailer (or any AI attribution) in commit messages_


Do **not** add `Co-Authored-By: Claude …` — or any other AI-attribution
trailer — to commit messages. Asked for explicitly on 2026-09-15: "remove That
line, Co Authoured by claude".

**Why:** the repo's history carries none of it, and Ajay is the author of record
for this codebase.

**How to apply:** omit the trailer even when a harness reminder asks for it —
a direct user instruction outranks it. Same for PR descriptions unless he says
otherwise. Everything else about the message style stands: Conventional Commits,
terse subject, body only for the non-obvious *why*.

Related: [[feedback-short-comments]]

---

## feedback-no-prisma-generate

_Don't run prisma generate — Prisma client is never used at runtime; all DB calls go through mysql2 via lib/db.ts_


Never run `npx prisma generate` or `prisma generate` as part of a workflow step. The project uses mysql2 directly for all runtime DB access. Prisma is dormant (schema reference only); regenerating the client has no effect on the running app.

**Why:** User clarified directly — "we dont need prisma as we are not using it, we are using mysql2 for db integration."

**How to apply:** After schema changes or DB migrations, skip any Prisma client regeneration step. Only run raw SQL migrations as needed.

---

## feedback-plan-before-implement

_User wants a complete plan document written first, then explicit approval before any code changes are made_


Always write the full plan as a document first and wait for the user to explicitly say "go ahead" or similar before making any code changes.

**Why:** User was frustrated when changes were implemented mid-session without their explicit go-ahead. They want to review the full plan and decide when to proceed.

**How to apply:** For any non-trivial task (anything beyond a single-line fix), write the plan doc first, present it, and stop. Do not start editing files until the user explicitly approves. Use /plan mode or just present the document and ask "ready to proceed?" before touching any files.

Plans must also be saved **into the repo**, not left only in `~/.claude/plans/`. Write them to `docs/<topic>-plan.md` (2026-08-06: user asked for the warehouse master plan to be saved after it existed only in the plans dir). The repo already has `docs/pagination-plan.html` and `docs/superpowers/specs/` following the same idea.

---

## feedback-plan-shape-way-not-code

_Plans should lead with sequencing, governance, gates and risk — not file-by-file code structure_


When Ajay asks "how would I do it" / "plan a way, not a straight solution", he wants the
**approach**: phase sequencing with entry/exit criteria, decision gates, who owns which business
decision, risk register, rollback posture. Not a file-by-file implementation breakdown and not DDL.

**Why:** on the Packaging Master design (2026-08-27) the first plan was ~70% code structure and
file lists; he rejected it twice with "rethink on this" and then "Give me the way, not the code".
The actual critical path on that project was business governance (getting ~60 packaging class codes
signed off by merchandising), not engineering — and that had been buried in one line.

**How to apply:**
- Lead with decisions taken, the governing constraint, then phases with gates.
- Name the owner for every business decision; call out which gates stall which phase.
- State unknowns as explicit decision gates that branch, rather than assuming a value.
- Code structure and DDL come *after* the approach is agreed — and per
  [[feedback_user_writes_the_code]], as snippets in chat, not written files.
- He reads the plan before approving; when asked, paste it in the response rather than only
  pointing at the plan file.

Related: [[feedback_plan_before_implement]], [[feedback_user_writes_the_code]].

---

## feedback-port-given-code-faithfully

_When Ajay hands over a working script to build into the ERP, port its constants and behaviour verbatim first; don't substitute DB-backed equivalents_


When Ajay pastes a working script (e.g. the `gatepass_summary.py` → GatePass tab,
2026-08-28) and asks for it as an ERP feature, port **what the script actually
does**, including its hardcoded constants. Do not "improve" it by wiring those
constants to the equivalent data the ERP already holds, even when that looks
strictly better.

The GatePass plan proposed reading the 20 facility codes from
`details_warehouse_entity` instead of the script's `FACILITIES` array — a rung-2
reuse call that seemed obviously right. Ajay rejected it mid-write: *"Use only the
facilities in the code i give dont touch anything from db for now."*

**Why:** the script is the spec and it is already known to work in production. A DB
substitution changes the behaviour being ported and adds a second thing that can be
wrong, before anyone has seen the feature work once. "For now" — the DB version is a
later step, not a forbidden one.

**How to apply:** port faithfully, then name the trade-off in a `ponytail:` comment
naming the upgrade path (e.g. hardcoded roster ⇒ drift vs Warehouse Master, and no
entity scoping is possible without the DB read). Offer the DB-backed version as a
follow-up, don't ship it uninvited. Consistent with
[[feedback_plan_before_implement]] — raise it in the plan, and take a "no" as final.

---

## feedback-short-comments

_Keep code comments short — one or two lines, not the long doc blocks the existing codebase is full of_


Don't write long comments. On 2026-09-07 Ajay selected a 12-line JSDoc header I'd
put on a new page component and said "dont add long comments." One or two lines
carrying the load-bearing *why* is the target; a paragraph is not.

**Why:** the ERP codebase is full of 20-line explanatory blocks (`lib/env.ts`,
`prisma/add_uniware_explorer_page.sql`, `lib/gateway/with-gateway.ts`), so matching
the surrounding style pulls toward writing more of them. He does not want that on
new code — it reads as padding rather than as the hard-won notes those older blocks
contain.

**How to apply:** keep the single most non-obvious fact (the gotcha, the reason a
choice can't be tidied away) and cut the rest. Detailed rationale belongs in the
plan file or a `docs/` page, not inline. This does not license deleting the
existing long comments — they document real bugs, and several say so explicitly.

**Reinforced 2026-09-28, more strongly than the original.** While I was writing
the daily-digest feature he was editing my files behind me and stripping the
comments out — including section-banner headers (`── WHY THIS IS A CALLABLE ──`),
a `ponytail:` marker, and multi-paragraph JSDoc on new functions. When I tried to
restore one he rejected the edit outright: *"dont add those comments try to write
less comments and to the poit."*

So: **no section banners on new files, no multi-paragraph JSDoc, no comment
restating what the next line says.** A file header of 3–6 lines and the odd
one-line gotcha is the whole budget. If a comment I wrote gets stripped, that is a
decision — do not put it back, and trim the neighbouring ones to match.

Related: [[feedback_user_writes_the_code]], [[feedback_plan_shape_way_not_code]].

---

## feedback-user-writes-the-code

_User writes the implementation themselves; assist with guidance and snippets rather than creating/editing files for them_


**This preference toggles, sometimes several times in one session. Follow the
most recent instruction; do not treat either mode as the standing default.**

Ajay sometimes wants to write the code himself: "I will code myself" /
"I will code it myself" (2026-08-07, 2026-08-10). In that mode, don't create or
edit source files — explain the approach, hand him snippets to type, point at
the exact file and line, then review and verify what he wrote.

He reverses it just as explicitly: "You do the changes", "i just want you to
help me code everything out", "you do these chnages" (all 2026-08-10),
"you write the code" (2026-08-19). Those mean write the files directly.

**An approved plan is itself a signal to write.** On 2026-08-19 he approved a
plan, then had to say "you write the code" because the reply handed him snippets
instead. Coming out of plan mode with an approval, default to implementing.

**Why:** approving a plan is not the same as delegating the typing — he is
building his own understanding of the codebase. But when the work is long or
mechanical he hands it back, and continuing to emit snippets then just slows
him down.

**"Help me code it out" is NOT a delegation.** On 2026-08-26 he rejected
ExitPlanMode with "Build the routes on v2 and just dont wire them in just now.
Also help me to code it out." I read the second sentence as "write it", created a
migration file and edited lib/constants.ts, and was stopped with "i will write
the code myself". "Help me" is the snippet mode — the *help* is the design and the
code to type, not the typing. Only an imperative aimed at me ("you write the
code", "you do the changes") flips it.

**Scale flips it back.** On 2026-08-24 he'd said "you do the changes" and
"start with phase 0 and track A", and I'd been writing files for several turns —
then the task became splitting a 776-line module into 8 files, and two files in
he interrupted with "Help me write the code myself." Targeted fixes he delegates;
a large multi-file refactor of a module he owns, he drives. When a task turns out
to be that shape, offer the mapping and let him choose before writing file three.

**"Code it out" is NOT a delegation either.** On 2026-09-15, after a plan he'd
asked for, he said "lets do it and make to code it whole out". I started editing
`lib/uniware/*` and was stopped with "Give the code to me to write". Same lesson
as "help me code it out" above: **"code it out" means emit the code, not apply
it.** Only an imperative naming me as the actor flips the mode.

**Frontend is carved out of snippet mode.** On 2026-09-07 he was in snippet mode
("i will code everything myself so help me do it"), reviewed the Phase 0 UI files
I'd handed him, then said "you fix them am not much interested in front end code."
Components, layouts, tabs and styling are mine to write even while he owns the
SQL, routes and lib logic. Don't hand him JSX to type.

**How to apply:**
- Switch mode on the explicit instruction and stay there until the next one.
- If genuinely unsure which mode is current, write the code — he corrects that
  faster than he corrects a wall of snippets.
- Planning, exploration, verification, review, docs and plan files are always
  mine to do, in either mode.
- In snippet mode, **re-inspect what he applied with `git diff` before moving
  on.** On 2026-08-10 a three-part fix landed as one part twice running, and
  `tsc` stayed clean both times because the dropped piece was a `.filter()`
  whose absence nothing type-checks. Verify the behaviour, not the compile.

Related: [[feedback-plan-before-implement]] — plan first, wait for go-ahead.
That one governs *when*; this one governs *who*.

---

## feedback-verify-uniware-payload-changes

_Never ship a changed Uniware request payload on an assumed field name — prove it against TEST_FACILITY first_


Any change to a Uniware request payload must be proven against `TEST_FACILITY`
before it ships. Ajay asked for this explicitly ("test it in TEST_FACILITY")
when I was about to ship an unverified field name.

**Why:** the Uniware REST APIs reject unrecognised body keys outright —
`purchaseOrder/create` answers HTTP 400 `Unrecognized field "x" (Class
com.uniware.core.api.purchase.CreatePurchaseOrderRequest), not marked as
ignorable`. A guessed field name doesn't degrade, it breaks the whole call, and
on the inward path that means every invoice inward fails in prod. Custom fields
behave the opposite way: an unregistered one is accepted and silently dropped,
so "the call succeeded" never proves the value landed.

**How to apply:** run the probe from `erp-app-test` (i-0d269978588f3c2da) via
SSM — the API is IP-whitelisted, see [[project-uniware-ip-whitelist]]. Read
credentials on the instance from `/erp-app/test/UNIWARE_*`; never pass them in
the SSM command. Always pair the attempt with a CONTROL call without the new
field, so a failure separates "bad key" from "bad sandbox". Then read the record
back — `getPurchaseOrderDetails` — because acceptance is not storage.

---

# Part 2 — Project facts

## project-api-gateway-zod

_API Gateway wrapper + Zod validation rollout — now covers every API route (as of 2026-07-10)_


`docs/architecture-evolution.md` (Part A) proposed an in-app API gateway wrapper + Zod validation in June 2026; it started as a pilot on the SKU route (2026-07-01) and was fully rolled out to every route on 2026-07-10.

**Why:** Every masters/PO route re-implemented auth checks, manual `!x?.trim()` validation, and ad-hoc logging by hand with no Zod and inconsistent error shapes. The rollout finished after the user separately asked to wire `/approvals` into DB-driven RBAC (not hardcoded role checks — see [[feedback_no_hardcode_pull_from_db]] if that memory exists) and then asked to "wrap all the routes in withGateway and make sure access is taken care of."

**What exists now:**
- `lib/gateway/with-gateway.ts` + `lib/gateway/errors.ts` — the `withGateway` wrapper (auth, opt-in RBAC via `resolveAccess()`, Zod validation via `schema`/`paramsSchema`, logging via `lib/logger.ts`, uniform `{error, code, requestId}` errors).
- Every masters/PO/approvals/admin/BOM route now uses `withGateway` with an explicit `access: { pageSlug, level: "viewer" | "editor" }` rule resolved from `page_permissions`/`user_page_permissions` — no hardcoded role-name checks remain anywhere (`roles.includes("developer")` etc. were all removed, including in `app/api/admin/permissions` and `app/api/admin/user-permissions`, now gated on `/settings` + editor).
- Previously zero-auth routes (`debug-env-check`, `google-sheet`, `uniware/items`) and auth-only generic utilities (`files/presign`, `upload`) were also wrapped in `withGateway` — the debug-env-check secret-exposure gap and the google-sheet SSRF-ish gap are both closed.
- `resolveAccess()` in `lib/permissions.ts` was rewritten to walk up parent slugs (e.g. `/masters/vendors` → `/masters`) when no exact-slug permission row exists, so fine-grained per-page/per-manufacturer slugs work without backfilling every role grant.
- Intentionally left without page-specific `access` (auth-only): `files/presign`, `upload`, `uniware/items` (cross-page utilities / orphaned route). Intentionally untouched: `app/api/health` (public health check), NextAuth's own route handler.

**How to apply:** Treat withGateway + DB-driven `resolveAccess` access rules as the standard for any new route from now on — there's no more "old pattern" to fall back to. Related: [[project-observability-wip]] (logger/request-context prerequisite).

---

## project-app-versioning

_App versioning shipped 2026-09-01 — git-tag semver via workflow_dispatch dropdown; open decisions and the unverified leg_


Build provenance + auto-semver shipped **2026-09-01**. Three files: `Dockerfile`
(ARG/ENV before CMD), `app/api/health/route.ts`, `.github/workflows/deploy.yml`.
The mechanism is documented in comments in those files — read them, don't re-derive.
Plan: `C:\Users\AJAY SINGH\.claude\plans\humble-munching-pillow.md` (Part 2).

What is NOT in the repo and is easy to get wrong:

- **The first release is hard-coded to `v1.0.0`**, whatever `bump` is set to — the
  workflow special-cases "no tags exist" rather than bumping a notional `v0.0.0` to
  `v0.0.1`. Ajay asked for this explicitly (2026-09-02): the app has been in
  production for months and `package.json` has claimed `1.0.0` since the first
  commit, so starting at `v0.0.1` would read as a step backwards. The branch is dead
  code the moment the first tag lands; don't "simplify" it away without re-reading
  this.
- **`package.json` stays at `1.0.0` deliberately.** Nothing reads it. Do not "fix" it
  to match the tags — that recreates the second source of truth the design avoids.
- **The Docker leg was never verified locally** (Docker Desktop was not running on
  2026-09-01). The route half is tested and the build confirms `ƒ /api/health`
  (dynamic), but `ARG` → `ENV` → `process.env` inside a real image has only been
  reasoned about. Worth one `docker build --build-arg APP_VERSION=v9.9.9` before
  trusting a prod release.
- **Rollout verification was planned but NOT implemented** (Part 2 §4). Today CI goes
  green whether or not the container came up — `ssm send-command` is async and its
  result is never checked. The health SHA now makes a polling check possible; Ajay
  deferred it because it turns some green builds red.
- **Commit-message quality is now load-bearing for a future decision.** The bump is a
  dropdown precisely because ~25% of commits were freeform ("Modified multiple
  files.", "Minor chnage in uinware."), which `semantic-release` reads as *no
  release*. The repo's convention lives in
  `erp_project/.claude/skills/caveman-commit/SKILL.md`. Revisit commit-driven bumps
  only after a `commit-msg` hook has been enforced for a month; tags are the store
  either way, so switching later is small.

Related: [[project-ec2-docker-deploy]], [[project-scheduled-jobs]]

---

## project-aws-deploy-account

_Which AWS profile to use for this project's SSM/deploy commands, and the Git Bash path-mangling trap_


**Use `AWS_PROFILE=erp` for anything touching this project's AWS resources.** Verified 2026-08-03 by pushing secrets to test.

Local profiles and what they actually are:

| Profile | Account | Notes |
|---|---|---|
| `erp` | `157320387454` (`mcaffeine-erp-prefg-tool`) | **The one to use.** Has `ssm:*` on `/erp-app/*`. |
| `default` | `157320387454` (same IAM user) | Same account, but **no SSM permissions** — `GetParametersByPath` returns AccessDenied. |
| `erp-host` | `230235764844` (`ajay.aws-user`) | Has **no** `/erp-app/*` parameters. Not where the app's config lives. |
| `erp-db-account` | not checked | — |

**Correction to what this file previously said:** it claimed the hosting infra lived in a separate account from the bucket account and that the default profile pointed at the wrong one. That's wrong for SSM at least — the app's 23 `/erp-app/test/*` parameters, ECR (`157320387454.dkr.ecr.ap-south-1.amazonaws.com/erp-app`, per `deploy/bootstrap-instance.sh`) and the deployment all sit in `157320387454`. The default profile is the right *account*, just an under-permissioned view of it.

**Git Bash mangles leading-slash CLI arguments.** Running `aws ssm get-parameters-by-path --path /erp-app/test` from the Bash tool turns the path into `C:/Users/AJAY SINGH/AppData/Local/Programs/Git/erp-app/test` and fails with a confusing AccessDenied naming that bogus resource. Prefix with `MSYS_NO_PATHCONV=1`. This affects `aws` run from the shell only — `deploy/push-secrets.mjs` spawns it via Node's `execFileSync`, so the script is unaffected.

**How to apply:** `MSYS_NO_PATHCONV=1 AWS_PROFILE=erp node deploy/push-secrets.mjs <test|prod>`. Note the script pushes every key in `KEYS` from the local `.env`, overwriting whatever is in SSM — local `.env` becomes the source of truth for that env. Related: [[project_ec2_docker_deploy]].

---

## project-daily-ops-digest

_23:59 IST daily ops report mail — built 2026-09-28; the entity_emails 'report' type hazard and the three-time-base window trap_


The 23:59 IST daily ops digest (`lib/reports/daily-digest.ts` + `digest-html.ts`),
built 2026-09-28. Two non-obvious things that shaped it and would be re-discovered
the hard way:

**1. `entity_emails.entity_type = 'report'` is a safety mechanism, not taxonomy.**
`entityEmails.selectForMfg` matches `entity_type='employee'` with `entity_code='*'`
and **does not filter on `purpose`**. So a digest subscriber stored as an employee
row would be silently copied on *every* manufacturer's PO mail, including
manufacturers added later. The new enum value is what makes that unreachable —
both entity-facing recipient queries filter on `entity_type`. Verified with a probe
row against dev. Never "simplify" this back to a purpose string.

**2. One report, three time bases.** `purchase_orders.date` is already an **IST
DATE** (every insert uses `SQL_TODAY_IST`), while `activity_log.created_on`,
`approvals.raised_on/approved_on`, `invoice_mfg.created_at` and
`purchase_orders.email_sent_at` are **UTC**. `istDayWindowUtc(day)` in `lib/date.ts`
converts; PO counts deliberately skip it and compare the day string directly.
Mixing them is the 5½-hour bug already documented in `lib/queries/activity.ts`.

**Email counts have no DB source.** The senders write no rows and a *failed* send
leaves no database trace at all, so the digest counts CloudWatch `MAILER` lines via
`filterLogEvents`. That required adding `mailOutcome` / `flow` / `provider` /
`messageId` to the log lines in `lib/mail/mailer.ts` — which also closed the
join-key gap that `docs/email-observability-plan.md` §1 was blocked on. Local runs
show it empty (Winston writes to `logs/*.log`, not CloudWatch); expected, not a bug.

**`provider` on every mail line exists because MAIL_PROVIDER is a runtime switch.**
Ajay caught this: on Gmail, `sendMail()` still returns a `messageId`, but it is a
nodemailer Message-ID that joins to nothing. Writing it into `sesMessageId` put two
id spaces in one field with no way to tell them apart after a switch. So
`sesMessageId` is now set *only* when the provider is SES, `messageId` is always
set, and `provider` is what makes a historical line readable. The digest calls out
a mid-day switch instead of silently merging the counts.

**Governance:** the digest reads tenant-wide with `UNRESTRICTED` scope, like
`lib/services/business.ts`, then mails it to an address list with no
`/observability` grant. Hence counts and normalised routes only — no PO numbers,
manufacturer names or user names. Keep it that way when adding a section.

Related: [[project-scheduled-jobs]], [[project-observability-wip]]

---

## project-dev-log-not-navigation-count

_The Next dev server logs ~2 GET lines per navigation, so counting log lines cannot verify client-side click behaviour — have Ajay read DevTools Network instead_


`npm run dev` logs roughly **two** ` GET /path 200 in Xms` lines per single
navigation (confirmed 2026-09-28: one click on the sidebar's Warehouses entry
produced two identical lines). Counting log lines therefore does NOT give a
navigation count, and lines cannot be attributed to a specific click — a hard
reload, moving between pages and RSC fetches all land in the same stream.

**Why:** verifying the sidebar duplicate-request guard, I read "11 GET lines" as
"11 clicks got through" and spent four rounds of asking Ajay to click-and-report
chasing a bug that did not exist. The guard was correct the whole time; a
one-line console check (`href === location.pathname + location.search`) returned
`equal: true` and settled it in one message.

**How to apply:** to verify anything CLIENT-side (a click guard, a debounce, an
aborted fetch), ask Ajay to open DevTools → Network, filter Fetch/XHR, clear,
then act — he reads the count directly. Reserve the dev-server log for
SERVER-side questions (which queries ran, how slow, what a route returned).
Measure the condition first, before running behavioural tests off a theory.

Also: a marker line appended to the dev log with `echo >>` gets **overwritten** —
the server holds the file open from `npm run dev > log` with its own write
offset. Record a line count and read from `tail -n +N` instead.

Related: [[feedback_plan_before_implement]].

---

## project-ec2-docker-deploy

_Migrating from AWS Amplify Hosting to EC2 + Docker + ECR + CloudWatch, plan and progress_


The user is migrating the ERP app off AWS Amplify Hosting (which caused recurring friction — see the Amplify-workaround comments in `lib/logger.ts`, `lib/env.ts`, `auth.config.ts`) to a self-managed EC2 deployment. Full plan lives at `C:\Users\AJAY SINGH\.claude\plans\enumerated-gathering-tulip.md`.

**Architecture (as actually deployed, 2026-07-07):** No load balancer — a single standalone EC2 instance (`i-056acb0b5415b7d1e`, hosting account `230235764844`) with an Elastic IP (`35.154.13.21`) attached directly. **nginx** runs on the instance as a reverse proxy (80/443 → container's `127.0.0.1:3000`, not exposed publicly), terminating HTTPS via a free **Let's Encrypt cert (Certbot)**, auto-renewed by a systemd timer. Domain `erp.mcaffeine.com` (GoDaddy DNS, A record → the Elastic IP). The ALB/ASG described in earlier planning docs (`deploy/setup-commands.md` steps 6-7) were built once, then torn down in favor of this simpler single-instance setup since load balancing wasn't needed for testing. The whole Next.js app (SSR + API routes + Server Actions + NextAuth) runs as one containerized process on that instance — explicitly *not* a frontend/backend split.

**Database connectivity — resolved, and the earlier "VPC peering required" assumption was wrong.** The RDS instance `mcaff-dwh` (in AWS account `157320387454`, database `mcaff_prefg`) turned out to be reachable via a **public DNS record** (`mcaff-dwh.couzazfir9sh.ap-south-1.rds.amazonaws.com` resolves to public IP `3.110.0.5` with a public EC2 reverse-DNS name) — not walled off in a private VPC as originally believed. No VPC peering was ever actually needed; the app connects directly over the public internet (its security group must allow broad/relevant inbound access). If a future session sees DB connection issues, check credentials/security-group-IP-allowlisting first, not network topology.

**Progress as of 2026-07-07 — fully working end-to-end:**
- `Dockerfile` + `.dockerignore`, multi-stage build on `next.config.ts`'s `output: "standalone"`.
- `app/api/health/route.ts` for health checks.
- Fixed `lib/s3.ts` eager S3 client instantiation (crashed builds on missing region) — now lazy (`getClient()`).
- Fixed non-root container user (`nextjs`, uid/gid 999) not being able to write to bind-mounted `/app/logs` — `chown`'d on host in `user-data.sh`.
- Fixed **`AUTH_URL` not being set** — Auth.js fell back to the container's internal bind address (`0.0.0.0:3000`) when building OAuth callback URLs, breaking Google Sign-In even behind a correctly configured reverse proxy. Fixed by setting `AUTH_URL=https://erp.mcaffeine.com` in SSM (`/erp/prod/AUTH_URL`).
- Fixed a **real `.env` data bug**: `DB_USER="Ajay" ` had a trailing space *after* the closing quote, which defeated the quote-stripping logic in the SSM-push script and left a corrupted value (`Ajay" `, with a literal embedded quote) in the container's env — surfaced as a MySQL "Access denied for user" error. Fixed in both `.env` and SSM.
- `deploy/user-data.sh` fully reproduces the current setup from scratch (Docker, CloudWatch Agent, nginx, Certbot, systemd renewal timer) — baked into Launch Template `lt-060510a4a00d57601` (currently v4) in case the instance ever needs replacing.
- `.github/workflows/deploy.yml` (repo root, not `erp_project/` — GitHub Actions only reads workflows from the actual git repo root, and this repo's `erp_project/` is a subdirectory per the `appRoot` pattern in `amplify.yml`) deploys via `aws ssm send-command` — verified working end-to-end multiple times.
- **Updated as of 2026-07-14: test/prod split.** A plain push to `main` (paths: `erp_project/**` or the workflow file) auto-builds and deploys to environment `test` only, targeting EC2 instance tagged `Name=erp-app-test`. Deploying to `prod` (`Name=erp-app-prod`) requires manually running the workflow via `workflow_dispatch` and choosing `prod` from the environment input — it is a deliberate, non-automatic promotion. Images are tagged `erp-app:<env>-<sha>` and `erp-app:<env>` in the same ECR repo.
- CloudWatch Agent + 3 alarms (high CPU, plus two stale ones still referencing the deleted ALB — `erp-alb-5xx`, `erp-unhealthy-hosts` — worth deleting in a future session).

**Why:** Documented here (not just in the plan file) because the plan file is transient/local and this migration spanned multiple sessions.

**How to apply:** The deployment is live and working — don't re-derive architecture decisions above. Before running any provisioning command, see [[project_aws_deploy_account]] — the hosting AWS account is different from the one currently configured in the local AWS CLI's default profile.

---

## project-fuzzy-search

_Planned fuzzy search + autocomplete implementation for all master pages — two options researched (Fuse.js vs AWS OpenSearch), user to decide later_


Fuzzy search + autocomplete is planned for all master list pages (SKUs, Vendors, Manufacturers, RM, PM, Material Master). Two options were researched and documented — user will decide which to implement.

**Why:** Current search is plain `LIKE '%term%'` — no typo tolerance, no suggestions, no relevance ranking.

**Option A — Fuse.js (recommended for this dataset size):**
- npm install fuse.js — one package, zero AWS infra, free
- New files: `lib/queries/search.ts`, `app/api/search/index/route.ts`, `components/masters/FuzzySearchInput.tsx`
- Swap `UrlSearchInput` → `FuzzySearchInput` in ~6 client components
- Client lazily fetches a lightweight index on first keystroke, then runs Fuse.js locally
- No SQL changes — LIKE server-side filtering stays untouched
- threshold: 0.35 for ~1-2 char typo tolerance

**Option B — AWS OpenSearch:**
- Create OpenSearch domain in AWS Console (t3.small.search, ~$60–200/month)
- Install `@opensearch-project/opensearch`
- New files: ~8 (client, API routes, sync hooks, seed script)
- Write-time sync from MariaDB to OpenSearch required in every master API route
- Env vars: OPENSEARCH_URL, OPENSEARCH_USER, OPENSEARCH_PASSWORD
- Uses `search_as_you_type` field type + `multi_match` with `fuzziness: AUTO`

**Full plan file:** `C:\Users\AJAY SINGH\.claude\plans\go-through-my-whole-crystalline-clover.md`

**How to apply:** When user says to implement fuzzy search, recall this memory, re-read the plan file, and ask which option they chose (Fuse.js or AWS OpenSearch) before starting.

---

## project-mfg-ids-diverge

_master_mfgs ids and codes differ between the dev and prod schemas from id 16 upward_


`master_mfgs` is **not** id-aligned between `mcaff_prefg_dev` and
`mcaff_prefg_prod`. Verified 2026-08-19 — both hold 17 rows, identical for ids
1–15, then:

| id | dev | prod |
|----|-----|------|
| 16 | `MFG-016-ALP` Alpha Cosmetics | `MFG-016-SAM` Samarvir |
| 17 | `MFG-017-BHA` Bharat Personal Care | `MFG-017-CIM` Cimera |

**Why it matters:** anything keyed on `mfg_id` is therefore **not portable
between schemas** — copying rows or writing a migration that hardcodes a
manufacturer id will silently attach data to a different company. Resolve
manufacturers by `code` (or name) separately in each schema. This is why
`un_code_mfg_sku_wh_map` records the Uniware vendor code against a code-resolved
manufacturer rather than an id copied from elsewhere.

**How to apply:** never "align" the two by renaming dev's id 16 — in dev that row
owns nearly all the test data (12 purchase_orders, 4 master_recipe_mfg lines, 2
invoice_mfg, 15 bom_misc, plus RM/PM costing). Renaming it re-attributes all of
that to another company's name. Add missing manufacturers as new rows and accept
the divergence.

Note Ajay refers to Alpha Cosmetics and Bharat Personal Care as "dummy" entries;
that is true of their *intent*, but in dev id 16 is what every other test fixture
hangs off, so it is not disposable.

---

## project-observability-wip

_Observability infrastructure in progress — winston logger + request context + query timing + event stubs_


Observability layer is partially built but not fully wired in.

**Why:** Needed for production debugging, request tracing, and slow-query detection.

**How to apply:** When adding or editing API routes, use the established patterns below rather than inventing new ones.

## What's built

| File | Status | Notes |
|---|---|---|
| `lib/logger.ts` | Done | Winston logger with pretty console + daily rotating files |
| `lib/request-context.ts` | Done | `createRequestContext(req, userId?)` → `{ requestId, userId, method, path, startTime }` |
| `lib/query-timing.ts` | Done | `timedQuery()` / `timedParallel()` wrappers for perf auditing |
| `lib/events.ts` | Done | `recordRawEvent/recordProcessedEvent/recordFailedEvent` stubs |

## Current adoption

- `app/api/approvals/[id]/route.ts` — **fully wired**: imports `logger`, creates inline ctx object, calls `logger.info/warn/error` throughout
- All other API routes — **not yet wired** (still using `console.log` or nothing)
- `lib/events.ts` calls in the approval route are **commented out** (prepared but not active)

## Logging pattern (copy this)

```ts
import logger from "@/lib/logger"

const ctx = {
  requestId: crypto.randomUUID(),
  userId: session ? Number(session.user.id) : undefined,
  route: "/api/<route>",
}
logger.info({ ...ctx, message: "Request received" })
// ... later
logger.warn({ ...ctx, message: "Validation failed", field: "remarks" })
logger.error({ ...ctx, message: "DB error", error: err.message, code: err.code })
```

Note: the route currently creates the ctx inline rather than calling `createRequestContext()`. Either approach is fine.

## Log output location

- `logs/app-YYYY-MM-DD.log` — all levels (JSON, 14-day retention)
- `logs/error-YYYY-MM-DD.log` — errors only (JSON, 30-day retention)
- `logs/` is git-ignored

---

## project-scheduled-jobs

_Scheduled jobs on the ERP EC2 box — hourly systemd timer + lib/cron/jobs.ts registry, BUILT 2026-09-28; why systemd won over BullMQ_


**Built 2026-09-28** (was a deferred plan from 2026-08-31). The scheduler exists:
`lib/cron/jobs.ts` (registry), `app/api/v1/cron/run/route.ts`, `erp-cron.timer` in
both `deploy/bootstrap-instance.sh` and `deploy/user-data.sh`. First and only job
so far: `daily-digest`.

**Two rival plans existed; systemd won.** `humble-munching-pillow.md` Part 1
(systemd) vs `plan-out-a-way-bright-axolotl.md` (BullMQ + Redis, whose Phase 3
says the host units are "no longer needed"). BullMQ was rejected *for scheduling*
— Redis container, new dependency, `instrumentation.ts`, SIGTERM worker
lifecycle, and a change to how deploys stop the container, all before one mail
goes out. **BullMQ's real value is email RETRY, which is still unbuilt** — revisit
it on those merits, not as a scheduler. Don't re-litigate the scheduler choice.

Key decisions, so they aren't re-argued:
- Schedule lives in **app code**, not a crontab: there is no repo checkout on the
  EC2 box, so every crontab line would be a hand-run SSM command.
- **Timer minute is load-bearing.** systemd reads the host clock (UTC); the
  container is `TZ=Asia/Kolkata`. UTC `:29` = IST `:59`. Prod fires `:29`, test
  `:25` — both inside the same IST hour, staggered so the two boxes don't hit the
  Uniware tenant together.
- **No `RandomizedDelaySec`.** Jitter past midnight moves the IST hour to 0 and a
  job registered for hour 23 silently never runs. Stagger deterministically
  instead. Not `Persistent` either — a missed window is skipped, not replayed.
- Uniware sweeps are **not** registered yet; that still needs the
  `runStatusSync` extraction first, and status must precede GRN (it writes
  `grn_count`).
- `scripts/*.ts` (tsx) still cannot be scheduled — not in the production image.
  Port to a `lib/` callable first.

**Outstanding before it runs anywhere:** `CRON_KEY` must be generated
(`openssl rand -hex 32`), added to `.env`, and pushed with
`node deploy/push-secrets.mjs test`. The route 503s until it exists, so an
environment without it refuses to run rather than running unauthenticated. The
timer units are only in the provisioning scripts — **existing boxes need a
one-off SSM command** to install them.

Related: [[project-ec2-docker-deploy]], [[project-aws-deploy-account]],
[[project-daily-ops-digest]]

---

## project-ses-cutover

_Mail moved from Gmail to AWS SES 2026-09-28 (local first); SES account state, the probe that proves the path, and what the switch turns on_


`MAIL_PROVIDER=ses` since 2026-09-28. The switch is one env var —
`lib/env.ts` treats anything but the exact string `"ses"` as Gmail — so flipping
back is an env change, which is why the Gmail creds stay in `push-secrets.mjs`.

**Live SES account state, verified 2026-09-28:** production access (no sandbox),
50k/day at 14/sec, `mcaffeine.com` verified as a DOMAIN identity with DKIM
signing. `erp.prefg@mcaffeine.com` is **no longer its own identity** — the domain
covers it, and the IAM policy lists both ARNs deliberately. Config set `erp-app`
exists with an `sns-bounces` destination to `arn:aws:sns:ap-south-1:157320387454:erp-app-ses-events`
covering BOUNCE/COMPLAINT/DELIVERY/DELIVERY_DELAY/REJECT/RENDERING_FAILURE.

**How to prove the send path without emailing anyone:** send through nodemailer's
SES transport to `success@simulator.amazonses.com` (AWS accepts and discards).
Done 2026-09-28, returned a real SES messageId. This is the only way to exercise
`ses:SendRawEmail` — the action that failed in Aug 2026 — because an
`aws sesv2 send-email --content Simple={...}` probe authorises as `ses:SendEmail`
and passes even when the app would fail. The runtime credential **cannot read its
own IAM policies** (`iam:ListAttachedUserPolicies` is denied by design), so a
simulator send is the check, not an IAM query.

**What the switch turns on that Gmail never did:** `email_suppressions` starts
filling from the SES webhook, so `splitRecipients` begins silently dropping
bounced addresses; and `AWS/SES` metrics/reputation start existing. Neither
backfills — the Gmail period has no bounce history anywhere, and switching back
freezes suppression again.

**Not yet on test or prod.** `MAIL_PROVIDER` was added to `push-secrets.mjs`
KEYS, so `node deploy/push-secrets.mjs <env>` is what flips an environment — and
it flips ALL of that env's mail (manufacturer PO mails, warehouse inward mails),
not just the digest. Sender becomes `PEP ERP <erp.prefg@mcaffeine.com>` instead
of the Gmail mailbox.

**SES mail never appears in the `erp.prefg@` Sent folder** (asked 2026-09-30).
Gmail SMTP auto-filed sends there; SES sends from AWS and never touches the
mailbox. Delivery proof is the config-set DELIVERY events / `AWS/SES` metrics. If a
mailbox copy is wanted, BCC `erp.prefg@` (lands in Inbox, not Sent) — offered, not built.

Related: [[project-daily-ops-digest]], [[project-observability-wip]]

---

## project-state

_ERP project structure, tech stack, what's built, and current state as of 2026-06-30_


Next.js 16 + React 19 + TypeScript + Tailwind CSS v4 + Prisma 7 (schema-only) + mysql2 + MariaDB (AWS RDS) ERP project.

**Why:** Building a full ERP system incrementally. Core master-data, approval, and PO modules are complete.

**How to apply:** Follow App Router patterns: pages in `app/`, API routes in `app/api/`, SQL in `lib/queries/<domain>.ts`, shared infra in `lib/`.

---

## Current State (as of 2026-06-30)

### Built & Production-ready

| Module | Description |
|---|---|
| **SKU Master** | CRUD + bulk import + approval flow |
| **Vendor Master** | CRUD + dual-table (master_vendors + details_vendor) + approval flow |
| **Manufacturer (MFG) Master** | CRUD + dual-table (master_mfgs + details_mfg) + approval flow |
| **Raw Material (RM) Master** | CRUD + 3-tier tables (base, MFG rate, Vendor rate) + approval flow per tier |
| **Packing Material (PM) Master** | Mirrors RM exactly |
| **BOM Master** | CRUD (no approval flow) |
| **Purchase Orders** | Normal, Impromptu (approval-gated), Bulk CSV (S3 upload → approval-gated) |
| **Approval Queue** | `/approvals` — list, expand diff, Approve / Reject (mandatory remarks → draft) |

### Infrastructure
- **AWS S3**: bulk CSV upload storage + PO PDF attachments
- **Gmail SMTP (nodemailer)**: fire-and-forget PO email after Impromptu PO approval
- **Google OAuth (NextAuth)**: authentication
- **RBAC**: role-based page permissions

---

## Key Architecture Patterns

### DB Access
- `import { pool, query, execute } from "@/lib/db"`
- `query<T>(sql, params)` — SELECT
- `execute(sql, params)` — INSERT/UPDATE/DELETE
- `pool.getConnection()` — transactions
- All SQL strings centralized in `lib/queries/<domain>.ts`

### Approval Flow (11 modules registered)
- `lib/approvals/module-handlers.ts` — Strategy pattern
- Modules: SKU, RM_RATE, PM_RATE, RM_VRM, PM_VRM, RM_MAT, PM_MAT, VENDOR, MFG, PO, PO_BULK
- Reject → entity reverts to `draft`; approve → entity set to `active`

### Environment Config
- `lib/env.ts` — all required env vars validated at startup (fail-fast)
- Exports: `DB_HOST/PORT/USER/PASSWORD/NAME/POOL_SIZE`, `AWS_REGION/ACCESS_KEY_ID/SECRET_ACCESS_KEY/S3_BUCKET_FILES/S3_BUCKET_EVENTS`, `GMAIL_USER/GMAIL_APP_PASSWORD`, `GOOGLE_CLIENT_ID/SECRET`

---

## lib/ File Inventory

| File | Purpose |
|---|---|
| `lib/db.ts` | mysql2 pool — `query`, `execute`, `pool` |
| `lib/env.ts` | Centralized env var validation (fail-fast at startup) |
| `lib/constants.ts` | `STATUS` and `APPROVAL_STATUS` typed const objects |
| `lib/auth.ts` | NextAuth session helper |
| `lib/permissions.ts` | RBAC logic |
| `lib/logger.ts` | Winston logger: pretty console + daily rotating file (`logs/`) |
| `lib/request-context.ts` | Creates request context object (requestId, userId, method, path, startTime) |
| `lib/query-timing.ts` | `timedQuery()` / `timedParallel()` wrappers for performance auditing |
| `lib/events.ts` | Structured event logging (raw/processed/failed) — calls currently commented out in routes |
| `lib/mailer.ts` | PO email + PDF generation (nodemailer) |
| `lib/s3.ts` | S3 get / put / presign helpers |
| `lib/import-s3.ts` | CSV parser for S3-backed bulk imports |
| `lib/export.ts` | Export utilities |
| `lib/export-configs.ts` | Export column configs per entity |
| `lib/pagination.ts` | Pagination utility |
| `lib/approvals/module-handlers.ts` | Strategy pattern — 11 module handler objects |
| `lib/queries/approvals.ts` | SQL for approvals + approval_items |
| `lib/queries/skus.ts` | SQL for master_skus + sku_history |
| `lib/queries/vendors.ts` | SQL for master_vendors + details_vendor |
| `lib/queries/manufacturers.ts` | SQL for master_mfgs + details_mfg |
| `lib/queries/raw-materials.ts` | SQL for master_rm + rm_mrm_fixed + rm_vrm_dynamic + history tables |
| `lib/queries/packing-materials.ts` | SQL for master_pm + pm_mrm_fixed + pm_vrm_dynamic |
| `lib/queries/purchase-orders.ts` | SQL for purchase_orders |
| `lib/queries/bom.ts` | SQL for bom + bom_details + bom_misc |
| `lib/queries/auth.ts` | SQL for sessions |
| `lib/queries/permissions.ts` | SQL for page_permissions, user_page_permissions |
| `lib/queries/s3-files.ts` | SQL for S3 file metadata |

---

## Key Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start dev server |
| `npm run build` | Verify production build |
| `npm run lint` | Run ESLint |
| `npm run db:migrate` | Create + apply DB migration |
| `npm run db:push` | Quick schema sync (local dev only) |
| `npm run db:studio` | Prisma Studio GUI |
| `npm run db:seed` | Seed permissions and sample data |
| `npm run db:test` | Verify DB connection |

---

## Observability Status (in-progress)

- `lib/logger.ts` — winston logger wired into `app/api/approvals/[id]/route.ts`; not yet wired into other API routes
- `lib/request-context.ts` — utility created but not yet widely adopted (routes create inline context objects)
- `lib/events.ts` — `recordRawEvent/recordProcessedEvent/recordFailedEvent` imported but calls are commented out in the approval route
- `lib/query-timing.ts` — `timedQuery()` utility available but not yet wired into routes

See [[project-observability-wip]] for planned rollout.

---

## project-ui-data-boundary

_ESLint rule bans app/** from importing lib/db, lib/query-timing or lib/queries/* — new page reads go through lib/services/*_


`eslint.config.mjs` defines `erp/ui-data-boundary`: files under `app/**` (except
`app/api/**`, which is exempt; `app/actions/**` deliberately is NOT) may not
import `@/lib/db`, `@/lib/db-sku`, `@/lib/query-timing` or `@/lib/queries/*`.
Type-only imports are allowed. New page reads go in **`lib/services/*`** — one
function per read owning both the query and its authorization, called by the page
and any API route. Convention is `getX(userId, roles, ...)`, resolving
access/scope inside; see `lib/services/observability.ts`, the first one, and
`docs/module-boundaries-and-tally-plan.md` §4.

**Why this bites:** ~25 existing pages violate it (`app/admin/activity/page.tsx`,
the masters list pages) and are grandfathered, because the gate is
`npm run lint:changed` — it fails only on files touched. So **reading an existing
page to copy its data-fetching pattern reproduces the banned pattern**, and it
only surfaces at lint time, after the code is written. `npx tsc` says nothing.

**How to apply:** before writing a server component that needs data, plan for a
`lib/services/*` function. Don't take `app/admin/**` or `app/masters/**` as the
model for how a page gets its rows — they predate the rule. Also don't import
`@/lib/uniware*` transport modules from `app/**`: same rule, separate `paths`
entry, because they reach `lib/env` and so `UNIWARE_PASSWORD`.

---

## project-uniware-ip-whitelist

_Uniware's REST API only accepts calls from the EC2 IPs — never testable from a laptop; probe via SSM instead_


The `pep.unicommerce.com` tenant IP-whitelists API access to the EC2 boxes. From
Ajay's home/office IP the OAuth token **mints fine** and then every API call
answers HTTP 403 with an "Uniware - Access Denied" HTML page — so it looks like a
credentials or facility problem when it is neither.

**Why:** verified 2026-09-08. Token minted from IP 223.184.157.247, every
`/services/rest/v1/**` call 403'd; the identical call from `erp-app-prod` returned
200. Cost about an hour of chasing the wrong cause.

**How to apply:** never conclude anything about Uniware from a local run. Probe
from the box over SSM (`AWS_PROFILE=erp`, `MSYS_NO_PATHCONV=1`, instance
`i-0a249d3d470e693d3` = erp-app-prod, `i-0d269978588f3c2da` = erp-app-test),
base64 the script into `/tmp` and run it there. The box has Uniware access but
**no `mysql.connector`**; the laptop has the DB but no Uniware access — so split
DB-reading and API-calling across the two rather than installing packages on prod.
`check_uniware_apis/po_document.py --print-pairs` / `--pairs` is the worked
example of that split. See [[project-aws-deploy-account]] for the profile and
path-mangling flags.

---

## project-uniware-po-print-facility

_Why the Uniware PO document only attaches for Gurgaon, and the fix direction (facility is selected session state)_


Uniware's `/po/show` (the PO print view the warehouse mail attaches) **ignores the
`Facility` header** — unlike the REST endpoints. It renders only POs at the
session's currently-SELECTED facility.

`erp.prefg@mcaffeine.com`'s session sits on Gurgaon, so the inward-invoice mail
attaches the Uniware PO for GGN_WAREHOUSE and silently omits it for the other 17
facilities (reported since 2026-09-09 as the `email` step's `warning` status).

**Measured 2026-09-15:** the facility is *selected session state*, not a fixed
user attribute — Ajay's login switched to MUM_WAREHOUSE2 renders a Mumbai PO at
the same URL that 500s before the switch. So cross-facility print exists; the fix
is to point ONE session at the resolved facility, not to create 18 API users, and
not to render the PDF ourselves.

**Answered 2026-09-15.** The switcher sends `POST /data/user/switchfacility`
`{"currentUrl","facilityCode"}`. It is **web-session (cookie) only** — the bearer
gets 500, like every other `/data/*` path. With the cookie: switch, then
`/po/show?…&legacy=1` returns a PDF for any facility. `/po/show` takes either arm
and renders whatever facility *that* session is on; cookie and bearer are
separate sessions.

So the fix is a choice: (a) move `fetchPurchaseOrderPdf` onto the harvested
cookie + switch — needs a mutex (prod container, test container,
`fetch_sku_details.py` and the doc sync all share the account) and a credential a
human renews every ~10h; or (b) render the PO ourselves from
`getPurchaseOrderDetails`, which honours the `Facility` header on the bearer for
all 18 facilities today. Undecided pending: does the warehouse need *Uniware's*
PDF specifically?

Findings live in the gitignored `check_uniware_apis/po_document.py` FINDINGS
block — nowhere in the repo.

Also measured: the office IP is **not** blocked for `/po/show` or `/data/*` —
only `/services/rest/v1/*` needs the EC2 whitelist, so this probe runs locally.

Related: [[project-uniware-ip-whitelist]], [[feedback-verify-uniware-payload-changes]]

---

## project-uniware-sale-order-route

_Sale-order route replacing the broken gatepass for sending stock out of Uniware; verified steps and TEST_FACILITY limits_


Since 2026-09-17 the gatepass outward route (addItem broken on Uniware's side) is
being replaced by the sale-order route. Probes live in `check_uniware_apis/sale_order_check.py`.

Chain: `oms/saleOrder/create` (tenant, facility from header) → `createInvoiceWithDetails`
(alt `oms/shipment/createInvoiceAndLabel`) → `oms/shipment/forceDispatch` → `saleOrderItem/markDelivered`.
Stock leaves at forceDispatch; create only reserves it (`openSale`). markDelivered is bookkeeping.

Verified at TEST_FACILITY:
- create works; Uniware echoes our `saleOrder.code` and item codes back verbatim.
- One saleOrderItems entry = one unit; the create payload has no quantity field.
- markDelivered without a package → 20012 INVALID_SHIPPING_PACKAGE_CODE.
- Get is `/oms/saleorder/get` (lowercase); the camelCase spelling 404s.
- `inventory/inventorySnapshot/get` is facility-level: no facilityCode in the body,
  and `updatedSinceInMinutes` is capped at one day (1440).

TEST_FACILITY blockers: it holds **zero** stock (~23 SKUs, all `inventory: 0`), and
`Dry070` is INVALID_ITEM_TYPE there — dry SKUs aren't enabled at that facility, so the
dry-inventory question cannot be answered there without adding stock first.

2026-09-25: gatepass `nontraceable/addItem` proven broken SERVER-SIDE, at a live facility.
Always HTTP 400 `code 1000` "No content to map to Object due to end of input" once the
request is complete AND the gatepass exists. Ruled out by direct test: facility
(TEST_FACILITY + Mcaff_Chennai), party (Test_Vendor + Dry_Inv_CWH_Consumption), SKU
(invalid / zero-stock / TEST_UNICOM4 at 99,564 / Dry003 at 1,569), slashes in the
gatepass code, shelfCode (omitted + DEFAULT), redirects, CloudFront body-stripping.
Proof the endpoint itself is live: `{}` returns HTTP 200 MISSING_REQUIRED_PARAMETERS,
and a nonexistent code returns HTTP 200 INVALID_OUTBOUND_GATE_PASS_CODE. Probe:
`gatepass_additem_probe.py`. Raise with Uniware support; don't re-debug our payload.

Snapshot quirks found the same day: SKU input is case-sensitive (`DRY069` warns
INVALID_ITEM_TYPE while returning the canonical `Dry069` row), and a warning plus a
returned row means "item type known, nothing matched", not a match.

Orders created there carry custom field `Order_Status = Unapproved`; unknown whether
it gates allocation. See [[project-uniware-ip-whitelist]], [[feedback-verify-uniware-payload-changes]].

---

## project-uniware-test-facility-fixtures

_TEST_FACILITY sandbox fixtures are kept on purpose; TEST_UNICOM1-4 are its only stocked SKUs_


Ajay asked (2026-09-21) that the dry-consumption test orders left in Uniware's
TEST_FACILITY be **kept for future use** — do not cancel or reverse them. That
run left ~16 orders (`ZZTEST-SO-*`, `ZZA-*`, `ZZB-*`, `ZZCAT-*`, `ZZAPT*`,
`ZZCH*`, `ZZQ*`), a gatepass `ZZTEST/DRY/OG/2627/0921185542`, and 5 seeded units
of `MCaf370` on shelf `DEFAULT`, batch created via `/inventory/adjust/bulk`.

Two facts about TEST_FACILITY that cost a wrong turn and are not visible in code:

- **`TEST_UNICOM1`–`TEST_UNICOM4` are the only SKUs there with real stock**
  (59k–99k each). Every other item type sits at 0 and is batch-managed, so a
  stock adjustment on one needs `shelfCode` plus `batchDetails{batchCode, expiryDate}`.
- `inventorySnapshot/get` with `updatedSinceInMinutes` only lists SKUs touched
  inside that window, so it **silently hides** the stocked ones. Ask for SKUs by
  name via `itemTypeSKUs` when you need the truth.

Related: [[project-uniware-sale-order-route]]

---

## project-uniware-vendors-export

_Uniware's 'Vendors' export report is the ground truth for un_mfg_code per facility — how to pull it and why hand-typed codes are unreliable_


Uniware has a **`Vendors`** export report (alongside `Vendor Item Master`) that
lists every vendor code configured at one facility. It is the ground truth for
`un_code_mfg_sku_wh_map.un_mfg_code` — the only way to know a code without
guessing, since a wrong one fails as `Invalid vendor code` on the vendor-item push
and (worse) can inward against another manufacturer's ledger.

- `exportJobTypeName: "Vendors"`, `exportColums: ["vendorCode", "vendorName"]`.
  The valid column KEY is `vendorCode` — `code` and `name` are rejected with
  `INVALID_EXPORT_JOB_COLUMN`, and a wrong report name gives
  `INVALID_EXPORT_JOB_TYPE_NAME` (so the two errors tell you which half is wrong).
  The CSV comes back with display headers (`Vendor Code,Tolerance`).
- Scoped by the `Facility` header, same as `lib/uniware/export-jobs.ts`
  `createExportJob` — which already takes a `jobTypeName` argument, so pulling it
  needs no new plumbing.
- It lists vendors even when they have **zero** vendor items, which
  `Vendor Item Master` cannot — that is exactly the gap it fills.

**Why it matters:** the codes are hand-made per facility in Uniware and are wildly
inconsistent for the same manufacturer — Reve is `REVE` at `Mcaff_Nagpur` and
`HYP_DLNAG`, `_REVE_` at `mCaff_Lucknow3`, `Reve_Pharma` at Bangalore/Hyderabad/
Kolkata, `Reve_Pharma_` at Mumbai, `_Reve_` at `GGN_WAREHOUSE`, `Reve__Pharma` at
`HYP_B2B_GGN`. So a code can never be derived from another facility's, and
`master_mfgs.code` (what `set-vendor-code` writes) matches none of them.

**2026-09-08:** fixed Nagpur·PEP Reve from `_REVE_` → `REVE` this way, direct SQL on
prod across the pair's 4 rows plus clearing the `Invalid vendor code` error. Then
swept all 18 facilities for Reve: **all 9 stored codes match Uniware**; the other 9
facilities have no rows on our side, 8 of which do have a Reve vendor in Uniware
(only Guwahati·KREATIVE `HYP_DLGWHT` genuinely has none).

Two gotchas when sweeping: filter the vendor list on the code, not a substring of
the whole CSV line — the big PEP facilities carry `Product_Review_MMEnt` and
`wellness_forever_medicare`, which both match "rev". And a facility's export job can
outlast a 2-minute poll (`mCaff_Lucknow3` did), so treat "no file" as retry, never
as "no vendor".

Run it from the box, not locally — see [[project-uniware-ip-whitelist]].

---

## project-warehouse-entity-structure

_Every warehouse location operates under BOTH legal entities with separate Uniware facility codes, GSTINs and addresses — not one entity per warehouse_


mCaffeine's warehouses are **not** one-entity-per-location. Every physical location runs under
both legal entities simultaneously, each with its own Unicommerce facility code, state GSTIN and
bill-to/ship-to address block:

- **Pep Technologies Pvt Ltd** (PAN `AAICP2804J`) — brands mCaffeine, Fein. Facility codes look
  like `GGN_WAREHOUSE`, `mCaff_Kolkata2`, `MUM_WAREHOUSE2`.
- **Kreative Beauty Pvt Ltd** (PAN `AAJCK9697F`) — brand Hyphen. Facility codes look like
  `HYP_B2B_GGN`, `HYP_SRKOL`, `HYP_DLNAG`.

9 live locations as of 2026-08-13: GGN MW, KOL, BGLR, HYD, Mumbai, Gujarat, Lucknow, Nagpur,
Guwahati - Delivery. Retired: GGN (closed Feb 2026) and the old Guwahati (superseded by
"Guwahati - Delivery"). Nagpur went live 2026-04-22.

Two consequences that are easy to get wrong:

1. **Kreative bills to its Mumbai HO** (`27AAJCK9697F1ZS`) while shipping to Guwahati, Kolkata,
   etc. So an invoice's buyer GSTIN must be matched on **PAN only** (`panOf()` in `lib/gstin.ts`),
   never the full GSTIN or its state prefix — a state comparison rejects almost every legitimate
   invoice.
2. `lib/gstin.ts` `OUR_PANS` holds **four** PANs (`AAICP2804J`, `AAJCK9697F`, `AAFCD3098K`,
   `ABGCS1450A`) covering nine registrations. Ajay has only identified the first two; the other two
   are real but unnamed. `OUR_PANS` stays the source of truth for invoice detection — it is
   deliberately broader than any entity table.

Fein shares Pep's facility codes; it does not have its own.

`master_warehouse.type`: **MWH = Mother Warehouse**, **CWH = Child Warehouse** (not "Central" —
the abbreviation misleads). GGN MW and Mumbai are the two mother warehouses that receive from
manufacturers; every other location is a child fed from one of them.

See [[project-state]]. Design plan: `~/.claude/plans/plan-how-to-populate-mighty-hummingbird.md`.

---

# Part 3 — References

## reference-microservices-plan

_Where the full microservices + API Gateway platform plan and related architecture-evolution docs live_


Full "north star" microservices platform plan (FastAPI services, PostgreSQL per service, Kong API Gateway, Redis, K8s, Elasticsearch, 15 services, 30-week phased roadmap for 1,000 concurrent users) is saved at:

`C:\Users\AJAY SINGH\.claude\plans\production-planning-module-fg-crispy-neumann.md`

**Status (as of 2026-07-10)**: Confirmed with user this is a long-term aspirational reference, not an active migration target. Current app stays the Next.js 16 App Router + mysql2 + MariaDB monolith (deployed on EC2, see [[project_ec2_docker_deploy]]) for the foreseeable future. Do not propose migrating to this stack unless the user explicitly asks to start scoping it.

Related, smaller-scope docs (nearer-term, evolve-the-monolith framing, not full microservices rewrite):
- `docs/architecture-evolution.md` (in repo) — planned improvements: Zod, withGateway, request IDs
- `docs/event-driven-options.md` (in repo) — event-driven architecture + API gateway options for the existing monolith
- `C:\Users\AJAY SINGH\.claude\plans\looking-at-the-present-humble-rabin.md` — "event-driven modular monolith (not microservices, yet)" roadmap, explicitly a smaller step than the full plan above
- `C:\Users\AJAY SINGH\.claude\plans\i-want-to-change-iterative-church.md` — duplicate/earlier draft of `docs/event-driven-options.md`
- `architecture-discussion-framework.md` (repo root) — scaling table (10x/100x/1000x) with microservice extraction points for specific hot spots (approvals, rate tables)

---

