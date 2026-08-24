import logger from "../logger"
import { getToken } from "./auth"
import { BASE, TIMEOUT_MS ,VENDOR_ITEM_CREATE_OR_EDIT_PATH} from "./endpoints"
import { authHeaders, uniwareFacility } from "./facility"

export type UniwareVendorItemInput = {
  /** Resolved facility code. Passed through uniwareFacility(), so off prod it is
   *  replaced by the sandbox facility like every other call. */
  facility?: string
  vendorCode: string
  itemTypeSkuCode: string
  /** The manufacturer's own code for the item, if they use one. */
  vendorSkuCode?: string | null
  unitPrice: number
  inventory?: number | null
  priority?: number | null
  enabled?: boolean
}

export async function createVendorItem(item: UniwareVendorItemInput): Promise<void> {
  if (!item.vendorCode) throw new Error("vendorCode is required")
  if (!item.itemTypeSkuCode) throw new Error("itemTypeSkuCode is required")
  if (!Number.isFinite(item.unitPrice)) {
    throw new Error("unitPrice is required and must be a number")
  }

  const token = await getToken()
  const facility = uniwareFacility(item.facility)

  // Only documented fields — Uniware rejects unknown keys.
  const payload = {
    vendorItemType: {
      vendorCode: item.vendorCode,
      itemTypeSkuCode: item.itemTypeSkuCode,
      vendorSkuCode: item.vendorSkuCode ?? undefined,
      inventory: item.inventory ?? undefined,
      unitPrice: item.unitPrice,
      priority: item.priority ?? undefined,
      enabled: item.enabled ?? true,
    },
  }

  const res = await fetch(`${BASE}${VENDOR_ITEM_CREATE_OR_EDIT_PATH}`, {
    method: "POST",
    headers: { ...authHeaders(token, facility), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const raw = await res.text()
  if (!raw.trim()) {
    throw new Error(`Uniware returned an empty response (HTTP ${res.status}) — check Facility and auth.`)
  }
  let data: {
    successful?: boolean
    message?: string
    errors?: { description?: string; message?: string; fieldName?: string }[]
    warnings?: { description?: string; message?: string }[]
  }
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`Uniware returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 300)}`)
  }

  if (!data.successful) {
    const msgs = (data.errors ?? [])
      .map((e) => [e.fieldName, e.description || e.message].filter(Boolean).join(": "))
      .filter(Boolean)
    throw new Error(
      msgs.join("; ") || data.message ||
      `Uniware rejected the vendor item (HTTP ${res.status})`
    )
  }
  for (const w of data.warnings ?? []) {
    logger.warn({
      module: "UNIWARE",
      vendorCode: item.vendorCode,
      itemTypeSkuCode: item.itemTypeSkuCode,
      message: w.description || w.message,
    })
  }
}