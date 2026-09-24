---
name: ebms-task-reflow
description: Reflow (reschedule, re-order, re-balance) EBMS / Koble tasks and work orders so no worker has overlapping tasks and everything fits inside working hours, lunch and changeover time — asking the user for the scheduling criteria first, showing the plan, writing it one task at a time, and keeping an undo snapshot. Use whenever someone asks to reschedule, re-order, reflow, re-plan, de-conflict, level or clean up the task schedule or calendar for a week or date range, fix double-booked or overlapping workers, push unfinished or past-due tasks into next week, fit tasks into 9-to-5 with a lunch break, or undo/reset a reschedule for a demo — even if they don't say "reflow". Builds on the ebms-tasks and ebms-api skills. Needs the koble-mcp server (ebms_get, ebms_write).
---

# EBMS task reflow

Move a set of open tasks so that each worker's day has no overlaps and fits the user's
working rules. The flow is always: **ask criteria → read → plan → show → write → verify**,
with an undo snapshot taken before the first write.

Load the **ebms-api** and **ebms-tasks** skills first for how to call the tools and the
shape of `TASK`. The write quirks that matter here are in `references/ebms-task-writes.md` —
read it before the first write; they are not obvious and they silently corrupt end times.

## 1. Ask for the criteria

Scheduling rules are the user's call, not yours. Before reading anything, collect the
criteria below. **Skip any the user already gave** in their request, and never ask more than
three at once. If `ask_user_input_v0` (tappable options) is available, use it; otherwise ask in
one short message with the defaults shown so the user can just say "defaults".

Round 1 — scope:

| Question | Options (default first) |
|---|---|
| Which dates? | This week Mon–Fri · Next week · A date range I'll give |
| Which workers? | Everyone with tasks in range · Only specific workers |
| Tasks on days that have already passed (or today)? | Move them to the same weekday next week · Squeeze them into the remaining days · Leave them where they are |

Round 2 — working rules:

| Question | Options (default first) |
|---|---|
| Working hours? | 9:00–5:00 · 8:00–4:00 · Custom |
| Lunch break? | 12:00–1:00 · 12:30–1:30 · No fixed lunch |
| Changeover between tasks? | 15 min · None · 10 min · 30 min |

Round 3 — ordering and availability:

| Question | Options (default first) |
|---|---|
| Order within a day? | Keep the current order · By priority · By due date |
| Time off / PTO? | Ignore it · Respect what you know of · I'll list who's out |
| After the plan? | Show me the plan first · Write it straight away |

Notes on the criteria:
- **Time off.** If you know of a worker's time off from context (memory, calendar, the
  conversation) and it overlaps the target dates, name it in one line and ask — unless the
  user already said to ignore it. Don't assume a worker ID is the user.
- **"Write it straight away"** is a yes for the whole plan as computed, but still stop at
  the first real problem.
- If the user says "same as last time", reuse the criteria from earlier in the conversation
  and say which ones you're using.

## 2. Read the tasks

```
ebms_get  path: TASK
          filter: not startswith(ID,'($)') and COMPLETED eq false
                  and START_DATE ge <first day>T00:00:00Z and START_DATE le <last day + 1>T00:00:00Z
          select: AUTOID,ID,EMP_ID,ASSIGN_EMP,DESCR,TYPE,PRIORITY,DUE_BY,
                  START_DATE,START_TIME,END_DATE,END_TIME,HOURS
          top: 1000
```

- A full ISO timestamp works in the date filter (a bare date is a 422).
- Also read the **destination** range the same way (e.g. next week) so the plan includes
  tasks already booked there — otherwise you'll stack new tasks on top of them.
- Check `truncated`; page with `skip` if needed.
- Flag tasks whose `ASSIGN_EMP` lists more than one worker — the plan treats `EMP_ID` as the
  only worker, and multi-worker writes are unverified.
- **Save the rows to a snapshot file** (`snapshot.json`) before planning. That snapshot is the
  undo.

## 3. Plan

Run the planner rather than packing by hand — hand-packing drifts and misses the lunch edge:

```bash
python3 scripts/reflow.py input.json --out plan.json      # on Windows: python
```

The script is in this skill's `scripts/` folder. If this app has no copy of the skill's files,
fetch it with `ebms_guide` (file `ebms-task-reflow/scripts/reflow.py`) and save it first. It uses
the `pulp` package when it is installed, to fit everything with the fewest moves, and a simpler
greedy pass when it isn't; the output says which (`method`). Installing `pulp` changes the user's
Python, so ask before running `pip install pulp`. If you cannot run Python here at all, say so:
don't pack the week by hand.

`input.json` takes the criteria as `config` and the snapshot rows as `tasks` — the format is
in the script's header. Map the criteria like this:
- days → `days` (working days, in order, including the destination days)
- past-day handling → `day_map` (e.g. `"2026-09-21": "2026-09-28"` for "same weekday next week";
  map nothing for "leave them")
- hours / lunch / changeover → `day_start`, `day_end`, `lunch_start`, `lunch_end`, `changeover_min`
- order → `order` (`original` | `priority` | `due`); for priority, pass each task's `TAPRIOR.SORT`
  as `priority_sort`
- duration: use the slot (`end − start`) by default. If `HOURS` and the slot disagree, say so and
  ask which is right before planning — it changes whether the week fits.

The planner never splits a task across lunch or days, keeps each task near its target day and
its own time where it fits, and reports anything it could not place. Tasks with no start/end
time are moved by date only. Tasks already booked in the destination are passed in as ordinary
tasks, so they are re-planned together with the incoming ones and may move within their own day;
point that out in the plan. The planner has no way to lock a task in place.

## 4. Show the plan

Show one table per worker, grouped by day: new time, task ID, description, and the old slot for
every task that moved. Then list, briefly:
- anything **unplaced** (doesn't fit) and what the options are (next week, extend hours, reassign)
- tasks flagged `needs_end_write` (their `HOURS` doesn't match the slot — see below)
- tasks sized by a questionable duration, time off you noticed, multi-worker tasks

Unless the user chose "write it straight away", end with one question asking to apply it.

## 5. Write

One task at a time, in plan order, reporting what EBMS stored (`verification.rows`):

1. `PATCH TASK('<AUTOID>')` with `START_DATE` and `START_TIME` only (`HH:MM:SS`), and
   `readBack: {"record": "END_DATE,END_TIME,HOURS"}`.
2. EBMS sets **END = START + HOURS**. If the plan row has `needs_end_write`, or the stored end
   isn't the planned end, send a second PATCH with `END_TIME` (and `END_DATE` if needed).
3. Date-only tasks: PATCH `START_DATE` only and check `END_DATE` followed.

The verifier reads `09:00:00` and `PT9H` as the same time, so a mismatch on a time is real.
**Stop at the first real problem**, say what happened, fix it or ask.

## 6. Verify and report

Read the whole range back once and check, per worker and day: no overlaps, gaps ≥ the
changeover, nothing crossing lunch, everything inside working hours, nothing left behind on
days that were meant to be cleared. Report a short per-day summary per worker plus any
corrections made along the way — not every write.

## Undo / reset for a demo

When asked to undo, restore from the snapshot: same write rules (start-only write, then end if
`HOURS` ≠ original slot — the reflow may have changed `HOURS`). Verify against the snapshot, not
against memory. Tell the user that `HOURS` on some tasks may now differ from before if an end
write changed it.
