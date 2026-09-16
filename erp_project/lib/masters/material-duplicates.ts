// "Is this uploaded material already in the master, spelled differently?"
//
// Material names are typed by hand and by CSV, so the same material arrives as
// "TWEEN 80" / "Tween 80" and "Gmoist BT 99" / "Gmoist BT99". The column
// collation (utf8mb4_0900_ai_ci) already ignores case, so an exact-name lookup
// catches the first pair and misses the second — spacing and punctuation are
// what actually slip through.
//
// THE KEY IS FOR COMPARISON ONLY. The name is stored exactly as typed:
// master_rm holds `Carbopol® Aqua SF-1 OS polymer` and must keep holding it.
// Never write a normalised name back to the table.

/**
 * A name reduced to the letters and digits in it, for comparison.
 *
 * NFD, not NFKD: NFD decomposes accents (é -> e + combining mark, which the
 * strip then drops) and leaves ™ alone to be stripped as punctuation. NFKD
 * expands ™ to the letters "TM", so `FOAMYSENSE™ N60K` would key as
 * `foamysensetmn60k` and stop matching `FOAMYSENSE N60K` — the exact pair this
 * is meant to catch.
 *
 * U+FFFD falls out too, so a mojibake row keys the same as its repaired form.
 */
export function normalizeName(s: string): string {
  return s.normalize("NFD").toLowerCase().replace(/[^a-z0-9]+/g, "")
}

export type MaterialRow = {
  id: number
  code: string
  name: string
  /** RM only — master_pm has no make column. */
  make?: string | null
}

/**
 * The existing material an uploaded row duplicates, or null.
 *
 * RM identity is (name, make), not name alone: prod holds "Disodium EDTA"
 * twice and "Citric Acid" twice, each under a different supplier, and both are
 * legitimate. Keying on name alone would flag them on every upload and train
 * people to click past the warning.
 *
 * PM has no make column, so `make` is undefined on both sides and the key
 * collapses to the name — which is what catches its byte-identical
 * "Mono Carton EDP (Fein) Cherry wine 50ml" pair.
 */
export function findNameCollision(
  existing: MaterialRow[],
  name: string,
  make?: string | null,
): MaterialRow | null {
  const key = normalizeName(name)
  if (!key) return null
  const makeKey = normalizeName(make ?? "")
  return existing.find(
    (r) => normalizeName(r.name) === key && normalizeName(r.make ?? "") === makeKey,
  ) ?? null
}

/**
 * Makes already used by materials with this same normalised name, excluding
 * the candidate's own. Feeds the "did you mean?" typo check.
 *
 * This is why the fuzzy-make check needs the normalised key too: it used to
 * find its candidates with `LOWER(name) = LOWER(?)`, so `Gmoist BT99` never
 * saw the makes on `Gmoist BT 99` and no typo suggestion could fire.
 */
export function sameNameMakes(
  existing: MaterialRow[],
  name: string,
  candidateMake: string,
): string[] {
  const key = normalizeName(name)
  const makeKey = normalizeName(candidateMake)
  return [...new Set(
    existing
      .filter((r) => normalizeName(r.name) === key && r.make)
      .map((r) => r.make as string)
      .filter((m) => normalizeName(m) !== makeKey),
  )]
}

/** How the collision reads in the CSV preview. */
export function collisionMessage(match: MaterialRow, name: string): string {
  const same = match.name.trim() === name.trim()
  const shown = same ? `${match.code}` : `${match.code} — "${match.name}"`
  return `"${name}" already exists as ${shown}${match.make ? ` (make ${match.make})` : ""}. Same material?`
}
