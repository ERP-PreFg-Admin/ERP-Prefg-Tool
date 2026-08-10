/**
 * Shared types for the per-manufacturer extraction strategies in this
 * directory. See ./index.ts for the registry they're wired into.
 */

import { ParsedInvoice } from "@/types/invoice";
import type { ExtractionConfigBuilder } from "../builder";

/**
 * One supplier's extraction quirks.
 *
 * Registered in ./index.ts against every GSTIN that supplier invoices under;
 * the parse route resolves one and applies it without knowing which it got.
 * A strategy only ever *layers onto* the shared base — it cannot replace it,
 * so a rule true of every invoice still belongs in ../instructions.ts.
 */
export interface ExtractionStrategy {
    readonly mfgCode : string,
    readonly label: string,

    configure(builder: ExtractionConfigBuilder) : void
    normalize?(parsed: ParsedInvoice): ParsedInvoice
}