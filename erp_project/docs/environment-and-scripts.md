# Environment Variables and Scripts

> **Related docs:** [Getting Started](./getting-started.md) · [Architecture](./architecture.md)

## Environment Variables

All variables are read at server startup. Changes require a server restart.

### Core

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DB_HOST` | Yes | — | MariaDB hostname (AWS RDS endpoint) |
| `DB_PORT` | No | `3306` | MariaDB port |
| `DB_USER` | Yes | — | Database username |
| `DB_PASSWORD` | Yes | — | Database password |
| `DB_NAME` | Yes | — | Database / schema name |
| `AUTH_SECRET` | Yes | — | Signs and verifies NextAuth JWT cookies. Changing this invalidates all active sessions. |
| `GOOGLE_CLIENT_ID` | Yes | — | Google OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | — | Google OAuth 2.0 client secret |

### AWS S3

Required for file uploads, bulk Excel imports, PO PDF storage, and event logging.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `AWS_REGION` | Yes | — | AWS region (e.g. `ap-south-1`) |
| `AWS_ACCESS_KEY_ID` | Yes | — | IAM access key |
| `AWS_SECRET_ACCESS_KEY` | Yes | — | IAM secret key |
| `AWS_S3_BUCKET_FILES` | Yes | — | Bucket for file uploads and PO attachments (e.g. `mcaffeine-erp-files`) |
| `AWS_S3_BUCKET_EVENTS` | Yes | — | Bucket for raw/processed/failed event logs (e.g. `mcaffeine-erp-events`) |

See [S3 Integration](./s3-integration.md) for the full key/prefix conventions.

### Email (PO dispatch)

Required to send PO PDFs to manufacturers via Gmail SMTP.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `GMAIL_USER` | Yes | — | Gmail address used as the sender (e.g. `procurement@mcaffeine.com`) |
| `GMAIL_APP_PASSWORD` | Yes | — | [Gmail App Password](https://support.google.com/accounts/answer/185833) — not the account password. 2FA must be enabled on the account. |
| `MAIL_SIGNATURE_TITLE` | No | `MIS Executive` | Job title printed under the sender's name on inward-invoice emails. The name itself comes from whoever filed the invoice, so only the title is configured. |

### Nanonets (invoice extraction)

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `NANONET_API_KEY` | Yes | — | Key for `extraction-api.nanonets.com`, used by `lib/nanonets.ts` to read supplier-invoice PDFs |

### Uniware (Unicommerce)

**Optional** — if these are unset the app simply doesn't push POs to Uniware (`uniwareEnabled()` returns false and the mirror step is skipped) rather than failing at boot.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `UNIWARE_BASE_URL` | No | `""` | Tenant base URL. Empty ⇒ integration disabled. |
| `UNIWARE_USER_NAME` | No | `""` | OAuth username |
| `UNIWARE_PASSWORD` | No | `""` | OAuth password |
| `UNIWARE_CLIENT_ID` | No | `my-trusted-client` | Unicommerce's stock public OAuth client — no per-tenant value to configure |
| `UNIWARE_FACILITY` | No | `TEST_FACILITY` | `purchaseOrder/create` is facility-scoped, so this decides where a PO lands |
| `UNIWARE_VENDOR_CODE` | No | `Test_Vendor` | Uniware vendors are configured per facility and are **not** `master_mfgs.code` (pushing that fails with `Vendor [...] is not configured for the facility`) |

> ⚠️ `UNIWARE_FACILITY` and `UNIWARE_VENDOR_CODE` both default to sandbox values and **must be overridden before going live**, or every PO lands against the test vendor in the test facility. See [PO Inwarding](./po-inwarding.md).

### Observability

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `LOG_LEVEL` | No | `info` | Winston log level: `error`, `warn`, `info`, `debug`. Set to `debug` for verbose query/request tracing in development. |

### Database connection pool settings

These are hardcoded in `lib/db.ts`. Change them there if your environment requires different values.

| Setting | Value | Notes |
|---------|-------|-------|
| `connectionLimit` | `10` | Max concurrent DB connections |
| `ssl.rejectUnauthorized` | `false` | Allows self-signed RDS certificates |
| `enableKeepAlive` | `true` | Prevents idle connection drops |
| `keepAliveInitialDelay` | `10000 ms` | Delay before first keep-alive probe |
| `connectTimeout` | `10000 ms` | Timeout for establishing a connection |
| Auto-retry | 1 attempt | Retries once on `ECONNRESET` / `PROTOCOL_CONNECTION_LOST` |

## npm Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the Next.js development server on port 3000 with hot reload |
| `npm run build` | Compile a production build — run before every merge to catch type errors |
| `npm run start` | Serve the production build (requires `npm run build` first) |
| `npm run lint` | Run ESLint — must pass before committing |
| `npm run db:seed` | Seed the minimum `page_permissions` rows the tool needs to be usable at all — see below |
| `npm run db:test` | Run a `SELECT NOW()` to verify the database connection and SSL |

## Prisma Commands

Prisma is used for **schema definition and migrations only** — the Prisma Client is not used at runtime. All runtime queries use `lib/db.ts` directly.

| Command | Description |
|---------|-------------|
| `npx prisma migrate dev --name <name>` | Create a new migration file and apply it locally |
| `npx prisma migrate deploy` | Apply all pending migrations in production/staging |
| `npx prisma studio` | Open a browser-based GUI to explore the schema and data |
| `npx prisma generate` | Regenerate the Prisma Client after schema changes (rarely needed at runtime) |
| `npx prisma db push` | Sync schema directly without creating a migration file — development only |

> After any `prisma migrate` or `prisma db push`, restart the dev server to pick up schema changes.

## scripts/ Directory

| File | Purpose | When to run |
|------|---------|------------|
| `scripts/seed-permissions.ts` | Seeds **two rules only**: `/admin` → `developer` + `admin`, and `/approvals` → the four `*_head` roles (derived from `APPROVER_ROLES`, so a new domain can't be added without its Head getting approval rights). Both slugs have no parent for `lib/permissions.ts`' walk to fall back to, which makes them deny-by-default with no way to fix from inside the UI. Everything else is granted from `/admin > Permissions`. Idempotent. | On a fresh database, or after adding a domain to `lib/roles.ts`. Run with `npm run db:seed`. |
| `scripts/seed-test-users.js` | Creates sample user accounts for development and testing. | Once, on a fresh development database. Run with `npx tsx scripts/seed-test-users.js`. |
| `scripts/test-connection.js` | Verifies database connectivity by running a `SELECT NOW()`. Exits with code 1 on failure. | Any time you want to confirm the DB connection is healthy. Run with `npm run db:test`. |
| `scripts/sync-skus-from-dwh.ts`, `backfill-rm-codes.ts`, `list-s3.ts`, `explain-check.ts`, `invoice_reading_nanonets.ts`, `add_uniware_inward_po.js` | One-off data / integration utilities: DWH SKU sync, RM code backfill, S3 listing, `EXPLAIN` on the heavy queries, a standalone Nanonets parse, a standalone Uniware inward-PO push | As needed, via `npx tsx scripts/<file>` |

> The old 51-row role × page matrix in `seed-permissions.ts` is gone — it granted access to roles nobody held (`production_operations`, `cost_creator`, `bom_creator`). `prisma/migrate_role_taxonomy.sql` cleans those out of an existing database.

### `_check-*.ts` verification scripts

Ad-hoc assertions written alongside each feature, run with `npx tsx scripts/<file>`. They hit the real database, so they are read-mostly and safe to re-run; keep adding one per non-trivial change rather than verifying by clicking.

| Script | Verifies |
|--------|----------|
| `_check-admin-panel.ts` | The admin tabs' queries and mutations |
| `_check-admin-authority.ts` | `app/admin/authority.ts` resolves effect + provenance the same way `resolveAccess` does |
| `_check-role-taxonomy.ts` | No role string outside `lib/roles.ts` survived the migration |
| `_check-entity-scope.ts` | `lib/scope.ts` helpers and the scoped queries (including that unrestricted users see exactly what they did before) |
| `_check-invoice-mapping.ts` | Fuzzy invoice → masters matching |
| `_check-inward-count.ts`, `_check-inward-sequence.ts`, `_check-inward-mail-summary.ts` | Invoice inwarding: rows written, step order, the warehouse mail summary |
| `_check-uniware-push.ts`, `_check-uniware-po-pdf.ts` | Uniware PO create and PO-document fetch |
| `_check-backdated-po.ts` | Inward POs take the invoice's own date as `expected_on` |
| `_check-po-status-filter.ts` | The PO list's status/`po_type` filter values, including the `inward` tab |
| `_check-sku-dedup.ts` | SKU de-duplication |

## Google Sheets Integration

The `/api/v1/google-sheet` endpoint fetches Google Sheets data as CSV. No Google API key is required — it uses the public CSV export URL.

**Requirement:** The sheet must be published publicly.
1. In Google Sheets: **File → Share → Publish to web**
2. Choose **Comma-separated values (.csv)** format
3. Copy the published URL and pass it as the `url` query parameter

A private or organisation-restricted sheet returns a 403/401 from Google, which the route surfaces as a 500 with an explanatory error message.

## next.config.ts

```ts
const nextConfig: NextConfig = {
  serverExternalPackages: [
    "mysql2",
    "@react-pdf/renderer", "fontkit", "pdfkit", "nodemailer",
    "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner",
  ],
};
```

`serverExternalPackages` tells Next.js not to bundle these packages into the server bundle. `mysql2`, the AWS SDK, and `@react-pdf/renderer` all use native Node.js APIs or binary addons that fail when bundled. **Do not remove any entry from this list.**
