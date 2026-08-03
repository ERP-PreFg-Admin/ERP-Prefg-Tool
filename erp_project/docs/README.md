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

## Developer Guides

| Document | Purpose |
|----------|---------|
| [Adding a New Module](./adding-a-new-module.md) | Step-by-step recipe for building a module from scratch |
| [Environment Variables & Scripts](./environment-and-scripts.md) | All env vars, npm scripts, Prisma commands, seed scripts |

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
| PO Tracking — PO Procurement | Partial (mock data) | `app/po-tracking/po-procurement/` |
| PO Tracking — PO Inwarding | Live | `app/po-tracking/po-inwarding/` |
| PO Tracking — RM/PM Procurement | Stub | `app/po-tracking/rm-pm-procurement/` |
| Finance & Accounting | Stub | `app/finance/` |
| HR & Payroll | Stub | `app/hr-payroll/` |
| Inventory Management | Stub | `app/inventory/` |
| Manufacturing | Stub | `app/manufacturing/` |
| Sales & CRM | Stub | `app/sales-crm/` |
| Reports & Analytics | Stub | `app/reports/` |
| Sheet Viewer | Partial | `app/sheet-viewer/` |
