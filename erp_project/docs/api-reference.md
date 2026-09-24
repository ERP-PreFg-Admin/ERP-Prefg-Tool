# API Reference

> **The per-route reference moved to [`docs/api/`](./api/README.md)** — one file per
> domain, every handler with its access rule, scope rule, request schema, example
> payload, example response and error codes.

This file is kept as the entry point because `docs/README.md`, `CLAUDE.md` and several
plan docs link to it.

| Start here | For |
|---|---|
| [`api/README.md`](./api/README.md) | The census — all 89 route files, 101 handlers, grouped by domain, with the verified quick-facts table |
| [`api/00-conventions.md`](./api/00-conventions.md) | What every route shares: the `withGateway` pipeline, access vs. scope, rate limiting, the error shape, the `action` discriminator, DB access rules, the approval flow, response conventions, observability |
| [`api-information-flow.md`](./api-information-flow.md) | How the modules hand data to each other — the approval gate, the costing chain, the PO lifecycle, the invoice pipeline, the Uniware sweeps, the bounce loop — with diagrams |
| [`api/known-issues.md`](./api/known-issues.md) | Defects found while documenting, and the doc drift corrected |

## By domain

| File | Handlers | Covers |
|---|---:|---|
| [`api/masters.md`](./api/masters.md) | 28 | SKU · Vendor · Manufacturer · Material Master · RM/PM Cost Masters · Recipe · Warehouse |
| [`api/admin-and-files.md`](./api/admin-and-files.md) | 19 | Users · permissions · entity scope · entity emails · S3 · SES webhook · health · auth |
| [`api/purchase-orders.md`](./api/purchase-orders.md) | 16 | Create · split · receive · cancel · close · mail · export |
| [`api/uniware.md`](./api/uniware.md) | 11 | Status/GRN/document sweeps · facility map · explorer · session · gatepass |
| [`api/manufacturing.md`](./api/manufacturing.md) | 9 | Production lines · misc costs · the seven costing exports |
| [`api/invoice.md`](./api/invoice.md) | 8 | Parse · commit · three-way match · payment · documents |
| [`api/approvals.md`](./api/approvals.md) | 5 | Queue · approve/reject · history |
| [`api/v2.md`](./api/v2.md) | 5 | What each v2 route adds over its v1 sibling |

---

**Do not add route detail to this file** — it will rot here, unnoticed. Add it in
`docs/api/`, where `tests/unit/docs-api-coverage.test.ts` fails the build if a route
exists with no entry, or if the census names a route that no longer exists.
