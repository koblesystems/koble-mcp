# koble-mcp

A thin MCP server over the EBMS (Koble Systems) OData API. It owns **authentication, the
list of companies it may use, and a few hard guards**, and nothing else. Which entity to touch, which
fields to select, how to chunk a large order, when to read back, when to ask — all of that
lives in skills. The two that ship here, in `skills/`, are `ebms-mrp` and `ebms-mrp-purchase-orders`.

It is the successor to the tool-per-task design in `ebms-mcp`, which is kept for comparison.

## Tools

| Tool | What it does | Refuses |
|---|---|---|
| `ebms_companies` | Lists the companies the serial reaches — ID, name, version, and whether writes are allowed. Needs no credentials. | — |
| `ebms_get` | One GET: a collection or a record, with `select`/`filter`/`expand`/`orderby`/`top`/`skip`. Reports `total` and `truncated` for collections. | anything but `ENTITY` or `ENTITY('key')`; a key containing `/ \ ? %` or `..` |
| `ebms_write` | One POST, PATCH or DELETE with a JSON body. | a company that is not configured (or not the sandbox, while testing); `PROCESS` anywhere in the body; a POST to `ARINV`/`APINV` whose `EXTERNALID` already exists; the same path rules |
| `ebms_command` | One bound action: `POST /ENTITY('key')/Model.Entities.<Command>`, with or without a dialog body. | a company that is not configured (or not the sandbox, while testing); any action that is not on the allow-list (`MarkAllAsShipped`, `RecalculateAllPrices`, `CalculateFreight`, `ChangeCustomer` by default); `PROCESS` in the body |

Every result names the company it ran against. Every failure carries `uncertain` and says
what it means:

- `uncertain: false` with `refused: true` — this server stopped it, a check before the write
  failed, or it could not sign in. **Nothing was sent.**
- `uncertain: false` with an `error.status` — EBMS answered and said no. Nothing was saved.
- `uncertain: true` — a timeout, a dropped connection, a response that broke off part-way, a
  5xx, a 2xx carrying an error message, or a fault inside this server after the request had gone out. The write may or may not have happened, so **read
  the record back before sending it again**. A resent create or add duplicates.

**Paths are parsed and rebuilt, not passed through.** The entity name is validated; each key
value may not contain `/ \ ? %`, `..` or control characters, and is percent-encoded (so a `#`
in a PO number is data, not a URL fragment). As a second check the client refuses any finished
URL that is not inside the company's own OData root. That is what makes the company boundary
hold even against text a model was tricked into using.

**Actions are allowed by name, not refused by name.** EBMS has many bound actions that post,
process, pay or send (`ProcessScanner`, `Post`, `Unpost`, `RecordPayment`, `Send`, …); a list of
those could never be complete, so `ebms_command` runs only `EBMS_ALLOWED_COMMANDS`.

## Every write is verified

A 2xx is not proof. EBMS answers 200 to writes it only partly applies: an unknown `@id` is
ignored, an unwritable field is dropped, an over-long value is cut, a quantity can come back
as 0. So after each write the server reads back **exactly the fields that were sent** and
compares them in code — numbers within half a cent, strings ignoring padding and line-ending
style — instead of leaving the arithmetic to a model:

```json
"verification": {
  "ok": false,
  "checked": 6,
  "mismatches": [{ "where": "Details[1] › Materials[2] TEAMJERSEY", "field": "M_QUAN_VIS", "sent": 1, "stored": 0 }],
  "problems": [],
  "notes": [],
  "rows": [ … the stored values of every row the write touched or created … ]
}
```

- `mismatches` — a field stored differently from what was sent.
- `problems` — a row that never appeared, an `@id` EBMS ignored, a removal that didn't happen.
- `notes` — rows EBMS added on its own, such as an assembly kit's default components. Not a
  failure. Pass `readBack.children: "Materials"` to have new rows checked for them.
- `rows` — what EBMS stored, including anything asked for in `readBack.lines`
  (`UNIT_MEAS,UNIT_VIS,SO_AMOUNT`) or `readBack.record`. Report these, not what was sent.

It is generic: it understands OData's shapes (top-level fields, `Nav@delta` arrays, nested
arrays on a create) and knows nothing about any one entity. New rows are told apart from old
by a light read of row IDs before a PATCH; children are read only for the parent rows the
write touched, because an unfiltered nested expand costs EBMS tens of seconds on a large
document. If the write succeeds and only the read-back fails, the result says exactly that
and tells the caller not to resend. `verify: false` switches it off.

The write result no longer echoes EBMS's whole record (about a hundred fields); it returns
the record's `AUTOID`, `INVOICE` and `ID` plus the verification.

## Planning (MRP)

Two read-only tools sit beside the proxy, for the same reason write verification does: it is
arithmetic over hundreds of rows that has to be exact.

| Tool | What it answers |
|---|---|
| `mrp_plan` | What to buy and make, by when, and why — for a time frame and a scope (everything, particular vendors, or particular products) that the user gives. It will not assume either. The worksheet comes back attached to the result, so it can be handed to the user in the conversation. |
| `mrp_item_view` | Everything needed to build N of one finished good, down every BOM level, against what is available. |
| `po_from_csv` | Reads the planner's approved worksheet and drafts one purchase order per vendor. Creates nothing; the drafts go through `ebms_write`. |

What is read, and how it is netted (worked out against SBX with someone who knows the database):

- **Demand** — open sales (`S`) and job (`J`) lines from `ARINVDET`, `QUAN − SHIP` in base units,
  dated by the line's `SHIP_DATE`. A line with a materials list underneath is skipped in favour
  of its children. Open batches' consumables (`INMFG` → `ARINVDETs`) are demand too.
- **Supply** — open purchase lines through `APINV` → `Details` (`O_QUAN_VIS − SHIP_VIS`), and
  open batches' finished goods (`INMFG` → `FinishedDetails`, where `SHIP_VIS` is the quantity
  made so far). These are in the line's unit and are converted to base units from `INVENUNT`.
- **Parameters** — `T_ON_HAND`, `MIN_INVEN` (floor), `MAX_INVEN` (order up to), `ORDER_AMT`
  (reorder increment), `PRI_VENDOR`, `PURC_METH` from `INVENTRY`. Only stocked products and
  stocked lines are pooled; drop-ship, sync and associated lines belong to their own orders.
- **Made or bought** — an item is manufactured if it has ever been a batch's finished good;
  `alsoMade` and `buyInstead` override that for a run. Made items explode through `INVENDET`,
  level by level, so a made component of a made item is planned too.
- **Two rules for shortage** — a projected stock-out pulls in a later receipt (an expedite
  message) or plans a dated order; being under the minimum only matters if it is still under at
  the end of the time frame. (`QUAN2ORDER` on the product is not a formula to match: it is
  whatever EBMS's own purchasing screen last saved. The worksheet shows it as a reference.)
- **A receipt with no expected date** is counted on the last day of the time frame — late enough
  that it cannot quietly cover a shortage it may not arrive for, early enough to count toward the
  minimum. Where it is needed sooner, the plan asks the buyer to confirm it by that date.
- **What is already on order just after the time frame** is not netted, but it is shown: on the
  worksheet, and beside any item the plan says to buy.
- **Lead time** — kept per product vendor in EBMS (the `LEAD_DAYS` column, according to Koble) but not published through the API,
  so orders carry a needed-by date. `leadTimeDays` / `leadTimes` supply it when the user knows.

**The worksheet.** `mrp_plan` writes a CSV (to `KOBLE_OUTPUT_DIR`, or `Documents/Koble MRP`) with
every planned item: its status, the recommendation (`EXPEDITE`, `BUY`, `MAKE`, `NOT NEEDED`, `OK`),
the numbers behind it, and for purchases the vendor, part number, purchase unit, order quantity in
that unit and cost from `INVENDOR` (the product's own stock unit when the vendor has none, stated
on the order so EBMS cannot default to a case). A planner edits `Order Qty`, `Approve`, `Vendor` and `Notes` in a spreadsheet and hands it back.

Spreadsheets reformat dates, turn long numeric product IDs into `3.94E+13` and drop leading
zeros, so the file is not trusted for anything the planner was not meant to edit: `mrp_plan`
also saves a small **run record** (`runs/<run>.json` beside the worksheet), and `po_from_csv`
takes the item, unit, cost and date from it, keyed by the row's `Line`. Each row also carries a
`Check` code over its run, line and product, so a `Run` cell changed on every row, a worksheet
re-pointed at another run, or a row typed in by hand is refused with or without the record.
A line the planner moves to another vendor has its quantity converted through stock units into
that vendor's unit (2 cases of 24 become 48 each), and says so. Rows added by hand,
duplicated rows, a changed `Run` cell, unrecognised `Approve` text and ambiguous quantities
(`1,5`, `1e3`) are named as problems, and each draft lists what the planner changed. If the
record cannot be found (the file moved to another computer) the file is read strictly and the
result says so. Drafts do not send an expected date: on the purchase orders created so far, EBMS stored its own
`ETA_DATE` (apparently from the vendor's lead time) and ignored the one sent, so the read-back reports it and the skill compares it with the day
the stock is needed. `po_from_csv` checks each approved row against EBMS, names
any it cannot order (no vendor, zero quantity, inactive product), and drafts one purchase order per
vendor whose `EXTERNALID` is the run plus the vendor, so the same worksheet cannot order twice.
The file is written and read by code so the numbers a person approves are the numbers ordered.

The engine (`src/mrp/engine.ts`), the finished-good view (`src/mrp/tree.ts`) and unit conversion
(`src/mrp/units.ts`) are pure and unit-tested; `src/mrp/snapshot.ts` does the reads. A 60-day
plan of SBX takes about 30 s, nearly all of it EBMS answering six reads one after another.

## Companies

One server can serve several companies on the same serial number.

```
EBMS_SERIAL_NUMBER=...
EBMS_USERNAME=...
EBMS_PASSWORD=...
EBMS_COMPANIES=sbx,live          # optional: narrow to these IDs; unset = every company the serial reaches
EBMS_SANDBOX=sbx                 # optional, while testing: writes go only here
EBMS_COF_USERNAME=...            # optional per-company credentials
EBMS_COF_PASSWORD=...
EBMS_ALLOWED_COMMANDS=MarkAllAsShipped,RecalculateAllPrices,CalculateFreight,ChangeCustomer   # optional; this is the default
EBMS_LOG_FILE=./logs/requests.jsonl   # optional; method, path, company, status, ms — never bodies
```

Users rarely know a company's internal ID, so the server discovers the companies itself: at
startup it asks the serial's unauthenticated company-list endpoint, and `ebms_companies`
shows the result with names. Every `company` argument accepts the ID or the name
("Sample Coffee Co"). `EBMS_COMPANIES` is only needed to narrow that list.

Every available company may be read and written. `EBMS_SANDBOX` is for testing:
when set, writes go only to that one company, which is readable by implication and need not
be repeated in the list. With one company configured, `company` may be omitted on reads; on
writes and commands it is always required, and with several companies it is required
everywhere. `EBMS_COMPANY_ID` (the variable `ebms-mcp` used) is still honoured.

Nothing in EBMS marks a dataset as live or a copy. Listing a live company means a model can
write to it, so the skills' rule of showing the exact request and getting a yes before every
write is what protects it — together with the guards below, which are the mistakes a
confirmation step does not catch.

## Getting started (for someone testing this)

You need Node 22 or newer, Claude Desktop (or Claude Code), and an EBMS login for the company
you will test against. Nothing here needs a Mac.

1. **Get the code and build it.**
   ```bash
   git clone https://github.com/dsbowman/koble-mcp.git
   cd koble-mcp
   npm install
   npm run check        # builds, then runs the tests; none of them touch the network
   ```
2. **Register the server** in Claude Desktop: Settings → Developer → Edit Config, and add this
   under `mcpServers` (the file is strict JSON — no comments, no trailing commas). Use the full
   path to `index.js` on your machine; on Windows double the backslashes.
   ```json
   "koble-mcp": {
     "command": "node",
     "args": ["/full/path/to/koble-mcp/index.js"],
     "env": {
       "EBMS_SERIAL_NUMBER": "your serial number",
       "EBMS_USERNAME": "your EBMS user",
       "EBMS_PASSWORD": "your EBMS password",
       "EBMS_SANDBOX": "ID of a test company, if you have one"
     }
   }
   ```
   Restart Claude Desktop. Ask Claude "which EBMS companies can you see?" — it should list them by
   name. You do not need to know a company ID; the server discovers them from the serial number.
3. **Install the skills** in `skills/`: `ebms-mrp` and `ebms-mrp-purchase-orders`. In Claude
   Desktop, zip each folder and add it under Settings → Capabilities → Skills. In Claude Code, copy
   the folders into `~/.claude/skills/`.
4. **Try it.** "Run MRP for the next 30 days." Claude should ask you to confirm the time frame and
   the company, take half a minute or more, and give you the path of a worksheet CSV in
   `Documents/Koble MRP`.

**What is safe.** Planning is read-only: `mrp_plan`, `mrp_item_view` and `po_from_csv` never write
to EBMS. Purchase orders are only created by the second skill, one at a time, after you say yes to
each. With `EBMS_SANDBOX` set, writes can only go to that company: the company is part of a URL
this server builds itself, and a request that would land anywhere else is refused before it is
sent. Leave it set while testing. The `PROCESS` field is refused in every request body, and
`ebms_command` runs only a short list of actions, none of which posts, pays or sends.

**What to look for, and tell us.** Numbers that disagree with what you know to be true, and why;
products planned that should not be (or the reverse); units that come out wrong; anything the plan
leaves out that matters in your business; how long a run takes on real data; and whether the
worksheet is something a buyer would actually use. The `Because` column and `mrp_item_view` are
there so you can check any number. Known gaps: no vendor lead times (EBMS does not publish them
through its API yet), no per-warehouse planning, no warehouse transfers, and `MAKE` rows stop at
the worksheet — nothing creates manufacturing batches.

## Setup

```bash
npm install
cp .env.example .env    # fill it in; the file is gitignored
npm run check           # build + tests, none of which touch the network
```

The server reads its settings from the process environment; supply them through the MCP
client's `env` block (or `node --env-file=.env index.js`).

## Design rules

- **The server never decides.** No chunking, no resume logic, no planning. Those were the
  parts that went wrong in the previous design, and they are the parts a skill can fix
  without a rebuild and a restart. What it does do in code is arithmetic nobody should
  trust a model with: comparing what was stored against what was sent.
- **The guards are the ones a model skips under pressure**, and only those: an
  unconfigured company, `PROCESS`, duplicate `EXTERNALID`, actions off the allow-list, and
  anything in a path that could leave the company.
- **Uncertainty is explicit.** Timeouts, network failures and 5xx responses are labelled
  so a skill can tell "EBMS said no" from "nobody knows".
- **Credentials stay in the process.** They are read once, per company, and never enter a
  result, an error or the log.
- **stdout belongs to JSON-RPC.** Log with `console.error` only.
