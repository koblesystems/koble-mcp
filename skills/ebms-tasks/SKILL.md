---
name: ebms-tasks
description: Create and manage EBMS / Koble tasks and work orders (TASK) — raising a task for a customer or a job, assigning it to a worker, setting its type, priority, due date and note, moving it through its pipeline phase, linking it to a sales order or an order line, recording hours against it, and marking it complete. Use whenever someone wants a task, work order, ticket or job card made, assigned, scheduled, updated, moved to another phase or closed, wants to know what is open or who is working on what, or wants time booked against a task — "make a task for Mike to fix the Smith bike by Friday", "what's open for the bike shop", "log 3 hours on that ticket", "move it to waiting on parts". Builds on the ebms-api skill. Needs the koble-mcp server (tools ebms_get, ebms_write and ebms_command).
---

# EBMS tasks and work orders

Workflows for `TASK` and the records around it. Everything runs through the koble-mcp tools
`ebms_get`, `ebms_write` and `ebms_command`; how to call them, and how to read a write's verification, is in the
**ebms-api** skill — load it first. `references/entities/TASK.md` there lists every field.

If those tools are not available, say the koble-mcp server is not connected and stop.

**This is a write workflow. The rules are short and not optional:**

1. **Nothing is created or changed without a yes for that specific write**, and one at a time.
2. **Report what EBMS stored**, from the write's `verification.rows`. `STATUS` in particular is
   derived by EBMS, not set by you.
3. **Stop at the first problem** rather than carrying on down a list.
4. **Time entries are payroll data.** Confirm worker, date, hours and work code back to the user
   before every single one.

## Which workflow

| The user wants to… | Open |
|---|---|
| Raise a task, change one, assign it, or close it | `references/build.md` |
| Attach a task to a sales order or an order line | `references/link.md` |
| Move a task through its pipeline | `references/phase.md` |
| Book hours against a task | `references/time.md` |
| Reschedule many tasks at once so no worker overlaps | the **ebms-task-reflow** skill |

## The shape of a task

- **`ID` is a 10-character key EBMS assigns on create** (`H3J6K9L2MC`). Never send one.
- **`TASK` also holds templates.** Rows whose `ID` starts with `($)` — `($)SALES`, `($)WORKCON` —
  are task templates, one per type, not real tasks. **Exclude them from every search** with
  `not startswith(ID,'($)')`. SBX has 1,742 rows and 1,726 real tasks.
- **`STATUS` is read-only and derived.** `TASTATUS` rows carry a logic expression that decides it
  from the task's own fields, so you set `COMPLETED` or `APPROVED_C` and EBMS works out whether
  the task reads `Open`, `Pending`, `Waiting for Parts`, `Completed`, `Approved`, `Billed` or
  `Closed`. Never try to write `STATUS`.
- **`ASSIGN_EMP` is read-only too** — a pipe-wrapped summary (`|RIVALE|`) of the task's assigned
  workers. Setting `EMP_ID` fills it in; nothing else is needed to assign one worker.
- `DOCUMENT` is the linked document's number, with `DOC_AID`, `DOC_STAMP` and `DOC_TYPE`
  read-only beside it. See `references/link.md`.

## The lookup tables

A task's type, priority and manager must match a configured row. Read them before creating
anything, and offer the user what exists rather than inventing a value.

```
ebms_get  path: TATYPES    select: AUTOID,TYPE,DEF_ID        # e.g. Roasting, Sales, Bike_Repair
ebms_get  path: TAPRIOR    select: AUTOID,PRIORITY,SORT      # Low, Normal, High, Pending
ebms_get  path: TASTATUS   select: AUTOID,STATUS,SORT        # derived — read only, never written
ebms_get  path: TAMANAGE   select: AUTOID,MANAGER,ACTIVE     # configured task managers
ebms_get  path: PYEMP      filter: not startswith(ID,'($)') and INACTIVE eq false
                           select: AUTOID,ID,F_NAME,L_NAME   # workers
ebms_get  path: PYWORK     filter: not startswith(ID,'($)')
                           select: AUTOID,ID,DESCR           # work codes, for time entries
```

`PYEMP` and `PYWORK` carry `($)` folder rows as well — exclude them the same way.

## Finding tasks

```
# Open tasks, newest first is not available — TASK will not $orderby AUTOID
ebms_get  path: TASK
          filter: not startswith(ID,'($)') and COMPLETED eq false
          select: AUTOID,ID,DESCR,TYPE,STATUS,PRIORITY,EMP_ID,CUST_ID,DOCUMENT,DUE_BY
          top: 50

# One worker's open tasks
filter: not startswith(ID,'($)') and COMPLETED eq false and EMP_ID eq 'RIVALE'

# A customer's tasks
filter: not startswith(ID,'($)') and CUST_ID eq 'KIMSAM'
```

Three read quirks to plan around:

- **`$orderby` on `AUTOID` is a 422.** On `TASK`, `DUE_BY` and `DUE_TIME` are orderable; sort
  anything else yourself after reading.
- **A bare-date comparison is a 422** (`DUE_BY eq 2026-07-21`), because these are
  DateTimeOffset fields and the literal format this build accepts is unconfirmed. Filter on
  something else and compare dates yourself.
- **A collection filter across the child workers 500s** — `TAEMPs/any(...)` fails on this build.
  Read `TAEMP` separately if you need to search by assigned worker beyond `EMP_ID`.

## Verified, and what is not

Verified end to end on SBX (EBMS 1.8.148, 2026-09-23) with a ZTEST task that was deleted
afterwards: creating a task (EBMS assigns `ID`, derives `STATUS` and `ASSIGN_EMP`); changing it;
`DUE_BY` as either `09/25/2026` or `2026-09-25`; a valid `PIPE_PHASE` (EBMS derives
`PHASE_AID`); linking to a sales order with `LinkInvoice`; booking time through `PYTMDETs`;
removing that time again; completing the task; and deleting it.

Still unknown: multiple workers through `TAEMPs`; whether a time entry can be saved without a
`WORK_CODE`; linking to a specific order **line** (`SalesDetailTimestamp`); and what `STATUS`
a completed task reads for a user who is not a task manager.

Of the task commands, only `LinkInvoice` is on the server's allow-list. `ClockIn`, `ClockOut`,
`EnterTime`, `NewPYTMDET`, `UploadFile`, `Email`, `Text` and `Call` are refused.
