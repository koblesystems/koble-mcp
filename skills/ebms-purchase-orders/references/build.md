# Raise a purchase order

Read `../SKILL.md` first for the ground rules.

## Steps

1. **Resolve the vendor and every product** to exact IDs — see `find.md`. Ask when a search is
   ambiguous.

2. **For each product, read the vendor's record** (`INVENDOR` filtered by the product `ID`):
   - Use the row for **this vendor**. Its `UNIT_MEAS` is the purchase unit and its `COST` is the
     cost.
   - **No row for this vendor?** Say so. The line goes out in the product's stock unit
     (`INVENTRY.EACH_UNIT`) and EBMS supplies the cost. Read the quantity back to the user in
     that unit and let them confirm it is what they meant — a quantity that was right in cases is
     wrong in each.
   - **`COST` of 0** means nobody has recorded one. Leave `UNIT_VIS` out and let EBMS fill it in
     rather than inventing a number. Say that is what you are doing.

3. **Ask the user for the quantity in the purchase unit**, and repeat it back that way: "3 bags"
   not "3". Never convert a unit yourself.

4. **Assemble the lines.**
   - Product line: `{"INVEN": "<ID>", "O_QUAN_VIS": <qty>, "UNIT_MEAS": "<unit>", "UNIT_VIS": <unit cost>}`.
     Include `UNIT_VIS` only when you have a real cost. `PART_NO` (the vendor's own number, max 24
     characters) is worth sending when you have it — it is what matches the vendor's invoice back
     to this line later.
   - Charge line for a fee — a **description-only** line, no product:
     `{"DESCR": "Handling fee", "COST": 42.50, "ACCOUNT": "<G/L account>"}`. On a line with no
     product, `COST` **is** the amount; EBMS mirrors it into `UNIT_VIS` and marks the line received
     straight away, so it counts in `SUBTOTAL` at once. Don't send `UNIT_VIS` or `O_QUAN_VIS` on it
     — a `UNIT_VIS` of 0 is overwritten and shows up as a mismatch. Ask the user for the G/L
     account, or use the vendor's `GL_CODE` and say that is where it came from — without an
     account EBMS aborts the whole document with a 422.
   - **Freight is usually better on the header** as `FREIGHT`, which persists on a create and a
     PATCH alike and lands in `TOTAL` and `TOTAL_PO`.
   - **Never send `COST` on a line that has a product.** On a `10 @ 7.50` line, a `COST` of 75
     rewrote the *unit cost* to 75. Quantity and unit cost are the only safe things to write
     there; EBMS derives the rest.

5. **Header fields.** `ID` (the vendor) is the only one you need. Others worth setting when the
   user says so: `PO_NO` is assigned by EBMS — do not send it; `WAREHOUSE` for where the stock
   is going; `DESCR_H`, which **truncates at 30 characters** in silence; `FREIGHT` and `TAX`,
   which do persist; `DUE_DATE`. Do not send `INVOICE`, `TOTAL`, `SUBTOTAL` or `TOP_TOTAL`.

6. **Give it an `EXTERNALID`** unique to this request, e.g. `claude-2026-09-21-po1`. The server
   refuses a second create with the same one, which is what stops a timeout turning into two
   purchase orders.

7. **Show the user the whole order and ask.** Vendor, each line with its quantity **and unit** and
   unit cost, the estimated total, and anything you had to assume. Then wait.

8. **Create it:**

   ```
   ebms_write  company: sbx
               method: POST
               path: APINV
               body: {"ID": "BIKEPARTS", "WAREHOUSE": "MAINSHOP",
                      "EXTERNALID": "claude-2026-09-21-po1",
                      "Details": [{"INVEN": "TUBE700C", "O_QUAN_VIS": 35,
                                   "UNIT_MEAS": "EA", "UNIT_VIS": 7.50}]}
               readBack: {"record": "INVOICE,PO_NO,SUBTOTAL,TOTAL,TOTAL_PO",
                          "lines": "UNIT_MEAS,UNIT_VIS,O_QUAN_VIS,ETA_DATE,ACCOUNT"}
   ```

   No `ETA_DATE`, no `INV_DATE` or `ORDER_DATE` unless the user gave them, no `PROCESS`.

9. **Report from the result.**
   - The PO number is `record.INVOICE` (`PO#183`) with `PO_NO` (`183`) — give both, since the
     person will see `183` on the screen.
   - Lines come from `verification.rows`: quantity, unit, unit cost, as EBMS stored them.
   - **"The order comes to" is `TOTAL_PO`.** `TOTAL` and `SUBTOTAL` only count what has been
     received, so on a new PO they are near zero. Don't report them as the order's value.
   - **Read each line's `ETA_DATE`** — EBMS sets it from the vendor's lead time. Say which lines
     have no expected date and which are expected later than the user needs them. That is their
     cue to call the vendor.
   - `verification.ok: false` means something did not land: show the mismatches and stop.
   - `refused: true` with an existing record means this `EXTERNALID` already created a PO. Give
     its number; do not create another.
   - `uncertain: true` means the outcome is unknown. **Read back by `EXTERNALID` before doing
     anything else** — never resend.

## Big orders

Purchase documents behave like sales documents: every write re-saves the whole document, and a
request is cut off at about two minutes. Measured on `ARINV`, a 50-line create takes about 40
seconds. So keep a create to **50 lines**, then append the rest 50 at a time with a
`Details@delta` of entries with no `@id` (see `change.md`), watching each chunk's `ms` and halving
once one passes about 60 seconds. `APINV` itself has not been timed.
