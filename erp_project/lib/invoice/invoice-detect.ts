/**
 * Which manufacturer issued this invoice?
 *
 * Answered from the PDF's own text before the Nanonets call, so the extraction
 * strategy is chosen up front rather than inferred from the extracted `from`
 * field afterwards. Costs ~190 ms against a ~60 s extraction.
 *
 * Nothing here throws. A scanned invoice with no text layer, an encrypted PDF
 * or a database blip must all degrade to "no manufacturer detected", which is
 * exactly the behaviour that shipped before strategies existed.
 */

import { extractText , getDocumentProxy} from "unpdf"
import { query } from "../db"
import { manufacturers } from "../queries/manufacturers"
import logger from "../logger"
// GSTIN shape and which ones are ours live in ./gstin — pure, so callers that
// only need those stay unit-testable without the DB credentials ./db requires.
import { findGstins, sellerGstinsOf } from "./gstin"

export { findGstins }

export type DetectedMfg = {
    mfgId : number
    code  : string
    name  : string
    gstin : string
}

export async function extractPdfText(buffer:Buffer) : Promise<string> {
    try {
        const pdf = await getDocumentProxy(new Uint8Array(buffer) , {
            verbosity: 0 
        })
        const { text } = await extractText(pdf, {mergePages:true})
        return text;
    } catch(err){
        logger.warn({module: "INVOICE_DETECT" , message: "PDF Text Extraction failed", err : String(err)})
    }

    return ""
}

export async function lookupMfgByGstin(gstins: string[]) : Promise<DetectedMfg | null > {
    if(gstins.length === 0) {
        return null
    }
    try {
        const rows = await query<{ id: number; code: string; name: string; gst_number: string; }>(
            manufacturers.selectByGstins,
            [gstins]
        );
        for (const gstin of gstins) {
            const row = rows.find((r) => r.gst_number === gstin)
            if(row) return {
                mfgId:row.id , 
                code: row.code , 
                name:row.name , 
                gstin
            }
        }
        return null
    } catch (err) {
        logger.warn({module:"INVOICE_DETECT" , message: "GST lookup failed." , err:String(err)});
        return null
    }
} 

export async function detectFromPdf(buffer: Buffer): Promise<{
  /** Full text layer. Returned so a caller can parse the invoice locally without
   *  paying for a second extraction — it costs ~190ms and we already have it. */
  text: string
  /** Every GSTIN on the document, the buyer's included. */
  gstins: string[]
  /** Only the ones that aren't ours — the safe input for both the manufacturer
   *  lookup and strategy selection. */
  sellerGstins: string[]
  mfg: DetectedMfg | null
}> {
  const text = await extractPdfText(buffer)
  const gstins = findGstins(text)
  const sellerGstins = sellerGstinsOf(gstins)

  return { text, gstins, sellerGstins, mfg: await lookupMfgByGstin(sellerGstins) }
}
