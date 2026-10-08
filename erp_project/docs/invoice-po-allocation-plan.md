# Invoice inwarding — allocate by manufacturer + SKU + destination, oldest first, split-aware

## Context

When an invoice is inwarded, each line is booked against an open procurement PO.
Today `allocateFifo` (`app/po-tracking/po-inwarding/invoice-form.ts:335`) groups
open POs **by SKU only** and fills oldest first; `openForReceiveByMfg`
(`lib/queries/purchase-orders.ts:901`) doesn't select the destination, and the
server (`receivePo`) checks only status and quantity. An invoice delivered to
Ahmedabad can be booked against the Mumbai child of a split.

## The rule (Ajay, 2026-10-07)

For each invoice line (manufacturer **M**, SKU **S**, invoice destination **D**):

1. **Candidates:** open POs with manufacturer **M**, SKU **S** and destination
   **D** (case- and space-insensitive), **oldest first**. A split child is dated
   by its **parent's** raise date — it is the same order, re-issued.
2. **If a candidate is a split child:** fill the child, then put anything still
   left on **its parent's** unallocated remainder — whatever the parent's own
   destination (parents are generally raised to Mumbai by default).
3. **Otherwise** (an ordinary PO, or a parent whose own destination is D): fill
   its unallocated remainder.
4. Then the **next oldest** candidate.
5. Whatever is still uncovered is a **shortage** — the invoice can't be submitted.

**"Marked against the child and its parent":** the receipt is **written to the
child**; the parent **shows it automatically**, because its `received_total` is
its own receipts plus its children's. Nothing is stored twice and nothing is
counted twice. A chunk that overflows onto the parent (step 2) is written to the
parent's own `received_qty`.

### Worked example

Parent `P` (Mumbai, 3,000, raised 1 Sep) split into `S001` Mumbai 1,000 and
`S002` Ahmedabad 1,500 → `P`'s unallocated remainder is 500. Another PO `Q`
(Ahmedabad, 1,000, raised 10 Sep). Invoice: **2,200 to Ahmedabad**.

| Step | Booked against | Qty | Why |
|---|---|---|---|
| 1 | `S002` (Ahmedabad) | 1,500 | oldest Ahmedabad candidate (dated 1 Sep via its parent) |
| 2 | `P` remainder | 500 | overflow from the split goes to its parent |
| 3 | `Q` (Ahmedabad) | 200 | next oldest Ahmedabad candidate |

Result: `S002` received 1,500; `P` shows 2,000 received (500 own + 1,500 via
`S002`); `Q` received 200. `S001` (Mumbai) untouched.

## ⚠️ To confirm before building

1. **POs with no destination.** On prod **366 of 513 open POs have none**.
   Under step 1 they never match, so most invoices would block. **Proposed:** after
   every PO naming **D**, a PO with **no** destination is also a candidate (oldest
   first), and the line says `booked against <po_no> (no destination on the PO)`.
   A PO naming a *different* destination is never a candidate.
2. **Parent remainder only via overflow.** In step 2 a Mumbai parent's remainder is
   used only by overflow from one of its own children at **D** — never directly
   by an Ahmedabad invoice that has no child there. (Step 3 covers a parent whose
   own destination is D.)

## Sequencing and gates

1. **Pure allocator** + unit tests (no DB) — the worked example and the truth
   table below.
2. **Data:** `openForReceiveByMfg` adds `po.destination`, `po.reference_po`, and
   the parent's raise date for children.
3. **Server re-check at commit** (`lib/invoice/invoice-inward.ts`): each line's
   reference PO has the line's SKU and the invoice's manufacturer, and either the
   invoice's destination or is the parent of a child at it. DB test under
   `withRollback`.
4. **Cancel guard:** a PO with receipts — or a parent whose child has receipts —
   can't be cancelled; short-close instead (stops units being received twice).
5. **Parent's inwarding panel** lists invoices booked against its children.
6. Dev end-to-end with the worked example.

No DDL.

## Not doing

- Storing child receipts on the parent too (it would double-count).
- Moving a shortfall between siblings, or tolerance at the parent level.
- The split/receipt race (needs a lock in the split route) — separate change.

## Risks

1. **Invoices that went through before will block** when the destination has no
   open PO for that SKU — intended; the shortage names the destination.
2. **Destination spelling** on older free-text POs may not match the warehouse
   names; run a read-only prod check for destinations not in `master_warehouse`
   before go-live.
3. **A stale browser tab** that allocated under the old rule is refused at commit
   by the new server check.

## Verification

- `npm test` — the worked example; never another destination; child before its
  parent's remainder; overflow from a child lands on **its own** parent; family
  dated by the parent; cross-line `remaining`; shortage message; (if confirmed)
  no-destination POs only after destination matches.
- `npm run test:db` — commit refuses a reference PO with another destination,
  SKU or manufacturer; cancel refuses a PO with receipts and a parent whose child
  has receipts; the parent's panel lists a child's invoice.
- Dev manual: the worked example above, then an invoice to Kolkata that blocks
  with the destination named.
