# Attach a task to a sales order

Read `../SKILL.md` first for the ground rules.

**Unverified.** Neither route below has been tested on this install, and the command route is
blocked today. Say so before trying either.

## What a linked task looks like

On SBX, tasks that carry work for a sales order read like this:

| Field | Example | Writable? |
|---|---|---|
| `DOCUMENT` | `1006` — the invoice number | yes (15 chars) |
| `DOC_AID` | the `ARINV` AUTOID | **read-only** |
| `DOC_STAMP` | the order **line's** `TIMESTAMP`, or empty for the whole order | **read-only** |
| `DOC_TYPE` | `S` for a sales document, `M` for a manufacturing batch | **read-only** |
| `CUST_ID` | the order's customer | yes |
| `ITEM` | the service product the line bills as | yes |

So the link is really `DOC_AID` plus an optional `DOC_STAMP`, and both are read-only — which is
why EBMS provides a command for this.

## Route 1: the `LinkInvoice` command (blocked today)

EBMS's own way:

```
entity: TASK   key: <task AUTOID>   command: LinkInvoice
body:   {"SalesInvoiceAutoID": "<ARINV AUTOID>",
         "SalesDetailTimestamp": "<order line TIMESTAMP>"}
```

`SalesDetailTimestamp` is optional, and the line it names must already carry the service code the
task bills as.

**`LinkInvoice` is not on the server's command allow-list, so `ebms_command` refuses it.** Adding
it is a deliberate change to the server, not something to work around. Tell the user the link has
to be made in EBMS for now.

## Route 2: writing `DOCUMENT` (untested)

`DOCUMENT` is writable, so a PATCH may be enough for a whole-order link:

```
ebms_write  company: sbx   method: PATCH   path: TASK('<task AUTOID>')
            body: {"DOCUMENT": "1193", "CUST_ID": "SMIJOH"}
            readBack: {"record": "DOCUMENT,DOC_AID,DOC_STAMP,DOC_TYPE,CUST_ID"}
```

The question the read-back answers: **does EBMS derive `DOC_AID` and `DOC_TYPE` from the number,
or does it store a number that points nowhere?** If `DOC_AID` comes back empty, the link did not
really happen — say so plainly and stop, rather than reporting a success.

Linking to a specific **line** cannot be done this way at all: `DOC_STAMP` is read-only.

## Going the other way

To find the tasks on an order, filter on the invoice number:

```
ebms_get  path: TASK
          filter: not startswith(ID,'($)') and DOCUMENT eq '1193'
          select: AUTOID,ID,DESCR,TYPE,STATUS,EMP_ID,DOC_STAMP,HOURS
```

`DOC_TYPE` `M` means the task hangs off a manufacturing batch rather than a sales order.
