# koble-mcp

A thin MCP server over the EBMS (Koble Systems) OData API. It owns **authentication, the
company allowlist and a few hard guards**, and nothing else. Which entity to touch, which
fields to select, how to chunk a large order, when to read back, when to ask — all of that
lives in skills (`ebms-api`, `ebms-sales-orders`, `ebms-products`, `invoice-to-po`).

It is the successor to the tool-per-task design in `ebms-mcp`, which is kept for comparison.

## Tools

| Tool | What it does | Refuses |
|---|---|---|
| `ebms_get` | One GET: a collection or a record, with `select`/`filter`/`expand`/`orderby`/`top`/`skip`. Reports `total` and `truncated` for collections. | a path that is not an entity path |
| `ebms_write` | One POST, PATCH or DELETE with a JSON body. | any company outside the write allowlist; `PROCESS` anywhere in the body; a POST to `ARINV`/`APINV` whose `EXTERNALID` already exists; malformed paths |
| `ebms_command` | One bound action: `POST /ENTITY('key')/Model.Entities.<Command>`, with or without a dialog body. | companies outside the allowlist; denied commands (`Send`, `RecordPayment`, `PrintReport`, `Sign` by default); `PROCESS` in the body |

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
EBMS_COMPANIES=sbx,live          # readable
EBMS_WRITE_COMPANIES=sbx         # writable (default: sbx, the demo dataset)
EBMS_COF_USERNAME=...            # optional per-company credentials
EBMS_COF_PASSWORD=...
EBMS_DENIED_COMMANDS=Send,RecordPayment,PrintReport,Sign
EBMS_LOG_FILE=./logs/requests.jsonl   # optional; method, path, company, status, ms — never bodies
```

With one company configured, `company` may be omitted on reads. On writes and commands it
is always required. With several, it is required everywhere. `EBMS_COMPANY_ID` (the
single-company variable `ebms-mcp` used) is still honoured.

Nothing in EBMS marks a dataset as live or sandbox, so the allowlist is the only thing
standing between a model and a live company. Keep it to sandboxes.

## Setup

```bash
npm install
cp .env.example .env    # fill it in; the file is gitignored
npm run check           # build + 23 tests, none of which touch the network
```

**Credentials stay in the server's own `.env`.** On startup the server loads `.env` from
its own directory (or the file named by `EBMS_ENV_FILE`), so the MCP client's config carries
no secrets — just the command:

```json
"koble-mcp": {
  "command": "node",
  "args": ["/path/to/koble-mcp/index.js"]
}
```

Values already in the process environment win over the file, so a client can still set
`EBMS_COMPANIES` or `EBMS_WRITE_COMPANIES` in its `env` block without touching the
credentials. Keep `.env` at mode 600. It is gitignored.

## Design rules

- **The server never decides.** No chunking, no resume logic, no diffing. Those were the
  parts that went wrong in the previous design, and they are the parts a skill can fix
  without a rebuild and a restart.
- **The guards are the ones a model skips under pressure**, and only those: company,
  `PROCESS`, duplicate `EXTERNALID`, denied commands, path shape.
- **Uncertainty is explicit.** Timeouts, network failures and 5xx responses are labelled
  so a skill can tell "EBMS said no" from "nobody knows".
- **Credentials stay in the process.** They are read once, per company, and never enter a
  result, an error or the log.
- **stdout belongs to JSON-RPC.** Log with `console.error` only.
