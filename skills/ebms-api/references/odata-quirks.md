# EBMS OData quirks

Server behaviors observed against a live install. These are the things that make a
textbook-correct OData request fail.

Several are build-specific. When you confirm or contradict one of these, note the `Version`
the company-list endpoint reported. A quirk fixed in a later build is worth dating rather
than deleting, since installs upgrade at their own pace.

## Filtering

- `contains()` and `tolower()` are supported. Combine them for case-insensitive search.
- **Not every field in the metadata is filterable.** `ARCUST.PHONE` is listed in metadata
  but returns EBMS error `-210 FieldNotFound` in a filter. When a filter 422s on one
  field, drop it rather than assuming the whole expression is wrong.
- **Collection filters can 500.** `TASK?$filter=TAEMPs/any(...)` returns HTTP 500 on this
  build. Work around it with a separate query against the child entity.
- **Bare-date comparisons 422.** `DUE_BY eq 2026-07-21` fails, because these are
  DateTimeOffset. Until the literal and timezone format is confirmed, filter dates
  client-side.
- Inventory *folders* live in `INVENTRY` as rows whose `ID` looks like `($)  15`. Exclude
  them from product searches with `not startswith(ID,'($)')`.

## Ordering and paging

- `$orderby` on `AUTOID` returns 422. Only some fields are orderable (on TASK, `DUE_BY`
  and `DUE_TIME` work).
- **No `@odata.nextLink`.** Page client-side with `$skip`/`$top`, and dedupe by `AUTOID`
  rather than relying on a stable sort.
- `@odata.context` in responses points at the server's *internal* host, which is not a
  reachable URL. Don't follow it.

## Detail rows must be read through their parent

Document detail rows carry `_VIS` fields (the visible, unit-aware quantity and cost).
Querying the detail entity **standalone** returns the rows with those fields reading **0**:

```
/APINVDET?$filter=DOC_AID eq 'PQ4RZT81HKVW2C00'&$select=INVEN,O_QUAN_VIS,UNIT_VIS
  -> {"INVEN":"TUBE700C","O_QUAN_VIS":0.00,"UNIT_VIS":0.00}

/APINV('PQ4RZT81HKVW2C00')?$expand=Details($select=INVEN,O_QUAN_VIS,UNIT_VIS)
  -> {"INVEN":"TUBE700C","O_QUAN_VIS":35.00,"UNIT_VIS":7.50}
```

The row, the `AUTOID` and non-`_VIS` fields such as `COST` and `UNIT_MEAS` are identical
either way, so nothing errors — the numbers are just silently zero. Verified on two POs
against SBX on EBMS 1.8.148; `$expand=APINVDETs` works as well as `Details`.

This is worth knowing before writing anything: a diff built from a standalone read sets
quantities from a baseline of zero and reports cost changes that never happened. Always
reach detail rows through the parent document.

## Selecting

Some virtual and derived fields are omitted from a normal GET **and** from `$select=*`.
They only appear when named explicitly (for example `TASK.PIPE_PHASEItems`). If a field you
expect from the docs isn't in the response, try selecting it by name before concluding it's
absent.

## Key addressing (the PATCH trap)

EBMS reports a wrong key form inconsistently: sometimes 404, sometimes 400 or 422 with
"Key not found". So a 404 on a keyed request usually means the key form, not a missing
record.

**Verified 2026-09-16 on SBX, EBMS 1.8.148**, for GET, PATCH and DELETE on `INVENTRY`,
`ARINV` and `ARCUST`:

| Path form | Result |
|---|---|
| `/ARINV('7XQPR42LM8W91000')` — AUTOID, **quoted** | works |
| `/ARINV(7XQPR42LM8W91000)` — AUTOID, unquoted | **404, every verb** |
| `/ARINV('1193')` — natural key, quoted | works |
| `/ARINV(INVOICE='1193')` — natural key, named | works |

Koble's own documentation shows unquoted AUTOID for DELETE; on this build it 404s like the
rest. Earlier versions of this file said to try unquoted AUTOID first — that only ever cost a
404.

- **Quoted AUTOID first.** Unique and unambiguous.
- The natural key, quoted. Invoice numbers are `EbmsLeftPad` and may be space-padded, which
  makes natural keys fragile.
- Composite keys. `APINV` is keyed by vendor **and** invoice number. Both the OData form
  `ID='AMERET',INVOICE='1234'` and EBMS's own pipe convention `'AMERET|1234'` appear in
  the wild, while `ARINV` by contrast is keyed by the invoice number alone.

## Values EBMS accepts but shouldn't

- **`APINV.TOP_TOTAL` is silently dropped.** POST and PATCH both return 200 and leave it at
  0. `TAX` and `FREIGHT` on the same header do persist, and `TOTAL` recomputes from them.
  Anything that diffs a document against a source will never satisfy a `TOP_TOTAL` change,
  so don't send it. (SBX, 1.8.148.)
- **`APINVDET.COST` is not the line amount you think it is.** On a line with a product,
  PATCHing `COST: 75` onto a `10 @ 7.50` line rewrote `UNIT_VIS` to **75**. Quantity
  (`O_QUAN_VIS`) and unit cost (`UNIT_VIS`) are the only safe things to write on a matched
  line; EBMS derives the rest. On a **description-only** line (no `INVEN`, quantity 0),
  `COST` *is* the amount and is mirrored into `UNIT_VIS` — that is the documented way to
  carry a freight or miscellaneous charge.
- **A matched line's `COST` stays 0 when the line was written over OData**, so the
  document's `SUBTOTAL` understates until EBMS recomputes it. Don't "fix" it by writing
  `COST` — see above.
- **`APVENDOR` does not auto-number.** A POST with no `ID` is accepted and creates a vendor
  whose natural key is the **empty string**: a record that no natural-key lookup will ever
  find. Vendor IDs are user-assigned mnemonics (`PARTSDIR`, `BAKSUP`, `FARMCO`); always send
  one. `APINV` *does* auto-number, assigning `INVOICE` "PO#174" and `PO_NO` "174".
- **`APINV.DESCR_H` truncates at 30 characters** without complaint.
- **`PIPE_PHASE` accepts any string** with a 200 and leaves the derived `PHASE_AID` stale.
  The client is the only validation. Related: write `PIPE_PHASE`, never `PHASE_AID` alone.
  The server derives the latter, and writing it directly corrupts the record.
- Fields that aren't writable in the record's current state are **silently ignored** on a
  PATCH that returns 2xx. Read back and compare for anything that matters.
- `TREE_ID` (inventory folder) is accepted unpadded (`"16"`) even though EBMS space-pads
  it internally.

## Other

- `PYEMP.TC_LOGIN` (the PIN) comes back **trimmed**, not space-padded to 10 like the raw
  DBF. Match as entered.
- `PYTMDET` (time detail) requires a `WORK_CODE` on clock-in, or you get "Workcode must not
  be empty" and a 422. Clock-out doesn't need one.
- Document attachments require the install's Document Storage folder to be configured, and
  a 404 on upload almost always means it isn't. Probe `?$select=DocumentsStatus&$top=1` on
  the entity first, where an empty string means working.

## Sales documents: creating, editing, shipping, processing

All verified 2026-09-16 against SBX on EBMS 1.8.148, using a throwaway customer, product and
orders that were deleted afterwards. The `ebms-sales-orders` skill turns these into
step-by-step workflows.

**Pricing**
- **Omit the price and EBMS applies the customer's price level, not `BASE`.** A product with
  `BASE` 27.50 came in at 41.04 for a `Retail` customer. Never promise a price before reading
  the line back.
- `UNIT_VIS` and `UNIT` both set a line's price on create and on edit, and mirror each other.

**Lines**
- **A description-only line (no `INVEN`) requires `ACCOUNT`**, a G/L account. Without one,
  EBMS aborts the *entire* document: `422 Saving has been aborted` / "requires a general
  ledger account". The account is company configuration — ask, don't reuse one you found.
- A new line's `DESCR` defaults to the product's `DESCR_1` and `DESCR_2` joined by a line
  break.
- `Details@delta` modify (`@id`), add (no `@id`) and remove (`@id` + `"@removed": true`) all
  work in one PATCH, and re-sending the same absolute values changes nothing.
- **An unknown `@id` is silently ignored**: 200, no error, no change, no phantom line. A
  mistyped line AUTOID looks like success. Read the document back and check each change.
- **An aborted POST still consumes an invoice number.** Orders `1193` and `1195` were created
  either side of a POST that aborted; `1194` does not exist. Validate a document before
  POSTing it rather than relying on EBMS to reject it, or the numbering gains gaps.

**Totals**
- `TOTAL_S_SO` / `TOTAL_SO` are the *order* subtotal and total (ordered quantities).
- `SUBTOTAL` / `TOTAL` are the *invoice* amounts and follow **shipped** quantities — they read
  0 until something ships. Quote `TOTAL_SO` as the order value.

**Shipping**
- `M_SHIP_VIS` records a shipment (the field Koble's examples use); `SHIP_VIS` mirrors it on
  a line in its default unit, and writing either sets both.
- **Back-orders are not computed.** Shipping 2 of 3 leaves `B_QUAN_VIS` at 0. Set it
  explicitly if the remainder should be back-ordered; the value sticks.
- **Over-shipping is accepted silently.** Shipping 7 against an ordered 5 returned 200 and
  invoiced all 7. Guard against it client-side.
- `MarkAllAsShipped` must be posted with **no request body**. An empty `{}` body returns
  `422 The command does not have a dialog`. It sets shipped = ordered on unshipped lines, but
  does **not** correct a line that is already over-shipped.

**Processing**
- `PATCH /ARINV('<AUTOID>') {"PROCESS": "Process"}` posts the order: `STATUS` goes `'U'` →
  `'O'` and `IsUnprocessed` → false. `PROCESS` itself reads back as `Default`; it is a
  trigger, not a stored state. Read `STATUS`.
- **A cash-terms order will not process until fully paid**: `422 Saving has been aborted` /
  "This cash invoice must be fully paid before it can be processed". Nothing is changed. New
  orders default to `TERMS` `Cash`; `TERMS: "Charge"` (with the customer's charge terms in
  `IDCHARGE`) processes without a payment. Payments can only be voided, never deleted.
- **A processed invoice's lines are locked, loudly**: editing one returns `403` "this field is
  read only in EBMS". Unlike most rejections this is a real error, not a silent no-op.
- `{"PROCESS": "Unprocess"}` reverses it: `STATUS` back to `'U'`, lines editable again.
  Unprocessing an order that is not processed is a harmless 200.
- Processing an order with a back-ordered line (2 shipped, 1 back-ordered) kept it as **one**
  document on this install; no separate back-order document was created.

## Document size and the 2-minute limit

API requests are limited to about 2 minutes. Measured against SBX on EBMS 1.8.148,
2026-09-17, with test orders that were deleted afterwards:

| Write on `ARINV` | Time |
|---|---|
| Create with 1 / 10 / 25 / 50 lines | 7.6 s / 11.8 s / 22.0 s / 39.6 s |
| Create with 50 lines, prices supplied | 42.6 s — pricing isn't the cost |
| Append 50 lines to an order with 50 / 100 lines | 50.4 s / 60.3 s |
| Append 100 lines to an order with 150 lines | 113.7 s — succeeded, within seconds of the limit |
| Change one line on an order with 150 lines | 24.7 s |
| Delete an order with 250 lines | 23.5 s |

- **A create costs about 7 s plus 0.65 s per line.**
- **Every write re-saves the whole document.** A one-line change on a 150-line order took
  25 s, and the same 50-line append took 10 s longer at 100 existing lines than at 50. Cost
  follows the document's size, not the change's.
- **So: at most 50 lines per request.** Create with the first 50, then append in 50s via
  `Details@delta`, and halve the chunk once a request passes about 60 s. Batch many edits into
  one PATCH rather than one PATCH per line. The `ebms-sales-orders` skill has the procedure.
- **Mark documents you create with an `EXTERNALID`.** It is settable on POST and filterable
  (`/ARINV?$filter=EXTERNALID eq '…'`), which is how you find out whether a create that timed
  out actually happened.
- **Never resend a timed-out write blindly.** Whether EBMS completes a write after the client
  is cut off is untested. Read back first: resending a modify is harmless, resending an append
  duplicates its lines.
- Timed on `ARINV` only. `APINV` has the same document shape and probably behaves alike, but
  wasn't measured.

## Commands (bound actions)

Verified against SBX on EBMS 1.8.148, 2026-09-17, with test records deleted afterwards.

- **Invoke as `POST /<ENTITY>('<AUTOID>')/Model.Entities.<Command>`.**
- **A command with no dialog must have no request body.** Even `{}` returns
  `422 The command does not have a dialog` (`MarkAllAsShipped`, `RecalculateAllPrices`,
  `CalculateFreight`).
- **A command with a dialog takes the dialog's fields as the body.** The metadata lists these as
  the action's *return* type (`…Dialog`) and declares no parameters, which is misleading.
- **Inside a dialog, refer to an existing record by `{"Guid": "…"}`.** Tested with
  `ARINV.ChangeCustomer`'s `NewCustomer`:
  - `{"Guid": "…"}` works.
  - `{"ID": "…"}` makes EBMS try to **create** a customer — `422 This Id already exists`.
  - `{"@id": "…"}` makes EBMS try to **save** one — `422 Could not find customer defaults`.
  - `{"AUTOID": "…"}` is refused (403) and `NewCustomer@odata.bind` isn't recognised.

  None of the failed attempts left a stray record behind.
- **Some identity fields can only change through a command.** `PATCH /ARINV('…') {"ID": "…"}`
  returns 403 "cannot change the id on a saved entity except with a command".
- **A command listed in the metadata may not be callable.** `ARINV.EstimateFees` returns 404 with
  no body, `{}`, or a payload.
- `RecalculateAllPrices` discards manual line prices, and on lines with materials lists replaces
  the materials-based price with the parent product's own price level — see below.
- `CalculateFreight` on an order shipping via `Pickup` returns 200 and changes nothing; untested
  with a carrier.

## Materials lists on sales lines

Verified against SBX on EBMS 1.8.148, 2026-09-17.

- Nest them as `Materials` inside a `Details` entry on create. They are **not** top-level lines:
  read them with `$expand=Details($expand=Materials)`. Each links to its parent by `PAR_TIME` =
  the parent's `TIMESTAMP`.
- **A material's `M_QUAN_VIS` is per single parent unit**, multiplied by the parent's quantity.
- **The parent line's price is the sum of its materials** per unit, not the parent product's own
  price. Setting a price on the parent rescales its materials proportionally.
- Edit with a nested delta: `Details@delta: [{"@id": "<parent>", "Materials@delta": [...]}]`.
  Modify, add and `@removed` all work, and the parent reprices each time.
- `RecalculateAllPrices` on such an order replaced each assembly's price with the parent
  product's own price level and rescaled every material: one untouched assembly went from 29.85
  to 149.25, and the order total from 152.26 to 462.68.

## Natural keys are silently truncated

A natural key longer than its field's maximum is **cut to length without an error**. An
`ARCUST.ID` of `ZTSKL71323A` (11 characters, max 10) was stored as `ZTSKL71323`. Two different
over-long IDs can therefore collide, and the second create fails with "This Id already exists"
for an ID you never sent. Check lengths against `references/entities/<ENTITY>.md` before
creating. (SBX, 1.8.148, 2026-09-17.)

## Reading materials: never `$expand=Materials`

Verified against SBX on EBMS 1.8.148, 2026-09-17, on a 120-line order with 3 materials.

| Read of the order's lines | Time |
|---|---|
| `Details($select=AUTOID)` | 4.1 s |
| `Details($select=` 8 line fields `)` | 8.2 s |
| `Details($select=AUTOID,INVEN,M_QUAN_VIS,UNIT_VIS;$expand=Materials($select=AUTOID))` | **50.2 s** |
| The same with `$filter` inside the expand, limited to the one parent | 49.2 s |
| `ARINVDET?$filter=DOC_AID eq '…' and PAR_TIME ne ''` — materials standalone | **0.5 s** |

- The materials expand costs about 43 s whatever is selected: EBMS resolves it for every line.
- The standalone materials rows matched the parent-expanded ones **field for field**, `_VIS`
  quantities and prices included. A material's `PAR_TIME` is its parent's `TIMESTAMP`.
- This does **not** contradict "detail rows must be read through their parent": that was
  observed on top-level `APINVDET` lines. Keep reading top-level lines through the parent.
