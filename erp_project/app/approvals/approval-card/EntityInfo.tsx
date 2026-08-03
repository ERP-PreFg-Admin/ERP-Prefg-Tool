"use client"

import type { Approval } from "../approvals-types"

/** Name leads (the team scans by name, not code) — code follows as a small
 *  muted monospace tag instead of the other way round. */
export function EntityInfo({ approval }: { approval: Approval }) {
  const { entity_code, entity_name, entity_secondary_code, entity_secondary_name, entity_id } = approval

  if (!entity_code && !entity_name) {
    return <span className="font-mono text-xs text-muted-foreground">#{entity_id}</span>
  }

  return (
    <div className="space-y-0.5">
      <div>
        {entity_name && (
          <span className="text-sm font-medium">
            {entity_name}
          </span>
        )}
        {entity_code && (
          <span className={`font-mono text-xs text-muted-foreground ${entity_name ? "ml-2" : "text-sm font-bold tracking-tight text-foreground"}`}>
            {entity_code}
          </span>
        )}
      </div>
      {(entity_secondary_code || entity_secondary_name) && (
        <div>
          {entity_secondary_name && (
            <span className="text-xs text-muted-foreground">
              {entity_secondary_name}
            </span>
          )}
          {entity_secondary_code && (
            <span className={`font-mono text-xs text-muted-foreground ${entity_secondary_name ? "ml-1.5" : ""}`}>
              {entity_secondary_code}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
