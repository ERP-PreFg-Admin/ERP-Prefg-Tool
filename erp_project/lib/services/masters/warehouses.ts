// Reads behind /masters/warehouses. Unscoped on purpose: see the page's header comment.
import { timedQuery } from "@/lib/query-timing"
import { warehouse as warehouseSql } from "@/lib/queries/warehouse"
import type { Warehouse, WarehouseEntity, Entity } from "@/types/masters"

export async function getWarehousesPage(): Promise<{ rows: Warehouse[]; entityRows: WarehouseEntity[]; entities: Entity[] }> {
  const rows = await timedQuery<Warehouse>(warehouseSql.selectAll, [], { label: "warehouses.selectAll" })
  const entities = await timedQuery<Entity>(warehouseSql.entityOptions, [], { label: "warehouses.entityOptions" })

  // Second query rather than a join: two child rows per location would either
  // duplicate every location row or need GROUP_CONCAT, which stops being
  // parseable once addresses are in it. Skipped entirely when there are no rows.
  const entityRows = rows.length
    ? await timedQuery<WarehouseEntity>(
        warehouseSql.selectEntityRowsByWarehouseIds,
        [rows.map((r) => r.id)],
        { label: "warehouses.selectEntityRows" }
      )
    : []
  return { rows, entityRows, entities }
}
