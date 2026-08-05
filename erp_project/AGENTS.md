# ERP Project Agent Instructions
Use this repository as a Next.js 16 App Router + React 19 + TypeScript + Tailwind CSS v4 project with Prisma 7 and MariaDB.

## What matters here
- Keep changes aligned with the App Router structure in `app/` and the Prisma schema in `prisma/schema.prisma`.
- Use the shared Prisma singleton from `lib/db.ts` for database access.
- Do not edit generated Prisma files under `app/generated/prisma/`; regenerate them with `npm run db:generate` after schema changes.
- The main project notes are in `README.md` and `CLAUDE.md`.

## Commands to use
- `npm run dev` — start the app
- `npm run build` — verify production build
- `npm run lint` — verify code quality
- `npm run db:test` — confirm the database connection
- `npx prisma generate` — regenerate Prisma client after schema updates
- `npx prisma migrate dev --name <name>` — create/apply migrations during development
- `npx prisma db push` — quick schema sync for local experiments

There is no `db:generate` / `db:migrate` / `db:push` npm alias — those are raw `npx prisma` commands.

## Working conventions
- Prefer TypeScript and existing Next.js patterns over ad-hoc scripts.
- When changing Prisma models, update the schema first, then run the relevant Prisma command before using new fields in code.
- Keep database access centralized in `lib/db.ts`; avoid importing from `app/generated/prisma/client` directly in application code.
- If a task depends on database setup, verify the `DATABASE_URL` environment variable exists first.

<!-- BEGIN:nextjs-agent-rules -->
This project uses a newer Next.js stack than older training examples. If you encounter unexpected behavior, consult the local Next.js docs in `node_modules/next/dist/docs/` before making assumptions.
<!-- END:nextjs-agent-rules -->
