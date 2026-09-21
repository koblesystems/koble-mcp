# Build a sales order

Read `../SKILL.md` first for the ground rules and the performance limits.

## Steps

1. **Resolve the customer and every product** to exact IDs. Ask when a search is ambiguous.

2. **Assemble the lines.**
   - Product line: `{"INVEN": "<ID>", "M_QUAN_VIS": <qty>}`.
   - Price: include `"UNIT_VIS": <price>` **only if the user stated one**. Otherwise EBMS prices
     the line from the customer's price level — which is not the product's `BASE` (a `BASE`
     27.50 product came in at 41.04 for a Retail customer). Supplying prices doesn't make the
     request faster.
   - Description-only line (freight, a note, a misc charge):
     `{"DESCR": "...", "M_QUAN_VIS": 1, "UNIT_VIS": <amount>, "ACCOUNT": "<G/L account>"}`.
     **Ask the user for the G/L account.** Without one EBMS aborts the whole order.
   - Assembly or kit with its parts listed: nest them as `Materials` on the line, with quantities
     **per parent unit**. Read `materials.md` first — the parent's price comes from its materials.

3. **Validate before posting.** Every product resolved, quantities > 0, every description line
   has an `ACCOUNT`. An order EBMS rejects still consumes an invoice number.

4. **Give the order an `EXTERNALID`** unique to this request, e.g. `claude-2026-09-17-a1`. It is
   filterable, so if a create times out or the connection drops you can find out whether the
   order exists before trying again.

5. **Show the user a summary** — customer, line count, any prices they gave — and post. For up
   to 50 lines, that is the whole order:
   ```
   POST /ARINV
   {"ID": "SMIJOH", "PO_NO": "PO-5521", "DESCR": "Spring restock",
    "EXTERNALID": "claude-2026-09-17-a1",
    "Details": [{"INVEN": "MUG-12", "M_QUAN_VIS": 24},
                {"INVEN": "LID-12", "M_QUAN_VIS": 24, "UNIT_VIS": 1.25}]}
   ```
   Don't send `M_SHIP_VIS` or `PROCESS` here. Shipping and invoicing are `fulfil.md`.

6. **Read it back** and report: the new `INVOICE` number, each line with the price EBMS applied,
   and `TOTAL_SO`. **Flag any $0.00 line** and any price that differs from what the user
   expected.

## Orders with more than 50 lines

**If `create_sales_order` from `ebms-mcp` is available, use it** — it does everything below,
including resuming when a call runs out of time. The rest of this section is the procedure for
doing it by hand.

A single request is limited to about 2 minutes, a 50-line create takes about 40 seconds, and
each later write costs more as the order grows. So build large orders in pieces:

1. **Create** with the first 50 lines, as above, including the `EXTERNALID`. Keep the returned
   `AUTOID`.
2. **Append** the rest 50 lines at a time, with no `@id` on the new entries:
   ```
   PATCH /ARINV('<order AUTOID>')
   {"Details@delta": [{"INVEN": "MUG-16", "M_QUAN_VIS": 12}, … up to 50 entries]}
   ```
3. **Track each chunk.**
   - Before sending a chunk, know how many lines the order should have afterwards.
   - After it returns, confirm the line count with a light read:
     `/ARINV('<AUTOID>')?$select=AUTOID&$expand=Details($select=AUTOID)`.
   - If a chunk took more than about 60 seconds, **halve the next one**. Appending 50 lines took
     50 seconds on a 50-line order and 60 on a 100-line order; 100 lines onto a 150-line order
     took 114.
4. **If a chunk times out or the connection drops, do not resend it.** Read the line count
   first. If the lines are there, move on; if they are not, resend. Re-sending an append that
   did land duplicates every line in it.
5. **If chunks keep getting slower** and a small one still approaches the limit, stop. Tell the
   user how many lines are in, which are not, and that the rest can't be added reliably through
   the API — an order that size may need to be split into two orders or finished in EBMS.
6. **Read back once at the end** and report the invoice number, total line count and
   `TOTAL_SO`, plus any $0.00 lines.

Tell the user up front roughly how long it will take: about 40 seconds for the first 50 lines,
then about a minute or more per further 50.
