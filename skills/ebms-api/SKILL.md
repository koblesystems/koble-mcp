---
name: ebms-api
description: Connect to and query the EBMS OData API (Koble Systems ERP) with token auth, OData filter/select syntax, write conventions, and the install-specific quirks that make naive requests fail. Use this whenever a task touches EBMS data or writes: products (INVENTRY), customers (ARCUST), sales orders (ARINV), purchase orders (APINV), vendors (APVENDOR), employees or tasks (PYEMP/TASK) or whenever someone mentions EBMS, Koble, koblesystems.dev, an ERP OData endpoint, or is debugging a 401/422/500 from one. Reach for this before hand-rolling curl or fetch against EBMS; the endpoint has enough non-obvious behavior that guessing wastes a lot of time.
---

# Accessing the EBMS API

EBMS exposes an OData v4 API. It is mostly standard OData, but a handful of behaviors
are specific to this server and are the usual reason a "correct-looking" request fails.
Read the connection and auth sections here, then consult `references/` for the entity
you're actually touching.

## 1. Connect

### Find the dataset

A serial number reaches one or more companies (datasets). List them first. This endpoint
needs no credentials:

```
GET https://{{serialNumber}}.koblesystems.dev/ebmscompanylist/myebms/companies
```

```json
[
  {
    "Id": "{{companyId}}",
    "Name": "{{Company Name}}",
    "Version": "1.8.148",
    "ApiVersion": "4"
  }
]
```

`Id` drops straight into the OData path below. Because this call is unauthenticated, it's
also the first diagnostic when something is wrong: if it responds, the serial is right and
the host is reachable, which separates a bad serial from a bad password.

`Version` is worth noting whenever you hit surprising behavior, since several quirks in
`references/odata-quirks.md` are build-specific.

**Nothing in the response marks which dataset is live.** Sandboxes are identified by naming
convention alone ("Sandbox...", "Test", "Copy of ...", or no marker at all), and that name is
a customer-chosen string, not a guarantee. Never infer write-safety from it. Ask which
company to work in, and name the one you're pointed at before the first write of a session.

### Build the base URL

```
https://{{serialNumber}}.koblesystems.dev/MyEbms/{{CompanyId}}/OData
```

Credentials belong in the environment, never in a file you commit or a skill:

```bash
export EBMS_BASE="https://{{serialNumber}}.koblesystems.dev/MyEbms/{{CompanyId}}/OData"
export EBMS_USER="..."
export EBMS_PASS="..."
```

## 2. Authenticate

Exchange username and password for a bearer token. Some Koble clients send an
`Application` field with this request; it is not required here.

```bash
curl -s -X POST "$EBMS_BASE/Token" \
  -H 'Content-Type: application/json' \
  -d "{\"Username\":\"$EBMS_USER\",\"Password\":\"$EBMS_PASS\"}"
# -> { "AccessToken": "...", "RefreshToken": "..." }
```

Then send `Authorization: Bearer <AccessToken>` on every request. Tokens last roughly ten
minutes, so long-running work should refresh proactively (~9 min) rather than wait for a
401, and should retry once on a 401 after refreshing:

```bash
curl -s -X POST "$EBMS_BASE/RefreshToken" \
  -H 'Content-Type: application/json' \
  -d "{\"RefreshToken\":\"$REFRESH\"}"
```

`scripts/ebms.sh` wraps all of this. Use it for exploration instead of rebuilding the token
dance each time.

Basic auth (`Authorization: Basic user:pass`) also works and is what the official docs
document, but the token flow is what the shipped clients use and is what's tested here.

## 3. Read

Standard OData query options apply. `contains()` and `tolower()` are both supported, which
is how case-insensitive search is done:

```
/INVENTRY?$filter=INACTIVE eq false and contains(tolower(DESCR_1),'shovel')&$select=ID,DESCR_1,COST,BASE&$top=25
```

Always `$select` the fields you need — including inside an expand, as
`$expand=Details($select=AUTOID,INVEN,M_QUAN_VIS)`. It is not a nicety. Requests are cut off at
about **2 minutes**, and an unselected read returns every field, many computed on the fly
(measured on SBX, EBMS 1.8.148):

| Read | No `$select` | With `$select` |
|---|---|---|
| One 150-line order with `$expand=Details` | 43.4 s · 164 KB | 8.1 s · 16 KB |
| 50 sales orders | 17.6 s · 83 KB | 8.7 s · 4 KB |
| 200 products | 14.6 s · 159 KB | 1.2 s · 11 KB |

Some virtual fields are omitted unless explicitly selected: they don't appear in an unselected
GET, or in `$select=*`.

Writes to documents are slow too, and get slower as the document grows, because EBMS re-saves
the whole document on every write. Large documents have to be written in chunks; see
**Document size and the 2-minute limit** in `references/odata-quirks.md`.

Percent-encode the filter. Escape single quotes in string literals by doubling them (`O''Brien`).

## 4. Write

- **Create**: `POST /<ENTITY>` with a JSON body of the natural-key field plus whatever
  else you're setting. Documents take their line items nested as `Details`.
- **Update fields**: `PATCH /<ENTITY>('<AUTOID>')` with the fields. Quote the AUTOID.
- **Edit lines**: only through the parent document, with one `Details@delta` array:
  `{"@id": "<line AUTOID>", ...}` modifies a line, `{"@id": "<line AUTOID>", "@removed": true}`
  removes one, and an entry with no `@id` adds one.

Key addressing is the sharp edge: see `references/odata-quirks.md` before writing a PATCH.

Two habits worth keeping:

- **Send `PROCESS` only on an explicit, confirmed request.** `PROCESS: "Process"` posts a
  document — a sales order becomes an invoice and its lines lock. Creating or editing an
  order or a PO leaves it unprocessed (`STATUS 'U'`). Process only when the user has asked
  for it and confirmed after seeing what will be posted; `PROCESS: "Unprocess"` reverses it.
  The `ebms-sales-orders` skill walks through this.
- **A 2xx is not proof the write applied.** EBMS will accept a PATCH and silently ignore
  fields that aren't writable in the record's current state, and can return 200 with an
  error in the body. For anything that matters, read the record back and compare.

## 5. Read errors properly

Errors arrive in the body, not just the status line:

```json
{ "Messages": [{ "TextBriefDescription": "Workcode must not be empty" }] }
```

Pull `Messages[].TextBriefDescription`, falling back to `BriefDescription`. The HTTP status
alone rarely tells you what's wrong. A 422 usually means a field is missing or a filter
expression isn't supported; a 500 usually means the query shape isn't supported by this
OData build, not that the server is broken.

## Reference files

- `references/odata-quirks.md`: verified server behaviors that break naive requests
  (unsupported filters, paging, key addressing). Read this when a request fails, or before
  writing anything.
- `references/entities.md`: hand-written cheat sheet for the entities in common use —
  natural keys, the fields that matter, and field-level gotchas verified live.
- `references/entities/<ENTITY>.md`: generated from the EBMS metadata, one per entity
  (index in `references/entities/README.md`). Every standard field with its type, EBMS
  label and required/read-only flags; related entities for `$expand`; enumerations; bound
  actions; and whether each operation has been verified. Open only the entity you're
  touching. These cover standard fields only — look custom fields up live with
  `EntityMetaData`. Where they and `odata-quirks.md` disagree, the quirks file wins.

## Patterns worth reusing

Working EBMS clients converge on the same few shapes. Reach for these rather than
rediscovering them:

- **Refresh proactively, retry once.** Wrap every call so it refreshes a token older than
  about nine minutes, and so a 401 triggers one refresh and one retry before failing.
- **Address records by quoted AUTOID.** `/<ENTITY>('<AUTOID>')` works for GET, PATCH and
  DELETE; **unquoted** AUTOID returns 404 for all three. The quoted natural key also works.
  A wrong key form fails as 404, 400 or 422 alike, so a 404 is usually the key form, not a
  missing record.
- **Read back after a write that matters.** Compare what you sent against what the record
  now holds, since a 2xx does not mean the fields applied.
- **Search case-insensitively, rank locally.** Use `contains(tolower(FIELD),'…')` across a
  few fields, then sort exact and prefix matches to the top client-side.
