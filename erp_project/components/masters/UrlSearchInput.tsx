"use client"

/**
 * UrlSearchInput — URL-synced search box for master list pages.
 *
 * Behaviour:
 *   1. Keeps a local useState so every keystroke is reflected instantly in the
 *      input (no visible lag to the user).
 *   2. After a 350 ms debounce fires, pushes ?search=term&page=1 to the URL,
 *      which triggers a server re-render with the filter applied at the DB level.
 *   3. Syncs back from initialValue (the current ?search URL param, passed from
 *      the server) so that a full-page reload never shows an empty box while
 *      filtered rows are displayed below it.
 *
 * Usage:
 *   <UrlSearchInput initialValue={currentSearch} placeholder="Search by code…" />
 *
 * The initialValue prop should be read from the server's searchParams and
 * passed down so the component can hydrate with the correct starting value.
 */

import { useState, useEffect, useRef } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { SearchInput } from "@/components/masters/SearchInput"

export function UrlSearchInput({
  initialValue = "",
  placeholder,
  debounceMs = 350,
}: {
  initialValue?: string
  placeholder?: string
  debounceMs?: number
}) {
  // Local state drives the visible input — shows the user's typing immediately.
  const [value, setValue]    = useState(initialValue)
  const router               = useRouter()
  const pathname             = usePathname()
  const searchParams         = useSearchParams()
  const timerRef             = useRef<ReturnType<typeof setTimeout>>(undefined)

  // When the server re-renders with a new initialValue (e.g. after "Clear filters"),
  // sync the visible input so it matches the URL state.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- resyncs the visible input when the URL-driven initialValue changes
  useEffect(() => { setValue(initialValue) }, [initialValue])

  function handleChange(v: string) {
    setValue(v)                      // instant local update
    clearTimeout(timerRef.current)   // reset debounce on every keystroke
    timerRef.current = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString())
      if (v) params.set("search", v)
      else   params.delete("search")
      // Always reset to page 1 when the search term changes.
      params.set("page", "1")
      router.push(`${pathname}?${params.toString()}`)
    }, debounceMs)
  }

  return (
    <SearchInput
      value={value}
      onChange={handleChange}
      placeholder={placeholder}
    />
  )
}
