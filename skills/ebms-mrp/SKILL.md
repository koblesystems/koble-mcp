---
name: ebms-mrp
description: Run material requirements planning (MRP) for an EBMS / Koble company and give the planner a worksheet — what to buy, what to make, which incoming orders to expedite or cancel, and why — for a time frame they choose. Use whenever someone asks what they need to order or make, what they are short of, whether they can fill open orders, what to reorder, to "run MRP", to plan purchasing or production, to check coverage for the next weeks, or whether they can build a quantity of a finished good. Needs the koble-mcp server (tools mrp_plan and mrp_item_view). To act on the approved worksheet afterwards, use the ebms-mrp-purchase-orders skill for BUY rows and the ebms-mrp-batches skill for MAKE rows.
---

# EBMS material requirements planning

The arithmetic is done by the `koble-mcp` server: `mrp_plan` reads EBMS, nets demand against
supply day by day through the bill of materials, and writes a worksheet. Your job is the part
that needs judgement: getting the right question from the planner, reading the result with
them, and explaining any number they doubt. **Nothing in this skill writes to EBMS.**

If the tools `mrp_plan` and `mrp_item_view` are not available, say the koble-mcp server is not
connected and stop. Do not try to reproduce the plan by reading tables yourself.

## 1. Ask before you run

Ask these, in one message, and wait for the answers. Do not assume any of them.

1. **The time frame.** "How far ahead should this cover?" — a date, or a number of days. This is
   the one input the plan cannot guess: it means *buy and make what is needed for everything due
   on or before this date*. Offer a starting point if they are unsure: roughly their longest
   vendor lead time plus how often they place orders. `mrp_plan` refuses to run without it.
2. **The scope.** "Is this for everything, or are you working particular vendors or products
   today?" Buyers often do one vendor at a time. Pass `scope` as `everything`, `vendors` (with
   `vendors`: IDs or names, as the user says them) or `products` (with `items`). `mrp_plan`
   refuses to run without it, and asks back if a vendor name fits more than one vendor. The plan
   is always worked out for the whole company, because demand flows between items; the scope
   decides what is reported and what goes on the worksheet. A vendor-scoped plan leaves out
   `MAKE` rows; say how many batches were planned elsewhere if the result mentions them.
3. **The company**, if more than one is available. Confirm it by name (`ebms_companies`).
4. **Lead times**, only if they have them. EBMS does not publish vendor lead times through its
   API, so by default the plan says when stock is *needed*, not when to *order*. If the planner
   gives a number ("assume three weeks", or per product), pass `leadTimeDays` / `leadTimes` and
   the plan adds release dates and flags anything already too late. Never invent one.

Leave `includeJobs` on unless they say job transfers should not count as demand.

## 2. Run it

Call `mrp_plan` with the company and the time frame. It takes about half a minute on a small
company and longer on a large one; say so before you call it.

It returns a summary and the **worksheet** as CSV, attached to the result, and also saved on the
user's computer (in `Documents/Koble MRP` unless they chose a folder with `saveTo`).

**Give the user the worksheet as a file in the conversation.** If you can create files, create one
named exactly `worksheet.fileName` whose content is the attached CSV **character for character**.
Do not re-sort it, re-format it, round a number, drop a column or retype a value: every row
carries a `Check` code tying it to this run, and any number that differs from the run's own
record is reported as a change when purchase orders are drafted. If you cannot create files,
show the CSV in a code block and also give the saved path. Never send the user off to find the
file as the only option. If the result says the worksheet was too large to attach in full, say
what was attached (the rows needing a decision) and where the full file is.

## 3. Report, in this order

Lead with the file, then what matters most. Keep it short; the detail is in the worksheet.

1. **Where the worksheet is**, how many rows, and how many of each type.
2. **Expedites** — incoming purchase orders or batches that arrive after the stock is needed,
   or that have no expected date at all. These are the urgent ones: the supply exists, it is
   just late or undated. Give the document, the item, and the dates.
3. **Stock-outs to buy**, grouped by vendor, soonest first. Say how many lines per vendor and
   name the biggest few. Call out any with **no primary vendor** — those cannot be ordered until
   someone picks one. If the result has `alreadyOnOrderAfterTimeFrame`, say which of these
   items already have an order arriving shortly after the time frame: moving that order up may be
   better than buying more, and the planner should decide.
4. **What to make**, and for each what it pulls in below it. If a made item is *also purchased*,
   say so: the planner may prefer to buy it this time (`buyInstead`).
5. **Not needed** — open purchase orders nothing requires, inside the time frame or (net of what
   is on order for later) after it. Present these as
   questions to review, not instructions to cancel; the plan cannot see reasons outside EBMS.
6. **What the plan left out, and why** (`leftOut`), in a sentence: drop-ship and associated
   lines belong to their own orders, service items are not materials, fully shipped or received
   lines carry nothing. Mention any `warnings` in full — they are usually a product set up
   wrongly (a unit that does not belong to the product, for instance) and someone should fix it.
7. **Caveats that change how to read it:** if lead times are unknown, say the dates are
   needed-by dates. If many demand lines were already past due, say the plan treats them as due
   now. If incoming receipts have no expected date in EBMS, say so: they are counted on the last
   day of the time frame, and where one is needed sooner it shows up as an `EXPEDITE` row asking
   the buyer to confirm it will arrive by that date.

Do not paste the whole plan into the chat. Do not recalculate quantities yourself.

## 4. Explain a number

When the planner asks "why 48?" or "can we actually build those?":

- Every planned row has a **Because** column: the orders, batches, minimum or parent batch that
  caused it. Read it out.
- For a finished good, call `mrp_item_view` with the product and quantity. It shows everything
  needed down every level of the bill of materials against what is available
  (on hand + incoming − on order), what is covered from stock, what must be made and what must
  be bought. Show the tree as it comes.
- If they think an item that has never been on a batch should be treated as manufactured, run
  again with `alsoMade`. If a made item should be bought this time, use `buyInstead`.

## 5. Hand over the worksheet

Tell the planner what to do with it:

- Open it in a spreadsheet. Rows are in reading order: `EXPEDITE`, `BUY`, `MAKE`, `NOT NEEDED`,
  `OK`.
- On the `BUY` rows they want ordered (and the `MAKE` rows they want manufactured), put **Y** in **Approve**. They may change **Order Qty**
  (it is in the purchase unit shown beside it; plain numbers like `12` or `1.5`) and fill in or
  change **Vendor**. **Notes** is theirs. Leave every other column alone — especially **Run** and
  **Line** and **Check**, which tie each row to this run. Rows cannot be added by hand, and a row
  whose Run, Line or Check was changed is refused.
- A spreadsheet may reformat dates or long product numbers when it opens the file. That is
  harmless as long as the purchase orders are created on the same computer that ran the plan,
  because the run keeps its own record of each row.
- **EBMS Qty To Order** is what EBMS's own purchasing screen last saved for the product. It is
  there for comparison; the plan does not use it.
- Save it as CSV and attach or paste it back into the conversation. The
  `ebms-mrp-purchase-orders` skill turns the approved rows into purchase orders, one per vendor,
  and asks before creating each.

`MAKE` rows work the same way: a **Y** in **Approve** (and an adjusted **Order Qty** if they wish), and the `ebms-mrp-batches` skill turns them into pending manufacturing batches, one per row, asking before each. A `MAKE` row whose Notes say the product is not classified Track Count cannot be created through EBMS's API; that one is made in EBMS.

## How the plan works, for when you are asked

- **Demand:** open sales-order and job lines (ordered minus shipped), and the unused consumables
  of open manufacturing batches. A sales line with a materials list counts its components, not
  the parent line.
- **Supply:** open purchase-order lines (ordered minus received) and the unmade output of open
  batches, converted into each product's stock unit.
- **Starting point:** on hand. Minimum, maximum and reorder increment come from the product.
- **Two rules:** a projected stock-out pulls in a later receipt (an expedite) or plans a dated
  order, sized to bring the item back up to its maximum (or its minimum, if it has no maximum),
  rounded up to the reorder increment. Being under the minimum only produces an order if the item
  is still under it at the end of the time frame. There is at most one order per item per day.
- **Receipts with no expected date** are counted on the last day of the time frame.
- **What is on order after the time frame** is not counted, but it is shown.
- **Made or bought:** an item is manufactured if it has ever been the finished good of a batch.
  Made items are exploded through their components, level by level. Kits and configure-to-order
  items that have never been on a batch are not planned as batches.
- **Only stocked products and stocked lines are pooled.** Drop-ship, sync and associated lines are
  supplied by their own purchase orders.
- **Not covered yet:** planning per warehouse, warehouse transfers, and vendor lead times from
  EBMS.
