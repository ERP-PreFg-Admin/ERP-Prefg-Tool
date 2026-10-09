# Welcome mail for new ERP users

## Context

Users are created on **Admin → Users** (`POST /api/v1/admin/users`,
`app/api/v1/admin/users/route.ts:74`): one transaction inserts `users` +
`user_roles`, and today **nothing is emailed** — the new person isn't told they
have access, or how to get in. Sign-in is **Google OAuth** against the user's
email (no password exists), and an `inactive` user can't sign in.

Goal: the ERP sends a welcome mail when someone is given access.

## Decisions (Ajay, 2026-10-08)

| | |
|---|---|
| Content | The **sign-in link** and "sign in with Google using **<their email>**", plus **who to contact** — the admin who added them |
| When | On **create, if active**. A user created `inactive` gets it the first time they're switched to `active` |
| Resend | **Yes** — a "Resend welcome mail" row action, and `users.welcome_sent_at` so the table shows when it went |
| Recipients | **To** the new user, **CC** the admin who added them (SES sends never appear in a Sent folder) |

## Sequencing and gates

1. **Migration on dev only** — `users.welcome_sent_at DATETIME NULL`. Stop.
   Prod on its own go-ahead, **before** the deploy.
2. **Pure pieces + unit tests** — the HTML renderer and the send rule.
3. **Sender** in the mailer; **create / activate** hooks; **resend** route.
4. **Users table**: "Welcome sent" + the Resend row action (existing table, in place).
5. **Dev end-to-end**: create a test user with your own address → mail arrives
   (check SES events); create inactive → no mail; activate → mail; resend → mail.

## Design

### 1. Migration — `prisma/add_users_welcome_sent_at.sql`
`ALTER TABLE users ADD COLUMN welcome_sent_at DATETIME NULL AFTER created_at;`
Not re-runnable (MySQL 8). Existing users stay NULL — **no backfill, no mail to
existing users**. Sync `schema.prisma`.

### 2. Pure — `lib/mail/welcome-mail.ts`
- `shouldSendWelcome({ before, after, welcomeSentAt })` → true when the user is
  now `active` **and** `welcomeSentAt` is null **and** (it's a create, or the
  status went `inactive → active`). Resend bypasses it on purpose.
- `renderWelcomeMail({ name, email, appUrl, admin: { name, email } })` →
  `{ subject, html, text }`:
  - Subject: **"Welcome to PEP ERP"**
  - Body: "Hi <name>, you've been given access to the PEP ERP. Sign in at
    **<APP_URL>** with **Sign in with Google**, using **<email>** — no password is
    needed. For access to more pages or any help, contact **<admin name>
    (<admin email>)**." Plain, no images; escaped like every other mail
    (`escapeHtml`).

### 3. Sender — `sendWelcomeEmail` in `lib/mail/mailer.ts`
- New `MAIL_FLOW.WELCOME = "welcome"`, so sends are counted and logged with
  `mailOutcome` like the others (and appear in the daily digest's email counts).
- Recipients through `splitRecipients` with the `email_suppressions` list: an
  address that bounced before is dropped and logged, not retried.
- Returns `{ sent, messageId?, error? }`; never throws into the caller.

### 4. Hooks — `app/api/v1/admin/users/route.ts`
- **POST:** after `commit` (never inside the transaction), if
  `shouldSendWelcome` → send; on success
  `UPDATE users SET welcome_sent_at = NOW() WHERE id = ? AND welcome_sent_at IS NULL`.
  **A failed mail never fails the create** — the response carries
  `welcome: "sent" | "failed" | "skipped"` and the dialog toasts it.
- **PATCH:** read the old status before updating; after `commit`, same rule
  (`inactive → active` with no `welcome_sent_at`).
- The admin for "who to contact" and the CC is the **session user** (`users` row
  by `session.user.id`).

### 5. Resend — `POST /api/v1/admin/users/[id]/welcome`
`withGateway`, `access: { pageSlug: ADMIN_PAGE, level: "editor" }`. Refuses an
`inactive` user (they couldn't sign in). Sends regardless of `welcome_sent_at`
and updates it. `tests/unit/route-scope.test.ts` requires scope on `[id]`
routes — add an `EXEMPT` entry with the reason (admin-only; users aren't scoped
entities), as the other admin routes do.

### 6. UI — `app/admin/UsersClient.tsx`
- Existing table, in place: under each user's status, a muted line
  "Welcome sent 8 Oct" / "Welcome not sent".
- Row menu gains **Resend welcome mail** (hidden for inactive users).
- Create / edit toasts say whether the welcome mail went.

## Risks

1. **`APP_URL` on prod.** `NEXT_PUBLIC_APP_URL` falls back to
   `http://localhost:3000`, and as a `NEXT_PUBLIC_` value it is fixed at **build**
   time. Check the prod image has it set to `https://erp.mcaffeine.com` before
   relying on it — or read a server-side value instead.
2. **Mail to the wrong address** — the email is typed by an admin; a typo sends
   the welcome to a stranger. It contains only the link and an admin contact,
   no data — acceptable, and the CC shows the admin what went out.
3. **SES bounce** on a mistyped address lands in `email_suppressions` and shows as
   "failed" in the toast; fixing the email and resending works once the
   address is corrected (a suppressed *correct* address needs removing first).

## Verification

- `npm test` — `shouldSendWelcome` truth table (create active / create inactive /
  inactive→active / active→active / already sent); `renderWelcomeMail` contains
  the link, the email, the admin, and escapes HTML in names.
- `npm run test:db` — the `welcome_sent_at` stamp only sets once (`IS NULL` guard).
- `npx tsc --noEmit --incremental false`, `npm run lint:changed`,
  route-scope test passes with the new `EXEMPT` entry.
- Dev end-to-end as in step 5; confirm delivery via SES events (not the mailbox's
  Sent folder).
