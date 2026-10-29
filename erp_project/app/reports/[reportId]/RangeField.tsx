"use client"

import { useState } from "react"
import { DateRangePicker } from "@/components/ui/date-picker"
import { monthBounds } from "@/lib/reports/month-range"

// The app's DateRangePicker inside a plain GET form: posts `from`/`to` as hidden fields.
// Month mode posts YYYY-MM (the months of the picked dates) for reports that work in months.
export default function RangeField({ from, to, months = false, placeholder = "Any dates", className }: {
  from: string | null
  to: string | null
  months?: boolean
  placeholder?: string
  className?: string
}) {
  const init = months ? monthBounds(from, to) : { from: from ?? "", to: to ?? "" }
  const [range, setRange] = useState(init)
  const out = (v: string) => (months ? v.slice(0, 7) : v)
  return (
    <div className={className ?? "w-64"}>
      <DateRangePicker from={range.from} to={range.to} onChange={(f, t) => setRange({ from: f, to: t })} placeholder={placeholder} />
      <input type="hidden" name="from" value={out(range.from)} />
      <input type="hidden" name="to" value={out(range.to)} />
    </div>
  )
}
