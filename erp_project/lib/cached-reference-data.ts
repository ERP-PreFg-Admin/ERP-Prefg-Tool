/**
 * Cached reference-data lookups.
 *
 * These are small, rarely-changing lists (vendors, manufacturers, distinct
 * type/make dropdowns, PO dropdown options) that were previously re-queried
 * on every single masters/PO page load. Wrapping them in `unstable_cache`
 * removes those redundant round-trips without adding any new infrastructure.
 *
 * Revalidation is time-based (REVALIDATE_SECONDS) rather than tag-driven —
 * a new vendor/manufacturer/material can take up to that long to appear in
 * dropdowns after approval. If that staleness window becomes a problem,
 * call `revalidateTag()` with the relevant tag right after the approval
 * commits in the module handler instead of shortening this window.
 */

import { unstable_cache } from "next/cache"
import { timedQuery } from "@/lib/query-timing"
import { vendors as vendorSql } from "@/lib/queries/vendors"
import { manufacturers as mfgSql } from "@/lib/queries/manufacturers"
import { rawMaterials } from "@/lib/queries/raw-materials"
import { packingMaterials } from "@/lib/queries/packing-materials"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { skus as skusSql } from "@/lib/queries/skus"
import { manufacturingSql } from "@/lib/queries/manufacturing"
import type { Vendor, Mfg, Sku, AgreedPmRateRow, AgreedRmRateRow, RmVendorRow, RmVendorHistoryRow, PmVendorRow, PmVendorHistoryRow } from "@/types/masters"

const REVALIDATE_SECONDS = 120

export const getVendorReferenceList = unstable_cache(
  () => timedQuery<Vendor>(vendorSql.selectAll, [], { label: "vendors.selectAll (cached)" }),
  ["ref-vendor-list"],
  { revalidate: REVALIDATE_SECONDS, tags: ["ref:vendors"] }
)

export const getManufacturerReferenceList = unstable_cache(
  () => timedQuery<Mfg>(mfgSql.selectAll, [], { label: "manufacturers.selectAll (cached)" }),
  ["ref-mfg-list"],
  { revalidate: REVALIDATE_SECONDS, tags: ["ref:manufacturers"] }
)

export const getRmDistinctMakes = unstable_cache(
  () => timedQuery<{ make: string }>(rawMaterials.selectDistinctMakes, [], { label: "rm.selectDistinctMakes (cached)" }),
  ["ref-rm-makes"],
  { revalidate: REVALIDATE_SECONDS, tags: ["ref:rm"] }
)

export const getRmDistinctTypes = unstable_cache(
  () => timedQuery<{ type: string }>(rawMaterials.selectDistinctTypes, [], { label: "rm.selectDistinctTypes (cached)" }),
  ["ref-rm-types"],
  { revalidate: REVALIDATE_SECONDS, tags: ["ref:rm"] }
)

export const getRmDistinctInciNames = unstable_cache(
  () => timedQuery<{ inci_name: string }>(rawMaterials.selectDistinctInciNames, [], { label: "rm.selectDistinctInciNames (cached)" }),
  ["ref-rm-inci-names"],
  { revalidate: REVALIDATE_SECONDS, tags: ["ref:rm"] }
)

export const getPmDistinctTypes = unstable_cache(
  () => timedQuery<{ make: string }>(packingMaterials.selectDistinctMakes, [], { label: "pm.selectDistinctMakes (cached)" }),
  ["ref-pm-types"],
  { revalidate: REVALIDATE_SECONDS, tags: ["ref:pm"] }
)

// ── Recipe master dropdowns ──────────────────────────────────────────────────
// SKU/RM/PM "active" lists feeding the Recipe creation wizard + line-editor
// grid's material pickers. Same rarely-changing-lookup shape as the vendor/
// mfg lists above, so they share those tags' invalidation story.

export const getActiveSkuList = unstable_cache(
  () => timedQuery<Sku>(skusSql.selectActive, [], { label: "skus.selectActive (cached)" }),
  ["ref-sku-active-list"],
  { revalidate: REVALIDATE_SECONDS, tags: ["ref:skus"] }
)

// ── SKU filter-panel dropdown options ───────────────────────────────────────
// Distinct brand/sku_type/category/subcategory values for the /masters/skus
// filter panel — small, rarely-changing lists, same caching story as above.

export const getSkuDistinctBrands = unstable_cache(
  () => timedQuery<{ brand: string }>(skusSql.selectDistinctBrands, [], { label: "skus.selectDistinctBrands (cached)" }),
  ["ref-sku-brands"],
  { revalidate: REVALIDATE_SECONDS, tags: ["ref:skus"] }
)

export const getSkuDistinctSkuTypes = unstable_cache(
  () => timedQuery<{ sku_type: string }>(skusSql.selectDistinctSkuTypes, [], { label: "skus.selectDistinctSkuTypes (cached)" }),
  ["ref-sku-types"],
  { revalidate: REVALIDATE_SECONDS, tags: ["ref:skus"] }
)

export const getSkuDistinctCategories = unstable_cache(
  () => timedQuery<{ category: string }>(skusSql.selectDistinctCategories, [], { label: "skus.selectDistinctCategories (cached)" }),
  ["ref-sku-categories"],
  { revalidate: REVALIDATE_SECONDS, tags: ["ref:skus"] }
)

export const getSkuDistinctSubcategories = unstable_cache(
  () => timedQuery<{ subcategory: string }>(skusSql.selectDistinctSubcategories, [], { label: "skus.selectDistinctSubcategories (cached)" }),
  ["ref-sku-subcategories"],
  { revalidate: REVALIDATE_SECONDS, tags: ["ref:skus"] }
)

export const getActiveRmMaterialOptions = unstable_cache(
  () =>
    timedQuery<{ id: number; rm_code: string | null; name: string; uom: string | null }>(
      rawMaterials.selectActive,
      [],
      { label: "rm.selectActive (cached)" }
    ),
  ["ref-rm-active-options"],
  { revalidate: REVALIDATE_SECONDS, tags: ["ref:rm"] }
)

export const getActivePmMaterialOptions = unstable_cache(
  () =>
    timedQuery<{ id: number; pm_code: string | null; name: string; uom: string | null }>(
      packingMaterials.selectActive,
      [],
      { label: "pm.selectActive (cached)" }
    ),
  ["ref-pm-active-options"],
  { revalidate: REVALIDATE_SECONDS, tags: ["ref:pm"] }
)

export const getPoDropdownOptions = unstable_cache(
  async () => {
    const [skus, mfgs, warehouses] = await Promise.all([
      timedQuery<any>(purchaseOrdersSql.skuOptions, [], { label: "po.skuOptions (cached)" }),
      timedQuery<any>(purchaseOrdersSql.mfgOptions, [], { label: "po.mfgOptions (cached)" }),
      timedQuery<any>(purchaseOrdersSql.warehouseOptions, [], { label: "po.warehouseOptions (cached)" }),
    ])
    return { skus, mfgs, warehouses }
  },
  ["ref-po-dropdown-options"],
  { revalidate: REVALIDATE_SECONDS, tags: ["ref:po-options"] }
)

// ── Manufacturing module: RM Vendor / Agreed Rates ──────────────────────────
// Agreed cost_master_rm_mfg/cost_master_pm_mfg rates rarely change (only on an RM_RATE/
// PM_RATE approval) — cache per-manufacturer and revalidate on a long timer,
// backstopped by an immediate revalidateTag() right after that approval
// commits (see app/api/v1/approvals/[id]/route.ts), so a rate change shows up
// on next load instead of waiting out the timer.
const MFG_RATES_REVALIDATE_SECONDS = 900

export const getRmVendorByMfg = unstable_cache(
  (mfgId: number) => timedQuery<RmVendorRow>(manufacturingSql.selectRmVendorByMfg, [mfgId], { label: "manufacturing.selectRmVendorByMfg (cached)" }),
  ["ref-mfg-rm-vendor"],
  { revalidate: MFG_RATES_REVALIDATE_SECONDS, tags: ["ref:mfg-rm-rates"] }
)

export const getRmVendorHistoryByMfg = unstable_cache(
  (mfgId: number) => timedQuery<RmVendorHistoryRow>(manufacturingSql.selectRmVendorHistoryByMfg, [mfgId], { label: "manufacturing.selectRmVendorHistoryByMfg (cached)" }),
  ["ref-mfg-rm-vendor-history"],
  { revalidate: MFG_RATES_REVALIDATE_SECONDS, tags: ["ref:mfg-rm-rates"] }
)

export const getPmVendorByMfg = unstable_cache(
  (mfgId: number) => timedQuery<PmVendorRow>(manufacturingSql.selectPmVendorByMfg, [mfgId], { label: "manufacturing.selectPmVendorByMfg (cached)" }),
  ["ref-mfg-pm-vendor"],
  { revalidate: MFG_RATES_REVALIDATE_SECONDS, tags: ["ref:mfg-pm-rates"] }
)

export const getPmVendorHistoryByMfg = unstable_cache(
  (mfgId: number) => timedQuery<PmVendorHistoryRow>(manufacturingSql.selectPmVendorHistoryByMfg, [mfgId], { label: "manufacturing.selectPmVendorHistoryByMfg (cached)" }),
  ["ref-mfg-pm-vendor-history"],
  { revalidate: MFG_RATES_REVALIDATE_SECONDS, tags: ["ref:mfg-pm-rates"] }
)

export const getAgreedRmRatesByMfg = unstable_cache(
  (mfgId: number) => timedQuery<AgreedRmRateRow>(manufacturingSql.selectAgreedRmRatesByMfg, [mfgId], { label: "manufacturing.selectAgreedRmRatesByMfg (cached)" }),
  ["ref-mfg-agreed-rm-rates"],
  { revalidate: MFG_RATES_REVALIDATE_SECONDS, tags: ["ref:mfg-rm-rates"] }
)

export const getAgreedPmRatesByMfg = unstable_cache(
  (mfgId: number) => timedQuery<AgreedPmRateRow>(manufacturingSql.selectAgreedPmRatesByMfg, [mfgId], { label: "manufacturing.selectAgreedPmRatesByMfg (cached)" }),
  ["ref-mfg-agreed-pm-rates"],
  { revalidate: MFG_RATES_REVALIDATE_SECONDS, tags: ["ref:mfg-pm-rates"] }
)

// ── Which approval modules invalidate which cached list ──────────────────────
/**
 * Approval module code -> the cache tags its approval makes stale.
 *
 * A MAP rather than a chain of `if (module === ...) revalidateTag(...)` in the
 * approvals route, because that chain was the bug: it covered RM_RATE, PM_RATE and
 * WAREHOUSE and silently omitted everything else. An approved manufacturer stayed
 * missing from the PO and invoice dropdowns for up to REVALIDATE_SECONDS, which
 * reads as "the master didn't save".
 *
 * Declared HERE, beside the caches, so a tag and the modules that dirty it are
 * defined together — adding a cached list means adding its invalidators in the same
 * file rather than remembering a route two directories away.
 *
 * The *_BULK variants matter as much as the singular ones: they are how several
 * masters get created at a time, so omitting them means a bulk upload is exactly
 * the case that does not show up.
 *
 * `ref:po-options` is one cache holding SKUs, manufacturers AND warehouses
 * (getPoDropdownOptions), so all three families list it.
 */
export const CACHE_TAGS_BY_MODULE: Record<string, string[]> = {
  // Feeds the PO + invoice dialogs' manufacturer dropdown.
  MFG:            ["ref:manufacturers", "ref:po-options"],
  MFG_BULK:       ["ref:manufacturers", "ref:po-options"],
  // …their destination dropdown, per (site, legal entity).
  WAREHOUSE:      ["ref:po-options"],
  // …and their SKU pickers.
  SKU:            ["ref:skus", "ref:po-options"],
  VENDOR:         ["ref:vendors"],
  VENDOR_BULK:    ["ref:vendors"],
  RM_MAT:         ["ref:rm"],
  RM_BULK:        ["ref:rm"],
  PM_MAT:         ["ref:pm"],
  PM_BULK:        ["ref:pm"],
  RM_RATE:        ["ref:mfg-rm-rates"],
  RM_RATE_BULK:   ["ref:mfg-rm-rates"],
  PM_RATE:        ["ref:mfg-pm-rates"],
  PM_RATE_BULK:   ["ref:mfg-pm-rates"],
  RM_VRM:         ["ref:rm"],
  RM_VRM_BULK:    ["ref:rm"],
  PM_VRM:         ["ref:pm"],
  PM_VRM_BULK:    ["ref:pm"],
}
