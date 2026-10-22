---
name: ebms-new-company
description: Set up a brand-new, empty EBMS / Koble company from scratch — checking it is the right company and still empty, then its configuration, folders, vendors, products, customers and workers in the order they depend on each other, from CSV or Excel files or details given in chat. Use whenever someone wants to "set up a new company", "migrate from our old system", "load everything into the new dataset", or asks what has to exist before orders can be entered. Builds on the ebms-api, ebms-import, ebms-products and ebms-customers-vendors skills. Needs the koble-mcp server (tools ebms_companies, ebms_get, ebms_write, import_from_csv).
---

# Set up a new EBMS company

This skill owns three things: **the company check, the order, and the questions.** Every
record is written by another skill: files through **ebms-import**, records given in chat through
**ebms-products** or **ebms-customers-vendors**. Load **ebms-api** first. If `import_from_csv`
is missing, say the koble-mcp server is not connected (or is older than 0.1.0-rc.14) and stop.

## Ground rules

1. **The company must already exist.** The API cannot create one; it is made in EBMS (usually
   from a template, which also brings accounts, terms and tax groups).
2. **Confirm it by name, and that it is empty, before any write.** A migration into the wrong
   company is the one mistake here that cannot be cleaned up quietly.
3. **Stages go in dependency order** (step 2). A later stage never starts while an earlier one it
   needs has rows left to fix.
4. **A yes to one stage or file is not a yes to the next.**

## Step 1: the company

Call `ebms_companies`; the company must be listed and `writable`. Then check it is empty, one
read each, `top: 1`, `select` the key:

| Entity | filter |
|---|---|
| `INVENTRY` | `not startswith(ID,'($)')` |
| `ARCUST`, `APVENDOR`, `PYEMP` | `not startswith(ID,'($)')` |
| `ARINV`, `APINV` | none |

Show the counts (`total`) as a table and ask: *"Set up COF (Ikawa Coffee Co)? It has 0
products, 0 customers, 0 workers and no orders; the vendors already there are the state tax
agencies EBMS installs."* Records already there are not a problem by themselves: imports skip them. **Any
`ARINV` or `APINV` rows mean the company has trading history**: say so plainly and get a second,
explicit yes that this is the company to load into.

Round 1 of questions (at most three; tappable options if `ask_user_input_v0` is available):

- What to set up: everything, or which of configuration, folders, vendors, products,
  customers, workers.
- Where the data is: files (paths), or details they will give in chat.
- Whether EBMS made the company from a template (then accounts, terms and tax groups are
  already there and are read, not imported).

## Step 2: the order, and why

| Stage | Needs | Because |
|---|---|---|
| 1. Configuration | — | folder defaults point at terms, price levels and GL accounts |
| 1a. Sales tax | agency vendors, liability accounts | a product's tax group and a customer's location only work once rates exist |
| 2. Folders | configuration | every record needs a `TREE_ID`, and the folder fills in its defaults. Product, worker and work-code folders through ebms-import; **customer and vendor folders in EBMS** (the API cannot create them) |
| 3. Vendors | folders | products name a primary vendor; vendor records need the vendor |
| 4. Products | folders, vendors, tax groups | `INVENTRY`, then units (`INVENUNT`), then vendor records (`INVENDOR`: `UNIT_MEAS` must be one of the product's units), then bills of materials (`INVENDET`: both products must exist) |
| 5. Customers | folders, price levels, salespeople | a customer's folder and price level set what it pays |
| 6. Workers | worker folders, work codes | **keyed in EBMS**: the API refuses worker creates; ebms-import can still review the file |

The long form, with what may be skipped, is in `references/sequence.md`. Show the stages the
person chose, in this order, and work through them one at a time.

## Step 3: configuration

Read what the company already has (`references/config-entities.md` gives the reads) and show it:
accounts, terms, price levels, warehouses, salespeople, ship-via, tax groups. For each set give
its honest status: **importable** through ebms-import once verified there, or **set up in EBMS**.
Accounts with departments and terms with formulas have child tables; importing their headers
alone makes incomplete records, so the default for those is to set them up in EBMS.

**Sales tax is its own sub-step, before products and customers.** Follow
`references/tax.md`. A product created with the install's default tax group in a company whose
rates are not set up is a quiet error that surfaces on the first invoice: when a product
stage's first write comes back, read `TAX_GROUP` in `verification.rows`, name the default you
saw, and ask whether it is right before going on.

## Step 4: folders

- **Product, worker and work-code folders** (`INVENTRE`, `PYEMPTRE`, `PYWORKTRE`): through
  **ebms-import**, one file per set. EBMS numbers each new folder, so a nested file takes one run
  per level; the tool says how many wait. Each new product folder gets a `($)` defaults row with
  the install's defaults (on COF: tax group Taxable, purchase account 60000-000, no markup): ask
  them to check those in EBMS before products go in.
- **Customer and vendor folders** (`ARCUSTRE`, `APVENTRE`) are made in EBMS: the API cannot
  create them. Give them the list to make, then read the folders back before the customer and
  vendor stages.
- Whether a customer folder generates IDs is a folder setting the API cannot show (see
  ebms-customers-vendors). A customer file with blank IDs worked on COF: EBMS made them from the
  names.

## Steps 5 to 8: vendors, products, customers, workers

For vendors, products and customers: follow **ebms-import** for a file; follow **ebms-products**
or **ebms-customers-vendors** for records given in chat. Nothing else here. Workers are keyed
in EBMS; offer to review their file with ebms-import first so what they key is clean.

## Finish

Summarise per entity: created, skipped as already there, left to fix (with each exceptions
file's path). Then what is still to do in EBMS:

- folder defaults (`($)` rows) for every folder made here, and the customer and vendor folders;
- workers;
- tax rates not created here, and exempt customers (`references/tax.md` step 7);
- opening balances (GL, receivables, payables);
- **opening stock**: imported products have nothing on hand; count and adjust in EBMS.

Nothing was posted or processed.

## Not yet verified

- The emptiness check's counts on a company made from a template.
- Configuration sets marked "not yet verified" in `references/config-entities.md`, and what makes
  an API-created local tax rate charge tax (`references/tax.md`).
