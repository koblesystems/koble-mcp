# Configuration sets

From `EntityMetaData` on COF (EBMS 1.8.184, 2026-10-12), plus a create, read-back and delete
where the table says **verified**. These are discovered facts about one install, not the
generated entity references in ebms-api; re-read the metadata on another version.

Read each set before the stages start (`ebms_get`, always with `select`):

| Set | Key | Read with `select` | Through the API |
|---|---|---|---|
| `GLEDGER` chart of accounts | `ACCOUNT` (9) | `ACCOUNT,DESCR,TREE_ID,INACTIVE` | **set up in EBMS**: accounts carry budget and history child tables |
| `GLTREE` account folders | `TREE_ID` | `TREE_ID,TREE_DESCR,B_RANGE,E_RANGE` | **set up in EBMS**: `TREE_ID` and `PARENT_ID` are read-only |
| `GLDEPT` departments | `DEPT_ID` (3) | `DEPT_ID,DESCR,DIVISION,INACTIVE` | importable, not yet verified |
| `APTERM` terms | `ID` (10) | `ID,DESCR,TMP_TYPE` | **set up in EBMS**: each is a formula (`EXPR`, `AMT_EXPR`) |
| `INPRICE` price levels | `LEVEL` (15) | `LEVEL,ROUND` | **set up in EBMS**: `LEVEL` is read-only |
| `INWH` warehouses | `WAREHOUSE` (10) | `WAREHOUSE,DEPT,DIVISION` | **set up in EBMS**: `WAREHOUSE` is read-only; no name or address field |
| `ARSALESP` salespeople | `ID` (20, labelled Name) | `ID,CITY,STATE,COM_GL` | **verified**: needs `COM_GL`, a commission GL account, or EBMS refuses it |
| `ARSHVIA` ship-via | `DESCR` | `DESCR` | **set up in EBMS**: nothing is writable |
| `PYWORK` work codes | `ID` (10) | `ID,DESCR,TREE_ID,REQ_JOB` | **verified**, with `TREE_ID` a `PYWORKTRE` folder |
| `PYWORKTRE` work code folders | `TREE_ID` (EBMS numbers it) | `TREE_ID,PARENT_ID,TREE_DESCR` | **verified** (see folders below) |
| `INMANUFACTURERS` | `MFG_ID` (10) | `MFG_ID,MFG_NAME,VENDOR_ID` | importable, not yet verified |
| `ARTAX`, `ARTAXGROUP`, `ARCUSTAX` | | | see `tax.md` |

COF's own values, for orientation: price levels `Retail`, `Wholesale`, `WholesaleB`; warehouses
`BIKECAFE`, `TEST`, `IMPERIAL`; salespeople `DEKE`, `ADMINISTRATOR`; 26 terms
(`1CHARGE` "Net ___ days", `5CHDUREC` "Due on Receipt", `CNONE` "(None)", …).

## Folders

| Set | Through the API |
|---|---|
| `INVENTRE` products, `PYEMPTRE` workers, `PYWORKTRE` work codes | **verified**. EBMS numbers the new folder (sending `TREE_ID` is refused, 403). `PARENT_ID` must be sent **space-padded to five** (`"   36"`): unpadded, EBMS pads it on the wrong side and cannot find the parent. Each new product folder gets a `($)` defaults row with the install's defaults (COF: `TAX_GROUP` Taxable, `PUR_ACC` 60000-000, `MARKUP` (None)). |
| `ARCUSTRE` customers, `APVENTRE` vendors | **set up in EBMS**. EBMS requires a `PARENT_ID` their API entity does not expose ("The category "     " in "ARCUSTRE.DBF" could not be found"); nothing is saved. |

## Not importable at all

- **Workers (`PYEMP`)**: every create is refused with "Invalid constructor parameter", with or
  without an ID, a folder or pay fields. A worker file can still be reviewed with
  `import_from_csv` so it is clean before someone keys it in EBMS.
