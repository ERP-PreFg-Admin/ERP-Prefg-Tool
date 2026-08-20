/**
 * Master-data row types — the SINGLE SOURCE OF TRUTH for the shape of each
 * master table's rows as they travel from the database to the screen.
 *
 * Where this connects (the data flow for every master entity):
 *
 *   MariaDB table
 *     └─ lib/db `query<T>(sql)`            ← casts raw mysql2 rows to type T
 *         └─ app/masters/<entity>/page.tsx ← server component, runs the SELECT
 *             └─ <Entity>Client.tsx        ← client component, renders the table
 *
 * Both the server page and its client child import the SAME type from here,
 * so a column only ever has to be added/changed in ONE place. Keep each type
 * in sync with:
 *   - the `SELECT ... FROM <table>` column list in that entity's page.tsx
 *   - the real columns in prisma/schema.prisma
 *
 * These are plain data shapes (string / number / Date / null only) with no
 * runtime values or server-only imports, so they are safe to import from both
 * server components and "use client" components.
 */

/** `master_skus` table — Stock Keeping Units. Used by app/masters/skus. */
export type Sku = {
  id: number
  sku_code: string
  name: string
  /** Free text, and the grouping key for variant families with base_sku_sno.
   *  Display only — never use it in an access predicate; see brand_id. */
  brand: string | null
  /** master_brand.id — the access-boundary key. NULL = unattributed, therefore
   *  visible to every brand-scoped user. Optional because not every query
   *  selects it. */
  brand_id?: number | null
  category: string | null
  status: string | null
  created_at: Date | null
  /** FK to users.id; optional because not every page selects it. */
  created_by?: number | null
  /** Native master_skus columns; optional since not every query selects them (e.g. selectByCode). */
  sku_type?: string | null
  subcategory?: string | null
  filling?: number | null
  filling_uom?: string | null
  mrp?: number | null
  gst?: number | null
  active_bom_id?: number | null
  updated_by?: number | null
  updated_on?: Date | null
  /** Below fields come from the SKU data warehouse (mcaff_dwh); optional since master_skus doesn't have them. */
  sub_category?: string | null
  hsn?: string | null
  launch_date?: string | null
  /** Grouping key for the variants popup; only selected by skus.selectPaginated/selectAllFiltered. */
  base_sku_sno?: number | null
  /** Joined in by skus.selectPaginated/selectAllFiltered — count of SKUs sharing this row's brand + base_sku_sno. */
  variant_count?: number
  /** Resolved server-side (page.tsx) from master_skus.active_bom_id via lib/queries/bom.ts's selectBomCodesByIds. */
  bom_code?: string | null
}

/**
 * Per-SKU rollup of the gaps that stop Agreed Final Costing from producing a
 * number — skus.selectCostingGapsBySkuIds. Only SKUs with an active recipe
 * carrying active lines get a row, so an absent entry is itself a reason.
 */
export type CostingGap = {
  sku_id: number
  /** Manufacturers this SKU's recipe is mapped to. 0 ⇒ the rate counts below are meaningless. */
  mfg_count: number
  rm_line_count: number
  pm_line_count: number
  rm_lines_without_rate: number
  pm_lines_without_rate: number
}

/** Shape shared by both variant-listing queries in lib/queries/skus.ts. */
export type SkuVariantRow = {
  id: number
  sku_code: string
  name: string
  sku_type: string | null
  category: string | null
  subcategory: string | null
  filling: number | null
  filling_uom: string | null
  mrp: number | null
  status: string | null
}

/**
 * One row of `skus.selectGroupedByBrandAndSno` (lib/queries/skus.ts) — a
 * family of SKUs sharing the same brand + base_sku_sno grouping key.
 */
export type SkuGroup = {
  brand: string
  base_sku_sno: number
  sku_count: number
  /** Parsed from the query's GROUP_CONCAT(JSON_OBJECT(...)) skus_json column. */
  skus: SkuVariantRow[]
}

/** `mfgs` table — Manufacturers (MFGs). Used by app/masters/manufacturers. */
export type Mfg = {
  id: number | null
  mfg_id: number
  code: string
  name: string
  location: string | null
  gst_number: string | null
  status: string | null
  registered_name: string | null
  zone: string | null
  bank_name: string | null
  ifsc_number: string | null
  account_number: string | null
  email: string | null
  gst_certificate_key: string | null
  cancelled_cheque_key: string | null
  pan_card_key: string | null
  misc_document_key: string | null
}

/** `vendors` table — Suppliers. `type` is one of: "rm" | "pm" | "both". Used by app/masters/vendors. */
export type Vendor = {
  vendor_id: number
  code: string
  name: string
  type: string
  location: string | null
  status: string | null
  zone: string | null
  registered_name: string | null
  gst_number: string | null
  bank_name: string | null
  ifsc_number: string | null
  account_number: string | null
  gst_certificate_key:  string | null
  cancelled_cheque_key: string | null
  pan_card_key:         string | null
  misc_document_key:    string | null
}

/** `master_brand` table — our brands, canonicalised. Four rows: mCaffeine, Fein,
 *  Hyphen, DND.
 *
 *  Exists because brand is an ACCESS BOUNDARY and `master_skus.brand` is free
 *  text: the dev survey found `FIEN` (a transposed `Fein`) on 28 SKUs, which a
 *  `brand = 'Fein'` predicate would have silently excluded. Scope predicates key
 *  on `master_skus.brand_id`, never on the text column. */
export type Brand = {
  id: number
  /** Normalised comparison key — lowercase, non-alphanumerics stripped. Mirrors
   *  brandKey() in lib/constants.ts. If these two diverge the boundary and the
   *  display value disagree, so treat this as the contract. */
  brand_key: string
  /** Display form, e.g. "mCaffeine". */
  name: string
  /** PO-number prefix. Matches what brandCode() produces, so PO numbering is
   *  unaffected by this table's existence. */
  po_code: string
  /** master_entity.id. Null for DND, whose legal entity isn't identified yet —
   *  the same "don't guess" stance entityForBrand() takes. */
  entity_id: number | null
  /** Joined from master_entity where selected. */
  entity_code?: string | null
  status: string
  created_at: Date | null
}

/** `master_warehouse` table — one row per physical LOCATION. Used by
 *  app/masters/warehouses. Mirrors WAREHOUSE_COLUMNS in lib/queries/warehouse.ts.
 *
 *  `name` is a de-facto foreign key with nothing enforcing it: it is copied by
 *  value into purchase_orders.destination, invoice_mfg.destination and
 *  entity_emails.entity_code (entity_type='warehouse'), and lib/scope.ts resolves
 *  warehouse scope to names rather than ids. Immutable after create.
 *
 *  Not to be confused with WarehouseOption in
 *  app/po-tracking/po-procurement/po-types.ts, which is the PO dropdown's shape. */
export type Warehouse = {
  id: number
  /** Stable short code, e.g. "GGN". NOT a join key yet — POs, invoices and mail
   *  routing all still reference `name`. Safe to edit for that reason. */
  code: string | null
  name: string
  /** The city. Held the state until 2026-08-13; `state` carries that now. This is
   *  what the PO destination dropdown renders, so changes here are user-visible. */
  location: string | null
  state: string | null
  /** One of ZONE_OPTIONS in components/masters/field-config.ts — a region
   *  (North/South/West/North East/East), not a state. */
  zone: string | null
  /** master_warehouse_type — "MWH" (Mother Warehouse: Gurgaon, Mumbai) or "CWH"
   *  (Child Warehouse, fed from a mother). Not "Central". */
  type: string
  /** Who to call at the site. One team serves both entities' goods. */
  contact_person: string | null
  contact_phone: string | null
  /** The facility OPERATOR's GST registration — relevant when the site is a 3PL.
   *  NOT ours: WarehouseEntity.gstin holds our entity's registration. */
  site_gstin: string | null
  /** "active" | "inactive" | "in_review" | "rejected" — the approval flow needs
   *  all four. Use STATUS from lib/constants.ts, not literals. */
  status: string
  created_by: number | null
  created_at: Date | null
  updated_at: Date | null
}

/** `details_warehouse_entity` table — one row per (location, legal entity),
 *  holding that entity's Unicommerce facility, GST registration and addresses
 *  for the site. Two rows per location: every warehouse operates under both Pep
 *  and Kreative with a DIFFERENT facility code.
 *
 *  Keyed by entity, not brand — Fein and mCaffeine are both Pep and share a
 *  facility, so Fein needs no row of its own. */
export type WarehouseEntity = {
  id: number
  warehouse_id: number
  entity_id: number
  /** Joined from master_entity — "PEP" | "KREATIVE". */
  entity_code: string
  /** Joined from master_entity.legal_name. */
  entity_name: string
  /** Sent as the Facility header on the Uniware PO create — see authHeaders() in
   *  lib/uniware.ts. Null means this entity cannot inward here, and
   *  lib/invoice-inward.ts fails fast rather than falling back to the env var. */
  facility_code: string | null
  /** "MWH" | "CWH" for THIS entity, overriding the location's. Null = use
   *  Warehouse.type. */
  type: string | null
  /** The registration WE bill under here. Its PAN must match this row's entity,
   *  which the route enforces — a valid GSTIN in the wrong entity's slot is
   *  otherwise invisible, since both are ours and isOurs() accepts either. */
  bill_to_gstin: string | null
  bill_to_name: string | null
  /** Free text, kept as the verbatim record of what the paperwork says. No
   *  structured counterpart — it is a head-office address nobody filters on. */
  bill_to_address: string | null
  ship_to_name: string | null
  /** Structured ship-to. Per entity because at Mumbai the two entities ship to
   *  different physical sites (Bhiwandi vs Kalyan). Authoritative for where goods
   *  physically go; Warehouse.location/.state are the site LABEL. */
  ship_to_line1: string | null
  ship_to_line2: string | null
  ship_to_city: string | null
  ship_to_state: string | null
  /** 6 digits, stored as CHAR(6) so a leading zero survives. */
  ship_to_pincode: string | null
  /** The CONSIGNEE registration — one of OUR PANs, but NOT necessarily this row's
   *  entity. Pep operates most sites, so Kreative's Kolkata/Bengaluru/Ahmedabad/
   *  Nagpur/Guwahati rows ship under Pep's registration for that state. Validating
   *  this against the row's own entity would reject correct data. */
  ship_to_gstin: string | null
  /** The verbatim block, kept alongside the structured columns above. */
  ship_to_address: string | null
  /** "active" | "inactive" — a location can be live for one entity and not the
   *  other. The facility resolver filters on it. */
  status: string
  /** Free note, e.g. "Activity started 22.04.2026". */
  remarks: string | null
  created_at: Date | null
  updated_at: Date | null
}

/** `master_entity` table — OUR own legal entities, not a counterparty's. Two
 *  rows: PEP and KREATIVE.
 *
 *  `pan` overlaps OUR_PANS in lib/gstin.ts, which stays the source of truth for
 *  invoice detection: it covers 9 registrations across 4 PANs and is deliberately
 *  broader than this table. Do not rewire isOurs() off these rows.
 *
 *  The brand → entity direction is a constant instead (entityForBrand in
 *  lib/constants.ts) — three brands fixed by company structure need no table. */
export type Entity = {
  id: number
  /** Short internal code, UPPERCASE — "PEP" | "KREATIVE". Matches the values
   *  entityForBrand() returns, and that comparison happens in TypeScript, where
   *  it is case-sensitive even though the column's collation is not. */
  code: string
  legal_name: string
  pan: string | null
  status: string | null
  created_at: Date | null
}

/** `rm` table — Raw Materials. Used by app/masters/raw-materials.
 *
 * r.hsn_code , r.inci_name , r.make , r.name, r.rm_code , r.status , r.type ,
	rmv.curr_rate , rmv.effective_from, rmv.effective_to ,
    rmv.moq , rmv.uom , rmv.vendor_code , rmv.vendor_id
*/
export type RM = {
  /** Primary key of master_rm — for cost-impact lookups (details_recipe.mtrl_id). */
  rm_id: number
  rm_code: string | null
  name: string
  make: string | null
  type: string | null
  uom: string | null
  status: string | null
  hsn_code: string | null
  inci_name: string | null
  curr_rate: string | null
  effective_from: string | null
  effective_to : string | null
  moq:number | 0
  vendor_code: string | null
  vendor_id: string | null
  /** Primary key of the cost_master_rm_ven rate row — for approval flow. */
  vrm_id: number | null
  /** Status of the cost_master_rm_ven rate row — for approval badges. */
  vrm_status: string | null
  /** Optional manufacturer tag on the vendor rate row — informational only,
   *  does not create a separate cost_master_rm_mfg row. */
  mfg_id: number | null
  mfg_name: string | null
  mfg_code: string | null
}

/** Raw Material rate row as seen through the MANUFACTURER rate master (`rm_mrm`).
 *  Used by app/masters/raw-materials when the "By Manufacturer" view is active.
 *
 *  rmm.rm_id, rmm.mfg_id, rmm.mfg_code, rmm.approved_vendor_id,
 *  rmm.approved_vendor_code, rmm.curr_rate, rmm.effective_from, rmm.uom,
 *  r.status, r.id, r.name, r.make, r.type, r.hsn_code, r.rm_code, r.inci_name
 */
export type RMByMfg = {
  /** Primary key of the cost_master_rm_mfg rate row — used for approval entity_id. */
  rate_id: number | null
  rm_id: number
  mfg_id: number | null
  mfg_code: string | null
  approved_vendor_id: number | null
  approved_vendor_code: string | null
  curr_rate: string | null
  effective_from: string | null
  uom: string | null
  /** Status of the base RM record (master_rm.status). */
  status: string | null
  /** Status of the rate row in cost_master_rm_mfg — used for approval badges. */
  rate_status: string | null
  id: number
  name: string
  make: string | null
  type: string | null
  hsn_code: string | null
  rm_code: string | null
  inci_name: string | null
}

/** `pm` table — Packing Materials. Used by app/masters/packing-materials. */
export type PM = {
  id: number
  pm_code: string | null
  name: string
  type: string | null
  hsn_code: string | null
  uom: string | null
  status: string | null
}

/** Product Material rate row joined with VENDOR rate master (`pm_vrm`).
 *  Used by app/masters/product-materials vendor view.
 */
export type PMVendor = {
  pm_code: string | null
  name: string
  type: string | null
  hsn_code: string | null
  pm_id: number
  /** Primary key of the cost_master_pm_ven rate row — for approval flow. */
  vrm_id: number | null
  vendor_id: number | null
  vendor_code: string | null
  curr_rate: string | null
  moq: number | null
  uom: string | null
  status: string | null
  effective_from: string | null
  effective_to: string | null
}

/** Product Material rate row joined with MANUFACTURER rate master (`pm_mrm`).
 *  Used by app/masters/product-materials manufacturer view.
 */
export type PMByMfg = {
  pm_code: string | null
  name: string
  type: string | null
  hsn_code: string | null
  uom: string | null
  pm_id: number
  /** Primary key of the cost_master_pm_mfg rate row — used for approval entity_id. */
  rate_id: number | null
  mfg_id: number | null
  mfg_code: string | null
  curr_rate: string | null
  /** Status of the cost_master_pm_mfg rate row — used for approval badges. */
  status: string | null
  effective_from: string | null
}


/**Recipe Master - Bill of Material details */
export type Recipe = {
  bom_code: string | null;
  recipe_id: number | null;
  sku_code: string | null;
  mtrl_id: number | null;
  mtrl_type: string | null;
  uom: string | null;
  amount: number | null;
  mtrl_cost: number | null;
  material_status: string | null;
  bom_status: string | null;
  last_updated: Date | string | null;
  created_by: string | null;
  mtrl_name: string | null;
  mtrl_code: string | null;
  /** master_rm.status / master_pm.status for this line's material — distinct
   *  from material_status (the details_recipe line's own status). Used to flag
   *  lines referencing a material that's since been deactivated. */
  mtrl_master_status: string | null;
};

/** One row per Recipe header, used by the Recipe Master listing page. */
export type RecipeListItem = {
  recipe_id: number | null;
  bom_code: string | null;
  sku_code: string | null;
  sku_name: string | null;
  created_at: Date | string | null;
  effective_from: Date | string | null;
  effective_till: Date | string | null;
  status: string | null;
  /** From this Recipe's own creating/editing approval's "__reason__" sentinel
   *  item — null for a SKU's first-ever Recipe or a bulk upload. */
  change_reason: string | null;
  /** Comma-joined "rm"/"pm" tags from the same approval's "__change_type__"
   *  sentinel item — format with formatChangeType (bom-format.ts). */
  change_type: string | null;
  /** Count of master_recipe_mfg rows with status='active' for this Recipe — how
   *  many manufacturers currently produce it. */
  live_mfg_count: number;
  /** "CODE — Name" per live manufacturer, comma-joined — tooltip source for
   *  live_mfg_count. Null when live_mfg_count is 0. */
  live_mfg_names: string | null;
};

/**
 * One row per Recipe version (header) that has been through an approval, used
 * by the Recipe History page — grouped/sorted SKU-wise (see
 * bom.selectHistoryPaginatedGrouped), with the creating/approving user's name
 * already resolved.
 */
export type RecipeHistoryListItem = {
  recipe_id: number | null;
  bom_code: string | null;
  sku_id: number | null;
  sku_code: string | null;
  sku_name: string | null;
  status: string | null;
  created_at: Date | string | null;
  created_by: number | null;
  created_by_name: string | null;
  updated_at: Date | string | null;
  updated_by: number | null;
  updated_by_name: string | null;
  approved_by: number | null;
  approved_by_name: string | null;
  approved_on: Date | string | null;
  /** See RecipeListItem's same-named fields. */
  change_reason: string | null;
  change_type: string | null;
};

/** Recipe detail side-panel payload: header + all material lines. */
export type RecipeArtifact = {
  id: number;
  recipe_id: number;
  s3_key: string;
  file_name: string;
  uploaded_by: number | null;
  uploaded_at: Date | string;
};

export type RecipeDetailResponse = {
  recipe_id: number | null;
  bom_code: string | null;
  sku_id: number | null;
  sku_code: string | null;
  status: string | null;
  created_at: Date | string | null;
  effective_from: Date | string | null;
  effective_till: Date | string | null;
  lines: Recipe[];
  artifacts: RecipeArtifact[];
};

export type bomType = {
  bom_code : string | null
  sku_code : string | null
  mfg_id : number | 0 
  created_by : number | 0 
  created_at : Date | null    
}
export type bom_detailsType = Record<string, never>

/**
 * MFG Management line status — a manufacturer's SKU-level production state.
 * `active` — normal production, POs can be raised.
 * `discontinued` — winding down: still "live" (existing ingredient stock can still
 *   be consumed, POs can still be raised) but on its way to `inactive`.
 * `inactive` — fully stopped; POs can no longer be raised against this line.
 */
export type MfgLineStatus = "active" | "discontinued" | "inactive"

/**
 * `master_recipe_mfg` joined with `master_recipe`/`master_skus`/`master_mfgs` — one
 * row per SKU a manufacturer produces. Used by app/manufacturing/[mfgId].
 */
export type MfgLine = {
  id: number
  recipe_id: number
  mfg_id: number
  status: MfgLineStatus
  effective_from: string | null
  effective_to: string | null
  monthly_capacity: number | null
  this_month_plan: number | null
  last_batch_date: string | null
  remarks: string | null
  bom_code: string | null
  sku_code: string | null
  sku_name: string | null
  brand: string | null
  /** `master_skus.filling` — the SKU's fill volume/weight; often empty. */
  filling: number | null
  filling_uom: string | null
  mfg_code: string
  mfg_name: string
}

/** Aggregated per-manufacturer production + PO stats. Used by app/manufacturing (Overview). */
export type MfgOverviewRow = {
  id: number
  code: string
  name: string
  capacity: number
  this_month_plan: number
  active_skus: number
  open_pos: number
  open_value: number
}

/** This calendar month's PO qty vs received qty per SKU. Shown in the manufacturer detail page header and the MFG Overview cards. */
export type MfgMonthlyPoRow = {
  mfg_id: number
  sku_code: string | null
  sku_name: string | null
  po_qty: string | null
  received_qty: string | null
}

/** `bom_misc` cost type — job work, shrink wrap, shipper (absolute cost); rm_loss/pm_loss (RM/PM wastage %, stored in the same `cost` column). */
export type MiscCostType = "jw" | "shrink" | "shipper" | "rm_loss" | "pm_loss"

/** `bom_misc` joined with `master_recipe`/`master_skus`. Used by the JW/Shrink Wrap/Shipper/Wastage tabs. */
export type MiscCostLine = {
  id: number
  recipe_id: number
  mfg_id: number
  type: MiscCostType
  cost: number | null
  effective_from: string | null
  effective_till: string | null
  status: string
  bom_code: string | null
  sku_code: string | null
  sku_name: string | null
}

/** Current (active) bom_misc line across all 4 cost types for one manufacturer — used by the misc-costs CSV/Excel export. */
export type MiscCostCurrentRateRow = {
  type: MiscCostType
  bom_code: string | null
  sku_code: string | null
  sku_name: string | null
  cost: string | null
  effective_from: string | null
  effective_till: string | null
  status: string
}

/** SKU/Recipe option scoped to lines a manufacturer already produces — for the JW/Shrink/Shipper "Add" dialog. */
export type MfgLineOption = { id: number; bom_code: string | null; sku_code: string | null; sku_name: string | null }

/** `cost_master_rm_mfg` joined with `master_rm`/`master_vendors` for one manufacturer. Used by the RM Vendor tab. */
export type RmVendorRow = {
  rm_code: string | null
  rm_name: string
  make: string | null
  type: string | null
  approved_vendor_code: string | null
  vendor_name: string | null
  curr_rate: string | null
  effective_from: string | null
  uom: string | null
  status: string
}

/** A superseded RM×vendor rate period for one manufacturer, from history_cost_mfg. Used by the RM Vendor tab's history section. */
export type RmVendorHistoryRow = {
  rm_code: string | null
  rm_name: string
  vendor_name: string | null
  rate: string | null
  effective_from: string | null
  effective_to: string | null
}

/** PM×vendor rate row for one manufacturer — cost_master_pm_mfg has no approved-vendor column, so the
 * vendor shown is whichever active cost_master_pm_ven row exists for that PM (same "best effort"
 * vendor resolution used by pmRateHandler.applyAndArchive when archiving history). */
export type PmVendorRow = {
  pm_code: string | null
  pm_name: string
  type: string | null
  approved_vendor_code: string | null
  vendor_name: string | null
  curr_rate: string | null
  effective_from: string | null
  effective_to: string | null
  uom: string | null
  status: string
}

export type PmVendorHistoryRow = {
  pm_code: string | null
  pm_name: string
  vendor_name: string | null
  rate: string | null
  effective_from: string | null
  effective_to: string | null
}

/** Agreed RM rate for one manufacturer. cost_master_rm_mfg has no effective_to column. */
export type AgreedRmRateRow = {
  code: string | null
  name: string
  curr_rate: string | null
  effective_from: string | null
  uom: string | null
  status: string
}

/** Agreed PM rate for one manufacturer. */
export type AgreedPmRateRow = {
  code: string | null
  name: string
  curr_rate: string | null
  effective_from: string | null
  effective_to: string | null
  uom: string | null
  status: string
}

/** One row per SKU in the Agreed Final Costing tab — computed, not stored. */
export type FinalCostingRow = {
  recipe_id: number
  sku_code: string | null
  sku_name: string | null
  rm_cost: number
  pm_cost: number
  jw: number
  shrink: number
  shipper: number
  /** rm_cost * (rm_loss% / 100) — real per-SKU RM wastage, not a flat rate. */
  rm_wastage: number
  /** pm_cost * (pm_loss% / 100) — real per-SKU PM wastage, not a flat rate. */
  pm_wastage: number
  /** rm_wastage + pm_wastage — kept for the existing combined "Wastage" column. */
  wastage: number
  total: number
  /** True when RM/PM cost or any misc cost (jw/shrink/shipper/rm_loss/pm_loss) row is missing for this SKU x mfg. */
  incomplete: boolean
  /** The SKU's fill weight, from master_skus or details_sku. NULL here is why
   *  an RM cost reads 0 — it is a multiplicand, so a missing value zeroes the
   *  whole line rather than just omitting one term. */
  filling: number | null
  /** RM recipe lines with no agreed rate for this manufacturer. */
  rm_lines_without_rate: number
  /** PM recipe lines with no agreed rate for this manufacturer. */
  pm_lines_without_rate: number
  /** Total RM lines on the recipe, so "2 of 3 unpriced" is expressible. */
  rm_line_count: number
}

/**
 * A FinalCostingRow recomputed using the cheapest/most-expensive available
 * vendor (VRM) rate per RM/PM component instead of the agreed MRM rate, with
 * deltas vs. the MRM-based row — for the Agreed Final Costing tab's
 * negotiation comparison tables.
 */
export type FinalCostingComparisonRow = FinalCostingRow & {
  rm_delta: number
  rm_delta_pct: number
  pm_delta: number
  pm_delta_pct: number
  total_delta: number
  total_delta_pct: number
}
/**
 * One cell of the MFG × Facility matrix on /po-tracking/mfg-overview — a
 * (manufacturer, facility) pair, where a facility is a details_warehouse_entity
 * row (location × legal entity), NOT a master_warehouse row.
 *
 * The matrix query returns the full cross-product, so a pair that has never been
 * configured still arrives here with zeroes and a null `un_mfg_code`. See
 * cellState() in app/po-tracking/mfg-overview/mapping-state.ts for what each
 * combination means on screen.
 */
export type MfgFacilityCell = {
  mfg_id: number
  mfg_code: string | null
  mfg_name: string
  /** details_warehouse_entity.id */
  wh_id: number
  wh_name: string
  /** master_warehouse.code — NULL on every row today, so the UI shows
   *  facility_code as the column's second line instead. */
  wh_code: string | null
  location: string | null
  entity_code: string
  /** The Unicommerce Facility header value. Null means Uniware cannot be
   *  addressed here at all. */
  facility_code: string | null
  wh_type: string
  /** This pair's Uniware vendor code. Null = the manufacturer is not a vendor at
   *  this facility, which is what makes the cell inert. */
  un_mfg_code: string | null
  total_skus: number
  mapped_skus: number
  /** Of the mapped ones, how many a Vendor Item Master import has confirmed. */
  confirmed_skus: number
  /** Mapped but neither pushed nor seen — drives the warning overlay. */
  unpushed_skus: number
  /** Mapped here but no longer a live line on this manufacturer. */
  orphan_skus: number
  last_seen_at: string | null
}

/** One SKU in the matrix drilldown panel, with its mapping state at one facility. */
export type MfgFacilitySkuRow = {
  sku_id: number
  sku_code: string
  sku_name: string | null
  brand_id: number | null
  /** 1 when a live master_recipe_mfg line links this SKU to the manufacturer —
   *  the costing-side relation. 0 means it is known only from Unicommerce. */
  has_recipe: number
  /** 1 when the SKU is actively mapped at some facility. */
  has_mapping: number
  /** Null when this SKU has no row at this facility at all. */
  map_id: number | null
  map_status: "active" | "inactive" | null
  un_pushed_at: string | null
  un_push_error: string | null
  un_seen_at: string | null
}
