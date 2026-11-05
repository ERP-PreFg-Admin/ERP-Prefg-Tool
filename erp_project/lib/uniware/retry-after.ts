// Retry a call on one kind of error, waiting the given delays between tries. Pure, so it's unit-tested.

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Tries once, then once more after each delay while `retryable(err)` holds; the last error is rethrown. */
export async function retryAfter<T>(
  fn: (attempt: number) => Promise<T>,
  retryable: (err: unknown) => boolean,
  delaysMs: number[],
  sleep: (ms: number) => Promise<void> = wait,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      if (attempt >= delaysMs.length || !retryable(err)) throw err
      await sleep(delaysMs[attempt])
    }
  }
}
