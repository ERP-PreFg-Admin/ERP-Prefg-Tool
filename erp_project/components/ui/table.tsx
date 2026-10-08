import * as React from "react"
import { cn } from "@/lib/utils"
import { ScrollFade } from "@/components/ui/scroll-fade"

const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <ScrollFade axis="x" className="w-full">
      {/* border-separate, not the preflight default of border-collapse: with
          collapsed borders browsers paint a `position: sticky` cell in the
          table's *background* layer, so the other columns' text draws straight
          over a frozen column no matter its background or z-index. Spacing is 0
          and the row borders moved to the cells below, so it looks identical. */}
      <table
        ref={ref}
        className={cn("w-full caption-bottom text-sm border-separate border-spacing-0", className)}
        {...props}
      />
    </ScrollFade>
  )
)
Table.displayName = "Table"

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <thead ref={ref} className={className} {...props} />
  )
)
TableHeader.displayName = "TableHeader"

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tbody ref={ref} className={cn("[&_tr:last-child>*]:border-b-0", className)} {...props} />
  )
)
TableBody.displayName = "TableBody"

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      // The border lives on the cells, not the row: the separated-borders model
      // above ignores borders set on a <tr>.
      className={cn("[&>*]:border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted", className)}
      {...props}
    />
  )
)
TableRow.displayName = "TableRow"

// The one header look (docs/table-header-plan.md). Opaque mix, not bg-muted/50,
// so sticky headers don't show rows through.
export const HEAD_BG = "bg-[color-mix(in_oklch,var(--muted)_50%,var(--background))]"
// For hand-written <tr><th> headers; put HEAD_BG on the <thead>, not the row,
// so a th's own background (sticky column, selected state) still wins.
export const HEAD_ROW_LOOK = "[&>th]:text-xs [&>th]:font-medium [&>th]:text-muted-foreground"

const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th
      ref={ref}
      className={cn("h-10 px-4 text-left align-middle text-xs font-medium text-muted-foreground", HEAD_BG, className)}
      {...props}
    />
  )
)
TableHead.displayName = "TableHead"

const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td ref={ref} className={cn("px-4 py-3 align-middle", className)} {...props} />
  )
)
TableCell.displayName = "TableCell"

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell }
