/**
 *  Allocates the serial segment of an ERP-minted Uniware PO code.
*/

import { PoolConnection } from "mysql2/promise";
import { supplierInvoicesSql } from "../queries/supplier-invoices";

export async function nextSerial(
    conn:PoolConnection , 
    { prefix , seed} : {prefix : string , seed?: number | null}
) : Promise<number> {
    const [rows] = await conn.execute(supplierInvoicesSql.maxUniwarePoSerial,  [`${prefix}/%`])
    const highest = Number((rows as {max_serial:number | null }[])[0]?.max_serial ?? 0)
    return Math.max(highest , Number(seed ?? 0)) + 1 
}
