# Playwright E2E suite for the ERP (read-only, local)

## Context

Ajay wants browser tests he can run before committing, kept out of GitHub. The repo has
no browser tests at all today: no Playwright or Cypress, and zero `data-testid`s. The
existing `node:test` suites cover logic and SQL, not pages.

**Decisions (2026-10-26):**

| | |
|---|---|
| Location | `Desktop\ERP Project\e2e`. The git root is `ERP Project`, so add `/e2e/` to the root `.gitignore`. |
| Scope | **Read-only first.** Pages load and lists, filters, search, sort, tabs and dialogs work. Nothing is ever saved. |
| When it runs | **Manually** (`npm test` in `e2e/`) before a commit. No git hook. |

## Sequencing and gates

1. **Scaffold.** Create the `e2e/` folder with its own `package.json` (only `@playwright/test`, `next-auth`, `mysql2`, `dotenv`), then run `npx playwright install chromium`. Add the `.gitignore` line, and **check that `git status` doesn't show `e2e/`.**
2. **Auth plus the safety net.** Write the global setup and the request block, then prove both with one smoke spec.
3. **Specs.** One spec per area, in the order below. Each one must pass twice in a row before moving on.
4. **Hand-over.** Ajay runs `npm test` himself. A `README.md` covers how to run it, re-mint the login, and debug with `--ui`.

**Gate:** nothing in `erp_project/` changes, so nothing gets committed. Adding `data-testid`s would be a separate request, made only where a role or label selector proves flaky.

## Design

### Server
- `playwright.config.ts` uses `webServer: { command: "npm run dev", cwd: "../erp_project", url: "http://localhost:3000", reuseExistingServer: true, timeout: 180_000 }`. A dev server that's already running gets reused.
- `workers: 2` keeps the load on the shared RDS light.
- `retries: 0` locally, so a flaky test shows up as a failure.
- Chromium only.
- Failures keep a trace and a screenshot.

### Login without Google
- Sessions are JWT (`auth.config.ts:24`). Nothing checks the DB `sessions` table, so a minted cookie is accepted.
- `global-setup.ts` loads `../erp_project/.env` and does a **read-only** `SELECT` on `users` and `user_roles` for `E2E_USER_EMAIL` (default: Ajay's address) to get the user id and roles.
- It then calls `encode({ token: { sub, email, name, userId, roles }, secret: AUTH_SECRET, salt: "authjs.session-token" })` from `next-auth/jwt`. The token shape mirrors the `jwt` callback in `lib/auth.ts:22-32`.
- It writes the cookie to `.auth/state.json` (gitignored), and every spec uses it via `storageState`.

### Refusing to touch prod
`global-setup` aborts if:
- `.env` has `APP_ENV=prod`; or
- the base URL isn't localhost; or
- `DB_NAME_TEST` is the same as `DB_NAME_PROD`.

### Read-only guard (`fixtures.ts`)
Every test gets a `page` with `page.route("**/api/**")`:
- **Aborts** any non-GET request, except `/api/auth/**`. A stray click on "Save" fails the test with "blocked write: POST …" instead of writing.
- **Also aborts** GETs that reach outside: `/api/v1/uniware/**`, `purchase-orders/uniware-*`, and `/api/v2/purchase-orders/invoice/parse` (paid Nanonets calls). Mail, S3 and Uniware are not switched off outside prod (they only fall back to `TEST_FACILITY`), so this guard is the only thing stopping them.

### Specs (`tests/*.spec.ts`)
Selectors come from roles, headings, placeholders and `aria-label`s, since the app has no testids.

| Spec | Checks |
|---|---|
| `smoke.spec.ts` | Every slug in `lib/pages.ts` returns 200 and shows its h1. No page error and no failed `/api` response. Signed out, `/` redirects to `/auth/signin`. |
| `po-procurement.spec.ts` | Tabs All/Open/… change the rows. Search filters. Sorting the Last Updated column flips the order. The Add PO dialog opens and refuses an empty submit. A row's History dialog opens. |
| `invoices.spec.ts` | List loads, the table switch (`aria-label "Which table to show"`) works, filters narrow the results. |
| `masters.spec.ts` | SKUs, vendors, manufacturers and materials load, search narrows the rows, and the History and Variants popups open. |
| `approvals.spec.ts` | Pending and History both load. The reject dialog requires remarks; we check that only, without submitting. |
| `manufacturing.spec.ts` | `/manufacturing/<id>?tab=misc_cost` loads. The CSV dialog opens and the preview runs on a fixture CSV. Preview is a **POST** (`check_duplicates`), which writes nothing, so it's the one allowlisted non-GET. |
| `gatepass.spec.ts` | The facility list is non-empty and comes from Warehouse Master (no hardcoded list). Summary is not run, because it calls Uniware. |
| `admin.spec.ts` | The Users, Permissions, Data Access and Activity tabs load, and user search works. |

Test data is found at runtime (for example, "the first manufacturer in the list"), never hardcoded ids, because ids differ between dev and prod (see `project-mfg-ids-diverge`).

### Files
`e2e/`:
- `package.json`
- `playwright.config.ts`
- `global-setup.ts`
- `fixtures.ts`
- `tests/*.spec.ts`
- `fixtures/misc-cost-sample.csv`
- `README.md`
- `.env.example` (`E2E_USER_EMAIL`, `BASE_URL`)

The root `.gitignore` gets `/e2e/`.

## Risks
1. **A forged cookie is real access.** Anyone with `AUTH_SECRET` can already do this. `.auth/state.json` stays local and gitignored and expires with the JWT. Re-run setup when roles change, because roles are baked into the token.
2. **The dev DB shares the prod RDS host.** The suite is read-only and `workers: 2`, so the load is a few page loads.
3. **Dev-mode compile time.** The first visit to each page compiles it (5–20 s). Navigation timeout is 60 s, and the smoke spec runs first so it warms the pages.
4. **A stale dev server.** A long-running `next dev` can serve old code (see `project-dev-server-stale-after-edits`). If results look wrong, restart it before trusting them.
5. **Selectors break on copy changes.** That's accepted. Add `data-testid`s later, only where a test proves brittle.

## Verification
- `cd e2e; npm test`: everything passes on two consecutive runs.
- Safety net: a throwaway spec that clicks a real Save fails with "blocked write". Delete it afterwards.
- With a bad `AUTH_SECRET`, the smoke spec fails at the sign-in redirect, proving the minted cookie is what grants access.
- `git status` from the repo root shows nothing under `e2e/`.
- `npx playwright show-report` opens the HTML report.
