/** The ERP-minted Uniware Inward Purchase Order Code. 
 * <letter>/<short code>/<FY>/<serial>
 * M / MUM1 / 2627 / 01234
 * 
*/

import {todayIST} from "@/lib/date"

export const SERIAL_WIDTH = 5;

export function financialYearToken(at : Date = new Date()): string {
    const [year , month] = todayIST(at).split("-").map(Number)
    const startYear = month >= 4 ? year : year - 1
    const two = (y : number) => String(y % 100).padStart(2 , "0")
    return `${two(startYear)}${two(startYear+1)}`
}

export type PoCodeParts = {
  letter: string     // "M" | "H", from poLetterForEntity
  shortCode: string  // "MUM1", from details_warehouse_entity.po_short_code
  fy: string         // "2627", from financialYearToken
}
export function poPrefix({letter, shortCode , fy } : PoCodeParts) : string {
    return `${letter}/${shortCode}/${fy}`
}

export function buildUniwarePoCode(parts: PoCodeParts, serial: number): string {
  return `${poPrefix(parts)}/${String(serial).padStart(SERIAL_WIDTH, "0")}`
}


export function poCodePartsFor(
  facility: { po_short_code?: string | null; entity_code?: string | null },
  letterFor: (entityCode: string | null | undefined) => string | null,
  at: Date = new Date()
): PoCodeParts | null {
  const shortCode = facility.po_short_code?.trim().toUpperCase()
  if (!shortCode) return null
  const letter = letterFor(facility.entity_code)
  if (!letter) return null   // unmapped entity — never guess a letter
  return { letter, shortCode, fy: financialYearToken(at) }
}