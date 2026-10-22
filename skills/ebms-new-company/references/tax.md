# Sales tax

Set up before products and customers. Confirmed on COF (EBMS 1.8.184, 2026-10-12) by reading
the company and by creating, reading back and deleting a ZTEST rate, a ZTEST exemption and a
ZTEST sales order.

## How EBMS models it

- **`ARTAX` is one row per jurisdiction rate**: `ID` (10), `DESCR` (35), `RATE` (a percent:
  `6` is 6%), `RATE_TYPE` (`Percentage`), `LEVEL` (`State`, `County`, … as EBMS spells them),
  `COUNTRY` (**required**: `USA`), `STATE` (3), `COUNTY` (30), `CITY` (30), `ZIP` (11),
  `FIPS_CODE` (3), `TAX_AGENCY` (a **vendor** ID), `LIAB_GL` (a GL account), `EFF_DATE`,
  `OLD_RATE`, `PMNT_FREQ` (`Monthly`, …), `PRINT_LBL`.
- **`ARTAXGROUP` is product taxability only**: `Taxable` and `Non-Taxable` on a template
  company. `INVENTRY.TAX_GROUP` names one. There is no description field.
- **`ARCUSTAX` is a customer's exemption**: `ID` (the customer), `EXEMPT_ID` (certificate
  number), `EXP_DATE`, `TAX_AGENCY`. EBMS adds an `ARCUSTAXDETs` row per tax group, both
  `EXEMPT: true`, by itself.
- **`GLCTL.AR_PRFL` is `BasedOnWarehouse` on COF**: tax follows the selling location. Neither
  `GLCTL` nor `INWH` exposes an address, so **the company's ZIP cannot be read: ask for it.**
- An order lists every rate EBMS considered in `ARINVTAXes` (`TAX_ID`, `SO_TAXABLE`,
  `SO_TAX_AMT`); `SO_TAX` is the order's tax and `TAX_TABLE` reads `Multiple` when more than one
  rate was considered. `TAX` stays 0 until the order is invoiced.

What COF has: one rate, `PA_SALES` (6%, State, agency `PADEP`, liability `24000-000`). The 50
state revenue departments are installed as vendors `<ST>DEP` ("Pennsylvania Dept of Revenue"),
all in vendor folder 2, "TaxJar Tax Agencies". **There is no agency for DC.** Liability accounts
are the `2…` accounts in `GLEDGER`; `24000-000` is "Sales Tax Collected".

## The stage, in order

Each step that writes gets its own yes.

1. **Read what exists** and show it as a table:
   - `ARTAX`, `select` `ID,DESCR,RATE,LEVEL,STATE,COUNTY,CITY,ZIP,FIPS_CODE,TAX_AGENCY,LIAB_GL,EFF_DATE`;
   - `ARTAXGROUP`, `select` `TAX_GROUP`;
   - the agency folder: `APVENDOR` with `filter` `TREE_ID eq '    2'` (padded: the unpadded
     `'2'` returns nothing), `select` `ID,L_NAME,STATE`. Confirm the folder's name in `APVENTRE`;
   - `GLEDGER`, `filter` `startswith(ACCOUNT,'2')`, `select` `ACCOUNT,DESCR`.
2. **Ask, in one message:** the ZIP of each selling location (each warehouse), the states where
   they collect tax, and whether any customers are exempt. If a customer file is in hand, run
   `import_from_csv` on it as a review: its rows show which states the customers are in.
3. **Recommend rates.** For each ZIP, look up the combined rate and its parts (state, county,
   city, special district, FIPS codes where published) with the host's web tools (WebSearch /
   WebFetch): Avalara's public rate lookup first, the state revenue department's own table
   second. If they have AvaTax credentials, its `taxrates/bypostalcode` endpoint is the better
   source; say how to use it, and never ask for the credentials in chat. Show a table:
   jurisdiction, level, rate, FIPS, effective date, source URL, date checked. **Rates change; the
   agency's own table is final.** With no web tool, ask them for the rates.
4. **Prerequisites per confirmed rate.** The agency: match each rate's state to its `<ST>DEP`
   vendor. Create one (through ebms-customers-vendors) only for a local jurisdiction that collects
   separately, or for DC. The liability account: from `GLEDGER`; if it is missing it is set up
   in EBMS.
5. **Create the rates** through **ebms-import** with `entity: ARTAX`, from a CSV you write from the
   confirmed table, so every number goes through the tool and none is retyped. Propose IDs as
   `<ST>_<LEVEL>` (`PA_STATE`, `PA_PHILA`) and let them confirm. Columns: ID, Description, Rate,
   Level, Country, State, County, City, ZIP, FIPS, Agency, Liability account, Effective date.
6. **Check each new rate in EBMS.** A ZTEST County rate created this way on COF was stored
   exactly as sent and was listed on a Philadelphia customer's order, but taxed $0 while the
   state rate on the same order taxed 6%. What the rate taxes is set in EBMS and is not visible
   through the API. Ask them to open each new rate in EBMS, then enter one test order per
   jurisdiction and read `SO_TAX` and `ARINVTAXes` before going on.
7. **Confirm `ARTAXGROUP`** has `Taxable` and `Non-Taxable`. Only then does the product stage set
   `TAX_GROUP`. A new product folder's `($)` row defaults it to `Taxable` on COF.
8. **Exempt customers**, after the customer stage: one `ebms_write` `POST` to `ARCUSTAX` per
   customer, `{"ID": "<customer>", "EXEMPT_ID": "<certificate>", "EXP_DATE": "2027-12-31",
   "TAX_AGENCY": "PADEP"}`, each with its own yes. Verified: EBMS marks the customer exempt for
   every tax group. **An exemption cannot be deleted through the API** (EBMS: "We never want the
   user to delete an ARCUSTAX"); it goes when its customer is deleted. Get the certificate
   details right before the write.

## Not yet verified

- What makes an API-created local rate charge tax (step 6).
- Destination-based companies (`AR_PRFL` other than `BasedOnWarehouse`).
- Exemptions that cover one tax group but not the other (`ARCUSTAXDETs` changes).
