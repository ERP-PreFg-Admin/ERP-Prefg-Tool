// import {readdirSync , readFileSync , statSync , existsSync} from "node:fs"
// import {join , resolve} from "node:path"
// import { extractPdfText } from "@/lib/invoice-detect"
// import { parseTallyRows } from "@/lib/invoice-local/tally"

// const ROOT = resolve(process.cwd(), ".." , "Invoices")
// const filter = process.argv[2]?.toLowerCase()

// async function main() {
//     if(!existsSync(ROOT)) {
//         console.log("No Samples at: ",ROOT);
//         return ;
//     }

//     for (const folder of readdirSync(ROOT)){
//         const dir = join(ROOT , folder)
//         if(!statSync(dir).isDirectory()) continue
//         if (filter && !folder.toLowerCase().includes(filter)) continue

//         const pdf = readdirSync(dir).find((f) => f.toLowerCase().endsWith(".pdf"))
//         if(!pdf) continue;
//         const rows = parseTallyRows(await extractPdfText(readFileSync(join(dir , pdf))))

//         console.log(`\n${folder} - ${rows.length} rows`)

//         for (const r of rows) {
//             const drift = Math.abs((r.qty ?? 0) * (r.rate ?? 0) - (r.amount ?? 0))
//             console.log(
//                     `  qty=${String(r.qty).padEnd(9)} rate=${String(r.rate).padEnd(8)} amt=${String(r.amount).padEnd(11)}` +
//                     ` hsn=${String(r.hsn).padEnd(9)} gst=${String(r.gst_percent).padEnd(5)}` +
//                     ` ${drift < 1 ? "ok" : `DRIFT ${drift.toFixed(2)}`}`
//                 )
//             console.log(`  ${r.sku_code ?? "—"} · ${r.sku_name}`)
//         }
//     }
// }

// main();

import { readdirSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { extractPdfText } from "../lib/invoice-detect"
import { parseTallyRows } from "../lib/invoice-local/tally"

const ROOT = resolve(process.cwd(), "..", "Invoices")
const OUT = resolve(process.cwd(), ".invoice-samples")
const filter = process.argv[2]?.toLowerCase()

async function main() {
  if (!existsSync(ROOT)) { console.log(`No samples at ${ROOT}`); return }
  mkdirSync(OUT, { recursive: true })

  for (const folder of readdirSync(ROOT)) {
    const dir = join(ROOT, folder)
    if (!statSync(dir).isDirectory()) continue
    if (filter && !folder.toLowerCase().includes(filter)) continue

    const pdf = readdirSync(dir).find((f) => f.toLowerCase().endsWith(".pdf"))
    if (!pdf) continue

    const text = await extractPdfText(readFileSync(join(dir, pdf)))
    const rows = parseTallyRows(text)
    const safe = folder.replace(/[^\w.-]+/g, "_")

    writeFileSync(join(OUT, `${safe}.txt`), text)
    writeFileSync(join(OUT, `${safe}.json`), JSON.stringify(rows, null, 2))

    console.log(`\n${"=".repeat(70)}\n${folder}  —  ${text.length} chars, ${rows.length} rows\n${"=".repeat(70)}`)
    console.log(text)
    console.log(`\n--- parsed ---`)
    console.dir(rows, { depth: null })
  }
}
main()