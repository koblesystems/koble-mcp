# Record what arrived

Read `../SKILL.md` first for the ground rules.

Receiving records how much of each line has actually come in. It is **not** processing: a fully
received purchase order still has `STATUS` `'U'`, and turning the receiving list into an expense
invoice is done by a person in EBMS.

**Receiving moves stock, immediately.** On SBX (2026-09-23), receiving 1 CASE (12 each) and 4
each on a ZTEST PO raised the product's `T_ON_HAND` by 16 the moment the PATCH returned — no
processing needed. Every quantity here changes what the company believes it has on hand, and it
is the one workflow in this skill that another person will notice at once. Confirm each document,
line by line, before writing.

## Steps

1. **Read the purchase order with its lines** (the read shape in `../SKILL.md`). Never a
   standalone `APINVDET` query — quantities come back as 0.

2. **Check it is still open.** `STATUS` must be `'U'`. On `'O'` or `'X'` the document is
   processed and its lines are locked; say so and stop.

3. **Show what is outstanding**, per line: product, `O_QUAN_VIS` ordered, `SHIP_VIS` already
   received, and the difference. A line already fully received is not one to receive again.

4. **Get the received quantities from the user**, in the line's `UNIT_MEAS`, and repeat them back
   in that unit. Do not convert.

5. **Guard the quantities.**
   - **Never receive more than was ordered** unless the user says so explicitly. EBMS has a
     company-level over-receipt policy, but do not rely on it to catch a typo.
   - **Short delivery?** Ask what happens to the rest: left outstanding, or back-ordered. Leaving
     `SHIP_VIS` short of `O_QUAN_VIS` simply leaves it outstanding; EBMS leaves `B_QUAN_VIS` at 0.
   - `SHIP_VIS` is an **absolute total received**, not an increment, and it is **in the line's
     unit**: `SHIP_VIS: 1` on a CASE line of 12 puts 12 into stock. A second delivery against a
     line that already shows 10 received, of 15 more, is `SHIP_VIS: 25`.

6. **Write it:**

   ```
   ebms_write  company: sbx
               method: PATCH
               path: APINV('<PO AUTOID>')
               body: {"Details@delta": [
                        {"@id": "<line AUTOID>", "SHIP_VIS": 35, "RDATE": "2026-09-21"},
                        {"@id": "<line AUTOID>", "SHIP_VIS": 10}
                      ]}
               readBack: {"record": "STATUS,SUBTOTAL,TOTAL,TOTAL_PO",
                          "lines": "INVEN,O_QUAN_VIS,SHIP_VIS,B_QUAN_VIS,UNIT_MEAS,UNIT_VIS,RDATE"}
   ```

   `RDATE` is the received date. EBMS sets it to today when you leave it out, so send it when the
   delivery was not today.

7. **Report from `verification.rows`**: per line, ordered, received and what is still outstanding,
   and whether the document is now complete. Each line's `COST` becomes received × unit cost, and
   the document's `SUBTOTAL` and `TOTAL` rise with it. Then say plainly that the purchase order is
   still unprocessed and that turning it into an expense invoice happens in EBMS.

## Undoing a receipt

Set the line's `SHIP_VIS` back to what it was — 0 to undo it entirely. Verified: that took the
ZTEST product's on-hand straight back down and the line's `COST` back to 0. `RDATE` is left as
it was. This changes stock again, so confirm it the same way as the receipt.

## Back orders

The header carries `CREATE_BO` ("force create back order"), and EBMS has a `CreateBackOrder`
command that splits what has not arrived onto a new document, reachable through the header's
`BackOrders` navigation. **Neither has been tested here, and the command is not on the server's
allow-list**, so it cannot be run through `ebms_command` today.

If the user wants a back order, say that: the delivery can be recorded here, and the back order
raised in EBMS. Do not set `CREATE_BO` speculatively — it changes how EBMS splits the document.

## Receiving everything at once

`MarkAllAsReceived` is EBMS's own command for "it all came in". It is **not on the server's
allow-list and has not been tested**. Until it is, receive everything by setting each line's
`SHIP_VIS` to its `O_QUAN_VIS` in one PATCH, which is the same result by a route that verifies
itself line by line.

## Not yet verified

- `MarkAllAsReceived` and `CreateBackOrder`, as above.
- Whether `SHIP_VIS` over `O_QUAN_VIS` is refused, warned about, or silently accepted on this
  install — the over-receipt policy is a company setting.
- Serialized and lot-tracked products, which need a serial number or lot assigned as they are
  received. Do those in EBMS.
- Whether setting `B_QUAN_VIS` yourself on a short line does anything useful before processing.
