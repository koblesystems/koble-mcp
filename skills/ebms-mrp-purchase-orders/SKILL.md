---
name: ebms-mrp-purchase-orders
description: Create EBMS / Koble purchase orders from an approved MRP worksheet — the CSV the ebms-mrp skill produced, after the planner marked rows to order. Use whenever someone hands back an MRP worksheet, says they have approved or reviewed the MRP file, asks to "create the POs", "place these orders" or "order what I approved", or attaches a CSV with Run / Type / Approve / Order Qty columns. One purchase order per vendor, each confirmed before it is created and verified after. Needs the koble-mcp server (tools po_from_csv and ebms_write).
---

# Purchase orders from an MRP worksheet

This is a **write** workflow. The rules are short and not optional:

1. **Nothing is created without a clear yes for that specific purchase order.**
2. **The numbers come from the worksheet, through `po_from_csv`. Never retype, round or "fix" a
   quantity, unit, cost or vendor yourself.** If something looks wrong, say so and let the
   planner change the file.
3. **Never send `PROCESS`.** These are purchase *orders*; receiving and processing them is a
   person's job in EBMS.
4. **One at a time, and stop on the first problem.**

If `po_from_csv` or `ebms_write` is not available, say the koble-mcp server is not connected
and stop.

## 1. Get the file and the company

- Ask for the worksheet if you do not have it: its path on their computer, or the file attached.
  Pass the path as `path`, or the file's text as `csv`.
- Confirm the company by name. It must be the company the worksheet was made for; `po_from_csv`
  refuses a mismatch. If the server is in testing mode, writes only go to the sandbox company —
  say so rather than working around it.

## 2. Read it

Call `po_from_csv`. It creates nothing. It returns:

- `counts` — rows, BUY rows, how many were approved and how many were not.
- `problems` — approved rows that cannot be ordered as they stand: no vendor, a quantity of 0,
  a vendor or product that is not in EBMS or is inactive, an approved row that is not a BUY row,
  a file that mixes runs or companies.
- `drafts` — one per vendor: vendor name, line count, estimated cost, and under `write` the exact
  request to send. A draft marked `alreadyCreated` was ordered from this same worksheet before.

**If there are problems, deal with them first.** Read each one out with its line number. The
planner either fixes the file and hands it back, or tells you to go ahead without those rows.
Do not guess a vendor or a quantity to make a row usable.

If nothing was approved, say so and explain the **Approve** column; do not offer to approve rows
for them.

## 3. Show each purchase order and ask

For every draft that is not `alreadyCreated`, show:

- the vendor (ID and name);
- each line: product, quantity **with its unit**, unit cost if there is one, needed-by date;
- the estimated total, or that it cannot be estimated because a cost is missing;
- anything the planner changed from the recommendation, if you can see it.

Then ask plainly, per purchase order: *"Create this purchase order for BIKEPARTS — 2 lines,
about $1,350?"* A yes to one is not a yes to the next. If they say "yes to all", list the
vendors back once and confirm, then proceed in order.

For drafts marked `alreadyCreated`, give the existing PO number and skip them. That is the
server protecting against ordering twice, not an error.

## 4. Create, verify, report

For each approved draft, call `ebms_write` with exactly what the draft's `write` gives you:
`method`, `path`, `body` and `readBack`. Do not add fields.

Read the result before moving on:

- **`verification.ok` is true** — report the PO number (`record.INVOICE`), the vendor, and the
  stored lines from `verification.rows`: quantity, unit, cost. Use EBMS's values, not the
  worksheet's.
- **`verification.ok` is false** — stop. Show every mismatch and problem exactly as returned
  (for example a quantity stored as 0, which means the product's unit is set up wrongly). The
  purchase order exists; tell the planner its number and what is wrong on it, and do not create
  the remaining ones until they say to continue.
- **`refused: true` with an existing record** — it was already created from this worksheet.
  Report its number and move on.
- **`uncertain: true`** (a timeout or dropped connection) — do **not** send it again. Look for it
  with `ebms_get` on `APINV` filtered by the draft's `EXTERNALID`. If it is there, report it; if
  not, tell the planner and ask before retrying.
- **Any other refusal** — report EBMS's message. Nothing was saved. Ask before trying anything
  else.

## 5. Finish

Summarise: which purchase orders were created (number, vendor, lines, total), which were
skipped and why, which approved rows could not be ordered, and what is left on the worksheet
unapproved. Remind them that `EXPEDITE` and `NOT NEEDED` rows are changes to existing purchase
orders that they make in EBMS, and `MAKE` rows are batches they create in EBMS.

Do not offer to receive, process or pay the purchase orders.

## Things to know

- The purchase order's `EXTERNALID` is the worksheet's run plus the vendor ID. That is why the
  same file cannot order twice, and why a *new* `mrp_plan` run is needed for a new round of
  ordering.
- Quantities are in the **vendor's purchase unit** shown on the row. A case is a case; do not
  convert.
- Costs come from the product's vendor record. A missing cost is left for EBMS to fill in; say so
  rather than estimating.
- The needed-by date is sent as the line's expected date. It is when stock is needed, not a
  promise from the vendor.
