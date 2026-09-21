# Change a purchase order

Read `../SKILL.md` first for the ground rules.

## Steps

1. **Read the purchase order with its lines**, using the read shape in `../SKILL.md`. Never read
   the lines on their own — a standalone `APINVDET` query reports every quantity and cost as 0.

2. **Check the status and what has arrived.** `STATUS` `'U'` is editable; `'O'` and `'X'` are
   processed and their lines are locked. On a `'U'` document, compare `SHIP_VIS` with
   `O_QUAN_VIS` line by line: **a line that has already been received is not a line to reprice or
   shrink without saying so.** Tell the user what has arrived before changing anything.

3. **Map each requested change to a line `AUTOID`.** If the same product is on more than one
   line, ask which.

4. **Build one PATCH for everything.** Header fields at the top level, line changes in
   `Details@delta`, always as **absolute values**:

   ```
   ebms_write  company: sbx
               method: PATCH
               path: APINV('<PO AUTOID>')
               body: {"FREIGHT": 42.50,
                      "Details@delta": [
                        {"@id": "<line AUTOID>", "O_QUAN_VIS": 48},
                        {"@id": "<line AUTOID>", "UNIT_VIS": 7.25},
                        {"@id": "<line AUTOID>", "@removed": true},
                        {"INVEN": "SADDLE", "O_QUAN_VIS": 2, "UNIT_MEAS": "EA"}
                      ]}
               readBack: {"record": "SUBTOTAL,TOTAL,TOTAL_PO,FREIGHT,TAX",
                          "lines": "O_QUAN_VIS,SHIP_VIS,UNIT_VIS,UNIT_MEAS,ETA_DATE"}
   ```

   - `@id` changes a line, `@id` with `"@removed": true` removes it, no `@id` adds one.
   - **Quantity (`O_QUAN_VIS`) and unit cost (`UNIT_VIS`) are the only safe fields on a line that
     has a product.** `COST` there rewrites the unit cost — a `COST` of 75 on a `10 @ 7.50` line
     made the unit cost 75.
   - A quantity is in that line's `UNIT_MEAS`. Changing the unit as well as the quantity changes
     what arrives; spell both out before sending.
   - Don't send `ETA_DATE` — EBMS owns it.

5. **Show before → after and get a clear go-ahead**, especially for a removal or anything on a
   line that is part-received.

6. **Read the verification.** `ok: true` means every change landed; report EBMS's values.
   `ok: false` lists mismatches and problems — an `@id` EBMS did not recognise is ignored
   silently, and this is what catches it. On `uncertain: true`, read the PO back before sending
   anything again: modifies and removals are safe to resend, adds are not.

## Things that behave differently from a sales order

- **`TOP_TOTAL` is silently dropped** on POST and PATCH alike. `TAX` and `FREIGHT` persist and
  `TOTAL` recomputes from them. `FREIGHT` on a PATCH specifically has not been tested — check the
  read-back rather than assuming.
- **A line's `COST` stays 0** when the line was written over OData, so the document's `SUBTOTAL`
  can understate until EBMS recomputes it. Do not "fix" that by writing `COST`.
- **`DESCR_H` truncates at 30 characters** without complaint.
- Changing the vendor on an existing PO is not possible here: there is no `ChangeVendor` command
  on the server's allow-list, and `ID` cannot be PATCHed on a saved document. Raise a new PO.

## Deleting a purchase order

`method: DELETE` on `APINV('<AUTOID>')` works the way it does elsewhere, and the server verifies
that the record is gone. It is irreversible, so do it only when the user asks outright and
confirms — and never on a document with anything received against it. Suggest EBMS when in doubt,
where they can see what they are removing.
