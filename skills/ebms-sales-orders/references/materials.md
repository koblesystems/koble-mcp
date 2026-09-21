# Materials lists

Read `../SKILL.md` first for the ground rules and the performance limits.

A materials list is a set of lines nested under one order line — the parts that make up an
assembly, a kit, or a job. Verified against SBX (EBMS 1.8.148, September 2026).

## Two kinds, and they price differently

- **An assembly kit** is a product with its own default materials list and **its own price**,
  which EBMS distributes down to the children. Order 1088: `FLATREPAIR` priced at 16, its
  children rescaled to 0.25 × 31.35 + 8.16.
- **An ad hoc materials list** has a **description-only parent** — a line with no `INVEN`, just a
  `DESCR` — and **the parent's price is the sum of its children**. This is the **typical** case in
  EBMS, not an edge case. The G/L account sits on the materials, so such a parent needs **no
  `ACCOUNT`** (verified by write, order 1209): the "description-only line needs an `ACCOUNT`"
  rule applies only to a description line with no materials.

Both are built the same way; only the pricing differs. Ask which one the user means when it
isn't obvious from whether they named a product.

## How EBMS models them

- **Materials are not ordinary lines.** They live only under their parent line's `Materials`
  collection, never in the order's top-level `Details`. Each one links to its parent by
  `PAR_TIME` = the parent line's `TIMESTAMP`.
- **A material's quantity is per ONE parent unit.** 3 of a part under an assembly ordered ×2
  means 6 go out, and the material's `SO_AMOUNT` is 3 × price × 2.
- **On an ad hoc list the parent's price is the sum of its materials**, per parent unit. A
  product given an explicit `Materials` array priced the same way: a `BASE` 100 product came out
  at 22.91 because its materials came to 1 × 5.00 + 3 × 5.97.
- **A product with default components brings them in by itself.** Posting one `FLATREPAIR` line
  with no `Materials` came back with its 2 default components attached (TUBE-26 ×0.25,
  TUBE700C ×1 @ 8.33). Ask for them back with `readBack.children: "Materials"` and they arrive
  in `verification.notes` — rows EBMS added, not an error. In that case the parent stayed at
  price 0, because its own `BASE` is 0: EBMS did **not** price it as the sum of its materials.
  Report what EBMS stored.
- **Setting a price on the parent line spreads it down.** Setting the assembly to 99 rescaled its
  materials proportionally (4 × 11.00 + 2 × 27.50 = 99). Tell the user before doing this — their
  material prices will change.
- A price set on a material (`UNIT_VIS`) sticks. Materials without one get the customer's price
  level.

## Read an order's materials

**Don't `$expand=Materials` on an order's lines.** On a 120-line order that expand added about
43 seconds, whatever was selected and even with a `$filter` inside it. Read the lines through
the order without it, then read the materials on their own:

```
# 1. Lines, through the order, with TIMESTAMP
ebms_get  path: ARINV('<AUTOID>')   select: AUTOID
          expand: Details($select=AUTOID,INVEN,DESCR,M_QUAN_VIS,UNIT_VIS,SO_AMOUNT,TIMESTAMP)

# 2. The order's materials, standalone
ebms_get  path: ARINVDET
          filter: DOC_AID eq '<order AUTOID>' and PAR_TIME ne ''
          select: AUTOID,INVEN,DESCR,M_QUAN_VIS,UNIT_VIS,SO_AMOUNT,PAR_TIME
```

Attach each material to the line whose `TIMESTAMP` equals its `PAR_TIME`. The standalone read
took 0.5 seconds and matched the expanded one field for field, quantities and prices included.
That is specific to materials: **top-level** lines must still be read through the order.

When reporting to the user, show materials under their parent and state quantities the way
EBMS means them: "per assembly".

## Create an order with materials

Nest `Materials` inside the line, with quantities **per parent unit**:

```
ebms_write  company: sbx   method: POST   path: ARINV
            body: {"ID": "SMIJOH", "EXTERNALID": "claude-2026-09-21-b1",
                   "Details": [
                     {"INVEN": "BENCH-KIT", "M_QUAN_VIS": 2,
                      "Materials": [{"INVEN": "LEG-18", "M_QUAN_VIS": 4},
                                    {"INVEN": "SEAT-OAK", "M_QUAN_VIS": 1, "UNIT_VIS": 45.00}]},
                     {"DESCR": "Bench, made to order", "M_QUAN_VIS": 1,
                      "Materials": [{"INVEN": "LEG-18", "M_QUAN_VIS": 4}]}
                   ]}
            readBack: {"lines": "UNIT_MEAS,UNIT_VIS,SO_AMOUNT", "children": "Materials"}
```

The second line is the ad hoc form: a description-only parent, no `ACCOUNT`, priced as the sum of
its children.

If the user gives total quantities ("8 legs for 2 benches"), divide by the parent quantity before
sending, and say so. Read back and report the parent line's price, which EBMS derives.

Count materials toward the 50-line limit per request.

## Change materials

Use a delta **inside** a `Details@delta` entry for the parent line:

```
ebms_write  company: sbx   method: PATCH   path: ARINV('<order AUTOID>')
            body: {"Details@delta": [
                     {"@id": "<parent line AUTOID>",
                      "Materials@delta": [
                        {"@id": "<material AUTOID>", "M_QUAN_VIS": 6},
                        {"@id": "<material AUTOID>", "@removed": true},
                        {"INVEN": "BRACE-12", "M_QUAN_VIS": 2}
                      ]}
                   ]}
```

Modify, remove and add all work this way, and the parent's price recalculates. A new assembly
with its own materials can be added in one step, as an entry with no `@id` carrying a
`Materials` array.

The same rules as other line edits apply: absolute values, read back, and never resend an add
without checking first.

## Warnings

- **Never run `RecalculateAllPrices` on an order with materials lists without an explicit
  go-ahead.** It replaced each assembly's materials-based price with the assembly product's own
  price level and rescaled every material to match. One untouched assembly went from 29.85 to
  149.25, and the order total from 152.26 to 462.68. See `commands.md`.
- **A quantity stored as 0 on a 200 is a unit problem, not a stock problem.** A material and a
  plain line for the same product both saved as quantity 0, price 0, no warning. The cause was
  the product's units: the API puts the product's `DEF_UNIT` on the line, and that unit's
  `INVENUNT` row had `MULTIPLY` "Larger" with `MULTIPLIER` 0, so one of them is zero base units.
  `UNIT_MEAS` is writable on a line — sending `{"@id": <line>, "UNIT_MEAS": "", "M_QUAN_VIS": 1}`
  brought it back as 1 @ 126.87. So: read `UNIT_MEAS` back on every line, and when a quantity is
  0, point at the product's unit setup rather than at stock. EBMS does accept orders for
  out-of-stock items.
- `NO_COMP` and `NO_ACC` (ignore a product's default components / accessories) were not tested,
  because the test products had no defaults configured. Don't set them without saying they're
  unverified.
