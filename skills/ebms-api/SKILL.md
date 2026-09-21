---
name: ebms-api
description: Read and write EBMS / Koble data (Koble Systems ERP) through the koble-mcp server — how to call ebms_companies, ebms_get, ebms_write and ebms_command, OData filter and select syntax, write conventions, how to read a write's verification, and the install-specific quirks that make correct-looking requests fail. Use this whenever a task touches EBMS data: products (INVENTRY), customers (ARCUST), sales orders (ARINV), purchase orders (APINV), vendors (APVENDOR), tasks or workers (TASK/PYEMP), or whenever someone mentions EBMS, Koble, koblesystems.dev, an ERP OData endpoint, or is debugging a 401/422/500 from one. The task skills (ebms-sales-orders, ebms-purchase-orders, ebms-products, ebms-tasks, ebms-mrp) build on this one. Needs the koble-mcp server (tools ebms_companies, ebms_get, ebms_write, ebms_command).
---

# The EBMS API through koble-mcp

EBMS exposes an OData v4 API. The **koble-mcp** server owns the connection: the serial number,
the credentials, the token and its refresh, which companies may be touched, and a few hard
guards. Four tools are all you get, and all you need.

**You never build a URL, send a token, or run curl.** If the four tools are not available, say
the koble-mcp server is not connected and stop — do not reach for the network another way.

Read this page, then open `references/` for the entity you are actually touching. For anything
beyond a single read or a single field change, use the task skill for that document
(`ebms-sales-orders`, `ebms-purchase-orders`, `ebms-products`, `ebms-tasks`, `ebms-mrp`); it knows
the procedure and what to confirm.

## 1. The company

`ebms_companies` lists the datasets the server can reach: `id`, `name`, `version`, and `writable`.
It needs no arguments.

**Nothing marks a dataset as live or a test copy.** The name is a customer-chosen string, not a
guarantee. Name the company you are working in, by name, before the first write of a session, and
ask if there is any doubt. Every tool takes `company` (an ID or a unique name); `ebms_get` may
omit it only when exactly one company is available. `ebms_write` and `ebms_command` always need it.

`version` is worth noting when behaviour surprises you — several entries in
`references/odata-quirks.md` are build-specific.

## 2. Read — `ebms_get`

`path` is the entity only: `ARINV`, `ARINV('<AUTOID>')`, `EntityMetaData('ARINV')`, `$metadata`.
**Query options are separate fields, never part of the path**: `select`, `filter`, `expand`,
`orderby`, `top`, `skip`, `count`. Nothing needs percent-encoding; the server does that.

```
ebms_get  company: sbx
          path: INVENTRY
          filter: INACTIVE eq false and contains(tolower(DESCR_1),'shovel')
          select: ID,DESCR_1,COST,BASE
          top: 25
```

A collection returns `rows`, `returned`, `total`, `truncated`; one record returns `record`.
`truncated: true` means there are more rows than you asked for — page with `skip`, do not assume
you have seen everything.

**Always pass `select`, including inside `expand`** (`Details($select=AUTOID,INVEN,M_QUAN_VIS)`).
It is not a nicety. Requests are cut off at about two minutes, and an unselected read returns
every field, many computed on the fly (measured on SBX, EBMS 1.8.148):

| Read | No select | With select |
|---|---|---|
| One 150-line order with `expand: Details` | 43.4 s · 164 KB | 8.1 s · 16 KB |
| 50 sales orders | 17.6 s · 83 KB | 8.7 s · 4 KB |
| 200 products | 14.6 s · 159 KB | 1.2 s · 11 KB |

The server warns you when `select` is missing. Some virtual fields are omitted unless named
explicitly — they appear neither in a plain read nor under `select: *`.

Escape a single quote inside a string literal by doubling it: `contains(ID,'O''Brien')`.
Search case-insensitively with `contains(tolower(FIELD),'…')`, then rank exact and prefix
matches to the top yourself.

## 3. Write — `ebms_write`

| | |
|---|---|
| Create | `method: POST`, `path: ARINV` (the entity set, never keyed), body of the natural-key field plus what you are setting. Documents carry their lines nested as `Details`. |
| Change fields | `method: PATCH`, `path: ARINV('<AUTOID>')` — **quoted AUTOID**. |
| Edit lines | Only through the parent, in one `Details@delta` array: `{"@id": "<line AUTOID>", …}` changes a line, `{"@id": "<line AUTOID>", "@removed": true}` removes one, an entry with no `@id` adds one. All three can go in one PATCH. |
| Delete | `method: DELETE`, keyed path, no body. |

Bound actions never go through `ebms_write` — see `ebms_command` below.

Three things the server refuses outright, before anything is sent:

- **`PROCESS` anywhere in the body, at any depth.** Posting or unprocessing a document is done
  by a person in EBMS, not through this server. Do not look for a way around it.
- **A `POST` whose `EXTERNALID` already exists** on `ARINV`, `APINV`, `INMFG` or `TASK`. You get
  the existing record back. That is the guard working: read it and continue from it rather than
  creating a second one.
- **A malformed request** — a keyed POST, a body on a DELETE, a PATCH with no key.

### Mark what you create

Put an `EXTERNALID` on every document you create. It is settable on a POST and filterable, so it
is how you find out whether a create that timed out actually happened — and it is what makes the
duplicate guard work. Use something traceable and unique, e.g. `claude-2026-09-21-a1`.

### Reading the result

`ebms_write` reads the record back and compares it, field by field, with what you sent. That is
the answer to "a 2xx is not proof": EBMS silently ignores an unknown line `@id`, and silently
drops fields that are not writable in the record's current state.

- **`verification.ok: true`** — every field you sent is stored as sent. **Report EBMS's values
  from `verification.rows`, not the ones you sent.** Prices, totals and dates are computed
  server-side and are frequently not what you asked for.
- **`verification.ok: false`** — the write was accepted but something did not land. `mismatches`
  is sent-vs-stored per field; `problems` is a row that never appeared or was not removed. Show
  the user; do not resend an add.
- **`notes`** — rows EBMS added by itself (an assembly kit's default components, for example).
  Not a failure. To see them on a new row, ask for them: `readBack.children: "Materials"`.
- **`refused: true`** — nothing was sent. Nothing changed in EBMS.
- **`uncertain: true`** — a timeout, a dropped connection or a 5xx. The outcome is unknown.
  **Read the record back before doing anything else. Never resend** — a resent create or add
  duplicates. Read the `uncertain` field itself, not the wording.
- **`verification: null` with a `verificationError`** — the write returned the status shown; only
  the read-back failed. Read the record before acting, and do not resend.

`readBack.record` and `readBack.lines` add fields to the read-back (`"INVOICE,TOTAL_SO"`,
`"UNIT_MEAS,UNIT_VIS"`) when you want to report what EBMS computed.

The verifier compares scalar fields two levels deep (a document, its lines, and one level of
children). It does not compare grandchildren or fields sent as objects.

## 4. Commands — `ebms_command`

A bound action: `entity`, `key` (the AUTOID), `command`, and `body` only when the command has a
dialog. **A command with no dialog must be sent with no body at all** — `{}` comes back as
`422 The command does not have a dialog`. A dialog command takes the dialog's fields, and refers
to an existing record as `{"Guid": "…"}`, not `ID` or `@odata.bind`.

The server allows a short list of commands by name, nothing that posts, processes, pays or sends.
Anything else is refused. Commands return very little, so read the record back afterwards.

## 5. When something fails

The message is in the body, not the status line. The server surfaces it for you as `message`,
`detail` and `solution` — read it before guessing. A 422 usually means a field is missing or a
filter is unsupported; a 500 usually means this build does not support the query shape, not that
the server is broken.

## Reference files

- `references/odata-quirks.md` — verified server behaviour that breaks correct-looking requests:
  unsupported filters, paging, key addressing, fields EBMS accepts and drops, document size and
  the 2-minute limit. Read it before writing anything, and whenever a request fails.
- `references/entities.md` — hand-written cheat sheet: natural keys, the fields that matter, and
  field-level gotchas verified live.
- `references/entities/<ENTITY>.md` — generated from EBMS metadata, one per entity (index in
  `references/entities/README.md`): every standard field with type, EBMS label and
  required/read-only flags; related entities for `expand`; enumerations; bound actions; and
  whether each operation has been verified. Open only the entity you are touching. Standard
  fields only — look custom fields up live with `EntityMetaData('<ENTITY>')`. Where these and
  `odata-quirks.md` disagree, the quirks file wins.

## Habits worth keeping

- **Address records by quoted AUTOID.** Unquoted AUTOID is a 404 on every verb. A quoted natural
  key also works. A wrong key form comes back as 404, 400 or 422 alike, so a 404 usually means
  the key form, not a missing record.
- **Let the server do arithmetic.** Quantities, unit conversions and totals are where a
  plausible-looking number does real damage. Report what EBMS stored.
- **One write at a time, confirmed.** Show the user what a write will do, in their words, and
  wait. A yes to one write is not a yes to the next.
