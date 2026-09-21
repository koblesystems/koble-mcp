# Fulfil a sales order — record the shipment

Read `../SKILL.md` first for the ground rules and the performance limits.

This workflow records what shipped and what is back-ordered. **Processing the order into an
invoice is not done here.** The koble-mcp server refuses `PROCESS` at any depth, on purpose:
posting a document locks its lines and is a person's decision, made in EBMS where they can see
what they are posting. Say that plainly when asked, and offer to get the order shipment-ready
instead.

## Steps

1. **Read the order** with `ebms_get`. It must be `STATUS` `'U'`. `'O'` means it has already been
   processed — its lines are locked and edits return 403.

2. **Decide what shipped.**
   - **Everything:** `ebms_command` with `entity: ARINV`, `key: <AUTOID>`,
     `command: MarkAllAsShipped`, and **no body at all**. An empty `{}` fails with "The command
     does not have a dialog".
   - **Specific quantities:** the user says what shipped on each line.

3. **Guard the quantities. EBMS checks neither of these:**
   - **Never ship more than ordered** unless the user explicitly says so. EBMS accepts 7 shipped
     against 5 ordered and invoices all 7, and `MarkAllAsShipped` won't correct it.
   - **Partial shipment?** Ask whether the rest is back-ordered. If yes, set
     `B_QUAN_VIS` = ordered − shipped yourself; EBMS leaves it at 0.

4. **Record the shipment:**
   ```
   ebms_write  company: sbx
               method: PATCH
               path: ARINV('<order AUTOID>')
               body: {"Details@delta": [
                        {"@id": "<line AUTOID>", "M_SHIP_VIS": 2, "B_QUAN_VIS": 1},
                        {"@id": "<line AUTOID>", "M_SHIP_VIS": 24}
                      ]}
               readBack: {"record": "TOTAL,TOTAL_SO", "lines": "M_QUAN_VIS,M_SHIP_VIS,B_QUAN_VIS"}
   ```
   On an order with more than 50 lines, split the delta into pieces of 50 or fewer, as in
   `change.md`. These are modifies, so resending one after an `uncertain` result is safe.

5. **Report the shipment from `verification.rows`:** shipped and back-ordered quantity per line,
   and `TOTAL` — the amount that will be invoiced when someone processes it. `TOTAL_SO` is the
   ordered total and does not move.

6. **Then stop, and say what is left.** For example: *"Order 1193 is recorded as shipped: 2 of 3
   mugs, 1 back-ordered, $87.00 to invoice. Processing it into an invoice is done in EBMS —
   this server won't post a document."*

   Worth mentioning when it applies: on `Cash` terms EBMS refuses to process until the order is
   fully paid, so the person will hit that in the screen. A back-ordered line stayed on the same
   document when processed on the install tested; no separate back-order document was created.

## Not available here

| Wanted | Where it happens |
|---|---|
| Processing an order into an invoice | EBMS. `PROCESS` is refused by the server. |
| Unprocessing a posted invoice | EBMS, same reason. |
| Recording a payment | EBMS. Payments can only be voided, never deleted. |
| Emailing or printing the invoice | EBMS. |

## Not yet verified

`MarkAllAsShipped` was tested only on small orders. On a large order it may approach the 2-minute
limit; if the result is `uncertain`, read the order back (`STATUS`, shipped quantities) before
trying again.
