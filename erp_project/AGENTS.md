# ERP Project Agent Instructions
Next.js 16 App Router + React 19 + TypeScript + Tailwind CSS v4, on **MySQL 8.0**
(AWS RDS) via `mysql2`. Prisma 7 is present but **schema-only**.

**`CLAUDE.md` is the detailed reference.** This file is the short version; where
the two disagree, CLAUDE.md wins.

## What matters here
- Keep changes aligned with the App Router structure in `app/` and the SQL in `lib/queries/`.
- Database access goes through `query` / `execute` / `pool` from `lib/db.ts`. **Prisma Client is never used at runtime** — there is no Prisma singleton.
- Do not edit generated files under `app/generated/prisma/`.
- **Table names were renamed in 2026-08** and `prisma/schema.prisma` was not updated. Check `lib/queries/*.ts` for the real name, or the mapping in CLAUDE.md — never the Prisma schema.
- API routes live under `app/api/v1/`. `/api/auth` and `/api/health` stay unversioned; external systems address them by URL.

## Commands to use
- `npm run dev` — start the app
- `npm run build` — verify production build
- `npm run lint` — full ESLint (~220 pre-existing problems)
- `npm run lint:changed` — ESLint on changed files only; **this is the gate**
- `npm test` — unit tests (`node:test`, no DB, no credentials)
- `npm run test:db` — DB tests, each rolled back

Two gotchas worth knowing before you trust a green check:

- `npx tsc --noEmit` can report clean on a file `npm run build` then rejects — `tsconfig.json` has `"incremental": true` and a stale `tsconfig.tsbuildinfo` skips it. Use `--incremental false` when it matters.
- `npm run build` refuses to start while `npm run dev` is running; Next 16 takes a single lock on `.next`.
- A unit test may only import **pure** modules. Anything reaching `lib/db`, `lib/s3` or `lib/mail/mailer` throws at import without credentials, which is why logic worth testing gets extracted (`lib/po-split.ts`, `lib/invoice/invoice-merge.ts`, `lib/mail/recipients.ts`, `lib/mail/mail-limits.ts`, `lib/po/po-rules.ts`).

There is **no** `db:test` / `db:generate` / `db:migrate` / `db:push` / `db:seed`
npm alias, despite older docs referencing them. Prisma is invoked as raw
`npx prisma …`, and migrations in practice are the hand-written `prisma/*.sql`
files applied directly to RDS.

## Working conventions
- Prefer TypeScript and existing Next.js patterns over ad-hoc scripts.
- Verify a table or column name against `lib/queries/` before using it — the rename left four columns deliberately spelled `bom_*`.
- Keep database access centralized in `lib/db.ts`; never import from `app/generated/prisma/client` in application code.
- DB config comes from `DB_HOST` / `DB_USER` / `DB_PASSWORD` / `DB_NAME_TEST` | `DB_NAME_PROD` (see `lib/env.ts`), **not** `DATABASE_URL`.

<!-- BEGIN:nextjs-agent-rules -->
This project uses a newer Next.js stack than older training examples. If you encounter unexpected behavior, consult the local Next.js docs in `node_modules/next/dist/docs/` before making assumptions.
<!-- END:nextjs-agent-rules -->
