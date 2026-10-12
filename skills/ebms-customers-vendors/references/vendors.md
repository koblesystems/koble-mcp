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
time in days if they know it. Propose the ID (below). Show what will be sent and ask before
sending.

**One POST: `TREE_ID` first, then `ID`, then everything else** (verified on SBX, 1.8.184):

```
ebms_write  method: POST   path: APVENDOR
            body: {"TREE_ID": "8", "ID": "BIKEPARTS", "L_NAME": "Bike Parts Co",
                   "ADDRESS1": "2 Industrial Rd", "ZIP": "17527", "LEAD_DAYS": 21,
                   "EXTERNALID": "claude-2026-10-12-v1"}
            readBack: {"record": "AUTOID,ID,CITY,STATE,COUNTRY"}
```

**Always send an `ID`.** EBMS only generates a vendor ID when the folder has a default ID method,
and the API cannot tell you whether it has one. Without one, a create with no `ID` does not
fail cleanly: EBMS tries to save a vendor whose ID is blank, which nothing can look up (on SBX
it was stopped only because a blank-ID vendor already existed, which tripped a uniqueness rule:
"duplicate key value violates unique constraint …apvendor…contact__unique"). If the user says the
folder has an ID method and wants EBMS to choose, leave `ID` out and report the ID it chose —
and if the answer is that duplicate-key error, the folder has no method: send an ID instead.

The ID is a short mnemonic of the name in capitals, like the existing ones (`BIKEPARTS`,
`FARMCO`), at most 10 characters; check it is free (`ID eq '…'`) and let the user change it.

**If EBMS answers "Could not find child APCONTACTS record"**, `TREE_ID` was not the first field
(a create with the name before the folder fails this way). Nothing was saved: send it again with
`TREE_ID` first. If it still fails, the two-step route also works (verified): POST
`{"TREE_ID": "8", "ID": "BIKEPARTS", "EXTERNALID": …}`, then PATCH the rest onto the AUTOID it
returns. Until that PATCH lands the vendor has no name; if it fails, read back and send it again.

**"This Id already exists"** means the ID is taken — usually by a vendor this conversation already
created: look it up by `EXTERNALID` first, and if it is yours, continue from it.

What EBMS does with it (verified):

- `TREE_ID` is required: without it the create fails with "Could not find vendor defaults".
- `ZIP` fills in `CITY`, `STATE` and `COUNTRY`; `EXTERNALID` is stored.
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

- A create without `ID` into a folder that has a default ID method (SBX's vendor folders have
  none).
- `MIN_ORDER`, `ACNT_ID`, `GL_CODE`, `PAY_TO` and `CRED_LIM` writes.
- Adding a second contact (an `APCONTACTSs@delta` entry without `@id`).
- Deleting a vendor that has history.
