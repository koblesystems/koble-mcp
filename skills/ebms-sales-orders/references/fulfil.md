# Fulfil a sales order — ship, then confirm before processing

Read `../SKILL.md` first for the ground rules and the performance limits.

This workflow **records the shipment, then always asks before processing** the order into an
invoice. Processing posts the document and locks its lines; it is never done without an
explicit yes.

## Steps

1. **Read the order.** It must be `STATUS` `'U'`.

2. **Decide what shipped.**
   - **Everything:** `POST /ARINV('<AUTOID>')/Model.Entities.MarkAllAsShipped` with **no request
     body at all**. An empty `{}` body fails with "The command does not have a dialog".
   - **Specific quantities:** the user says what shipped on each line.

3. **Guard the quantities. EBMS checks neither of these:**
   - **Never ship more than ordered** unless the user explicitly says so. EBMS accepts 7 shipped
     against 5 ordered and invoices all 7, and `MarkAllAsShipped` won't correct it.
   - **Partial shipment?** Ask whether the rest is back-ordered. If yes, set
     `B_QUAN_VIS` = ordered − shipped yourself; EBMS leaves it at 0.

4. **Record the shipment:**
   ```
   PATCH /ARINV('<order AUTOID>')
   {"Details@delta": [
      {"@id": "<line AUTOID>", "M_SHIP_VIS": 2, "B_QUAN_VIS": 1},
      {"@id": "<line AUTOID>", "M_SHIP_VIS": 24}
   ]}
   ```
   On an order with more than 50 lines, split the delta into pieces of 50 or fewer, as in
   `change.md`. These are modifies, so resending one after a timeout is safe.

5. **Read back and report the shipment:** shipped and back-ordered quantity per line, and
   `TOTAL` — the amount that will be invoiced.

6. **Ask before processing. Always.** Check `TERMS` first:
   - **`Charge`:** processing posts an invoice for `TOTAL`.
   - **`Cash`:** EBMS refuses to process until the order is fully paid ("This cash invoice must
     be fully paid before it can be processed"). Say so. Don't record a payment or change the
     terms unless the user tells you to — payments can only be voided, never deleted.

   Then ask plainly, with the invoice number, amount and consequence. For example: *"Order 1193
   is shipped: 2 of 3 mugs, 1 back-ordered, $87.00 to invoice. Process it into an invoice now?
   That posts it and locks the lines."*

7. **Only on an explicit yes:**
   ```
   PATCH /ARINV('<order AUTOID>')
   {"PROCESS": "Process"}
   ```
   Read back and confirm `STATUS` is `'O'`. `PROCESS` itself always reads back as `Default`, so
   `STATUS` is what tells you it worked. If EBMS returns `422 Saving has been aborted`, nothing
   changed; relay the message from `Messages[].TextDetail`.

A back-ordered line stayed on the same document when processed; no separate back-order
document was created on the install tested.

## Reversing a processed order

Only on an explicit request, after confirming:
```
PATCH /ARINV('<order AUTOID>')
{"PROCESS": "Unprocess"}
```
`STATUS` returns to `'U'` and the lines unlock. Unprocessing an order that isn't processed is a
harmless no-op.

## Not yet verified

`MarkAllAsShipped` and processing were timed only on small orders. On a large order either may
take long enough to approach the 2-minute limit; if one times out, read the order back
(`STATUS`, shipped quantities) before trying again.
