# Build a sales order

Read `../SKILL.md` first for the ground rules and the performance limits.

## Steps

1. **Resolve the customer and every product** to exact IDs with `ebms_get`. Ask when a search is
   ambiguous.

2. **Assemble the lines.**
   - Product line: `{"INVEN": "<ID>", "M_QUAN_VIS": <qty>}`.
   - Price: include `"UNIT_VIS": <price>` **only if the user stated one**. Otherwise EBMS prices
     the line from the customer's price level — which is not the product's `BASE` (a `BASE`
     27.50 product came in at 41.04 for a Retail customer). Supplying prices doesn't make the
     request faster.
   - Description-only line (freight, a note, a misc charge):
     `{"DESCR": "...", "M_QUAN_VIS": 1, "UNIT_VIS": <amount>, "ACCOUNT": "<G/L account>"}`.
     **Ask the user for the G/L account.** Without one EBMS aborts the whole order. (A
     description-only line that carries a `Materials` list is the exception — see
     `materials.md`.)
   - Assembly or kit with its parts listed: nest them as `Materials` on the line, with quantities
     **per parent unit**. Read `materials.md` first — the parent's price comes from its materials.

3. **Validate before posting.** Every product resolved, quantities > 0, every description line
   has an `ACCOUNT` or a materials list. An order EBMS rejects still consumes an invoice number.

4. **Give the order an `EXTERNALID`** unique to this request, e.g. `claude-2026-09-21-a1`. The
   server refuses a second create with the same one, and it is how you find out whether a create
   that timed out actually happened.

5. **Show the user a summary** — customer, line count, any prices they gave — and ask before
   sending. For up to 50 lines, one call is the whole order:

   ```
   ebms_write  company: sbx
               method: POST
               path: ARINV
               body: {"ID": "SMIJOH", "PO_NO": "PO-5521", "DESCR": "Spring restock",
                      "EXTERNALID": "claude-2026-09-21-a1",
                      "Details": [{"INVEN": "MUG-12", "M_QUAN_VIS": 24},
                                  {"INVEN": "LID-12", "M_QUAN_VIS": 24, "UNIT_VIS": 1.25}]}
               readBack: {"record": "INVOICE,TOTAL_SO", "lines": "UNIT_MEAS,UNIT_VIS,SO_AMOUNT",
                          "children": "Materials"}
   ```

   Don't send `M_SHIP_VIS`. `PROCESS` is refused by the server; shipping and invoicing are
   `fulfil.md`.

6. **Report from the result, not from what you sent.** The new `INVOICE` number is in `record`;
   every line as EBMS stored it is in `verification.rows`.
   - **`notes`** lists rows EBMS added itself. A product with default components brings them in
     as materials — that is EBMS, not an error. Say so.
   - **Flag any $0.00 line and any zero quantity.** A quantity stored as 0 on a 200 means the
     product's unit is set up wrongly (`UNIT_MEAS` with an `INVENUNT` multiplier of 0), not that
     the order failed. Read `UNIT_MEAS` back and say which line needs the unit fixed.
   - Flag any price that differs from what the user expected.

## Orders with more than 50 lines

A single request is limited to about 2 minutes, a 50-line create takes about 40 seconds, and each
later write costs more as the order grows. So build large orders in pieces:

1. **Create** with the first 50 lines, as above, including the `EXTERNALID`. Keep the returned
   `AUTOID`.
2. **Append** the rest 50 lines at a time, with no `@id` on the new entries:
   ```
   ebms_write  method: PATCH
               path: ARINV('<order AUTOID>')
               body: {"Details@delta": [{"INVEN": "MUG-16", "M_QUAN_VIS": 12}, … up to 50]}
   ```
3. **Track each chunk.**
   - Before sending a chunk, know how many lines the order should have afterwards.
   - After it returns, confirm the line count with a light read: `ebms_get` on
     `ARINV('<AUTOID>')` with `select: AUTOID` and `expand: Details($select=AUTOID)`.
   - If a chunk took more than about 60 seconds (`ms` in the result), **halve the next one**.
     Appending 50 lines took 50 seconds on a 50-line order and 60 on a 100-line order; 100 lines
     onto a 150-line order took 114.
4. **If a chunk comes back `uncertain: true`, do not resend it.** Read the line count first. If
   the lines are there, move on; if they are not, resend. Re-sending an append that did land
   duplicates every line in it.
5. **If chunks keep getting slower** and a small one still approaches the limit, stop. Tell the
   user how many lines are in, which are not, and that the rest can't be added reliably through
   the API — an order that size may need to be split into two orders or finished in EBMS.
6. **Read back once at the end** and report the invoice number, total line count and `TOTAL_SO`,
   plus any $0.00 lines.

Tell the user up front roughly how long it will take: about 40 seconds for the first 50 lines,
then about a minute or more per further 50.
