# Writing task times in EBMS — what actually happens

Observed on SBX, EBMS 1.8.178, 2026-09-24, by moving 31 tasks, restoring
them, and moving them again.

## Time format

- `START_TIME` / `END_TIME` **read** as ISO durations: `PT9H`, `PT13H30M`, `null` when unset.
- They must be **written** as `HH:MM:SS`: `"09:00:00"`. Sending `"PT9H"` is a 500
  ("not recognized as a valid TimeSpan") and changes nothing.
- `START_DATE` / `END_DATE` accept `"2026-09-28"` and read back as `2026-09-28T00:00:00Z`.
- The write verifier treats `09:00:00` and `PT9H` as the same time, so a time it reports as a
  mismatch really is one.

## The end time follows the start — using HOURS

When `START_TIME` or `START_DATE` changes, EBMS recomputes the end as **start + `HOURS`**.

- If `HOURS` equals the task's slot length, a start-only PATCH moves the task cleanly.
- If `HOURS` is 0 or different, the end lands in the wrong place. Seen: a 10:00–11:00 task with
  `HOURS` 0 moved to 10:00 and saved as 10:00–10:00.
- Sending `START_TIME` and `END_TIME` in the **same** PATCH is not safe: the end is applied first
  and then shifted when the start moves. Seen: sending start 08:00 and end 09:30 to a task at
  9:00–10:30 stored 8:00–8:30.
- Writing `END_TIME` on its own leaves the start alone and **updates `HOURS`** to match the new
  slot (0 → 1 in the example above). Mention that side effect to the user.

So: write the start first, read back the end, and write the end separately only when it's wrong.

## Reading

- A date filter works with a full timestamp: `START_DATE ge 2026-09-21T00:00:00Z`.
  A bare date (`2026-09-21`) is a 422.
- `TASK` will not `$orderby` `AUTOID`; sort after reading.
- Exclude template rows with `not startswith(ID,'($)')`.
- Results over `top` come back with `truncated: true`; page with `skip`.

## Not verified

- Tasks with several workers (`TAEMPs`) — the reflow uses `EMP_ID` only.
- Whether EBMS enforces anything about overlaps itself (it didn't object to any here).
- Tasks that span more than one day (`END_DATE` after `START_DATE`).
