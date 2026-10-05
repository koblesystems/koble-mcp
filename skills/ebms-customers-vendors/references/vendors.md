# Vendors — `APVENDOR`

## Find one

```
ebms_get  path: APVENDOR
          filter: not startswith(ID,'($)') and (contains(tolower(L_NAME),'bike parts') or ID eq 'BIKEPART')
          select: AUTOID,ID,L_NAME,F_NAME,CITY,STATE,TREE_ID,LEAD_DAYS,INACTIVE
          expand: APCONTACTSs($select=AUTOID,NAME,B_PHONE,EMAIL)
```

The vendor list also holds tax agencies and other payees; a supplier search by name is usually
enough. Phone and email are on the contact record (`APCONTACTSs`), not on the vendor.

## Choose the ID

**EBMS does not generate a vendor ID through the API.** A create without `ID` makes a vendor
whose ID is blank, which nothing can look up. Always send one: a short mnemonic of the company
name in capitals, the way the existing ones read (`BIKEPARTS`, `FARMCO`), at most 10 characters.
Check it is free (`ID eq '…'`), propose it, and let the user change it.

## Create one

Ask for, in one message: the company name, the folder, the address, phone, email, and the lead
time in days if they know it. Show what will be sent and ask before sending.

**Try the whole record in one POST first:**

```
ebms_write  method: POST   path: APVENDOR
            body: {"ID": "BIKEPARTS", "L_NAME": "Bike Parts Co", "TREE_ID": "8",
                   "ADDRESS1": "2 Industrial Rd", "ZIP": "17527", "LEAD_DAYS": 21}
            readBack: {"record": "AUTOID,ID,CITY,STATE,COUNTRY"}
```

**If EBMS refuses it with "Could not find child APCONTACTS record"** — a known EBMS fault on
1.8.184 when a vendor is created with a name; nothing was saved — create it in two steps
instead, each with its own yes:

1. The vendor with only its ID and folder:
   `body: {"ID": "BIKEPARTS", "TREE_ID": "8"}`. Note the AUTOID it returns.
2. Everything else as a PATCH on that AUTOID:
   `path: APVENDOR('<AUTOID>')`, `body: {"L_NAME": "Bike Parts Co", "ADDRESS1": "2 Industrial Rd", "ZIP": "17527", "LEAD_DAYS": 21}`.

If step 2 fails, the vendor exists without a name: say so, and offer to delete it rather than
leaving it behind.

What EBMS does with it (verified):

- `TREE_ID` is required: without it the create fails with "Could not find vendor defaults".
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

- `MIN_ORDER`, `ACNT_ID`, `GL_CODE`, `PAY_TO` and `CRED_LIM` writes.
- Adding a second contact (an `APCONTACTSs@delta` entry without `@id`).
- Deleting a vendor that has history.
