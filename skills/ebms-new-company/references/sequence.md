# The order, in full

Each stage lists what it needs, what breaks if it runs early, and when it can be skipped.

## 1. Configuration

Chart of accounts (`GLEDGER`, `GLTREE`, `GLDEPT`), terms (`APTERM`), price levels (`INPRICE`),
warehouses (`INWH`), salespeople (`ARSALESP`), ship-via (`ARSHVIA`), manufacturers
(`INMANUFACTURERS`), work codes (`PYWORK`).

- **Needs:** nothing.
- **If early-skipped:** folder defaults set later in EBMS have nothing to point at; a customer
  file with price levels or salespeople fails its lookups.
- **Skip when:** the company was made from a template and the person is happy with what came
  with it. Read and show it either way.

## 1a. Sales tax

Rates (`ARTAX`), tax groups (`ARTAXGROUP`), and later exemptions (`ARCUSTAX`). See `tax.md`.

- **Needs:** the agency vendors (installed with EBMS), the liability accounts (configuration).
- **If skipped:** products get the install's default tax group and orders get no tax, silently.
- **Skip when:** the company never charges sales tax. Ask; don't assume.

## 2. Folders

`INVENTRE`, `PYEMPTRE`, `PYWORKTRE` through ebms-import; `APVENTRE` and `ARCUSTRE` in EBMS
(the API cannot create them). Nested folders take one run per level.

- **Needs:** configuration, so the folder defaults can be set in EBMS right after.
- **If early-skipped:** every later create fails ("Could not find vendor defaults") or lands in
  the wrong folder.
- **Skip when:** the template's folders are the ones they want.

## 3. Vendors

`APVENDOR`, one file.

- **Needs:** vendor folders.
- **If early-skipped:** a product file naming primary vendors reports them all missing; vendor
  records cannot be added.

## 4. Products

In four files, in this order:

1. `INVENTRY` — needs product folders, the vendors named as primary, tax groups.
2. `INVENUNT` — needs the products. A product created through the API may have a blank main
   unit until its units are added (ebms-products).
3. `INVENDOR` — needs the products, the vendors, and the units each record names.
4. `INVENDET` — needs both the product and every component.

Skip any of 2 to 4 the person does not have.

## 5. Customers

`ARCUST`.

- **Needs:** customer folders, and the price levels and salespeople the file names.
- **Then:** exempt customers (`tax.md` step 7).

## 6. Workers

`PYEMP`, after `PYEMPTRE` folders and `PYWORK` codes. **Keyed in EBMS**: EBMS 1.8.184 refuses
every worker create through the API. Review the file with ebms-import first, so what is keyed is
clean.

## After all stages

Folder defaults, opening balances and opening stock are set in EBMS. Nothing in these stages
posts or processes anything.
