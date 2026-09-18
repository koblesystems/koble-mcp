# koble-mcp

A thin MCP server over the EBMS (Koble Systems) OData API. It owns **authentication, the
list of companies it may use, and a few hard guards**, and nothing else. Which entity to touch, which
fields to select, how to chunk a large order, when to read back, when to ask — all of that
lives in skills (`ebms-api`, `ebms-sales-orders`, `ebms-products`, `invoice-to-po`).

It is the successor to the tool-per-task design in `ebms-mcp`, which is kept for comparison.

## Tools

| Tool | What it does | Refuses |
|---|---|---|
| `ebms_get` | One GET: a collection or a record, with `select`/`filter`/`expand`/`orderby`/`top`/`skip`. Reports `total` and `truncated` for collections. | a path that is not an entity path |
| `ebms_write` | One POST, PATCH or DELETE with a JSON body. | a company that is not configured (or not the sandbox, while testing); `PROCESS` anywhere in the body; a POST to `ARINV`/`APINV` whose `EXTERNALID` already exists; malformed paths |
| `ebms_command` | One bound action: `POST /ENTITY('key')/Model.Entities.<Command>`, with or without a dialog body. | a company that is not configured (or not the sandbox, while testing); denied commands (`Send`, `RecordPayment`, `PrintReport`, `Sign` by default); `PROCESS` in the body |

Every result names the company it ran against. Every failure comes back as
`{ error, uncertain, advice }`, where `uncertain: true` means a timeout, a dropped
connection or a 5xx: the write may or may not have happened, so **read the record back
before sending it again**. A resent create or add duplicates.

A 2xx is not proof. EBMS silently ignores unknown `@id`s and fields it won't accept, and
can attach warnings to a success; the result carries those as `warnings`. Read back and
compare.

## Companies

One server can serve several companies on the same serial number.

```
EBMS_SERIAL_NUMBER=...
EBMS_USERNAME=...
EBMS_PASSWORD=...
EBMS_COMPANIES=sbx,live          # every listed company may be read and written
EBMS_SANDBOX=sbx                 # optional, while testing: writes go only here
EBMS_COF_USERNAME=...            # optional per-company credentials
EBMS_COF_PASSWORD=...
EBMS_DENIED_COMMANDS=Send,RecordPayment,PrintReport,Sign
EBMS_LOG_FILE=./logs/requests.jsonl   # optional; method, path, company, status, ms — never bodies
```

Listing a company authorises both reading and writing it. `EBMS_SANDBOX` is for testing:
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
npm run check           # build + 23 tests, none of which touch the network
```

The server reads its settings from the process environment; supply them through the MCP
client's `env` block (or `node --env-file=.env index.js`).

## Design rules

- **The server never decides.** No chunking, no resume logic, no diffing. Those were the
  parts that went wrong in the previous design, and they are the parts a skill can fix
  without a rebuild and a restart.
- **The guards are the ones a model skips under pressure**, and only those: an
  unconfigured company, `PROCESS`, duplicate `EXTERNALID`, denied commands, path shape.
- **Uncertainty is explicit.** Timeouts, network failures and 5xx responses are labelled
  so a skill can tell "EBMS said no" from "nobody knows".
- **Credentials stay in the process.** They are read once, per company, and never enter a
  result, an error or the log.
- **stdout belongs to JSON-RPC.** Log with `console.error` only.
