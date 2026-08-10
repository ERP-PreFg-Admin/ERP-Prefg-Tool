/**
 * Extraction strategies — Strategy Pattern.
 *
 * Each entry owns one supplier's extraction quirks. Adding a manufacturer means
 * adding one file in this directory and one line below; the parse route never
 * changes. Same shape as lib/approvals/module-handlers.ts.
 *
 * Keyed by seller GSTIN, not manufacturer code, because GSTIN is what detection
 * reads straight off the PDF — so choosing a strategy needs no database at all.
 * A manufacturer that invoices from several states gets one line per GSTIN,
 * all pointing at the same object.
 *
 * The registry is deliberately empty until a real sample invoice proves the
 * base rules fail on that supplier's format. Most Indian GST invoices are
 * Tally/Busy output and differ only cosmetically.
 */

import { extractionConfig , type ExtractionConfig } from "../builder";
import type { ExtractionStrategy } from "./types";


export const STRATEGIES: Record<string , ExtractionStrategy> = {
    // "27AAKFR0481L1ZT" : reveStrategy
}

// The  first GSTIN on the document that has a registered strategy.
export function strategyFor(gstins: string[]): ExtractionStrategy | undefined {
    for (const gstin of gstins) {
        const strategy = STRATEGIES[gstin]
        if(strategy) return strategy
    }

    return undefined
}

// Base Configa - 
export function configFor(strategy?: ExtractionStrategy) :
ExtractionConfig{
    const builder = extractionConfig()
    strategy?.configure(builder)
    return builder.build()
}