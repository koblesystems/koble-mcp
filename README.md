# koble-mcp

A thin MCP server over the EBMS (Koble Systems) OData API. It owns **authentication, the
list of companies it may use, and a few hard guards**, and nothing else. Which entity to touch, which
fields to select, how to chunk a large order, when to read back, when to ask — all of that
lives in skills (`ebms-api`, `ebms-sales-orders`, `ebms-products`, `invoice-to-po`).

It is the successor to the tool-per-task design in `ebms-mcp`, which is kept for comparison.

## Tools

| Tool | What it does | Refuses |
|---|---|---|
| `ebms_companies` | Lists the companies the serial reaches — ID, name, version, and whether writes are allowed. Needs no credentials. | — |
| `ebms_get` | One GET: a collection or a record, with `select`/`filter`/`expand`/`orderby`/`top`/`skip`. Reports `total` and `truncated` for collections. | a path that is not an entity path |
| `ebms_write` | One POST, PATCH or DELETE with a JSON body. | a company that is not configured (or not the sandbox, while testing); `PROCESS` anywhere in the body; a POST to `ARINV`/`APINV` whose `EXTERNALID` already exists; malformed paths |
| `ebms_command` | One bound action: `POST /ENTITY('key')/Model.Entities.<Command>`, with or without a dialog body. | a company that is not configured (or not the sandbox, while testing); denied commands (`Send`, `RecordPayment`, `PrintReport`, `Sign` by default); `PROCESS` in the body |

Every result names the company it ran against. Every failure comes back as
`{ error, uncertain, advice }`, where `uncertain: true` means a timeout, a dropped
connection or a 5xx: the write may or may not have happened, so **read the record back
before sending it again**. A resent create or add duplicates.

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
EBMS_DENIED_COMMANDS=Send,RecordPayment,PrintReport,Sign
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
  unconfigured company, `PROCESS`, duplicate `EXTERNALID`, denied commands, path shape.
- **Uncertainty is explicit.** Timeouts, network failures and 5xx responses are labelled
  so a skill can tell "EBMS said no" from "nobody knows".
- **Credentials stay in the process.** They are read once, per company, and never enter a
  result, an error or the log.
- **stdout belongs to JSON-RPC.** Log with `console.error` only.
