"use client"

import { useRouter, usePathname, useSearchParams } from "next/navigation"

/**
 * Merges filter/search param updates into the current URL and resets to
 * page 1 — the same "change a filter → refetch server page 1" navigation
 * every master/list table implements, previously redefined verbatim in each
 * one. Empty-string values delete the param.
 */
export function useUrlFilters() {
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()

  function navigate(updates: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v)
      else   params.delete(k)
    }
    params.set("page", "1")
    router.push(`${pathname}?${params.toString()}`)
  }

  return { navigate, router, pathname, searchParams }
}
