---
name: ebms-products
description: Create and update products in EBMS / Koble (the INVENTRY entity) — checking for duplicates, choosing the product folder and classification, setting cost and base price, units of measure, vendor records with part numbers and purchase costs, minimum/maximum and reorder quantities, and bills of materials. Use whenever someone wants to add, create, set up or edit a product, SKU, item or part in EBMS or Koble (a whole file of them goes through ebms-import), to change a price or cost, to set up a case or box unit, to link a product to a vendor or set a vendor part number, or when a sales order, purchase order or MRP run needs a product that doesn't exist yet. Builds on the ebms-api skill. Needs the koble-mcp server (tools ebms_get and ebms_write).
---

# EBMS products

Workflows for `INVENTRY`, the product catalogue, and the records hanging off it. Everything runs
through the koble-mcp tools `ebms_get` and `ebms_write`; how to call them, and how to read a
write's verification, is in the **ebms-api** skill — load it first.
`references/entities/INVENTRY.md` there lists every field; `references/entities.md` has the
classification enum and folder details.

If those tools are not available, say the koble-mcp server is not connected and stop.

Verified against a live install (EBMS 1.8.148, 2026-09-16) by creating, reading,
For many products at once, from a CSV or Excel file, use **ebms-import**; it applies this
skill's rules to every row. The server refuses a product POST whose `EXTERNALID` already exists
(since 0.1.0-rc.14), as it does for orders: read the existing product and continue from it.

Verified against a live install (SBX, EBMS 1.8.148, 2026-09-16) by creating, reading,
updating and deleting a test product. The sections marked *not yet verified* were not.

## Ground rules

1. **Name the company before the first write** and confirm it's the one the user means.
2. **Search before you create.** A duplicate product is worse than a missing one.
3. **Nothing is created or changed without a yes for that specific write**, and one at a time.
4. **Address a product by quoted AUTOID** — `INVENTRY('<AUTOID>')` — or quoted ID —
   `INVENTRY('MUG-12')`. Unquoted AUTOID is a 404.
5. **Report what EBMS stored**, from the write's `verification.rows`, not what you sent.

## Create a product

1. **Check it doesn't already exist.** Search the ID, description and the codes a supplier
   would use, excluding folder rows:
   ```
   ebms_get  path: INVENTRY
             filter: not startswith(ID,'($)') and (ID eq 'MUG-12' or contains(tolower(DESCR_1),'12 oz mug') or UPC eq '012345678905' or MFG_PART eq 'CM-12')
             select: AUTOID,ID,DESCR_1,UPC,MFG_PART,INACTIVE
   ```
   If something close comes back, show it and ask before creating.

2. **Get the ID from the user.** `ID` is required (max 24 characters) and is not assigned by
   EBMS — product IDs are the company's own convention. **Check the length yourself:** EBMS
   silently cuts an over-long ID to fit rather than rejecting it, so two long IDs can collide. Propose one that follows the pattern
   of existing IDs if asked, but let the user decide.

3. **Choose the folder.** Folders are rows in `INVENTRY` itself:
   ```
   ebms_get  path: INVENTRY   filter: startswith(ID,'($)')   select: ID,FOLDERNAME
   ```
   An ID of `($)   26` is folder number `26`. Send `TREE_ID` as the bare number string
   (`"26"`). EBMS pads it and fills in `FOLDERNAME`. Ask which folder when it isn't obvious.

4. **Choose the classification, `C_TYPE`. Ask — don't default it.** It decides whether EBMS
   tracks stock: `0` Service Item · `1` No Count · `2` Track Count · `3` Serialized Item ·
   `6` Percentage Price · `7` Non-inventory Serialized · `8` Rental Code · `9` Lots-Avg Cost ·
   `10` Percentage Discount · `11` Lots-Tracked Cost.

5. **Set cost and price.** `COST` is the cost. `BASE` is the base selling price. Tell the user
   that **customers are not charged `BASE` directly**: EBMS derives each price level from it.
   A product with `BASE` 27.50 was priced at 41.04 for a Retail customer. And if `BASE` is 0
   while markup is `(None)` — the default on create — every price level computes to **$0**.
   Don't create a sellable product with no `BASE` without saying so.

6. **Post:**
   ```
   ebms_write  company: <company>   method: POST   path: INVENTRY
               body: {"ID": "MUG-12", "DESCR_1": "12 oz ceramic mug", "TREE_ID": "<folder>",
                      "C_TYPE": 2, "COST": 3.10, "BASE": 7.95,
                      "UPC": "012345678905", "MFG_PART": "CM-12"}
               readBack: {"record": "FOLDERNAME,MARKUP,TAX_GROUP,PUR_ACC"}
   ```
   `DESCR_2` and `DESCR_3` are further description lines. On a sales order line, EBMS joins
   `DESCR_1` and `DESCR_2` as the default line description.

7. **Report what came back.** The `readBack.record` fields above put EBMS's own defaults in
   `verification.rows` alongside what you sent. EBMS fills defaults the user may want to review,
   such as `MARKUP` `(None)`, `TAX_GROUP` `Taxable`, and a purchase account in `PUR_ACC`. Those
   defaults are company configuration and may differ elsewhere. Mention them rather than assuming they're right.

## Update a product

```
ebms_write  company: <company>   method: PATCH   path: INVENTRY('<AUTOID>')
            body: {"BASE": 8.25, "DESCR_2": "Dishwasher safe"}
```
`verification.ok: false` with a mismatch means EBMS ignored a field it won't accept in the
record's current state — it does that with a 200. `FOLDERNAME` is read-only, as are `MIN_INVEN`
and `MAX_INVEN` (see below).

## Delete a product

`method: DELETE` on `INVENTRY('<AUTOID>')` works (204). It is irreversible. Only on an explicit
request, and check first that no open order or purchase order uses the product.

## Units of measure — `INVENUNT`

A product's units live in `INVENUNT` rows, one per unit, and they are the usual cause of a
quantity or price that comes back as 0.

```
ebms_get  path: INVENUNT   filter: ID eq 'MUG-12'
          select: AUTOID,UNIT,MULTIPLIER,MULTIPLY,SELLABLE,INT_QUAN
```

- `MULTIPLY` is `Larger` (one of this unit is `MULTIPLIER` main units) or `Smaller`
  (`MULTIPLIER` of this unit make one main unit). **The main unit's row carries `MULTIPLIER` 0.**
- `INVENTRY.EACH_UNIT` is the main unit; `DEF_UNIT` is the default selling unit, and it is what
  the API puts on a new order line.
- **A `Larger` unit with `MULTIPLIER` 0 is broken**: one of it is zero main units, so a line in
  that unit saves as quantity 0 at price 0, with a 200 and no warning. When a quantity comes back
  0, read the product's units before blaming stock. Seen live on two products in two different
  companies (most recently EBMS 1.8.184, 2026-10-12), so it is not a one-off. **Whenever you
  work on a product's units, check for `Larger` with `MULTIPLIER` 0 and point it out to the
  user.** Pointing `DEF_UNIT` at a sound unit stops new API order lines defaulting to the broken
  one, but the broken unit is still there.
- **`INVENUNT` cannot be written directly.** `PATCH INVENUNT('<AUTOID>')` returns 422 "Cannot
  modify detail table INVENUNT without accessing it through a parent entity!" and saves nothing
  (EBMS 1.8.184, 2026-10-12). Every unit change goes through `INVENTRY('<AUTOID>')`.
- `ID` on an `INVENUNT` row is the product ID and is read-only.
- **A product created through the API gets a blank main unit**: one `INVENUNT` row with `UNIT`
  "" (`Smaller`, multiplier 0), and `EACH_UNIT` and `DEF_UNIT` both "". Lines for it then carry
  `UNIT_MEAS` "". That works, but it is not what a product made in EBMS looks like; mention it.

**Add a unit through the product**, as a child collection (verified 2026-09-23):

```
ebms_write  company: <company>   method: PATCH   path: INVENTRY('<AUTOID>')
            body: {"INVENUNTs": [{"UNIT": "CASE", "MULTIPLY": "Larger", "MULTIPLIER": 12}]}
```

The new row comes back in `verification.rows` with its AUTOID. **Never create a `Larger` unit
with a multiplier of 0** — that is exactly the broken unit that zeroes order lines. Adding uses
the plain `INVENUNTs` collection; changing an existing unit uses `INVENUNTs@delta`, below.

### Change an existing unit

Through the product, as a delta naming the unit's AUTOID in `@id` — the same pattern as document
lines in `ebms-api`. Renaming verified on EBMS 1.8.184, 2026-10-12:

```
ebms_write  company: <company>   method: PATCH   path: INVENTRY('<product AUTOID>')
            body: {"INVENUNTs@delta": [{"@id": "<INVENUNT AUTOID>", "UNIT": "<new name>"}]}
            readBack: {"record": "EACH_UNIT,DEF_UNIT"}
```

- The row keeps its AUTOID; only `UNIT` changes.
- **Renaming the main unit** (the `Smaller` row with `MULTIPLIER` 0) **updates `EACH_UNIT` to
  match**, without sending it. Read `EACH_UNIT` back to confirm.
- **`DEF_UNIT` can be set with a plain PATCH** on the product, e.g. `{"DEF_UNIT": "<unit>"}`
  (verified on EBMS 1.8.184, 2026-10-12). Use a unit the product already has; only that was
  tested.
- **Not verified:** changing `MULTIPLIER` or `MULTIPLY` on an existing unit, removing a unit
  (`{"@id": "…", "@removed": true}`), and whether a sales order line in a renamed unit saves the
  right quantity and price. Say so if a request depends on them, and read the units back after
  any attempt. A unit already used on documents is safer to change in EBMS.

## Vendor records — `INVENDOR`

What a product costs from a particular vendor, and what that vendor calls it. This is what a
purchase order needs.

```
ebms_get  path: INVENDOR   filter: ID eq 'MUG-12'
          select: AUTOID,ID,VENDOR_ID,PART_NO,UNIT_MEAS,COST,LEAD_DAYS,ORDER_AMT
```

- `ID` is the **product** ID; `VENDOR_ID` is the vendor. `PART_NO` is the vendor's own part
  number (max 24 characters) and is how an invoice line is matched back to a product.
- `UNIT_MEAS` is the **purchase** unit for that vendor, which is often not the stock unit.
- `INVENTRY.PRI_VENDOR` names the primary vendor.
- `LEAD_DAYS` is this product's lead time from this vendor, in days; 0 means not set, and the
  vendor's own `APVENDOR.LEAD_DAYS` applies instead. MRP and a new PO's expected dates use it.
  It is writable, but setting it through the API has not been tried yet.
- `ORDER_AMT` is the reorder increment (order in multiples of this).

**Add a vendor record through the product** (verified 2026-09-23):

```
ebms_write  company: <company>   method: PATCH   path: INVENTRY('<AUTOID>')
            body: {"INVENDORs": [{"VENDOR_ID": "<vendor ID>", "PART_NO": "<part no>",
                                  "UNIT_MEAS": "CASE", "COST": 30}]}
```

`UNIT_MEAS` must be one of the product's units — add the unit first. Adding a vendor record does
**not** set `PRI_VENDOR`; set that on the product separately if this vendor should be the
primary. Changing an existing vendor record has not been tested; like units, it probably has to
go through the product as `INVENDORs@delta` (writing `INVENDOR` directly is likely refused, not
verified).

Deleting a product takes its units and vendor records with it.

## Stock levels and reordering

`MIN_INVEN` and `MAX_INVEN` on `INVENTRY` are the minimum and maximum, and both are
**read-only through the API** — they are set in EBMS. `QUAN2ORDER` is a quantity EBMS's own
purchasing screen persists; treat it as a reference number, not a recommendation you computed.
`T_ON_HAND` and `T_AVAIL` are computed and **cannot be filtered on**. For what to order and when,
use the `ebms-mrp` skill rather than reading these fields and guessing.

## Bill of materials — `INVENDET`

The components of a manufactured or assembled product.

```
ebms_get  path: INVENDET   filter: ID eq 'BENCH'
          select: AUTOID,ID,COMP_ID,QUAN
```

`ID` is the parent product, `COMP_ID` the component, and `QUAN` is **per one parent, in the
component's base unit**. Changing a bill of materials is **not yet verified**.

## Not yet verified

Say so if a request depends on these: moving a product to another folder by changing `TREE_ID`;
price levels (`INVPRICE`) and markup templates; changing a unit's multiplier or removing a unit
(adding and renaming units are verified); changing or removing vendor records (adding them is
verified); bills of materials (`INVENDET`) — reading is verified, writing is not; serialized or
lot-tracked setup; product images and documents; and changing a product's ID (the `ChangeID`
action, which is not on the server's command allow-list).
