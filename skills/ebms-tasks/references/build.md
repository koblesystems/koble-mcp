# Raise, change and close a task

Read `../SKILL.md` first for the ground rules and the lookup tables.

Verified on SBX, 2026-09-23, with a ZTEST task created, changed, completed and deleted.

## Raise a task

1. **Read the lookup tables** (`TATYPES`, `TAPRIOR`, `TAMANAGE`, `PYEMP`) and offer what exists.
   A type is the one field most likely to be wrong if you guess.

2. **Gather what the user actually said.** Only `DESCR` and `TYPE` are really needed; everything
   else is optional and should be left out rather than invented.

   | Field | What it is |
   |---|---|
   | `DESCR` | The task, in words (max 200 characters) |
   | `TYPE` | A `TATYPES.TYPE` value |
   | `CUST_ID` | The customer, when the work is for one |
   | `EMP_ID` | The assigned worker, a `PYEMP.ID` |
   | `MANAGER` | A `TAMANAGE.MANAGER` value |
   | `PRIORITY` | A `TAPRIOR.PRIORITY` value |
   | `DUE_BY` / `DUE_TIME` | When it is due |
   | `START_DATE`, `END_DATE` | Scheduling |
   | `ESTIMATED` | Estimated hours |
   | `ITEM` | The service product the work bills as |
   | `NOTE` | A free-text note; `\r\n` for line breaks |
   | `IN_HOUSE` | `InHouse` or `OnSite` |
   | `EXTERNALID` | Yours, to make the create safe to retry |

   Do **not** send `ID`, `STATUS`, `ASSIGN_EMP`, `CREATE_D`, `DOC_AID`, `DOC_STAMP`, `DOC_TYPE`
   or `PHASE_AID` — all read-only or derived.

3. **Give it an `EXTERNALID`** unique to the request. `TASK` is covered by the server's duplicate
   guard, so a repeat create with the same one is refused rather than making a second task.

4. **Show the user the task as you will send it, and ask.**

5. **Create it:**

   ```
   ebms_write  company: sbx
               method: POST
               path: TASK
               body: {"TYPE": "Bike_Repair", "DESCR": "Tube change and new chain",
                      "CUST_ID": "RIVALE", "EMP_ID": "RIVALE", "PRIORITY": "Normal",
                      "DUE_BY": "09/25/2026", "NOTE": "Customer will collect Friday",
                      "EXTERNALID": "claude-2026-09-21-t1"}
               readBack: {"record": "ID,STATUS,CREATE_D,ASSIGN_EMP,PIPE_PHASE"}
   ```

   Both `09/25/2026` and `2026-09-25` are accepted; EBMS stores midnight of that day.

6. **Report what came back**: the `ID` EBMS assigned, the `STATUS` it derived, and anything in
   `mismatches` — a field EBMS quietly dropped will show up there rather than as an error.

## Change a task

```
ebms_write  company: sbx   method: PATCH   path: TASK('<AUTOID>')
            body: {"EMP_ID": "LEEJAN", "PRIORITY": "High", "DUE_BY": "09/26/2026"}
            readBack: {"record": "STATUS,ASSIGN_EMP"}
```

Address the task by quoted AUTOID, or by its quoted `ID` (`TASK('K7Q2M9X4LA')`). Reassigning is
just `EMP_ID`: EBMS rebuilds `ASSIGN_EMP` from it. Several workers on one task would go through
the `TAEMPs` child rows, which have not been tested.

## Close a task

`COMPLETED` is the writable flag; `STATUS`, `COMP_D` and `COMP_U` are EBMS's.

```
ebms_write  company: sbx   method: PATCH   path: TASK('<AUTOID>')
            body: {"COMPLETED": true}
            readBack: {"record": "STATUS,COMPLETED,COMP_D,COMP_U"}
```

EBMS stamps `COMP_D` and `COMP_U` itself. **It may approve the task in the same step**: on SBX,
completing the test task also set `APPROVED_C` and `STATUS` came back `Approved`, not
`Completed` — most likely because the signed-in user is a task manager. Older tasks read
`Closed`. The `TASTATUS` logic expressions decide, so **report the status EBMS derived** rather
than the one you expected, and mention it when the task was approved as well as completed.

Reopening is `{"COMPLETED": false}` — not tested.

## Deleting a task

`method: DELETE` works, and the server verifies the record is gone — but **EBMS refuses to
delete a task that has time entered** ("You cannot delete a task that has time entered"). Prefer
completing a task. Delete only if the user asks outright and confirms; if it has time, the time
has to be removed first (`time.md`), which changes someone's timecard, so say that plainly.
