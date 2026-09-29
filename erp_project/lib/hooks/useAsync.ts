"use client"

/**
 * Two hooks for client-side requests, split by what a SECOND trigger means.
 *
 * READS supersede. Opening row B while row A is still loading means A's answer
 * is no longer wanted: abort it, and drop it if it lands anyway. Without the
 * drop, A resolving after B overwrites B's data and the panel shows one row's
 * answer under another row's heading — which is what RateHistoryDialog did.
 *
 * WRITES do not supersede. Aborting a POST stops the client reading the
 * response, NOT the server doing the work, so a mutation gets an in-flight guard
 * and no abort. Cancelling one would hide the outcome of something that still
 * happened — worse than the duplicate it was meant to prevent.
 *
 * Deliberately not a data-fetching library: no cache, no revalidation, no query
 * keys. Most data here renders server-side; this covers the client panels that
 * fetch when they open.
 */

import { useEffect, useRef, useState } from "react"

type AsyncState<T> = {
  data: T | null
  error: string | null
  pending: boolean
}

/**
 * Data a panel fetches when it opens, or when what it is showing changes.
 *
 * `run` receives an AbortSignal to pass to fetch. It is NOT an effect
 * dependency — an inline closure changes identity every render, so `deps` is
 * what decides when to re-run. Key `deps` on the REQUEST's identity, usually the
 * URL, so two renders that would issue the same request do not issue it twice.
 */
export function useAsyncData<T>(
  run: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
  enabled = true,
): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({
    data: null, error: null, pending: false,
  })

  // Monotonic. A response whose ticket is no longer the current one is dropped:
  // without this, request A resolving after request B overwrites B's data, and
  // the panel shows one row's answer under another row's heading.
  const ticket = useRef(0)

  useEffect(() => {
    if (!enabled) return
    const mine = ++ticket.current
    const controller = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- marks pending before the request starts
    setState((s) => ({ ...s, pending: true, error: null }))

    // `run` is read from this render's closure, not a ref: `deps` alone decides
    // when to re-run, which is the same contract a plain useEffect has with an
    // explicit dependency list. (A ref assigned during render is what
    // react-hooks/refs forbids.)
    run(controller.signal)
      .then((data) => {
        if (mine === ticket.current) setState({ data, error: null, pending: false })
      })
      .catch((e: unknown) => {
        // An abort is us superseding it, not a failure worth showing.
        if (controller.signal.aborted || mine !== ticket.current) return
        setState({
          data: null,
          error: e instanceof Error ? e.message : String(e),
          pending: false,
        })
      })

    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` IS the dependency list, by contract
  }, [enabled, ...deps])

  return state
}

/**
 * "One of these at a time", for a component whose handlers take arguments and
 * already own their own loading state.
 *
 * Same guard as useAsyncAction, without the `pending` flag. It exists as a hook
 * rather than a bare `useRef` in the component because `react-hooks/refs`
 * refuses a ref that render-defined handlers close over — keeping the ref inside
 * a hook is what makes the guard expressible at all.
 *
 * Returns `undefined` when it refused, so a caller can tell a skipped click from
 * a completed one.
 */
export function useInFlightGuard(): <T>(fn: () => Promise<T>) => Promise<T | undefined> {
  const inFlight = useRef(false)

  return async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight.current) return undefined
    inFlight.current = true
    try {
      return await fn()
    } finally {
      inFlight.current = false
    }
  }
}

/**
 * A mutation fired by a click. A second click while the first is in flight is a
 * no-op, and `pending` drives the button's disabled state.
 */
export function useAsyncAction<T>(
  run: () => Promise<T>,
): { pending: boolean; trigger: () => Promise<T | undefined> } {
  const [pending, setPending] = useState(false)
  // The REF is the guard, not `pending`. setState is async, so two clicks landing
  // in the same tick would both read pending === false and both fire.
  const inFlight = useRef(false)

  // Deliberately NOT memoized: it has to close over the current `run`, and the
  // guard that matters is the ref above, which persists across renders whatever
  // this function's identity does.
  const trigger = async (): Promise<T | undefined> => {
    if (inFlight.current) return undefined
    inFlight.current = true
    setPending(true)
    try {
      return await run()
    } finally {
      // finally, so a throw cannot leave the button permanently dead.
      inFlight.current = false
      setPending(false)
    }
  }

  return { pending, trigger }
}
