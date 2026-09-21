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

- Ask for the worksheet if you do not have it. The usual way is that they attach or paste the
  edited CSV into the conversation: pass its text to `po_from_csv` as `csv`, **exactly as
  received** — do not tidy it. A path on their computer works too (`path`). Either way the run's
  own record is found on the computer that ran the plan.
- Confirm the company by name. It must be the company the worksheet was made for; `po_from_csv`
  refuses a mismatch. If the server is in testing mode, writes only go to the sandbox company —
  say so rather than working around it.

## 2. Read it

Call `po_from_csv`. It creates nothing. It returns:

- `counts` — rows, BUY rows, how many were approved and how many were not.
- `runRecordFound` — true when the run's own record was found on this computer. Then the
  product, unit, cost and date on every line come from the run, and only Order Qty, Approve and
  Vendor come from the file, so nothing a spreadsheet did to the file matters. If it is false,
  say so, and ask the planner to check products, units and costs on each draft with extra care.
- `problems` — approved rows that cannot be ordered as they stand: no vendor, a quantity that is
  not a plain number above 0, a vendor or product that is not in EBMS or is inactive, an approved
  row that is not a BUY row, a row that appears twice or was added by hand, Approve text it does
  not recognise, a Run cell that was changed, a file that mixes runs or companies — or that this
  server is not allowed to write to the company at all.
- `notes` — things that were handled but are worth saying, such as a product ID the spreadsheet
  had reformatted.
- `drafts` — one per vendor: vendor name, line count, estimated cost, `changedByPlanner` (every
  quantity or vendor that differs from the recommendation), and under `write` the exact request
  to send. A draft marked `alreadyCreated` was ordered from this same worksheet before.

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
- everything in `changedByPlanner`, read out, so they can confirm each change was meant. A line
  ordered in the stock unit because the chosen vendor has no record for the product needs a
  second look at its quantity.

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
  worksheet's. Then look at each line's `ETA_DATE`: EBMS sets it itself, from the vendor's lead
  time. Hold it against the draft's `neededBy` for that product and say plainly which lines are
  **expected after they are needed** ("SADDLE is needed 25 Sep; EBMS expects it 5 Oct") and
  which have **no expected date**. That is the planner's cue to call the vendor.
- **`verification.ok` is false** — stop. Show every mismatch and problem exactly as returned
  (for example a quantity stored as 0, which means the product's unit is set up wrongly). The
  purchase order exists; tell the planner its number and what is wrong on it, and do not create
  the remaining ones until they say to continue.
- **`refused: true` with an existing record** — it was already created from this worksheet.
  Report its number and move on.
- **`uncertain: true`** (a timeout, a dropped connection, a response that broke off) — do **not**
  send it again. Look for it: `ebms_get` with `path` `APINV`, `filter`
  `EXTERNALID eq '<the draft's EXTERNALID>'`, `select` `AUTOID,INVOICE,ID`. If it is there,
  report its number and carry on; if it is not, tell the planner and ask before retrying.
- **`uncertain: false`** with an error or a refusal — nothing was saved. If the result says the
  write was not sent (a check before it failed, or the server could not sign in), it is safe to
  try again; otherwise report EBMS's message and ask before trying anything else. Read the
  `uncertain` field, not the wording, to tell the two apart: the server sets it to true whenever
  the request had already gone to EBMS and the outcome is not known.

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
- Quantities are in the **purchase unit shown on the row**. A case is a case; never convert one
  yourself. If the planner moved a line to another vendor, `po_from_csv` has already converted
  it — the quantity is read in the unit the row showed, taken through stock units, and written
  in the new vendor's unit — and `changedByPlanner` spells that out ("2 CASE = 48 in stock
  units, ordered from V2 as 48 EA"). Read it back to them; it is the change most worth a second
  look. A line that could not be converted with confidence is in `problems` and was not drafted.
- Costs come from the product's vendor record. A missing cost is left for EBMS to fill in; say so
  rather than estimating.
- The needed-by date is **not** sent: EBMS works out a purchase line's expected date from the
  vendor's lead time, as far as has been observed (on four purchase orders in one company, a
  date that was sent came back as a different date or as nothing). What comes back is EBMS's
  own expected date, which is the useful thing to compare with the day the stock is needed.
