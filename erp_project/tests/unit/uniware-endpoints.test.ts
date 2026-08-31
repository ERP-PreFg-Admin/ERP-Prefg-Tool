// Uniware's REST paths are OURS to get wrong and THEIRS to define.
//
// Same hazard tests/unit/nanonets-endpoints.test.ts exists for: on 2026-08-07 a
// repo-wide find-replace on "/api/" rewrote an outbound Nanonets URL to
// "/api/v1/v2/files", which compiled, linted, type-checked and 404'd at the
// network boundary. Uniware's paths carry a /v1/ of their own — THEIRS, not ours
// — so the same sweep would break these the same silent way.
//
// The GRN paths matter more than most: on this API a wrong path or a wrong key
// comes back as an empty-but-successful record rather than an error (see the
// FINDINGS block in check_uniware_apis/po_grn.py), so a broken one reads as
// "this PO has no GRNs" forever.
//
// Imports ./endpoints only — ./auth and ./grn pull lib/env in at module load.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  PO_CREATE_PATH,
  PO_DETAILS_PATH,
  GRN_LIST_PATH,
  GRN_DETAILS_PATH,
  VENDOR_ITEM_CREATE_OR_EDIT_PATH,
  EXPORT_JOB_CREATE_PATH,
  EXPORT_JOB_STATUS_PATH,
} from "../../lib/uniware/endpoints"

const REST_PATHS = [
  PO_CREATE_PATH,
  PO_DETAILS_PATH,
  GRN_LIST_PATH,
  GRN_DETAILS_PATH,
  VENDOR_ITEM_CREATE_OR_EDIT_PATH,
  EXPORT_JOB_CREATE_PATH,
  EXPORT_JOB_STATUS_PATH,
]

test("every REST path carries Uniware's version segment, not ours", () => {
  for (const path of REST_PATHS) {
    assert.ok(
      path.startsWith("/services/rest/v1/"),
      `${path} must start with /services/rest/v1/ — that is Uniware's API version.`
    )
    assert.ok(
      !/\/api\/v\d+\//.test(path),
      `${path} has our /api/vN prefix in an outbound URL — a find-replace leaked into it.`
    )
    assert.ok(
      !/\/v\d+\/v\d+\//.test(path),
      `${path} has two version segments.`
    )
  }
})

test("the two GRN endpoints are distinct and named the way Uniware names them", () => {
  // getInflowReceipts (plural, the code list) vs getInflowReceipt (singular, the
  // detail). Swapping them returns a successful response with no usable fields
  // rather than an error, which is the failure this pin exists to catch.
  assert.equal(GRN_LIST_PATH, "/services/rest/v1/purchase/inflowReceipt/getInflowReceipts")
  assert.equal(GRN_DETAILS_PATH, "/services/rest/v1/purchase/inflowReceipt/getInflowReceipt")
  assert.notEqual(GRN_LIST_PATH, GRN_DETAILS_PATH)
})

test("no path ends in a slash — `${BASE}${PATH}` would double it", () => {
  for (const path of REST_PATHS) assert.ok(!path.endsWith("/"), path)
})
