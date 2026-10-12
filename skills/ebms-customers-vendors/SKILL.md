---
name: ebms-customers-vendors
description: Create and update customers (ARCUST) and vendors (APVENDOR) in EBMS / Koble — checking for an existing record first, choosing the folder that supplies the defaults (price level, terms, GL), letting EBMS generate a customer ID or choosing a vendor ID, name and address (a ZIP fills in city and state), phone and email, lead days, moving a record to another folder, and marking it inactive. Use whenever someone wants to add, set up, create or edit a customer, client, account, dealer, supplier or vendor in EBMS or Koble — "add a customer for Smith Roofing", "set up Bike Parts Co as a vendor", "change Joe's phone number", "make that customer wholesale", "mark that vendor inactive" — or when a sales order or purchase order needs a customer or vendor that doesn't exist yet. Builds on the ebms-api skill. Needs the koble-mcp server (tools ebms_get and ebms_write).
---

# EBMS customers and vendors

Customers live in `ARCUST`, vendors in `APVENDOR`. Both are organised in folders, and the
folder is what fills in most of a new record. Everything runs through `ebms_get` and
`ebms_write`; how to call them and read a write's verification is in the **ebms-api** skill —
load it first. If those tools are not available, say the koble-mcp server is not connected and
stop.

| The user wants to… | Open |
|---|---|
| Add or change a customer | `references/customers.md` |
| Add or change a vendor | `references/vendors.md` |

Verified on SBX (EBMS 1.8.184) with ZTEST customers and vendors that were created, changed
and deleted, deletions verified: customers on 2026-10-05, vendors on 2026-10-05 and 2026-10-12. What was not tried is listed at the end of
each reference.

## Ground rules

1. **Name the company before the first write**, and confirm it is the one the user means.
2. **Search before you create.** EBMS happily creates a second "Joe Smith": it gives the new one
   the next free ID (`SMIJOE1`) without a word. Show anything close and ask.
3. **One write at a time, each with a yes**, and report what EBMS stored — from
   `verification.rows`, not from what you sent.
4. **The folder is required, comes first, and sets the defaults.** Put `TREE_ID` as the
   **first** field of every create body. A vendor create with the name before `TREE_ID` fails
   ("Could not find child APCONTACTS record"); `TREE_ID` first always works. (Customers saved
   with the name first in testing, but put `TREE_ID` first anyway.) Ask which folder when it is not obvious,
   and list them by name (`ARCUSTRE` / `APVENTRE`, `TREE_DESCR`). Defaults come from the folder
   **only when the record is created**; moving it later keeps its old price level and terms.
5. **Company names go in `L_NAME`, with `F_NAME` left blank.** People: first name in `F_NAME`,
   last name in `L_NAME`.
6. **IDs are at most 10 characters and are cut short silently** — `ZTSKL71323A` was stored as
   `ZTSKL71323`, and two long IDs can then collide. Count before you send one.
7. **Prefer inactive to delete.** A customer or vendor with history should be marked
   `INACTIVE: true`; delete only a record created by mistake, and only with a yes.
   **Never send a vendor create without an `ID`** (the server refuses one), and never a customer
   create with neither a name nor an `ID`. A customer create may leave the `ID` to EBMS, but check
   the `ID` that comes back: in a folder without an ID method it is blank, and only the record's
   AUTOID finds it.
8. **Address a record by quoted AUTOID**: `ARCUST('<AUTOID>')`, `APVENDOR('<AUTOID>')`.
9. **Give every create an `EXTERNALID`** (`claude-<date>-<short id>`, as in ebms-api). The server
   then refuses a second create with the same one, and after an `uncertain` result it is how you
   find out whether the record was made: search `EXTERNALID eq '…'` before anything else. Never
   resend a create blind: a customer's ID is generated, so a resend makes `SMIJOE1`. If a
   different, legitimate record really shares an outside system's ID, give it its own
   `EXTERNALID`.

## The folder's ID method

Each folder can have a **default ID method** (set on the folder's defaults in EBMS, e.g. "first 3
letters of last name and first 3 letters of first name"). With one, EBMS generates the ID when
the create leaves `ID` out; without one, EBMS saves a blank ID. The API cannot show which folders
have a method (only product folders publish it). So: **customers** leave `ID` out and check the
`ID` that comes back (SBX's customer folders all generate one); **vendors** always send an `ID`.

## Folders

```
ebms_get  path: ARCUSTRE        (vendors: APVENTRE)
          select: TREE_ID,TREE_DESCR
```

`TREE_ID` comes back space-padded (`"   24"`); send it unpadded (`"24"`). Each folder's defaults
are stored on a row with ID `($)` plus the folder's ID, in the same entity as the records
(`ARCUST`, `APVENDOR`). That is why every search must exclude `not startswith(ID,'($)')`. Read a
customer folder's row to tell the user what a new customer there will get (for a vendor folder,
`GL_CODE` and `COUNTRY` are the defaults worth showing):

```
ebms_get  path: ARCUST
          filter: ID eq '($)   24'
          select: IN_LEVEL,IDCHARGE,CHARGE,CHARGEDFLT,DEF_FOB,FRGHT_TYPE
```
