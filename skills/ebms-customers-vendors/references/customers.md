# Customers — `ARCUST`

## Find one

```
ebms_get  path: ARCUST
          filter: not startswith(ID,'($)') and (contains(tolower(L_NAME),'smith') or contains(tolower(F_NAME),'joe') or ID eq 'SMIJOE')
          select: AUTOID,ID,F_NAME,L_NAME,ADDRESS1,CITY,STATE,ZIP,PHONE,EMAIL,TREE_ID,IN_LEVEL,INACTIVE
```

`PHONE` cannot be used in a filter (it is in the metadata but EBMS refuses it). Search by name,
then compare phone, email and address in what comes back. Unlike a search for an order, which
wants active customers only, a search before creating includes inactive ones: an old account may
be the one to reactivate.

## Create one

Ask for, in one message: the name (a person's first and last, or a company name), the folder,
the address, phone and email. Then show the body and ask before sending.

```
ebms_write  method: POST   path: ARCUST
            body: {"F_NAME": "Joe", "L_NAME": "Smith", "TREE_ID": "24",
                   "ADDRESS1": "100 Main St", "ZIP": "17527",
                   "PHONE": "(717) 555-0101", "EMAIL": "joe@example.com",
                   "EXTERNALID": "claude-2026-10-05-c1"}
            readBack: {"record": "AUTOID,ID,CITY,STATE,COUNTRY,IN_LEVEL,CHARGE,DEF_FOB,CONTACT_1,CONTACT_3"}
```

What EBMS does with it (verified):

- **It generates the ID** from the folder's naming rule when `ID` is left out: the first three
  letters of the last name and of the first name (`SMIJOE`), with a number added if that is
  taken (`SMIJOE1`). Report the ID it chose. Send an `ID` only if the user asks for a particular
  one, at most 10 characters. What it generates for a company (last name only) was not tried:
  report whatever comes back, and offer to change it if it reads badly.
- **The folder's defaults are copied in**: price level (`IN_LEVEL`), charge and discount terms,
  which payment methods are allowed, shipping method, freight formula, mailing and email lists.
  A Wholesale folder gives a Wholesale price level.
- **`ZIP` fills in `CITY`, `STATE` and `COUNTRY`** from EBMS's postal-code database. Send city
  and state only for an address outside it.
- **`PHONE` and `EMAIL` fill the contact slots** labelled Phone and E-Mail (`CONTACT_1` …
  `CONTACT_5`, labels in `CONID_1` …) and the customer's contact record (`ARCONTACTSs`), which is
  created by itself with the customer's full name. Write `PHONE` and `EMAIL`, not the slots.
- `E_DATE` (date entered) is set to today.

## Change one

PATCH only the fields that change; each one is checked in the verification.

```
ebms_write  method: PATCH   path: ARCUST('<AUTOID>')
            body: {"ADDRESS1": "9 Other Street", "PHONE": "(717) 555-0199", "EMAIL": "new@example.com"}
```

- Phone and email changes reach the contact slots and the contact record too.
- **Moving to another folder** (`TREE_ID`) does not change the price level or terms. Ask whether
  the price level should follow the new folder, and if so send `IN_LEVEL` in the same PATCH,
  taken from the new folder's `($)` row. Terms are not changed this way: changing them is not
  verified yet (see below), so tell the user to check them in EBMS.
- `IN_LEVEL` takes a price level's name: `Retail`, `Wholesale` — read the existing ones from
  other customers or the folders rather than guessing.
- **Inactive:** `{"INACTIVE": true}`; reverse with `false`.

## Delete one

Only a customer created by mistake, with a yes: `ebms_write method: DELETE path:
ARCUST('<AUTOID>')`, then search for it to confirm it is gone. A customer with orders or
invoices should be made inactive instead.

## Not yet verified

- A create carrying `EXTERNALID`. The field exists and `EXTERNALID eq '…'` filters work on
  `ARCUST`; read the verification to confirm it stored.
- Changing terms (`IDCHARGE`, `IDDISCOUNT`, `CHARGEDFLT`, payment-method switches), credit limit,
  salesperson and shipping method after creation. They are ordinary fields and are expected to
  write, but read the verification.
- Sales-tax settings and exemptions (`ARCUSTAXs`), ship-to addresses (`ARCUSSITEs`) and extra
  contacts: set these in EBMS for now.
- Deleting a customer that has history.
- Install-specific custom fields (on SBX: bike, roast, subscription fields): list them with
  `EntityMetaData('ARCUST')` and ask before writing one.
