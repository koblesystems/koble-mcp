# Book hours against a task

Read `../SKILL.md` first for the ground rules.

**This is payroll data.** Hours booked here are what someone gets paid for and what a customer
gets billed for. Confirm the worker, the date, the hours and the work code back to the user
before every single entry, and never batch several past one yes.

Verified on SBX, 2026-09-23, with a ZTEST task: an entry was booked, then removed.

## What a time entry looks like

Time lives in `PYTMDET`, one row per worker per day per task. On SBX:

| Field | Example | What it is |
|---|---|---|
| `ID` | `RIVALE` | the **worker** (`PYEMP.ID`) |
| `TASK_ID` | `R5T8W2N6PB` | the task's `ID` — **empty on a plain timecard row** |
| `DATE` | `2026-05-13` | the day worked |
| `HOURS` | `3` | hours, decimal |
| `WORK_CODE` | `BIKE` | a `PYWORK.ID` — `ROAST`, `BIKE`, `BAKE`, `OFFICE` on SBX |

A row with no `TASK_ID` is ordinary timecard time, not task time. Do not create one.

## Before writing

1. **Resolve the worker** in `PYEMP` (excluding `($)` rows) and say their name back, not just
   their ID.
2. **Resolve the work code** in `PYWORK` (also excluding `($)` rows). Do not guess one: on
   clock-in EBMS rejects an empty work code outright with "Workcode must not be empty", so it is
   likely required here too.
3. **Check what is already booked** for that task, so the same afternoon is not entered twice:

   ```
   ebms_get  path: PYTMDET   filter: TASK_ID eq '<task ID>'
             select: AUTOID,ID,TASK_ID,DATE,HOURS,WORK_CODE
   ```

4. **Say it back and wait:** *"3 hours for Alex Rivera on 13 May, work code BIKE, against task
   R5T8W2N6PB — book it?"*

## Write it

Through the task, as a child collection:

```
ebms_write  company: sbx   method: PATCH   path: TASK('<task AUTOID>')
            body: {"PYTMDETs": [{"ID": "RIVALE", "DATE": "05/13/2026",
                                 "HOURS": 3, "WORK_CODE": "BIKE"}]}
            readBack: {"record": "ACT_TIME,HOURS,BILL_TIME,STATUS"}
```

Dates go in as `05/13/2026` or `2026-05-13`.

- **A plain `PYTMDETs` array adds rows**; it does not replace the ones already there. The new row
  comes back in `verification.rows` with its AUTOID.
- The task's `ACT_TIME` is read-only and rises by the hours booked. `HOURS` and `BILL_TIME` are
  the task's own figures and are not touched; `UPDATE_BT` asks EBMS to refresh billable time from
  actual time.

## Correcting a mistake

**A direct `DELETE` on a `PYTMDET` row is refused**: EBMS answers with its screen's confirmation
question as an error ("This timecard line is attached to a task and contributes to that task
time total. Are you sure…?"). Removing it **through the task** works:

```
ebms_write  company: sbx   method: PATCH   path: TASK('<task AUTOID>')
            body: {"PYTMDETs@delta": [{"@id": "<time entry AUTOID>", "@removed": true}]}
            readBack: {"record": "ACT_TIME"}
```

`ACT_TIME` drops back by the hours removed. This takes an entry off someone's timecard: confirm
the worker, date and hours with the user first, and prefer that the person it belongs to fixes
it in EBMS when there is any doubt. Changing the hours on an entry (`{"@id": …, "HOURS": 2}` in
the same delta) has not been tested.

## Not available

`ClockIn`, `ClockOut`, `EnterTime` and `NewPYTMDET` are EBMS commands and none of them is on the
server's allow-list, so live clock-in and clock-out cannot be driven from here at all. That is
deliberate — clocking someone in is not something to do on their behalf.
