# Attach a task to a sales order

Read `../SKILL.md` first for the ground rules.

Verified on SBX, 2026-09-23: `LinkInvoice` makes a real link; writing `DOCUMENT` does not.

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

## Link it with `LinkInvoice`

```
ebms_command  company: sbx   entity: TASK   key: <task AUTOID>
              command: LinkInvoice
              body: {"SalesInvoiceAutoID": "<ARINV AUTOID>"}
```

Add `"SalesDetailTimestamp": "<order line TIMESTAMP>"` to tie the task to one line; the line it
names must already carry the service code the task bills as. That variant has not been tested.

The command answers with its dialog and nothing else, so **read the task back** and check that
`DOC_AID` is now the order's AUTOID and `DOCUMENT` its invoice number. EBMS also fills in
`DOC_TYPE` `S`.

## Do not write `DOCUMENT` to link

`DOCUMENT` is writable, and a PATCH setting it returns 200 with `DOCUMENT` stored and `DOC_TYPE`
set to `S` — but **`DOC_AID` stays empty**. It is a half-link: the number shows on the task, and
nothing actually points at the order. If you find a task in that state, `LinkInvoice` repairs
it.

## Going the other way

To find the tasks on an order, filter on the invoice number:

```
ebms_get  path: TASK
          filter: not startswith(ID,'($)') and DOCUMENT eq '1193'
          select: AUTOID,ID,DESCR,TYPE,STATUS,EMP_ID,DOC_STAMP,HOURS
```

`DOC_TYPE` `M` means the task hangs off a manufacturing batch rather than a sales order.
