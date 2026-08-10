/**
 * Approval Module Handlers — Strategy Pattern
 *
 * Each entry in MODULE_HANDLERS owns the full approve/reject logic for one
 * module code. Adding a new module means adding one object in the relevant
 * lib/approvals/handlers/*.ts file (grouped by domain, mirroring
 * lib/queries/'s layout) and registering it below; the route handler
 * (app/api/v1/approvals/[id]/route.ts) never changes.
 *
 * Interface:
 *   setStatus       — called on reject: marks entity as "rejected"
 *   applyAndArchive — called on approve: archives old snapshot, applies diff
 *
 * All methods run inside the caller's open transaction. They must NOT call
 * beginTransaction / commit / rollback — that is the route handler's job.
 */

import { skuHandler } from "./handlers/sku"
import { rmRateHandler, rmVrmHandler, rmMatHandler, rmBulkHandler, rmVrmBulkHandler, rmRateBulkHandler } from "./handlers/raw-materials"
import { pmRateHandler, pmVrmHandler, pmMatHandler, pmBulkHandler, pmVrmBulkHandler, pmRateBulkHandler } from "./handlers/packing-materials"
import { vendorHandler, vendorBulkHandler } from "./handlers/vendors"
import { mfgHandler, mfgBulkHandler } from "./handlers/manufacturers"
import { poHandler, poBulkHandler } from "./handlers/purchase-orders"
import { bomHandler, bomBulkHandler } from "./handlers/recipe"

import type { DiffItem, ModuleHandler } from "./handlers/types"
export type { DiffItem, ModuleHandler }

// ── Registry ─────────────────────────────────────────────────────────────────

export const MODULE_HANDLERS: Record<string, ModuleHandler> = {
  SKU:     skuHandler,
  RM_RATE: rmRateHandler,
  PM_RATE: pmRateHandler,
  RM_VRM:  rmVrmHandler,
  PM_VRM:  pmVrmHandler,
  RM_MAT:  rmMatHandler,
  PM_MAT:  pmMatHandler,
  VENDOR:  vendorHandler,
  MFG:     mfgHandler,
  PO:      poHandler,
  PO_BULK: poBulkHandler,
  VENDOR_BULK: vendorBulkHandler,
  MFG_BULK: mfgBulkHandler,
  RM_BULK: rmBulkHandler,
  PM_BULK: pmBulkHandler,
  RM_VRM_BULK: rmVrmBulkHandler,
  RM_RATE_BULK: rmRateBulkHandler,
  PM_VRM_BULK: pmVrmBulkHandler,
  PM_RATE_BULK: pmRateBulkHandler,
  BOM:     bomHandler,
  BOM_BULK: bomBulkHandler,
}
