# koble-mcp

EBMS (Koble Systems ERP) for Claude. Ask Claude to enter a sales order, raise or receive a purchase
order, set up a product, manage a task, or plan what to buy and make — and it does it in EBMS,
confirming each change with you and checking afterwards that EBMS stored what was sent.

It is two things in one install:

- **A small MCP server** that owns the EBMS connection: your credentials, which companies it may
  touch, and a few hard guards (nothing is ever posted, paid or sent; every write is verified).
- **Skills** — the procedures, written down: how to build an order in chunks, what to confirm,
  which EBMS quirks to avoid. They live in `skills/`, and the server also serves them to Claude
  apps that cannot install skills themselves.

## Install

One command downloads the `koble` program (checked against the release's checksums), then
`koble setup` asks for your EBMS serial number, a test company, your username and your password,
checks that they work, stores the password in your system's credential store, and connects the AI
apps you choose from the ones it finds:

| App | What koble sets up |
|---|---|
| Claude Desktop | the server, in the config Desktop actually reads (including the Windows Store build's own folder) |
| Claude Code, and Claude Desktop's **Code** tab | the server, plus the skills as `/` commands — using Desktop's built-in Claude Code if the `claude` command isn't installed |
| Codex (OpenAI) | the server, in `~/.codex/config.toml` |
| Cursor, VS Code (Copilot), Gemini CLI, Windsurf | the server, in each app's MCP config |

Every app also gets the procedures through the server itself (`ebms_guide`), so none of them needs
anything uploaded. Run `koble doctor` any time to check everything, and `koble connect --apps …` to
add an app later.

> **ChatGPT.** The ChatGPT app can only connect to servers on the internet, not to a program on
> your computer, so it needs a hosted version of koble that doesn't exist yet. OpenAI's Codex works
> today.

### Windows

In **PowerShell** (Start menu → PowerShell):

```powershell
irm https://raw.githubusercontent.com/koblesystems/koble-mcp/master/scripts/install.ps1 | iex
```

It installs `koble.exe` to `%LOCALAPPDATA%\Programs\koble` and adds that folder to your PATH.
The password goes to Windows Credential Manager.

> **If Windows blocks `koble.exe`.** Releases are not code-signed yet, so SmartScreen may show
> "Windows protected your PC" — choose *More info → Run anyway*. On Windows 11 with **Smart App
> Control** turned on, unsigned programs are blocked outright; until signed builds are published,
> use a machine or VM without Smart App Control. Please don't turn it off just for this.

### macOS

In **Terminal**:

```bash
curl -fsSL https://raw.githubusercontent.com/koblesystems/koble-mcp/master/scripts/install.sh | bash
```

It installs `koble` to `~/.local/bin` (Apple silicon). The password goes to the macOS Keychain.
Intel Macs are not built yet.

### Linux

```bash
curl -fsSL https://raw.githubusercontent.com/koblesystems/koble-mcp/master/scripts/install.sh | bash
```

x64 and arm64. The password goes to the Secret Service keyring when `secret-tool` is available,
otherwise to a file in `~/.config/koble` that only you can read. Claude Desktop does not run on
Linux; use Claude Code.

### Claude Code

The installer above connects Claude Code and copies the skills into its skills folder, so they are
`/` commands straight away: `/ebms-mrp`, `/ebms-purchase-orders`, `/koble-setup` and the rest.

If you'd rather start from inside Claude Code, add the plugin:

```bash
claude plugin marketplace add koblesystems/koble-mcp
claude plugin install koble-mcp@koblesystems
```

and ask Claude to **"set up Koble"** (or run `/koble-mcp:koble-setup`): it installs the program,
saves your settings, and has you type the password into `koble login` yourself — the password
never goes through the chat.

### Let an AI agent install it

Point any coding agent at [install.md](install.md). It is written to be followed step by step.

### After installing

- **Claude Desktop:** quit and reopen it.
- **Claude Code:** start a new session (or run `/mcp`).
- Ask: *"Which EBMS companies can you see?"* — Claude should name them.

Settings live in `~/.config/koble` (`%APPDATA%\koble` on Windows). `koble update` installs the
newest release; `koble setup` again changes any answer.

### `/` commands in Claude Desktop's chat

Claude Code and Desktop's Code tab get the skills as `/` commands automatically. Desktop's regular
chat shows skills from plugins on your Claude account, and this repository is a plugin marketplace:

1. Claude Desktop → **Settings → Customize → Plugins → Add marketplace → Add from a repository**
2. Enter `koblesystems/koble-mcp` and install **Koble**.

The skills then appear under `/` as **Koble** in every Claude chat on your account, and update
themselves from this repository. (They follow the repository, so they can be a little newer than
your `koble`; they only use its tools, so that is fine — `koble update` keeps the two close.)
`koble doctor` says whether the plugin is on your account. Desktop's **Code** tab shows it too, so
once it is there `koble connect` stops copying the skills into Claude Code's folder (and removes the
copies it made) — otherwise every skill would appear twice. The `claude` command in a terminal
does not see account plugins; used on its own, it keeps koble's copies.

If your account cannot add a marketplace from GitHub, `koble plugin` saves the same skills as a
`koble.plugin` file to upload there instead — one or the other, not both.

### Uninstall

```
koble uninstall
```

The same on every system. It lists everything koble added — its entry in each AI app's config,
the skills it put in Claude Code, the stored password, its settings, and the program itself (and,
on Windows, its folder on your PATH) — asks once, then removes exactly those. Each app config is
backed up first, a config it cannot read safely is left alone with a note, and a skill of your own
with the same name is never touched. Your MRP worksheets and the config backups stay. Quit Claude
Desktop first, or it may write koble back into its config. `--yes` skips the question.

## Using it

Ask in your own words — *"order 10 tubes from Bike Parts Co"*, *"what's open for the bike shop?"*,
*"run MRP for the next 60 days"* — or start a named workflow:

| Workflow | Claude Code (and Desktop's Code tab) | Claude Desktop chat (＋ menu; or `/` once `koble.plugin` is uploaded) |
|---|---|---|
| Plan what to buy and make | `/ebms-mrp` | ＋ menu → koble-mcp → **mrp-plan** |
| Create the POs / batches an MRP worksheet approved | `/ebms-mrp-purchase-orders`, `/ebms-mrp-batches` | ＋ → **mrp-purchase-orders**, **mrp-batches** |
| Sales orders | `/ebms-sales-orders` | ＋ → **sales-order** |
| Purchase orders, receiving, what's on order | `/ebms-purchase-orders` | ＋ → **purchase-order**, **receive**, **on-order** |
| Products, tasks | `/ebms-products`, `/ebms-tasks` | ＋ → **product**, **task** |
| Reschedule a week's tasks so nobody overlaps | `/ebms-task-reflow` | ＋ → **task-reflow** |
| Check or repair the install | `/koble-setup` | run `koble doctor` in a terminal |

The server's named workflows also appear in Claude Code as `/mcp__koble-mcp__mrp-plan` and so on,
and in other apps wherever they list an MCP server's prompts.

**What is safe.** Planning is read-only: `mrp_plan`, `mrp_item_view`, `po_from_csv` and
`batches_from_csv` never write to EBMS. Purchase orders and batches are only created by the second
and third skills, one at a time, after you say yes to each. With `EBMS_SANDBOX` set, writes can only go to that company: the company is part of a URL
this server builds itself, and a request that would land anywhere else is refused before it is
sent. Leave it set while testing. The `PROCESS` field is refused in every request body, and
`ebms_command` runs only a short list of actions, none of which posts, pays or sends.

Testing it? [TESTING.md](TESTING.md) has a checklist and what to send back.

## Tools

| Tool | What it does | Refuses |
|---|---|---|
| `ebms_companies` | Lists the companies the serial reaches — ID, name, version, and whether writes are allowed. Needs no credentials. | — |
| `ebms_get` | One GET: a collection or a record, with `select`/`filter`/`expand`/`orderby`/`top`/`skip`. Reports `total` and `truncated` for collections. | anything but `ENTITY` or `ENTITY('key')`; a key containing `/ \ ? %` or `..` |
| `ebms_write` | One POST, PATCH or DELETE with a JSON body. | a company that is not configured (or not the sandbox, while testing); `PROCESS` anywhere in the body; a POST to `ARINV`/`APINV`/`INMFG`/`TASK` whose `EXTERNALID` already exists; the same path rules |
| `ebms_command` | One bound action: `POST /ENTITY('key')/Model.Entities.<Command>`, with or without a dialog body. | a company that is not configured (or not the sandbox, while testing); any action that is not on the allow-list (`MarkAllAsShipped`, `RecalculateAllPrices`, `CalculateFreight`, `ChangeCustomer` by default); `PROCESS` in the body |
| `ebms_guide` | Serves the skills: the list, one skill, or one reference file. Lets Claude Desktop use them without uploading anything. | — (read-only; only the files it shipped with) |
| `mrp_plan`, `mrp_item_view`, `po_from_csv`, `batches_from_csv` | Planning and worksheet reading (see *Planning*). | — (read-only) |

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
those could never be complete, so `ebms_command` runs only `EBMS_ALLOWED_COMMANDS` — by default `MarkAllAsShipped`, `RecalculateAllPrices`, `CalculateFreight`, `ChangeCustomer` and `LinkInvoice`.

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
| `batches_from_csv` | Reads the approved `MAKE` rows and drafts one pending manufacturing batch per row, with every component from the bill of materials. Creates nothing. |

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

**Manufacturing batches.** What creating test batches in EBMS showed, and the drafts are built on:
the finished good must be a Track Count product (anything else is refused); EBMS does **not** add
consumed materials itself when a batch arrives through the API, as its own screens do, so every
component is sent from `INVENDET`; and a consumed line's `M_QUAN_VIS` is the amount for one
finished good, which EBMS multiplies by the batch size. Drafts mark nothing as made or consumed,
state each line's unit, take the warehouse the planner gives or the one the product was last made
in, and carry an `EXTERNALID` of the run plus the worksheet line so a batch cannot be created
twice (`INMFG` is covered by the duplicate guard alongside `ARINV`, `APINV` and `TASK`).

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

## Developing

Needs Node 22.

```bash
git clone https://github.com/koblesystems/koble-mcp.git
cd koble-mcp
npm install
npm run check                      # builds, then runs the tests; none of them touch the network
node cli.js setup                  # the same setup, run from source
node scripts/build-single.mjs      # the single-file koble for this platform, in dist/
```

The Claude Code plugin brings only the skills. `koble connect` registers the server itself, by its full path, so it never depends on PATH.

The server reads `EBMS_*` settings from its environment when they are set (see `.env.example`),
and otherwise from what `koble setup` stored — so an existing configuration that passes them in
an MCP client's `env` block keeps working. A release is cut by pushing a tag `vX.Y.Z` that matches
`package.json`; the release workflow builds `koble` for Windows, macOS and Linux and publishes it
with `checksums.txt`.

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

## License

MIT — see [LICENSE](LICENSE). Security reports: see [SECURITY.md](SECURITY.md).
