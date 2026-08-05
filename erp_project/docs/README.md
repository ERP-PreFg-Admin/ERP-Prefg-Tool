# ERP System — Documentation Index

This index is the single entry point for understanding the ERP codebase. Read documents in the order shown below; each one builds on the previous.

## Quick Reading Order

| # | Document | What you learn |
|---|----------|----------------|
| 1 | [Getting Started](./getting-started.md) | Install, configure env vars, start the dev server |
| 2 | [Architecture](./architecture.md) | Tech stack, request lifecycles, folder map |
| 3 | [Database Schema](./database-schema.md) | All 25+ models, relationships, naming conventions |
| 4 | [Authentication & Permissions](./authentication-and-permissions.md) | Google OAuth, RBAC, session lifecycle |
| 5 | [API Reference](./api-reference.md) | Every endpoint: method, body, response |
| 6 | [Masters Module](./masters-module.md) | The fully-implemented reference module |
| 7 | [Frontend Patterns](./frontend-patterns.md) | Server/client split, styling, components |

## Feature Docs

| Document | What it covers |
|----------|----------------|
| [Admin Panel & Data Scoping](./admin-and-data-scoping.md) | `/admin` (Users · Permissions · Data Access · Activity), the declared role taxonomy, per-user entity scope, the activity trail |
| [PO Inwarding](./po-inwarding.md) | Supplier-invoice PDF → Nanonets extraction → review → inward POs / goods receipts → Uniware mirror → warehouse notification |
| [S3 Integration](./s3-integration.md) | Bucket layout, key conventions, presigned URLs, event writes |

## Developer Guides

| Document | Purpose |
|----------|---------|
| [Adding a New Module](./adding-a-new-module.md) | Step-by-step recipe for building a module from scratch |
| [Environment Variables & Scripts](./environment-and-scripts.md) | All env vars, npm scripts, Prisma commands, seed + verification scripts |

## Architecture Roadmap (pre-existing)

These docs capture ongoing architectural decisions. Do not edit them without consulting the owner.

| Document | Status | Topic |
|----------|--------|-------|
| [Architecture Evolution Plan](./architecture-evolution.md) | Proposed | In-app API gateway layer + event-driven backbone |
| [Event-Driven Options](./event-driven-options.md) | For review | Comparison of event backbone options (in-process, EventBridge, MSK, Redis) |

## Module Status

| Module | Status | Location |
|--------|--------|----------|
| Masters (SKUs, Vendors, Manufacturers, RM, PM, BOM) | Complete | `app/masters/` |
| Material Master (flat RM + PM view) | Complete | `app/masters/material-master/` |
| Approvals (queue, grouped sections, history) | Complete | `app/approvals/` |
| Admin Panel (Users · Permissions · Data Access · Activity) | Complete | `app/admin/` |
| MFG Cost Manager | Live (2 tabs are placeholders: Common RMs, Vendor Ing Mapping) | `app/manufacturing/` |
| PO Tracking — FG POs Tracking | Live | `app/po-tracking/po-procurement/` |
| PO Tracking — PO Inwarding + invoice inwarding | Live | `app/po-tracking/po-inwarding/` |
| PO Tracking — MFG Overview | Live | `app/po-tracking/mfg-overview/` |
| PO Tracking — RM/PM Procurement | Stub | `app/po-tracking/rm-pm-procurement/` |
| Finance & Accounting | Stub | `app/finance/` |
| HR & Payroll | Stub | `app/hr-payroll/` |
| Inventory Management | Stub | `app/inventory/` |
| Sales & CRM | Stub | `app/sales-crm/` |
| Reports & Analytics | Stub | `app/reports/` |
| Sheet Viewer | Partial | `app/sheet-viewer/` |
