# Vendors — `APVENDOR`

## Find one

```
ebms_get  path: APVENDOR
          filter: not startswith(ID,'($)') and (contains(tolower(L_NAME),'bike parts') or ID eq 'BIKEPARTS')
          select: AUTOID,ID,L_NAME,F_NAME,CITY,STATE,TREE_ID,INACTIVE
          expand: APCONTACTSs($select=AUTOID,NAME,B_PHONE,EMAIL)
```

`LEAD_DAYS` is left out of the search: older EBMS builds do not have it (1.8.184 does), and any
query naming it is refused there with "Could not find a property named 'LEAD_DAYS'". On such a
build, leave it out of the create and PATCH too, and say lead times are set in EBMS.

The vendor list also holds tax agencies and other payees; a supplier search by name is usually
enough. Phone and email are on the contact record (`APCONTACTSs`), not on the vendor.

## Create one

Ask for, in one message: the company name, the folder, the address, phone, email, and the lead
time in days if they know it. Show what will be sent and ask before sending.

**One POST, `TREE_ID` first, no `ID`:**

```
ebms_write  method: POST   path: APVENDOR
            body: {"TREE_ID": "8", "L_NAME": "Bike Parts Co", "ADDRESS1": "2 Industrial Rd",
                   "ZIP": "17527", "LEAD_DAYS": 21, "EXTERNALID": "claude-2026-10-12-v1"}
            readBack: {"record": "AUTOID,ID,CITY,STATE,COUNTRY"}
```

- **It works** when the folder has a default ID method: EBMS generates the ID. Report it.
- **It fails with "Could not find child APCONTACTS record"** when the folder has no default ID
  method. Nothing was saved. Tell the user exactly that, and offer two ways on:
  1. **Set the folder's default ID method in EBMS** (the vendor folder's defaults), then send
     the same POST again. Best when more vendors will go in that folder.
  2. **Choose the ID and create it in two steps**, each with its own yes:
     ```
     ebms_write  method: POST   path: APVENDOR
                 body: {"TREE_ID": "8", "ID": "BIKEPARTS", "EXTERNALID": "claude-2026-10-12-v1"}
     ebms_write  method: PATCH  path: APVENDOR('<AUTOID from the POST>')
                 body: {"L_NAME": "Bike Parts Co", "ADDRESS1": "2 Industrial Rd", "ZIP": "17527", "LEAD_DAYS": 21}
                 readBack: {"record": "ID,CITY,STATE,COUNTRY"}
     ```
     The ID is a short mnemonic of the name in capitals, like the existing ones (`BIKEPARTS`,
     `FARMCO`), at most 10 characters; check it is free (`ID eq '…'`) and let the user change it.

If the user wants a particular ID anyway, add `ID` after `TREE_ID` in the one POST.

In the two-step route the vendor exists without a name until the PATCH lands. If the PATCH
fails, read the vendor back and send it again (it is safe to repeat); if the user stops in
between, say the vendor is there unnamed. **A create that answers "This Id already exists"**
usually means an earlier first step went through: find the vendor by ID, and if it is the
nameless one, carry on with the PATCH instead of choosing a new ID. Delete a half-made vendor
only if the user asks.

What EBMS does with it (verified):

- `TREE_ID` is required: without it the create fails with "Could not find vendor defaults".
- The "APCONTACTS" failure and the two-step route were verified on SBX (1.8.184), whose vendor
  folders have no default ID method. That the failure *is* the missing ID method, and that
  `TREE_ID` must come first, was found by Koble (2026-10-12); a one-POST create into a folder
  with an ID method has not been run here yet.
- `ZIP` fills in `CITY`, `STATE` and `COUNTRY`.
- A contact record is created by itself, blank.

## Phone, email and the contact's name

Read the vendor's contact AUTOID (`expand: APCONTACTSs($select=AUTOID)`), then change it through
the vendor, with the **plain** AUTOID as `@id`:

```
ebms_write  method: PATCH   path: APVENDOR('<vendor AUTOID>')
            body: {"APCONTACTSs@delta": [{"@id": "<contact AUTOID>", "NAME": "Pat Jones",
                   "B_PHONE": "(717) 555-0102", "EMAIL": "orders@bikeparts.example"}]}
```

An `@id` in any other form (`"APCONTACTS('…')"`) is ignored without an error; the verification
then reports the row as not found.

## Change one

PATCH the fields that change: name, address, `LEAD_DAYS` (verified), and `MIN_ORDER`, `ACNT_ID`
(your account number with them), `GL_CODE`, `INACTIVE`. Moving folder (`TREE_ID`) does not
re-apply the new folder's defaults.

`LEAD_DAYS` is the vendor's default lead time; a product's own figure on its vendor record
(`INVENDOR.LEAD_DAYS`, the **ebms-products** skill) wins over it. MRP and new purchase orders use
both.

## Delete one

Only a vendor created by mistake, with a yes, then search to confirm it is gone. A vendor with
purchase orders or bills should be made inactive.

## Not in the API, so done in EBMS

Payment terms, the 1099 flag and tax ID are not published for vendors. Say so and leave them to
EBMS's vendor screen.

## Not yet verified

- A create carrying `EXTERNALID`. The field exists and `EXTERNALID eq '…'` filters work on
  `APVENDOR`; read the verification to confirm it stored.
- `MIN_ORDER`, `ACNT_ID`, `GL_CODE`, `PAY_TO` and `CRED_LIM` writes.
- Adding a second contact (an `APCONTACTSs@delta` entry without `@id`).
- Deleting a vendor that has history.
