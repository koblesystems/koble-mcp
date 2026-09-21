---
name: ebms-sales-orders
description: Build, change and ship EBMS / Koble sales orders (ARINV) — creating an order for a customer, adding, removing or repricing lines, changing quantities, materials lists on assembly, kit and made-to-order lines, recalculating prices, changing an order's customer, calculating freight, and recording what shipped and what is back-ordered. Handles large orders within the API's 2-minute request limit. Use whenever someone wants to enter, edit, fulfil, ship, back-order, reprice or re-assign a sales order in EBMS or Koble, even if they just say "put in an order for…", "move order 1193 to another customer" or "mark order 1193 shipped". Posting an order into an invoice is not done here. Builds on the ebms-api skill. Needs the koble-mcp server (tools ebms_get, ebms_write, ebms_command).
---

# EBMS sales orders

Workflows for the sales document `ARINV` and its lines. Everything runs through the koble-mcp
tools `ebms_get`, `ebms_write` and `ebms_command`; how to call them, and how to read a write's
verification, is in the **ebms-api** skill — load it first. Its `references/odata-quirks.md`
holds the evidence behind these rules, and `references/entities/ARINV.md` / `ARINVDET.md` list
every field.

If those tools are not available, say the koble-mcp server is not connected and stop.

Everything here was verified against a live install (SBX, EBMS 1.8.148, September 2026)
unless it says otherwise.

## Which workflow

| The user wants to… | Open |
|---|---|
| Enter a new order | `references/build.md` |
| Change quantities, prices, lines or header fields on an existing order | `references/change.md` |
| Record a shipment or back-order, or turn an order into an invoice | `references/fulfil.md` |
| Work with a line's materials list (assemblies, kits) — or any order whose lines have one | `references/materials.md` |
| Recalculate prices, change the order's customer, or calculate freight | `references/commands.md` |
| Post the order into an invoice | Not here — see `references/fulfil.md` |

One request can need more than one — "bump the mugs to 30 and ship it" is a change, then a
fulfilment. Open each file the request needs before acting; this page is only the summary.

**This is a write workflow. The rules are short and not optional:**

1. **Nothing is created or changed without a yes for that specific write.** Show the user what it
   will do, in their words, and wait. A yes to one write is not a yes to the next.
2. **Report what EBMS stored, not what you sent.** `ebms_write` reads the record back and gives
   you `verification.rows`; prices and totals are computed server-side.
3. **One write at a time, and stop at the first problem** rather than carrying on down a list.
4. **Never send `PROCESS`.** The server refuses it at any depth. Posting a document is done by a
   person in EBMS.

**Not done by this skill:** posting or unprocessing an order, recording payments, emailing the
customer (`Send`), PDFs, and fee estimates. `references/commands.md` and `references/fulfil.md`
say why for each. If asked, say so plainly and suggest doing it in EBMS.

## Ground rules for every workflow

1. **Name the company before the first write** of a session and confirm it's the one the user
   means. Nothing in EBMS marks a dataset as live or sandbox.
2. **Address records by quoted AUTOID**: `/ARINV('<AUTOID>')`. Unquoted AUTOID is a 404.
3. **Change lines only through the order**, with a `Details@delta` array. Never write to
   `ARINVDET` directly. Read **top-level** lines through the order too — standalone detail reads
   have returned `_VIS` quantities as 0. Materials are the tested exception; see
   `references/materials.md`.
4. **A 200 proves nothing.** EBMS silently ignores an unknown line `@id` and fields it won't
   accept. After every write, read the order back and check each intended change landed.
5. **Report EBMS's numbers, not yours.** Prices and totals are computed server-side.
6. **Processing is never a side effect, and never happens here.** The server refuses `PROCESS`;
   `references/fulfil.md` says what to tell the user.
7. **Nothing reprices an order without a go-ahead.** `RecalculateAllPrices` and a customer
   change that recalculates prices both discard manual prices, and on orders with materials lists
   `RecalculateAllPrices` can multiply the total. See `references/commands.md`.

## Performance: the 2-minute limit

API requests are cut off at about **2 minutes**, and both careless reads and large orders run
into it. The measurements behind these rules are in ebms-api's `references/odata-quirks.md`.

- **Always pass `select`, including inside `expand`:**
  `Details($select=AUTOID,INVEN,M_QUAN_VIS)`. Unselected reads return every field, many computed
  on the fly — reading one 150-line order took 43 s unselected and 8 s selected.
- **At most 50 lines per request.** A 50-line create takes about 40 s. Larger orders are
  created with the first 50 lines, then extended in 50-line appends; `references/build.md` has
  the procedure.
- **Every write re-saves the whole order**, so cost follows the order's size, not the change's:
  one changed line on a 150-line order took 25 s. Put all of a request's changes in one PATCH
  rather than one PATCH per line.
- **Watch each chunk's time.** Past about 60 seconds, halve the next chunk. Orders of several
  hundred lines may not be extendable through the API at all — tell the user rather than
  sending chunks that will time out.
- **Never retry a write blindly.** When a result says `uncertain: true`, read the order back
  first. Whether EBMS finishes a write after the client is cut off has not been tested, and
  re-sending an add duplicates the lines.

## Finding things

Search case-insensitively, select only what you need, and confirm with the user whenever more
than one record matches.

Every one of these is an `ebms_get` call — `path` plus `filter`, `select` and `top` as separate
fields.

```
# Customers — not PHONE, which is not filterable
path: ARCUST
filter: INACTIVE eq false and (contains(tolower(ID),'smith') or contains(tolower(L_NAME),'smith') or contains(tolower(F_NAME),'smith'))
select: AUTOID,ID,F_NAME,L_NAME,CITY     top: 20

# Products — exclude the folder rows that share this entity set
path: INVENTRY
filter: not startswith(ID,'($)') and (contains(tolower(ID),'mug') or contains(tolower(DESCR_1),'mug'))
select: AUTOID,ID,DESCR_1,BASE           top: 20

# A customer's open (unprocessed) orders
path: ARINV   filter: ID eq 'SMIJOH' and STATUS eq 'U'
select: AUTOID,INVOICE,INV_DATE,DESCR,TOTAL_SO

# One order by number, or by the EXTERNALID you gave it
path: ARINV('1193')   select: AUTOID,INVOICE,STATUS
path: ARINV   filter: EXTERNALID eq 'claude-2026-09-21-a1'   select: AUTOID,INVOICE
```

If a product doesn't exist yet, use the **ebms-products** skill rather than inventing one.

**Read an order** with this shape every time you read back:

```
path:   ARINV('<AUTOID>')
select: AUTOID,INVOICE,ID,STATUS,TERMS,DESCR,PO_NO,EXTERNALID,TOTAL_S_SO,TOTAL_SO,SUBTOTAL,TOTAL
expand: Details($select=AUTOID,INVEN,DESCR,M_QUAN_VIS,M_SHIP_VIS,B_QUAN_VIS,UNIT_VIS,UNIT_MEAS,SO_AMOUNT,ACCOUNT)
```

- `STATUS` `'U'` = unprocessed order, editable. `'O'` = processed invoice, lines locked.
- `TOTAL_SO` is the **order** total (ordered quantities). `TOTAL` is the **invoice** total and
  follows **shipped** quantities — it reads 0 until something ships.
- For a quick check on a large order, drop `DESCR` and `ACCOUNT` from the line select.
- This shape does not show materials lists. If any line may have one, add `TIMESTAMP` to the line
  select and read the materials separately as `references/materials.md` shows — never with
  `expand: Details($expand=Materials)`, which added ~43 s on a 120-line order.
- **A line quantity of 0 with a 200 is a unit problem**, not a stock problem — check `UNIT_MEAS`
  against the product's `INVENUNT` rows. See `references/materials.md`.

## Not yet verified

Treat these as unknown, and say so if a request depends on them: whether EBMS completes a
write after the client times out; `MarkAllAsShipped` on very large orders; shipping part of a
line **without** back-ordering the rest; serialized, lot-tracked or rental items; units of
measure other than a product's default; multi-warehouse orders; tax overrides (`MAN_TAX`); the
`#id` / `#removed` delta syntax; `CalculateFreight` with a real carrier; the `NO_COMP` /
`NO_ACC` flags on materials; and whether a product with **accessories** (which add top-level
lines, unlike default components) behaves the same way on a create.
