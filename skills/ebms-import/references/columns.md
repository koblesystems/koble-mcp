# Columns each import accepts

A column is matched to a field by, in order: a `mapping` you pass (`{"Old SKU": "ID"}`, or
`""` to leave a column out), the field's own name (`DESCR_1`), the headers below, and the
field's label in EBMS (`Base price`). Case, spaces and punctuation are ignored. Any other
writable field can be imported under its own name. Types, maximum lengths and required flags
are read from EBMS's live metadata on every run, so they follow the install.

## Rules for every file

- **IDs**: keep them as text. A spreadsheet that turns `00123` into `123` or a long number into
  `1.23E+13` has changed the ID; the tool flags the second, not the first. Format ID columns as
  text before saving. IDs longer than EBMS keeps are refused, never cut.
- **Folders** (`TREE_ID`): the folder's number (`26`) or its exact name (`Mugs`); a name that
  matches two folders is refused. Never padded.
- **Numbers**: `1250`, `1,250.00`, `$1,250.00`, `-3`, `(3.00)`, `6%`. Not `1.250,00`.
- **Dates**: `2026-10-12` or `10/12/2026` (month first). Excel dates are read as dates.
- **Yes/no**: yes/no, y/n, true/false, 1/0, x.
- **Enums**: by name or number, e.g. classification `Track Count` or `2`.
- **EXTERNALID**: leave it out. The tool makes one per row; a value in the file is used as is.

## Products — `INVENTRY`

| Field | Headers | Notes |
|---|---|---|
| `ID` (24) | Part Number, Part No, SKU, Item, Item Number, Product, Product ID | required |
| `DESCR_1` (80) | Name, Description | |
| `TREE_ID` | Folder, Folder ID, Category, Category ID | required; ask, or pass in `defaults` |
| `C_TYPE` | Classification, Type | required; ask (ebms-products step 4). `0` Service Item · `1` No Count · `2` Track Count · `3` Serialized Item · `6` Percentage Price · `7` Non-inventory Serialized · `8` Rental Code · `9` Lots-Avg Cost · `10` Percentage Discount · `11` Lots-Tracked Cost |
| `COST` | Cost | |
| `BASE` | Price, Base Price | price levels derive from it (ebms-products step 5) |
| `PRI_VENDOR` | Vendor, Primary Vendor | must be a vendor in EBMS |
| `TAX_GROUP` | Tax Group | must be a tax group in EBMS (`Taxable`, `Non-Taxable`) |
| `UPC`, `MIN_INVEN`, `MAX_INVEN` | UPC, Min, Max | |

```
Part Number,Name,Folder,Classification,Cost,Price,Vendor
MUG-12,12 oz ceramic mug,26,Track Count,3.10,7.95,BEANCO
```

## Units — `INVENUNT`, vendor records — `INVENDOR`, bills of materials — `INVENDET`

One row per unit, vendor record or component; `ID` names the product, which must be in EBMS.
Units and vendor records are added to the product in one PATCH per product (at most 50 rows);
each bill-of-materials line is its own POST (EBMS refuses additions to a product's `INVENDETs`).
Rows the product already has are skipped, never replaced.

| Entity | Columns |
|---|---|
| `INVENUNT` | Product (`ID`), Unit (`UNIT`, 10), Multiply (`MULTIPLY`: Larger or Smaller), Multiplier (`MULTIPLIER`: main units in one; not 0 for Larger) |
| `INVENDOR` | Product (`ID`), Vendor (`VENDOR_ID`), Part Number (`PART_NO`), Unit (`UNIT_MEAS`: one of the product's units), Cost (`COST`), Lead Days (`LEAD_DAYS`) |
| `INVENDET` | Product (`ID`), Component (`COMP_ID`: a product in EBMS, not the product itself), Qty (`QUAN` > 0) |

Put `EACH_UNIT` and `DEF_UNIT` (say `EA`) on the product file: then the product's main unit has a
name from the start, and a units file only adds the larger ones.

```
Product,Unit,Multiply,Multiplier
MUG-12,CASE,Larger,12
```

## Customers — `ARCUST`, vendors — `APVENDOR`, workers — `PYEMP`

`TREE_ID` is written first: the folder fills in the defaults (ebms-customers-vendors). The folder
must already exist: customer and vendor folders are made in EBMS. Workers are review only.

| Field | Headers |
|---|---|
| `TREE_ID` | Folder, Folder ID, Category (required) |
| `ID` | Customer / Customer ID / Account; Vendor / Vendor ID / Supplier; Employee / Worker. Customers: may be blank, and EBMS makes one from the name (`ZTEST Cust 2` became `ZTECUS`, the next `ZTECUS1`). **Vendors: required.** |
| `L_NAME`, `F_NAME` | Name, Company, Company Name, Last Name; First Name. One of the two is required. |
| `ADDRESS1`, `CITY`, `STATE`, `ZIP` | Address, Street, City, State, ZIP, Zip Code, Postal Code |
| `PHONE`, `EMAIL` | Phone, Email |
| `IN_LEVEL`, `SALESMAN` (customers) | Price Level (must be in `INPRICE`), Salesperson / Sales Rep (must be in `ARSALESP`) |
| `GL_CODE` (vendors) | GL Account (must be in `GLEDGER`) |
| `DEF_PAY`, `PAY_TYPE`, `PAY_METHOD`, `HIRE_DATE` (workers) | Pay / Default Pay (`Salary`, `Hourly`), Frequency / Pay Frequency (`Weekly`, `Monthly`, …), Pay Method (`Check`, …), Hire Date. The first three and the hire date are required. |

```
Folder,Name,Address,ZIP,Phone,Email
Retail,Smith Roofing,12 Main St,17101,717-555-0100,office@smithroofing.example
```

## Folders — `INVENTRE`, `PYEMPTRE`, `PYWORKTRE`

| Field | Headers |
|---|---|
| `TREE_DESCR` (35) | Name, Folder Name, Description (required) |
| `PARENT_ID` | Parent, Parent Folder, Parent ID (required): an EBMS folder's number, the name of an EBMS folder (unique), or another row of this file (by its Folder or its Name) |
| `TREE_ID` | Folder, Folder ID, Folder No: optional, the old system's number, used only so other rows can name this one as a parent. **Never sent**: EBMS numbers new folders itself. |

A folder is matched to EBMS by its name under its parent, so a rerun finds the ones already made.
A row whose parent is another row of the file waits for the run after that parent is created.
Every new product folder gets a `($)` defaults row with the install's defaults (on COF: tax group
Taxable, purchase account 60000-000, no markup); check them in EBMS before records go in.
Customer (`ARCUSTRE`) and vendor (`APVENTRE`) folders cannot be created through the API.

```
Folder,Parent,Name
10,Products,Coffee
11,10,Single Origin
```

## Tax rates — `ARTAX`

| Field | Headers |
|---|---|
| `ID` (10) | ID — propose `<ST>_<LEVEL>` (`PA_STATE`, `PA_ALLEG`); the person confirms |
| `DESCR` | Description |
| `RATE` | Rate (percent: `6` or `6%`) |
| `COUNTRY` | Country (required: `USA`) |
| `LEVEL` | Level (State, County, City, …: spelling as EBMS shows it) |
| `STATE`, `COUNTY`, `CITY`, `ZIP`, `FIPS_CODE` | State, County, City, ZIP, FIPS |
| `TAX_AGENCY` | Agency: a vendor in EBMS (each state's revenue department is installed as one) |
| `LIAB_GL` | Liability Account: a GL account in EBMS |
| `EFF_DATE` | Effective Date |

## Work codes — `PYWORK`, salespeople — `ARSALESP`

| Entity | Columns |
|---|---|
| `PYWORK` | Work Code (`ID`, 10), Description (`DESCR`), Folder (`TREE_ID`: a `PYWORKTRE` folder, by number or name) |
| `ARSALESP` | Name (`ID`, 20), Address, City, State, ZIP, Commission Account (`COM_GL`: required, a GL account) |

## Other configuration sets

`ARTAXGROUP`, `GLDEPT`, `INMANUFACTURERS`: matched to their fields by name and label, keyed on
EBMS's own natural key, not yet verified. `INWH` and `INPRICE` are refused (EBMS will not take
their key from the API); `APTERM` and `GLEDGER` are better set up in EBMS. Read the
**ebms-new-company** skill's configuration reference (config-entities) before importing any.
