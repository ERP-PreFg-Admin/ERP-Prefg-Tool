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

export function uniwareVendorCode(mfgCode: string): string {
  if (UNIWARE_SANDBOX) return UNIWARE_SANDBOX_VENDOR
  return UNIWARE_VENDOR_CODE || mfgCode
}

/** Headers every Uniware REST call needs. */
export function authHeaders(token: UniwareToken, facility?: string) {
  return { Authorization: `Bearer ${token.accessToken}`, Facility: uniwareFacility(facility) }
}