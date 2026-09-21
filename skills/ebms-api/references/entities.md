# EBMS entity cheat sheet

**This file is deliberately not exhaustive.** EBMS 1.8.148 exposes 372 entity sets
(449 entities counting virtual ones). What follows covers the ones in common use, and only
facts verified against a live install.

For field-level facts — every standard field, its type, EBMS label, whether it is required
or read-only, related entities, enumerations and bound actions — open the generated file for
that entity in `entities/` (index: `entities/README.md`). Those are built from the metadata,
not written by hand.

For anything not covered there, look it up rather than guessing:

- `ebms_get` with `path: $metadata` returns the install's full schema. Confirmed served on
  SBX and a second company (1.8.148); not yet confirmed on every build.
- `ebms_get` with `path: EntityMetaData('<ENTITY>')` and `expand: Properties` returns EBMS's
  own label, description, required and read-only flags for every field, **including the
  install's custom fields**, which the generated references deliberately leave out.

What lives here is what none of those will tell you: where the schema and reality
disagree.

Every entity has an `AUTOID` (unique, unambiguous) alongside its natural key.

## INVENTRY: products

Natural key `ID`. Also the home of inventory folders (rows with `ID` like `($)  15`).

| Field | Notes |
|---|---|
| `ID` | product SKU, natural key |
| `DESCR_1..3` | description lines |
| `COST` | cost |
| `BASE` | base sell price (settable on create) |
| `C_TYPE` | product type, Int32 (see enum below) |
| `TREE_ID` | folder number as a string; unpadded is fine |
| `FOLDERNAME` | folder name (readable, not settable) |
| `UPC`, `MFG_PART` | good search targets |

`C_TYPE`: 0 Service Item · 1 No Count · 2 Track Count · 3 Serialized Item · 6 Percentage
Price · 7 Non-inventory Serialized · 8 Rental Code · 9 Lots-Avg Cost · 10 Percentage
Discount · 11 Lots-Tracked Cost.

Watch out: a product with markup "(None)" and `BASE` 0 computes every price level to $0.

## ARCUST / APVENDOR: customers and vendors

Natural key `ID`. Search on `ID`, `F_NAME` and `L_NAME`, but **not** `PHONE` (see quirks).
Filter `INACTIVE eq false`.

## ARINV: sales orders and invoices

Natural key `INVOICE`. `STATUS 'U'` means an unprocessed order, the ones you can still
append to.

Create: `POST /ARINV {"ID": "<customer>", "Details": [...]}`. Line fields: `INVEN`
(product), `M_QUAN_VIS` (qty), `UNIT` (sell price; omit it and EBMS prices the line from
the product's own config), `DESCR`.

## APINV: purchase orders and vendor invoices

Structurally symmetric to ARINV, but with a **composite** natural key (vendor + invoice).
Line fields differ: `O_QUAN_VIS` (ordered qty) and `UNIT_VIS` (unit *cost*).

Create: `POST /APINV {"ID": "<vendor>", "Details": [...]}`.

## PYEMP / TASK / PYTMDET: labor

`PYEMP.TC_LOGIN` is the PIN. `TASK.PIPE_PHASE` is the authoritative phase field.
`PYTMDET` records clock in and out, and needs `WORK_CODE` on clock-in.

## GetPrice

Customer-specific computed price, invoked as an OData action:
`POST /INVENTRY(ID='<id>')/Model.Entities.GetPrice {"CustomerId":..., "Quantity":...}`.

The **response** shape is declared by the metadata: `INVENTRYGetPriceCommandDialog` with
`Price`, `Quantity`, `CustomerId`, `PriceLevel` and `Uom`.

The **request** shape is still unconfirmed, and the sources disagree. The metadata declares
the action with no parameters at all; clients in the wild post `CustomerId` and `Quantity`
as the body, following EBMS's command-dialog pattern; and the official documentation shows a
GET with a body while also listing it as a command. Fall back to the product's `BASE` if it
returns nothing usable.
