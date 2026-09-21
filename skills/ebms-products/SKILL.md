---
name: ebms-products
description: Create and update products in EBMS (the INVENTRY entity) through the OData API — checking for duplicates, choosing the product folder and classification, setting cost and base price, and verifying what EBMS saved. Use whenever someone wants to add, create, set up, import or edit a product, SKU, item or part in EBMS or Koble, including when a sales order or purchase order needs a product that doesn't exist yet. Builds on the ebms-api skill for connection and auth.
---

# EBMS products

Workflows for `INVENTRY`, the product catalogue. Connection, auth and error reading come
from the **ebms-api** skill — load it first. `references/entities/INVENTRY.md` there lists
every field; `references/entities.md` has the classification enum and folder details.

Verified against a live install (SBX, EBMS 1.8.148, 2026-09-16) by creating, reading,
updating and deleting a test product.

## Ground rules

1. **Name the company before the first write** and confirm it's the one the user means.
2. **Search before you create.** A duplicate product is worse than a missing one.
3. **Address a product by quoted AUTOID** — `/INVENTRY('<AUTOID>')` — or quoted ID —
   `/INVENTRY('MUG-12')`. Unquoted AUTOID is a 404.
4. **Read back after every write** and report what EBMS saved, not what you sent.

## Create a product

1. **Check it doesn't already exist.** Search the ID, description and the codes a supplier
   would use, excluding folder rows:
   ```
   /INVENTRY?$filter=not startswith(ID,'($)') and (ID eq 'MUG-12' or contains(tolower(DESCR_1),'12 oz mug') or UPC eq '012345678905' or MFG_PART eq 'CM-12')&$select=AUTOID,ID,DESCR_1,UPC,MFG_PART,INACTIVE
   ```
   If something close comes back, show it and ask before creating.

2. **Get the ID from the user.** `ID` is required (max 24 characters) and is not assigned by
   EBMS — product IDs are the company's own convention. **Check the length yourself:** EBMS
   silently cuts an over-long ID to fit rather than rejecting it, so two long IDs can collide. Propose one that follows the pattern
   of existing IDs if asked, but let the user decide.

3. **Choose the folder.** Folders are rows in `INVENTRY` itself:
   ```
   /INVENTRY?$filter=startswith(ID,'($)')&$select=ID,FOLDERNAME
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
   POST /INVENTRY
   {"ID": "MUG-12", "DESCR_1": "12 oz ceramic mug", "TREE_ID": "26", "C_TYPE": 2,
    "COST": 3.10, "BASE": 7.95, "UPC": "012345678905", "MFG_PART": "CM-12"}
   ```
   `DESCR_2` and `DESCR_3` are further description lines. On a sales order line, EBMS joins
   `DESCR_1` and `DESCR_2` as the default line description.

7. **Read back and report:**
   ```
   /INVENTRY('<AUTOID from the response>')?$select=AUTOID,ID,DESCR_1,C_TYPE,TREE_ID,FOLDERNAME,COST,BASE,MARKUP,TAX_GROUP,PUR_ACC
   ```
   EBMS fills defaults the user may want to review: on the install tested, `MARKUP` `(None)`,
   `TAX_GROUP` `Taxable`, and `PUR_ACC` `60000-000`. Those defaults are company configuration
   and may differ elsewhere. Mention them rather than assuming they're right.

## Update a product

```
PATCH /INVENTRY('<AUTOID>')
{"BASE": 8.25, "DESCR_2": "Dishwasher safe"}
```
Read it back and confirm each field changed. Fields EBMS won't accept in the record's current
state are ignored with a 200. `FOLDERNAME` is read-only.

## Delete a product

`DELETE /INVENTRY('<AUTOID>')` works (204). It is irreversible. Only on an explicit request,
and check first that no open order or purchase order uses the product.

## Not yet verified

Say so if a request depends on these: moving a product to another folder by changing
`TREE_ID`; price levels (`INVPRICE`) and markup templates;
units of measure (`INVENUNT`); vendor part numbers; serialized or lot-tracked setup;
product images and documents; and changing a product's ID (`ChangeID` action).

If the session has the EBMS MCP server, its `create_product` tool creates products with
`ID`, descriptions, `COST`, `C_TYPE` and `TREE_ID`. It cannot set `BASE`, so use the API
directly when a selling price is needed.
