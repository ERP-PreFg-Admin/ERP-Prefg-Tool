# Observability redesign — module logs, user tab, Infra split by environment — plan

**Status:** built on dev 2026-10-15 (Ajay: "Go ahead", D1–D4 as recommended), uncommitted.
- **Checks:** tsc `--incremental false` clean, `npm test` 1057/1057, user-activity DB test passes, eslint clean on the touched files.
- **CloudWatch probes against `/erp-app/test`:** `= "x*"`, `!= "x*"` and `= "*x*"` all work.
- **Not yet:** Ajay's signed-in click-through after a dev-server restart, and a build.
- **Changed beyond the plan:** the 23:59 digest's mail search now matches `$.code = "MAILER"`, because `module` holds the module key now.

## What exists today

**Logs (`/observability/logs`):**
- It is one flat search over the `/erp-app/{test,prod}` CloudWatch groups.
- It has three filters: Request ID, then Level, then Contains. **Only one applies at a time.**
- **Lines can't be tied to a module or a user.** Only the gateway's own lines ("Request completed" / "Request failed") carry `path` and `userId`.
- The 134 `logger.*` calls inside handlers carry a free-form `module` code (`PO_SPLIT`, `BOM`, `NANONETS`, …). They have **no** `requestId` and **no** `userId`, so they can't be traced to a request or a person.

**User activity:**
- It is only on `/admin > Activity`, read from the `activity_log` and `session_history` tables.
- `activity_log` holds every non-GET call, plus slow or failing GETs.

**Infra (`/observability/infra`):**
- One grid mixes the prod and test boxes, told apart only by the series label.
- The RDS panels and every alarm in the AWS account sit in the same grid and table.

## Sequencing and gates

| Step | What | Gate |
|---|---|---|
| **1. Log context** | Every log line gets stamped with `requestId`, `userId` and a `module` key. This happens once, in the logger, with no changes to the 134 calls | Unit test on the stamping; on dev, one PO action's lines all share one requestId and userId |
| **2. Module map** | One pure file maps a module to its API path prefixes and its old `module` codes | Unit test: every `app/api/v1` top-level folder maps to a module, so a new route can't fall through unlabelled |
| **3. Logs → by module** | The Logs page becomes module-first, with filters that combine | On dev: pick Purchase Orders + error and get only PO errors |
| **4. "By user" view in Logs** | A view selector on the Logs tab (By module \| By user), not a new tab | On dev: your own row matches what `/admin > Activity` shows for you |
| **5. Infra → Test \| Prod** | Two columns side by side, with shared resources below them | On dev: each box's numbers sit under the right heading |
| **6. Build + deploy** | No DDL anywhere in this plan | `tsc --incremental false`, `lint:changed`, `npm test`, then a build with the dev server stopped |

Steps 3–5 are independent of each other once 1 and 2 are in. Step 5 needs neither 1 nor 2, so it can go first if you want a quick win.

## 1. Log context (backend, small)

**How it works:**
- `withGateway` runs the handler inside an `AsyncLocalStorage` holding `{ requestId, userId, path }`.
- A winston format reads that store and adds those fields, plus `module` (from the path, via step 2), to **every** line written during the request.
- A call that already passes its own `module` keeps it. Its value moves to `code`, so `PO_SPLIT`-style detail isn't lost.

**What it gives:**
- Handler lines become traceable to a request and a person with no per-call edits.
- Cron and webhook lines carry no user and get `module` from their own path.

**Risk:** only lines written after the deploy carry these fields. Older lines still show up in module search through the request lines (`path`). They won't show up per user, apart from the gateway's request lines, which already carry `userId`.

## 2. The module map

**One list, used by both Logs views and the Requests tab's route table.**

| Module | API path prefixes | Old `module` codes folded in |
|---|---|---|
| Purchase Orders | `/purchase-orders` (except `/invoice`), `/facilities` | `PO_*` |
| Invoices & Inwarding | `/purchase-orders/invoice`, v2 `/purchase-orders/invoice` | `PO_INVOICE`, `INVOICE_*`, `NANONETS` |
| Masters | `/masters/*` | `SKU*`, `VENDOR*`, `MFG_CREATE/UPDATE/DOCS/BULK`, `RM*`, `PM*`, `BOM*`, `WAREHOUSE*` |
| Manufacturing | `/manufacturing/*` | `MFG_LINE_*`, `MFG_MISC_*`, `MFG_FACILITY_*` |
| Approvals | `/approvals/*` | `GET_APPROVAL*`, `GET_ENTITY_HISTORY` |
| Uniware & Gatepass | `/uniware/*`, `/gatepass/*` | `UNIWARE*`, `GATEPASS` |
| Mail & Jobs | `/cron`, `/webhooks` | `CRON`, `MAILER`, `SES_WEBHOOK` |
| Admin | `/admin/*` | `ADMIN_*`, `OBSERVABILITY` |
| Other | anything unmatched | — |

**Where it lives:** a pure file, `lib/observability/modules.ts`, so it can be unit-tested and imported by both the page and the service.

## 3. Logs tab — module-first

**Layout:** the existing filter row stays; the page keeps its plain GET form, with no client JS.
- **Module strip:** a row of module chips (All · Purchase Orders · Invoices · Masters · …). Each chip shows its error count for the window, so the noisy module is visible before you click.
- **Filters combine:** Module + Level + User + Contains, ANDed into one CloudWatch JSON pattern. CloudWatch accepts `&&` / `||`, so "one filter at a time" goes away.
  - Request ID still overrides everything, since it is already exact.
- **Environment:** the test/prod picker stays.
- **Line list:** the existing list, plus two new pills on each line:
  - the module;
  - the user's name, linking to that user's detail in the By user view.

**How a module search matches:** a module matches either its path prefix (`$.path = "/api/v1/masters*"`) or its old codes (`$.module = "SKU*"`). That way pre-deploy lines are found too.
- **Check on dev first:** CloudWatch's trailing-`*` wildcard on JSON string values. It is documented, but this app hasn't used it yet.

**Error counts on the chips:**
- They come from `activity_log` (status ≥ 400, grouped by path → module), not CloudWatch.
- That's one cheap SQL query, versus nine metered log scans per page view.

## 4. "By user" view inside the Logs tab

**No new tab** (Ajay, 2026-10-15). The Logs tab gets a selector at the top, `By module | By user` (`?view=user`), using the same `SegmentedToggle` as the time window. The window and environment pickers are shared by both views.

**List view:** one table with one row per person active in the window. It reads `activity_log` + `session_history`, the same sources as `/admin > Activity`.

| User | Calls | Errors (4xx / 5xx) | Error rate | Slowest | Modules touched | Last sign-in | Last seen |
|---|---|---|---|---|---|---|---|

- Sorted by errors by default, so whoever is having trouble is on top.

**Detail view:** click a row to open `?view=user&user=<id>`.
- **Summary line:** calls, errors and modules.
- **Activity timeline:** that person's calls and sign-ins, newest first.
  - Each entry shows its module.
  - Failures are highlighted, with the status and the error message.
- **Errors only toggle.**
- **Each request ID links to the Logs tab** filtered to that request, so you can see what went wrong server-side.

**Data and access:**
- It reads only the current environment's DB, because `activity_log` is per schema. The page says which environment it is showing.
- Access is the same as the rest of `/observability`. This is a cross-user view, so it's the same audience that already sees the Requests tab's user names.

**What it can't show:** GETs that were fast and successful aren't recorded (by design, to keep `activity_log` small). So "activity" here means changes, sign-ins and failures, not page views. The page states this.

## 5. Infra tab — Test | Prod side by side

```
            ┌─────────── TEST (erp-app-test) ──┐ ┌────────── PROD (erp-app-prod) ──┐
            │ CPU      ▁▂▃▂▁   12%             │ │ CPU      ▂▃▅▃▂   31%            │
            │ Memory   ...                     │ │ Memory   ...                    │
            │ Disk     ...                     │ │ Disk     ...                    │
            │ Alarms on this box (n)           │ │ Alarms on this box (n)          │
            └──────────────────────────────────┘ └─────────────────────────────────┘
            Shared — RDS mcaff-dwh (both schemas live here): CPU · Connections · its alarms
            Other alarms in the account (collapsed)
```

**How series are assigned:**
- **Box metrics:** each EC2 series goes to its column by its instance's `Name` tag (`erp-app-test` / `erp-app-prod`), which is already looked up.
- **RDS:** one database instance holds both schemas, so it is honestly **shared**. It sits under both columns, not inside either.
- **Alarms:** each alarm goes to the box it watches, by the instance id in its dimensions.
  - RDS alarms go to Shared.
  - Anything else, including the stale `CWAgent` one, goes to a collapsed "Other" section, instead of mixing into the main table.

**Layout details:**
- Prod is on the **right**, as you asked ("tests on one side and prod on other").
- On a phone the columns stack, test first.
- **No new metrics:** this is a regrouping of what is already fetched. Still one `GetMetricData` call per view.

## Decisions (owner: Ajay)

| # | Question | Recommendation |
|---|---|---|
| D1 | Should the By user view also be visible to non-admins, showing only their own row? | **No.** The whole of `/observability` stays one audience. Self-service can come later |
| D2 | Keep `/admin > Activity` once the By user view exists? | **Keep.** It has filters (path, method, date range) the By user view won't. Revisit after a month |
| D3 | Module chip counts from `activity_log` (cheap, this environment only) or CloudWatch (both environments, metered)? | **`activity_log`** |
| D4 | Put the module list on the Requests tab's route table too (group the rows by module)? | **Yes, as a column only.** It improves the table in place, with no new section |

## Risks

| Risk | Mitigation |
|---|---|
| `AsyncLocalStorage` context leaking between concurrent requests | Each request gets its own `run()` scope, which is the standard Node pattern. A unit test runs two overlapping requests and checks they don't share a context |
| A module-filter pattern CloudWatch rejects | Proven on dev against the test log group before the page uses it. A bad pattern already comes back as data (`ok: false`), not a crash |
| New routes landing in "Other" | The step-2 unit test fails on any unmapped top-level API folder |
| Cost of CloudWatch scans | It stays one `FilterLogEvents` per search, as today. Chip counts come from SQL (D3) |
