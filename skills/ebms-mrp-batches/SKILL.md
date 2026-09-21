---
name: ebms-mrp-batches
description: Create EBMS / Koble manufacturing batches from an approved MRP worksheet — the CSV the ebms-mrp skill produced, after the planner marked MAKE rows to manufacture. Use whenever someone hands back an MRP worksheet and wants the batches created, says "create the batches", "start production on what I approved", "make the ones I marked", or asks to turn planned production into manufacturing batches. One batch per approved row, each confirmed before it is created and verified after. Batches are left pending: nothing is marked as made, consumed or processed. Needs the koble-mcp server (tools batches_from_csv and ebms_write).
---

# Manufacturing batches from an MRP worksheet

This is a **write** workflow. The rules are short and not optional:

1. **Nothing is created without a clear yes for that specific batch.**
2. **The numbers come from the worksheet and the bill of materials, through `batches_from_csv`.
   Never retype, round or "fix" a quantity, unit, component or warehouse yourself.** If something
   looks wrong, say so; the planner changes the worksheet or the product in EBMS.
3. **A batch is created pending.** Nothing is marked as made, nothing as consumed, and `PROCESS`
   is never sent. Recording production and processing the batch is a person's job in EBMS.
4. **One at a time, and stop on the first problem.**

If `batches_from_csv` or `ebms_write` is not available, say the koble-mcp server is not connected
and stop.

## 1. Get the file, the company and the warehouse

- The planner attaches or pastes the edited worksheet: pass its text as `csv`, exactly as
  received. A path on their computer works too (`path`). The same worksheet can carry approved
  `BUY` rows as well; those belong to the ebms-mrp-purchase-orders skill and are ignored here.
- Confirm the company by name. It must be the company the worksheet was made for.
- **Ask about the warehouse** if the company has more than one: "Which warehouse are these
  batches for?" Pass it as `warehouse`. If they do not say, each product's batch goes to the
  warehouse where that product was last made, and the draft says so — read that out so they can
  correct it.

## 2. Read it

Call `batches_from_csv`. It creates nothing. It returns:

- `counts` — MAKE rows, how many were approved and how many were not.
- `runRecordFound` — true when the run's own record was found on this computer, so nothing a
  spreadsheet did to the file matters. If false, say so and ask for extra care over each draft.
- `problems` — approved rows that cannot become a batch:
  - **the product is not classified Track Count.** EBMS refuses any other classification as a
    batch's finished good through its API. The batch has to be created in EBMS, or the product's
    classification changed there first. Do not try to work around it.
  - the product has no components on its bill of materials, or is not an active product;
  - no warehouse is known for a product that has never been made;
  - the usual worksheet problems: a row that was changed, duplicated or added by hand, Approve
    text it does not recognise, a quantity that is not a plain number.
- `drafts` — one per approved row: the product, how many and in what unit, the warehouse, the day
  it is needed, `consumes` (every component, with the amount for one finished good and the total
  for the batch), `changedByPlanner`, `notes`, and under `write` the exact request to send. A draft
  marked `alreadyCreated` was made from this same worksheet before.

**Deal with problems first.** Read each one out with its line number. Do not guess a warehouse,
and do not drop a component to make a row usable.

## 3. Show each batch and ask

For every draft that is not `alreadyCreated`, show:

- the product, the quantity **with its unit**, the warehouse and the needed-by date;
- everything it will consume, from `consumes`. This is the whole bill of materials for that
  product: EBMS does **not** add consumed materials itself when a batch arrives through the API,
  so what is listed is exactly what the batch will contain. Ask them to look it over — a missing
  or outdated component on the product is fixed on the product in EBMS, then the draft is made
  again;
- every `note`: components left off because they belong to an option group (configure-to-order
  choices), have a quantity of 0, or are the product itself; and where the warehouse came from;
- everything in `changedByPlanner`.

Then ask plainly, per batch: *"Create a batch for 6 × GADGET in MAIN, consuming 12 WIDGET and
48 BOLT?"* A yes to one is not a yes to the next.

For drafts marked `alreadyCreated`, give the existing batch number and skip them.

## 4. Create, verify, report

For each approved draft, call `ebms_write` with exactly what the draft's `write` gives you:
`method`, `path`, `body` and `readBack`. Do not add fields — in particular no dates, no
quantities made or consumed, and never `PROCESS`.

Read the result before moving on:

- **`verification.ok` is true** — report the batch number (`BATCH` in the record's stored values),
  the product, quantity, unit and warehouse, and the consumed lines as EBMS stored them.
- **`verification.ok` is false** — stop. Show every mismatch and problem exactly as returned. The
  batch exists; give its number and say what is wrong on it. A quantity stored as 0 means a unit
  on that product is set up wrongly. Do not create the remaining batches until they say to go on.
- **`refused: true` with an existing record** — it was already created from this worksheet.
  Report its number and move on.
- **`uncertain: true`** — do **not** send it again. Look for it: `ebms_get` with `path` `INMFG`,
  `filter` `EXTERNALID eq '<the draft's EXTERNALID>'`, `select` `AUTOID,BATCH`. If it is there,
  report it; if not, tell the planner and ask before retrying.
- **`uncertain: false`** with an error — nothing was saved. Report EBMS's message. "You must
  select a product that is of a track count type for manufacturing" means the product's
  classification; it is fixed in EBMS, not here.

## 5. Finish

Summarise: which batches were created (number, product, quantity, warehouse), which were skipped
and why, which approved rows could not become batches, and what is left unapproved. Remind them:

- the batches are **pending** — production is recorded, and the batch processed, in EBMS;
- the next MRP run will count each new batch as incoming supply of its product and as demand on
  its components. With no expected date on it, the plan will ask them to confirm it by the day it
  is needed; putting an expected date on the batch in EBMS removes that question.

## Things to know

- A batch's `EXTERNALID` is the worksheet's run plus the row's line. That is why the same file
  cannot create a batch twice, and why a new `mrp_plan` run is needed for a new round.
- Quantities: the finished good is in its own stock unit. Each consumed line carries the amount
  for **one** finished good; EBMS multiplies by the batch size (3 finished goods at 2 each is
  stored as 6). This was confirmed by creating test batches.
- Every line states its unit, the product's stock unit, so EBMS cannot default a line to a unit
  the quantity was not written in.
- Labour and other service items on the bill of materials are included as consumed lines, the
  way EBMS's own screens include them.
- Not covered: lots and serial numbers on finished or consumed lines, a separate warehouse for
  consumption, sub-batches, and recording or processing production.
