import { UNIWARE_SANDBOX_FACILITY , UNIWARE_SANDBOX , UNIWARE_FACILITY , UNIWARE_SANDBOX_VENDOR , UNIWARE_VENDOR_CODE} from "../env"
import { UniwareToken } from "./auth"
export function uniwareFacility(resolved?: string): string {
  if (UNIWARE_SANDBOX) return UNIWARE_SANDBOX_FACILITY

  const facility = resolved?.trim() || UNIWARE_FACILITY
  if (facility === UNIWARE_SANDBOX_FACILITY) {
    throw new Error(
      "Refusing a production Uniware call against the sandbox facility " +
      `(${UNIWARE_SANDBOX_FACILITY}) — set UNIWARE_FACILITY, or map the destination's ` +
      "facility on /masters/warehouses."
    )
  }
  return facility
}

/**
 * Mirrors uniwareFacility() exactly, and for the same reason.
 *
 * It used to read `UNIWARE_VENDOR_CODE || resolved`, which put the env var
 * AHEAD of a resolved code — and UNIWARE_VENDOR_CODE defaults to Test_Vendor.
 * On prod, with the var unset in SSM, every push therefore went out as
 * Test_Vendor whatever the caller had looked up, and Uniware answered
 * "Vendor [Test_Vendor] is not configured for the facility [GGN_WAREHOUSE]".
 * The resolved value wins now; the env var is only the fallback.
 *
 * `resolved` is a UNIWARE vendor code (un_code_mfg_sku_wh_map.un_mfg_code),
 * never master_mfgs.code — the two are different identifiers and Uniware
 * rejects the latter the same way.
 */
export function uniwareVendorCode(resolved?: string): string {
  if (UNIWARE_SANDBOX) return UNIWARE_SANDBOX_VENDOR

  const vendor = resolved?.trim() || UNIWARE_VENDOR_CODE
  if (vendor === UNIWARE_SANDBOX_VENDOR) {
    throw new Error(
      `Refusing a production Uniware call as the sandbox vendor (${UNIWARE_SANDBOX_VENDOR}) — ` +
      "map this manufacturer's Uniware vendor code for the facility on " +
      "/po-tracking/mfg-overview, or set UNIWARE_VENDOR_CODE."
    )
  }
  return vendor
}

/** Headers every Uniware REST call needs. */
export function authHeaders(token: UniwareToken, facility?: string) {
  return { Authorization: `Bearer ${token.accessToken}`, Facility: uniwareFacility(facility) }
}