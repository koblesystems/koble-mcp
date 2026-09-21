---
name: ebms-purchase-orders
description: Create and change EBMS / Koble purchase orders (APINV) by hand — ordering products from a vendor, adding, removing or repricing lines, changing quantities, vendor part numbers and purchase units, freight and tax, finding a vendor or an open PO, and recording what was received. Use whenever someone wants to order something from a supplier, raise or edit a purchase order, add a line to a PO, change a cost or a quantity on one, look up what is on order, or record a delivery — "order 10 tubes from Bikeparts", "add two cases to PO 182", "what's on order from Farm Co", "receive PO 119". For orders that come out of an MRP run use ebms-mrp-purchase-orders instead, and for turning a vendor's invoice into a PO use the invoice intake tooling. Builds on the ebms-api skill. Needs the koble-mcp server (tools ebms_get and ebms_write).
---

# EBMS purchase orders

Workflows for `APINV`, the purchase document, and its lines (`APINVDET`). Everything runs through
the koble-mcp tools `ebms_get` and `ebms_write`; how to call them, and how to read a write's
verification, is in the **ebms-api** skill — load it first. Its `references/entities/APINV.md`
and `APINVDET.md` list every field, and `references/odata-quirks.md` holds the evidence behind
the rules here.

If those tools are not available, say the koble-mcp server is not connected and stop.

**This is a write workflow. The rules are short and not optional:**

1. **Nothing is created or changed without a yes for that specific write.** Show the vendor, the
   lines with their units, and the money, then wait. A yes to one is not a yes to the next.
2. **Report what EBMS stored**, from the write's `verification.rows` — costs, dates and totals
   are computed server-side and are often not what you sent.
3. **One write at a time, and stop at the first problem.**
4. **Never send `PROCESS`.** The server refuses it. Posting a purchase document is done by a
   person in EBMS.

## Which workflow

| The user wants to… | Open |
|---|---|
| Find a vendor, a product's vendor record, or what is on order | `references/find.md` |
| Raise a new purchase order | `references/build.md` |
| Change lines, quantities, costs, freight or header fields | `references/change.md` |
| Record what arrived | `references/receive.md` |

A purchase order that came from an MRP run belongs to `ebms-mrp-purchase-orders` until it is
created; after that, change it here.

## Ground rules

1. **Name the company before the first write** and confirm it is the one the user means.
2. **Address a PO by quoted AUTOID** — `APINV('<AUTOID>')` — or by its quoted `INVOICE`, which is
   the whole string EBMS assigned (`PO#110`), **not** the `PO_NO` (`110`). `APINV('182')` is a
   422. The composite `ID=…,INVOICE=…` form and the `VENDOR|INVOICE` pipe form both fail on this
   build, whatever EBMS's own documentation says.
3. **Read lines only through the parent document.** A standalone `APINVDET` query returns the
   rows with **every `_VIS` field reading 0** — quantities and costs silently zero, no error. Use
   `expand: Details($select=…)` on the `APINV`. A diff built on a standalone read would set
   quantities from a baseline of zero.
4. **Quantities are in the line's purchase unit**, which is often not the stock unit. Never
   convert a unit yourself; read `UNIT_MEAS` and say what it is.
5. **Change lines only through the parent**, with one `Details@delta` array.

## What EBMS numbers itself

- **`INVOICE` and `PO_NO` are assigned on create.** A new PO comes back as `INVOICE` `PO#175`
  and `PO_NO` `175`. Do not send them for a new order. (When a vendor's invoice is later recorded
  against the PO, `INVOICE` becomes the vendor's own number and `PO_NO` is left alone.)
- **`ETA_DATE` is EBMS's, not yours.** A date sent on a line came back as a different date or as
  nothing, on four purchase orders. Don't send it; read back what EBMS chose and tell the user
  when a line is expected after it is needed.
- **`ACCOUNT` is filled in** from the vendor or company defaults on a line with a product
  (`60000-000` on SBX).
- `TOTAL`, `SUBTOTAL` and `TOTAL_PO` are computed. `TOP_TOTAL` is silently dropped — never send it.

## Status

`STATUS` `'U'` is an unprocessed purchase order, editable. `'O'` and `'X'` are processed
documents. **Receiving is not processing**: a PO can be fully received and still be `'U'`, and
`receive.md` works on `'U'` documents.

## Finding things

Every one of these is an `ebms_get` call — `path` plus `filter`, `select` and `top` as separate
fields. `references/find.md` has more.

```
# Vendors — exclude the folder rows that share this entity set
path: APVENDOR
filter: not startswith(ID,'($)') and INACTIVE eq false and (contains(tolower(ID),'bike') or contains(tolower(L_NAME),'bike'))
select: AUTOID,ID,L_NAME,F_NAME,CITY,STATE,GL_CODE

# A vendor's open purchase orders
path: APINV   filter: ID eq 'BIKEPARTS' and STATUS eq 'U'
select: AUTOID,INVOICE,PO_NO,INV_DATE,DUE_DATE,TOTAL_PO,WAREHOUSE

# One PO by its number
path: APINV   filter: PO_NO eq '182'   select: AUTOID,INVOICE,PO_NO,ID,STATUS
```

**Read a purchase order** with this shape every time you read one back:

```
path:   APINV('<AUTOID>')
select: AUTOID,INVOICE,PO_NO,ID,STATUS,INV_DATE,ORDER_DATE,DUE_DATE,WAREHOUSE,TERMS,FREIGHT,TAX,SUBTOTAL,TOTAL,TOTAL_PO,EXTERNALID
expand: Details($select=AUTOID,TIMESTAMP,INVEN,DESCR,O_QUAN_VIS,SHIP_VIS,B_QUAN_VIS,UNIT_VIS,UNIT_MEAS,PART_NO,ETA_DATE,RDATE,ACCOUNT,WAREHOUSE)
```

`O_QUAN_VIS` is the quantity ordered, `SHIP_VIS` the quantity received, `B_QUAN_VIS` what is back
ordered, and `UNIT_VIS` the **unit cost** — the purchase document's fields are not the sales
document's.

## Not yet verified

Say so if a request depends on these: `MarkAllAsReceived` and `CreateBackOrder` (both bound
actions, neither on the server's command allow-list, neither tested — see `references/receive.md`);
`FREIGHT` on a PATCH rather than a create; timings on `APINV` (measured on `ARINV` only, and the
document shape is the same, but that is an assumption); multi-warehouse purchase orders; drop-ship
and special-order lines (`PURC_METH` other than stocked); vendor creation; serialized or
lot-tracked receiving; and paying or posting anything.
