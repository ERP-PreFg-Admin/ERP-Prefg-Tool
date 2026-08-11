# ERP System

A full-stack Enterprise Resource Planning system built with Next.js 16, TypeScript, Tailwind CSS v4, and MariaDB.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript 5 |
| Styling | Tailwind CSS v4 |
| Database | MariaDB |
| DB Client | `mysql2/promise` connection pool (via `lib/db.ts`) |
| ORM | Prisma 7 (schema management + migrations only) |
| Auth | NextAuth v5 (credentials + Google OAuth) |

> **Note:** Application queries use the `mysql2` pool directly via `lib/db.ts` helpers (`query<T>()`, `execute()`). Prisma is used for schema definition and migrations, not for runtime queries.

---

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Create a `.env` file at the project root:

```env
# Database
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=yourpassword
DB_NAME=erp_db

# NextAuth
AUTH_SECRET=your-auth-secret

# Google OAuth (optional)
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
```

### 3. Run database migrations

```bash
npm run db:migrate
```

### 4. Seed test data (optional)

```bash
npm run db:seed
```

### 5. Start development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## NPM Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start development server |
| `npm run build` | Verify production build |
| `npm run lint` | Run ESLint checks |
| `npm run db:generate` | Regenerate Prisma client after schema changes |
| `npm run db:migrate` | Create and apply a new migration |
| `npm run db:push` | Push schema changes without migration history |
| `npm run db:studio` | Open Prisma Studio (DB GUI) |
| `npm run db:seed` | Seed the database with test data |
| `npm run db:test` | Test the database connection |

---

## Project Structure

```
erp_project/
├── app/
│   ├── api/
│   │   └── masters/
│   │       ├── raw-materials/route.ts       # RM CRUD + wizard actions
│   │       ├── packing-materials/route.ts   # PM CRUD + wizard actions
│   │       └── material-master/route.ts     # Unified RM/PM base insert
│   ├── auth/                                # Sign-in / error pages
│   ├── masters/
│   │   ├── raw-materials/                   # Raw Materials master page
│   │   ├── packing-materials/               # Packing Materials master page
│   │   └── material-master/                 # Material Master flat view
│   ├── generated/prisma/                    # Auto-generated Prisma client (do not edit)
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
├── components/
│   ├── masters/                             # Shared table, toolbar, dialog, CSV components
│   ├── ui/                                  # shadcn/ui primitives
│   └── Sidebar.tsx
├── lib/
│   ├── db.ts                                # mysql2 pool singleton + query/execute helpers
│   ├── auth.ts                              # NextAuth config
│   ├── permissions.ts                       # RBAC resolver
│   └── queries/                             # Centralized SQL strings
│       ├── raw-materials.ts
│       ├── product-materials.ts
│       ├── vendors.ts
│       └── manufacturers.ts
├── prisma/
│   └── schema.prisma                        # Source of truth for DB schema
├── types/
│   └── masters.ts                           # Shared TypeScript types for master data
└── scripts/
    ├── seed-test-users.js
    └── test-connection.js
```

---

## Modules Built

### Masters

#### Raw Materials (`/masters/raw-materials`)
- Toggle between **By Vendor** and **By Manufacturer** views
- Sortable, searchable, filterable table
- **Add Raw Material Wizard** — 3-step dialog:
  - Step 1: Material details (Name, Make, INCI Name, Type, UOM, HSN Code, Status) — duplicate check before advancing
  - Step 2: Vendor pricing (one or more vendors; rate, MOQ; warns if vendor rate already exists and will be updated)
  - Step 3: Manufacturer selection (approve one or more manufacturers)
- CSV bulk import
- Backend: archives old vendor rates to `vrm_history` before updating (audit trail)

#### Packing Materials (`/masters/packing-materials`)
- Same structure as Raw Materials (By Vendor / By Manufacturer toggle)
- **Add Packing Material Wizard** — identical 3-step pattern adapted for PM fields
- Backend: same vrm_history archival for vendor rate updates

#### Material Master (`/masters/material-master`)
- Flat view of all materials — toggle between **Raw Material** and **Packing Material**
- Shows base material data only (no rate columns)
- **Add Material dialog** — simple single-step form, no vendor/manufacturer steps
  - RM fields: Name\*, Make\*, INCI Name\*, Type, UOM, HSN Code, Status
  - PM fields: Name\*, Type\*, UOM, HSN Code, Status
- Dedicated API route: `POST /api/v1/masters/material-master`

---

## API Routes

### `POST /api/v1/masters/raw-materials`

| `action` | Description |
|---|---|
| `create` | Insert a single RM record (optionally with one vendor or mfg rate row) |
| `check-RM` | Duplicate check by name + make + INCI name |
| `check-vendor` | Check if a vendor rate already exists for this material |
| `create-full` | Full wizard submit — insert RM + upsert vendor rates + add mfg approvals (transaction) |
| `bulk` | CSV bulk import |

### `POST /api/v1/masters/packing-materials`

| `action` | Description |
|---|---|
| `create` | Insert a single PM record |
| `check-PM` | Duplicate check by name + type |
| `check-vendor` | Check if a vendor rate exists for this material |
| `create-full` | Full wizard submit — insert PM + upsert vendor rates + mfg approvals (transaction) |
| `bulk` | CSV bulk import |

### `POST /api/v1/masters/material-master`

| `action` | `material` | Description |
|---|---|---|
| `create` | `rm` | Insert base RM record only (no rate rows) |
| `create` | `pm` | Insert base PM record only (no rate rows) |

---

## Database Access Pattern

All application queries go through two helpers in `lib/db.ts`:

```ts
query<T>(sql: string, params?: any[]): Promise<T[]>   // SELECT
execute(sql: string, params?: any[]): Promise<ResultSetHeader>  // INSERT / UPDATE
```

Both helpers include a single automatic retry on fatal connection errors (`ECONNRESET`, `PROTOCOL_CONNECTION_LOST`). SQL strings are centralized in `lib/queries/` — no inline SQL in route handlers or components.

For multi-step mutations (e.g. RM create-full), route handlers acquire a connection from the pool directly (`pool.getConnection()`), run within a transaction, and release the connection in a `finally` block.

---

## Key Database Tables

| Table | Purpose |
|---|---|
| `rm` | Raw material master records |
| `rm_vrm` | Raw material — vendor rates |
| `rm_mrm` | Raw material — manufacturer approvals |
| `pm` | Packing material master records |
| `pm_vrm` | Packing material — vendor rates |
| `pm_mrm` | Packing material — manufacturer approvals |
| `vrm_history` | Archived vendor rates (covers both RM and PM via `mtrl_type` enum) |
| `vendors` / `vendor_details` | Vendor master |
| `manufacturers` / `mfg_details` | Manufacturer master |

---

## Planned

- Redis caching layer for master data reads (plan documented in `.claude/plans/`)
- HR & Payroll module
- Inventory Management
- Sales & CRM
- Finance & Accounting
- Manufacturing
- Reports & Analytics
