# Find a vendor, a product's vendor record, or what is on order

Read `../SKILL.md` first for the ground rules.

## Vendors — `APVENDOR`

Natural key `ID` (max 10 characters). Search `ID`, `L_NAME` and `F_NAME`; **not `PHONE`**, which
is in the metadata but 422s in a filter.

```
ebms_get  path: APVENDOR
          filter: not startswith(ID,'($)') and INACTIVE eq false and (contains(tolower(ID),'bike') or contains(tolower(L_NAME),'bike'))
          select: AUTOID,ID,L_NAME,F_NAME,CITY,STATE,GL_CODE,TREE_ID,MIN_ORDER
          top: 20
```

- **Exclude `($)` rows.** `APVENDOR` holds category folders in the same entity set, exactly as
  `INVENTRY` does. SBX has 73 real vendors and a wall of tax authorities.
- A company's vendor name usually lives in `L_NAME`, with `F_NAME` empty.
- `GL_CODE` is the vendor's G/L account, which matters for a description-only charge line.
- `MIN_ORDER` is the vendor's minimum order; mention it when an order looks small.
- Confirm with the user whenever more than one vendor matches.

**Creating a vendor is not done by this skill.** EBMS does **not** assign vendor IDs: a POST with
no `ID` is accepted and creates a vendor whose natural key is the empty string — a corrupt record,
not an auto-numbered one. If a vendor is missing, say so and let the user add it in EBMS.

## What a vendor charges for a product — `INVENDOR`

One row per product/vendor pair. This is where a purchase order's cost, unit and part number come
from.

```
ebms_get  path: INVENDOR
          filter: ID eq 'TUBE700C'
          select: AUTOID,ID,VENDOR_ID,PART_NO,UNIT_MEAS,COST,ORDER_AMT
```

- `ID` is the **product**; `VENDOR_ID` is the vendor. Filter by either.
- `UNIT_MEAS` is the **purchase unit for that vendor** — `bag`, `5lb-Bag`, `EA`. It is often not
  the product's stock unit, and the quantity on the line is in this unit.
- `COST` is that vendor's cost. `0` means nobody has recorded one; leave it out of the write and
  let EBMS fill it in rather than inventing a number.
- `ORDER_AMT` is the reorder increment.
- `INVENTRY.PRI_VENDOR` names the product's primary vendor.
- `LEAD_DAYS` exists in the database but **is not published by this API version**, so a purchase
  order cannot say when stock will arrive before EBMS sets `ETA_DATE` itself.

If a product has no row for the vendor the user named, say so: the order will go out in the
product's stock unit at whatever cost EBMS supplies, and the quantity deserves a second look.

## A vendor's part number, in reverse

To turn a number printed on a vendor's quote or invoice into a product:

```
ebms_get  path: INVENDOR   filter: VENDOR_ID eq 'PARTSDIR' and PART_NO eq 'CM-12'
          select: ID,VENDOR_ID,PART_NO,UNIT_MEAS,COST
```

Require exactly one hit. Two products sharing a part number is a question for the user, not a
guess. Fall back to `INVENTRY.MFG_PART`, then `UPC`, then the product `ID`, then an exact
`DESCR_1` — and stop at the first step that gives exactly one answer.

## What is on order

```
# Every open purchase order
ebms_get  path: APINV   filter: STATUS eq 'U'
          select: AUTOID,INVOICE,PO_NO,ID,INV_DATE,DUE_DATE,TOTAL_PO,WAREHOUSE   top: 50

# One vendor's
ebms_get  path: APINV   filter: ID eq 'BIKEPARTS' and STATUS eq 'U'
          select: AUTOID,INVOICE,PO_NO,INV_DATE,DUE_DATE,TOTAL_PO

# By PO number, or by an EXTERNALID a tool gave it
ebms_get  path: APINV   filter: PO_NO eq '182'   select: AUTOID,INVOICE,PO_NO,ID,STATUS
ebms_get  path: APINV   filter: EXTERNALID eq 'mrp-sbx-20260921-1526-BIKEPARTS'   select: AUTOID,INVOICE
```

`STATUS eq 'U'` is what "open" means — but remember a `'U'` purchase order may already be fully
received. To see what is genuinely outstanding, read the lines and compare `O_QUAN_VIS` with
`SHIP_VIS`.

**What is on order for one product**, across purchase orders, needs the lines. Read each
candidate document with `expand: Details(...)`; a standalone `APINVDET` filter returns zeros. For
a company-wide picture of incoming stock, use the `ebms-mrp` skill, which already does this
properly.
