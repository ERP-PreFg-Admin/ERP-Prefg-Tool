// Splits Infra metrics and alarms into the Test box, the Prod box, the shared RDS and the rest. Pure.

export type Env = "test" | "prod"

// Classified by Name tag; the ids are only the fallback for a failed tag lookup.
export const BOXES: Record<Env, { name: string; fallbackId: string }> = {
  test: { name: "erp-app-test", fallbackId: "i-0d269978588f3c2da" },
  prod: { name: "erp-app-prod", fallbackId: "i-0a249d3d470e693d3" },
}

export const instanceIdIn = (s: string | null | undefined) => s?.match(/i-[0-9a-f]+/)?.[0] ?? null

/** Which box an instance id is, by its Name tag, else by the known ids when the tag is missing. */
export function envForInstance(id: string | null, names: Record<string, string>): Env | null {
  if (!id) return null
  const name = names[id]
  if (name !== undefined) return name === BOXES.test.name ? "test" : name === BOXES.prod.name ? "prod" : null
  return id === BOXES.test.fallbackId ? "test" : id === BOXES.prod.fallbackId ? "prod" : null
}

/** Instance ids that belong to each box: every id tagged with its name, else its fallback id. */
export function boxInstanceIds(names: Record<string, string>): Record<Env, string[]> {
  const ids = (env: Env) => {
    const tagged = Object.keys(names).filter((id) => names[id] === BOXES[env].name)
    return tagged.length > 0 ? tagged : [BOXES[env].fallbackId]
  }
  return { test: ids("test"), prod: ids("prod") }
}

type PanelLike<S> = { series: S[] }

/** Splits each box panel's series into Test / Prod / Other, keeping every panel in each column. */
export function splitBoxPanels<S extends { label: string }, P extends PanelLike<S>>(
  panels: readonly P[],
  names: Record<string, string>
): Record<Env | "other", P[]> {
  const pick = (want: Env | null) =>
    panels.map((p) => ({ ...p, series: p.series.filter((s) => envForInstance(instanceIdIn(s.label), names) === want) }))
  return {
    test: pick("test"),
    prod: pick("prod"),
    other: pick(null).filter((p) => p.series.length > 0),
  }
}

type AlarmLike = { namespace: string | null; dimensions: string | null }

/** Box alarms by an instance id in their dimensions; AWS/RDS to shared; everything else to other. */
export function groupAlarms<A extends AlarmLike>(
  alarms: readonly A[],
  names: Record<string, string>
): Record<Env | "rds" | "other", A[]> {
  const ids = boxInstanceIds(names)
  const out: Record<Env | "rds" | "other", A[]> = { test: [], prod: [], rds: [], other: [] }
  for (const a of alarms) {
    const dims = a.dimensions ?? ""
    if (ids.test.some((id) => dims.includes(id))) out.test.push(a)
    else if (ids.prod.some((id) => dims.includes(id))) out.prod.push(a)
    else if (a.namespace === "AWS/RDS") out.rds.push(a)
    else out.other.push(a)
  }
  return out
}
