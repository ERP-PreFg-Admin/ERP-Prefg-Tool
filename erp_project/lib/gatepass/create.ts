/**
 * Raise one facility's gatepass in Unicommerce, end to end.
 *
 * Three stages, and the order is forced by the API rather than chosen:
 *
 *   1. ALLOCATE a serial — read the facility's existing `…/DRY/…` codes and take
 *      max + 1, so this automation's series stays separate from the one people
 *      raise by hand.
 *   2. CREATE the gatepass. It comes into existence EMPTY; there is no way to
 *      create a populated one.
 *   3. ADD each package type as a line, one call each.
 *
 * ── The failure mode that matters ───────────────────────────────────────────
 * Because 2 and 3 are separate calls, a failure during 3 leaves a REAL gatepass
 * carrying some of its lines. That cannot be rolled back — Uniware has no delete
 * — so this never pretends it did not happen: the result always carries the code
 * and the per-item outcome, and a partial run is reported as partial rather than
 * as a failure. Reporting it as a failure would be worse than useless, because
 * the operator would create a second document for the same boxes.
 *
 * Every step is emitted as it happens so the UI can say which stage it is at.
 */

import {
  searchGatepassCodes, createGatepass, addGatepassItem,
} from "@/lib/uniware/gatepass"
import { dryGatepassPrefix, nextSerialFrom, padSerial, financialYearStart } from "./gatepass-code"
import { buildGatepassPayload, type GatepassPlan } from "./plan"
import logger from "@/lib/logger"

export type CreateStep =
  | { step: "serial"; status: "start" | "ok"; code?: string }
  | { step: "create"; status: "start" | "ok"; code?: string }
  | { step: "item"; status: "ok" | "failed"; sku: string; quantity: number; index: number; total: number; error?: string }

export type CreateEmit = (e: CreateStep) => void | Promise<void>

export type CreateResult = {
  facility: string
  ok: boolean
  /** The code Uniware confirmed. Present whenever the document exists — including
   *  when some lines then failed, which is exactly when it matters most. */
  gatePassCode: string | null
  added: number
  failed: { sku: string; error: string }[]
  error?: string
}

export async function createFacilityGatepass(
  plan: GatepassPlan,
  emit?: CreateEmit,
  at: Date = new Date(),
): Promise<CreateResult> {
  const out: CreateResult = {
    facility: plan.facility, ok: false, gatePassCode: null, added: 0, failed: [],
  }

  const prefix = dryGatepassPrefix(plan.facility, at)
  if (!prefix) {
    out.error = `${plan.facility} has no code prefix — map its city in lib/gatepass/gatepass-code.ts`
    return out
  }
  if (!plan.toParty) {
    out.error = `${plan.facility} has no toParty configured`
    return out
  }

  try {
    // ── 1. serial ────────────────────────────────────────────────────────────
    await emit?.({ step: "serial", status: "start" })
    // From the start of the financial year: a series is per FY, so searching
    // from any later point could miss a code and re-issue its number.
    const existing = await searchGatepassCodes(plan.facility, financialYearStart(at))
    const code = `${prefix}${padSerial(nextSerialFrom(existing, prefix))}`
    await emit?.({ step: "serial", status: "ok", code })

    // ── 2. create ────────────────────────────────────────────────────────────
    await emit?.({ step: "create", status: "start", code })
    // Uniware's answer wins over the code we asked for: if it numbered the
    // document differently, every addItem below must use ITS code or the lines
    // land on nothing.
    out.gatePassCode = await createGatepass(plan.facility, buildGatepassPayload(plan, code))
    await emit?.({ step: "create", status: "ok", code: out.gatePassCode })

    // ── 3. items ─────────────────────────────────────────────────────────────
    const total = plan.items.length
    for (let i = 0; i < total; i++) {
      const item = plan.items[i]
      try {
        await addGatepassItem(plan.facility, {
          gatePassCode: out.gatePassCode,
          itemSKU: item.code,
          quantity: item.quantity,
        })
        out.added++
        await emit?.({ step: "item", status: "ok", sku: item.code, quantity: item.quantity, index: i + 1, total })
      } catch (err: unknown) {
        // One rejected line must not abandon the rest: the document already
        // exists, and stopping here would leave it emptier for no reason.
        const message = err instanceof Error ? err.message : String(err)
        out.failed.push({ sku: item.code, error: message })
        await emit?.({ step: "item", status: "failed", sku: item.code, quantity: item.quantity, index: i + 1, total, error: message })
      }
    }

    out.ok = out.failed.length === 0
    if (!out.ok) {
      out.error = `${out.failed.length} of ${total} lines were rejected — the gatepass exists with ${out.added}.`
    }
  } catch (err: unknown) {
    out.error = err instanceof Error ? err.message : String(err)
  }

  logger.info({
    module: "GATEPASS", facility: plan.facility, gatePassCode: out.gatePassCode,
    added: out.added, failed: out.failed.length, err: out.error,
    message: "Gatepass create finished",
  })
  return out
}
