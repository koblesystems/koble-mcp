# Change a sales order

Read `../SKILL.md` first for the ground rules and the performance limits.

## Steps

1. **Read the order** with `ebms_get`. If `STATUS` is `'O'` it has been processed: its lines are
   locked and edits return 403. Tell the user — unprocessing is done in EBMS, not here
   (`PROCESS` is refused by the server). See `fulfil.md`.

2. **Map each requested change to a line `AUTOID`.** If the same product appears on more than
   one line, ask which.

3. **Build one PATCH for everything.** Header fields go at the top level; line changes go in
   `Details@delta`, always as **absolute values**, never increments:
   ```
   ebms_write  company: sbx
               method: PATCH
               path: ARINV('<order AUTOID>')
               body: {"PO_NO": "PO-5521-R1",
                      "Details@delta": [
                        {"@id": "<line AUTOID>", "M_QUAN_VIS": 30},
                        {"@id": "<line AUTOID>", "UNIT_VIS": 1.10},
                        {"@id": "<line AUTOID>", "@removed": true},
                        {"INVEN": "STRAW-100", "M_QUAN_VIS": 2}
                      ]}
               readBack: {"lines": "UNIT_MEAS,UNIT_VIS,SO_AMOUNT"}
   ```
   - `@id` modifies a line.
   - `@id` plus `"@removed": true` removes it.
   - An entry with no `@id` adds a line.

   If a client can't send `@`-prefixed keys, `#id` / `#removed` are the documented alternatives
   (untested).

4. **Show before → after, and get a clear go-ahead for any removal.**

5. **Send it and read the verification.** `verification.ok: true` means every change landed;
   report EBMS's stored values from `verification.rows`. `ok: false` means the write was
   accepted but something did not: `mismatches` is field by field, `problems` names a line that
   never appeared or was not removed — an `@id` EBMS did not recognise is ignored silently, and
   this is what catches it. Before retrying anything, read the order again: re-sending a modify
   or a removal is harmless, but re-sending an add creates a second copy of the line.

## Related changes that need a different approach

- **Materials on an assembly line** are edited with a nested `Materials@delta` inside the parent
  line's entry. See `materials.md`.
- **Setting a price on a line that has materials** rescales every material under it. Warn first.
- **Changing the order's customer** can't be done by PATCHing `ID` (EBMS refuses). Use
  `ebms_command` with `ChangeCustomer`; see `commands.md`.
- **Resetting prices** with `RecalculateAllPrices` discards manual prices. See `commands.md`.

## Paired fields

Terms and discounts are pairs: an ID and a display value, with **the ID first in the body**:
`{"IDDISCOUNT": "1DSCOUNT", "DISCOUN": "5 % paid in 10 days"}`. For "(None)", send only the ID:
`{"IDDISCOUNT": "DNONE"}`.

## Large orders

- **Every PATCH re-saves the whole order.** Changing one line on a 150-line order took 25
  seconds. Put all the user's changes into as few PATCHes as possible rather than one per line.
- **Keep each PATCH to 50 delta entries or fewer.** For bigger edits, split the delta and send
  the pieces in turn, watching each one's time. If one passes about 60 seconds, halve the next.
- Group removals with the other changes rather than removing lines one at a time.
- On an `uncertain: true` result, read the order back before sending anything again. Modifies
  and removals are safe to resend; adds are not.
