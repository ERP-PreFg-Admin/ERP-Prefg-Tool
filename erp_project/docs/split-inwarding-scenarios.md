# Split POs at inwarding — every scenario, for discussion

Each scenario shows what the **proposed rule** does
(`docs/invoice-po-allocation-plan.md`). Open questions are marked **DECIDE**.

## The rule being discussed

For each invoice line (manufacturer, SKU, invoice destination):

1. Candidates = open POs with the **same manufacturer, SKU and destination**,
   **oldest first**. A split child is dated by its **parent**.
2. Split child → fill the child; anything left goes to **its parent's** remainder.
3. Otherwise → fill the PO's remaining quantity.
4. Then the next oldest candidate. Whatever is left → **shortage, invoice blocked**.

A receipt written to a child also shows on its parent (parent's Received = own +
children's). Nothing is counted twice.

## The POs every scenario starts from

All for manufacturer **NGE**, SKU **SKU-A**.

| PO | Destination | Qty | Raised | Notes |
|---|---|---|---|---|
| **P** | Mumbai | 3,000 | 1 Sep | split into S001 + S002 → **remainder 500** |
| ↳ **S001** | Mumbai | 1,000 | split 20 Sep | dated **1 Sep** (its parent) for ordering |
| ↳ **S002** | Ahmedabad | 1,500 | split 20 Sep | dated **1 Sep** |
| **R** | *(none)* | 800 | 5 Sep | impromptu, no destination |
| **Q** | Ahmedabad | 1,000 | 10 Sep | ordinary PO |
| **M** | Mumbai | 600 | 15 Sep | ordinary PO |

Tolerance (auto-close): `min(100, 10% of qty)` → S001 100, S002 100, Q 100, M 60.

---

## A. Invoices to the split child's destination (Ahmedabad)

| # | Invoice | Booked | Result |
|---|---|---|---|
| A1 | 1,000 | S002 1,000 | S002 1,000/1,500 · P shows 1,000/3,000 |
| A2 | 1,500 | S002 1,500 | S002 **received** (full) · P 1,500 |
| A3 | 2,200 | S002 1,500 → **P 500** → Q 200 | worked example: overflow goes to the split's own parent before the next PO |
| A4 | 4,000 | S002 1,500 → P 500 → Q 1,000 → *R 800?* | 200 short → **blocked** (see **DECIDE 1** for R) |
| A5 | 1,450 | S002 1,450 | S002 within tolerance (50 ≤ 100) → **auto-closes received**. See J |

## B. Invoices to the parent's destination (Mumbai)

| # | Invoice | Booked | Result |
|---|---|---|---|
| B1 | 800 | S001 800 | the child goes first, even though P is also Mumbai |
| B2 | 1,800 | S001 1,000 → P 500 → M 300 | child, then its parent, then the next oldest Mumbai PO |
| B3 | 300, when S001 is already full | P 300 | **DECIDE 3**: P is a Mumbai candidate in its own right, so its remainder is used directly |

## C. Invoices to a destination with no PO (Kolkata)

| # | Invoice | Booked | Result |
|---|---|---|---|
| C1 | 100 | *R 100?* or nothing | **DECIDE 1**: with no-destination POs as a fallback → R; without → **blocked**, "no open PO for SKU-A to Kolkata" |
| C2 | 100, R already used up | nothing | **blocked** |

## D. Several lines or SKUs on one invoice

| # | Invoice | Booked | Result |
|---|---|---|---|
| D1 | Two lines of SKU-A to Ahmedabad: 1,000 + 800 | line 1 → S002 1,000 · line 2 → S002 500 → P 300 | what's left on a PO is tracked across the **whole invoice**, so lines can't double-book |
| D2 | SKU-A 500 + SKU-B 200, Ahmedabad | each SKU allocated on its own candidates | an SKU-B shortage blocks the invoice even if SKU-A is fine |

## E. Order between families

| # | Setup | Invoice | Booked |
|---|---|---|---|
| E1 | A second split family **P2** (raised 25 Aug) with an Ahmedabad child S2-A 400 | Ahmedabad 600 | **S2-A 400 → P2's remainder** (P2 is older than P), then S002 |
| E2 | Q was raised 31 Aug (older than P) | Ahmedabad 600 | **Q 600**: an ordinary older PO beats a newer split family |

## F. The parent's own destination

| # | Setup | Invoice | Booked |
|---|---|---|---|
| F1 | P raised to **Ahmedabad**, split into Mumbai + Gurgaon children | Ahmedabad 400 | P's remainder (P is an Ahmedabad candidate) |
| F2 | Same P | Mumbai 400 | Mumbai child; overflow → P's remainder (**DECIDE 2**: even though P is Ahmedabad) |

## G. Split happened after a part receipt

| # | Setup | Invoice | Booked |
|---|---|---|---|
| G1 | P received 600 **before** the split, then split S001 1,000 + S002 1,500 → remainder 3,000 − 600 − 2,500 = **−100** | — | the split route already refuses this (split total > remaining). With S002 1,400 instead → remainder 0 |
| G2 | As G1, remainder 0 | Ahmedabad 1,500 | S002 1,400 → P **0** → next Ahmedabad PO (Q) 100 |

## H. Different manufacturer on a child (API-only split)

| # | Setup | Invoice | Booked |
|---|---|---|---|
| H1 | S002 moved to manufacturer **KAI** | KAI invoice to Ahmedabad 1,600 | S002 1,500 → **DECIDE 4**: overflow to P (an NGE PO) from a KAI invoice? Proposed **no**: overflow only to a parent of the same manufacturer → then the next KAI Ahmedabad PO |

## I. Special types (npd / tech_transfer / cpr)

| # | Setup | Invoice | Booked |
|---|---|---|---|
| I1 | P is an **npd** PO at price 0; children inherit npd at 0 | Ahmedabad 1,000 | S002 1,000. The invoice rate is taken as it is; the PO shows "no agreed rate (NPD)", not a variance |

## J. Tolerance and short-close — where a parent gets stuck

| # | Setup | What happens |
|---|---|---|
| J1 | S002 auto-closed at 1,450 (A5) | P shows 2,950 / 3,000 — **never reaches full**. Its 50-unit gap is still "allocated" to S002, so P drops out of the picker. **Someone must short-close P manually.** **DECIDE 5** |
| J2 | S001 short-closed at 700 | Same: P stays partially received at 2,700 + own. **DECIDE 5** |
| J3 | Invoice to Ahmedabad 100 after J1 | S002 is closed → next candidate Q 100. The 50 units S002 didn't get **are not offered** to Ahmedabad again |

## K. Cancelling and the guard

| # | Action | Proposed |
|---|---|---|
| K1 | Cancel S002 with **0** received | allowed → its 1,500 returns to P's remainder (2,000) |
| K2 | Cancel S002 with **1,000** received | **refused**: "S002 has received 1,000. Short-close it instead." Without this, the 1,000 vanish from P and can be received again |
| K3 | Cancel **P** while S001 has receipts | **refused**, same reason |
| K4 | Cancel P when no child has receipts | allowed. **DECIDE 6**: should it cancel the children too? Today they stay receivable |

## L. Mailing and drafts

| # | Setup | Proposed |
|---|---|---|
| L1 | S002 **not yet mailed** to the manufacturer (shows as Draft) | **DECIDE 7**: may an invoice be booked against it? Today: yes through invoices, no through manual Receive |

## M. Safety nets (no decisions, they just hold)

| # | Case | Behaviour |
|---|---|---|
| M1 | The invoice's destination is changed in the dialog | allocation runs again on the new destination |
| M2 | A stale browser tab allocated under the old rule | the server re-checks at commit and refuses with the line named |
| M3 | Uniware | the inward PO's `ReferenceOrder` lists the PO numbers received against, e.g. `P-S002, P`. GRNs map back through the inward PO |
| M4 | Inward POs | one per SKU per invoice, as today; `reference_po` = the PO received against |

---

## Decisions needed

| # | Question | Proposed |
|---|---|---|
| **1** | POs with **no destination** (366 of 513 open on prod): candidates? | Yes, but only **after** every PO naming the destination, with a note on the line |
| **2** | Overflow from a child to its parent when the parent's destination is different | Yes, always (parents are generally Mumbai by default) |
| **3** | A parent's remainder used **directly** when the parent itself is at the invoice destination (B3) | Yes, it's an ordinary candidate for its own destination |
| **4** | Overflow across manufacturers (child moved to another manufacturer) | No: only to a parent of the same manufacturer |
| **5** | Parent stuck short of full after a child closes within tolerance or is short-closed | **Auto-close the parent** when every child is closed and its own remainder is received. Otherwise leave it for a manual short-close |
| **6** | Cancelling a parent: cascade to children without receipts? | Yes, cascade (children are the same order) |
| **7** | Receiving against a child that hasn't been mailed | No: same as manual Receive, it must be mailed first |
