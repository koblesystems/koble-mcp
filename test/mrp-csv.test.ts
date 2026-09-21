import { test } from "node:test";
import assert from "node:assert/strict";
import { BOM, COLUMNS, checkCode, draftPurchaseOrders, externalIdFor, parseCsv, parseDate, parseQuantity, readSheet, toCsv as writeCsv, type RunManifest, type SheetRow } from "../src/mrp/csv.js";
import { baseUnitOf, fromBaseUnits, type UnitRow } from "../src/mrp/units.js";

const RUN = "mrp-sbx-20260921-140533";
/** Rows are stamped the way the worksheet writer stamps them, unless a test sets Check itself. */
const stamp = (row: SheetRow): SheetRow => (row.Check !== undefined ? row : { ...row, Check: checkCode(String(row.Run ?? ""), String(row.Line ?? ""), String(row.Item ?? "")) });
const toCsv = (rows: readonly SheetRow[]): string => writeCsv(rows.map(stamp));
const base: SheetRow = { Run: RUN, Company: "SBX" };
const rows: SheetRow[] = [
    { ...base, Line: "L0001", Type: "BUY", Item: "SADDLE", Description: 'Bike Saddle, 10" "pro"', Vendor: "BIKEPARTS", "Purchase Unit": "Each", "Order Qty": 48, "Unit Cost": 22.5, "Needed By": "2026-09-25", Approve: "", Because: "sales 1069: 12; sales 1070: 30" },
    { ...base, Line: "L0002", Type: "BUY", Item: "12OZBAG", Description: "12 oz Bag", Vendor: "PACKCO", "Purchase Unit": "Case", "Order Qty": 2, "Unit Cost": 40, "Needed By": "2026-09-21" },
    { ...base, Line: "L0003", Type: "MAKE", Item: "HOUSE-BLEND", Description: "=SUM(A1) looks like a formula" },
];
const manifest: RunManifest = {
    run: RUN, company: "SBX", through: "2026-11-20", createdAt: "2026-09-21T18:05:33Z",
    lines: {
        L0001: { type: "BUY", item: "SADDLE", vendor: "BIKEPARTS", partNo: "BS-1", purchaseUnit: "Each", orderQty: 48, unitCost: 22.5, neededBy: "2026-09-25" },
        L0002: { type: "BUY", item: "12345678901234", vendor: "PACKCO", partNo: "", purchaseUnit: "", orderQty: 2, unitCost: null, neededBy: "2026-10-05" },
        L0003: { type: "MAKE", item: "HOUSE-BLEND", vendor: "", partNo: "", purchaseUnit: "", orderQty: null, unitCost: null, neededBy: "2026-09-21" },
        L0004: { type: "BUY", item: "0012345", vendor: "(no primary vendor)", partNo: "", purchaseUnit: "EA", orderQty: 5, unitCost: null, neededBy: "2026-10-01" },
    },
};

test("the worksheet survives a round trip through CSV, awkward text included", () => {
    const text = toCsv(rows);
    assert.ok(text.startsWith(BOM + COLUMNS.join(",")));
    const back = parseCsv(text);
    assert.equal(back.length, 3);
    assert.equal(back[0]?.["Description"], 'Bike Saddle, 10" "pro"');
    assert.match(text, /'=SUM\(A1\)/, "a formula-looking cell is written as text");
    assert.equal(back[2]?.["Description"], "=SUM(A1) looks like a formula");
    assert.match(toCsv([{ ...base, Line: "L1", Type: "OK", Item: "X", Notes: "\t=HYPERLINK(1)" }]), /'\t=HYPERLINK/, "a tab before the = does not get it past");
});

test("only approved BUY rows become purchase-order lines, one order per vendor, tied to the run", () => {
    const edited = toCsv([{ ...rows[0], Approve: "Y", "Order Qty": 50 }, { ...rows[1], Approve: "yes" }, { ...rows[2], Approve: "" }, { ...base, Line: "L0009", Type: "BUY", Item: "LID", Vendor: "PACKCO", "Order Qty": 10, Approve: "" }]);
    const reading = readSheet(edited);
    assert.deepEqual(reading.problems, []);
    assert.deepEqual(reading.counts, { rows: 4, buyRows: 3, approved: 2, notApproved: 1 });
    const drafts = draftPurchaseOrders(reading);
    assert.deepEqual(drafts.map((d) => d.vendor), ["BIKEPARTS", "PACKCO"]);
    assert.equal(drafts[0]?.externalId, `${RUN}-BIKEPARTS`);
    assert.equal(drafts[0]?.estCost, 1125);
    assert.deepEqual(drafts[0]?.body, { ID: "BIKEPARTS", EXTERNALID: `${RUN}-BIKEPARTS`, Details: [{ INVEN: "SADDLE", O_QUAN_VIS: 50, UNIT_MEAS: "Each", UNIT_VIS: 22.5 }] });
    assert.deepEqual(drafts[0]?.neededBy, { SADDLE: "2026-09-25" }, "the needed-by day is kept to compare with the expected date EBMS assigns; it is not sent");
});

test("what a spreadsheet does to the file does not reach the purchase order when the run record is there", () => {
    // Excel: the date became 10/5/2026, the 14-digit product ID became 3.94E+13, a leading zero vanished.
    const excel = toCsv([
        { ...base, Line: "L0002", Check: checkCode(RUN, "L0002", "12345678901234"), Type: "BUY", Item: "1.23457E+13", Vendor: "PACKCO", "Purchase Unit": "", "Order Qty": 3, "Needed By": "10/5/2026", Approve: "Y" },
        { ...base, Line: "L0004", Check: checkCode(RUN, "L0004", "0012345"), Type: "BUY", Item: "12345", Vendor: "acme", "Purchase Unit": "Case", "Unit Cost": 999, "Order Qty": 5, "Needed By": "10/1/2026", Approve: "Y" },
    ]);
    const reading = readSheet(excel, manifest);
    assert.deepEqual(reading.problems, []);
    assert.equal(reading.fromManifest, true);
    const [long, zero] = reading.approved;
    assert.equal(long?.item, "12345678901234");
    assert.equal(long?.neededBy, "2026-10-05");
    assert.deepEqual(long?.changes, ["quantity 2 → 3"]);
    assert.equal(zero?.item, "0012345", "the leading zero comes from the run, not the cell");
    assert.equal(zero?.vendor, "ACME");
    assert.equal(zero?.unit, null, "a vendor the planner chose may sell in another unit: looked up again");
    assert.equal(zero?.originalUnit, "EA", "and the quantity is remembered as being in the unit the row showed");
    assert.equal(zero?.unitCost, null, "an edited Unit Cost cell is not trusted");
    assert.deepEqual(zero?.changes, ["vendor set to ACME"]);
    assert.equal(reading.notes.filter((n) => /spreadsheets often reformat/.test(n)).length, 2);
    const [draft] = draftPurchaseOrders({ ...reading, approved: [long as NonNullable<typeof long>] });
    assert.deepEqual(draft?.body["Details"], [{ INVEN: "12345678901234", O_QUAN_VIS: 3, UNIT_MEAS: "" }], "a blank-named stock unit is still sent, so EBMS cannot default to a case");
});

test("without the run record the file is read strictly and says so", () => {
    const reading = readSheet(toCsv([
        { ...base, Line: "L0001", Type: "BUY", Item: "SADDLE", Vendor: "BIKEPARTS", "Order Qty": 4, "Needed By": "10/5/2026", Approve: "Y" },
        { ...base, Line: "L0002", Type: "BUY", Item: "1.23457E+13", Vendor: "PACKCO", "Order Qty": 1, Approve: "Y" },
        { ...base, Line: "L0003", Type: "BUY", Item: "LID", Vendor: "PACKCO", "Order Qty": 1, "Needed By": "next week", Approve: "Y" },
    ]));
    assert.equal(reading.approved[0]?.neededBy, "2026-10-05");
    assert.match(reading.problems.join("\n"), /spreadsheet turned the product ID into a number|does not match the run/);
    assert.match(reading.notes.join("\n"), /"next week" is not a date/);
    assert.match(reading.notes.join("\n"), /run's own record was not found/);
});

test("rows that were approved but cannot be ordered are named, not dropped", () => {
    const reading = readSheet(toCsv([
        { ...base, Line: "L1", Type: "BUY", Item: "A", Vendor: "(no primary vendor)", "Order Qty": 5, Approve: "Y" },
        { ...base, Line: "L2", Type: "BUY", Item: "B", Vendor: "ACME", "Order Qty": 0, Approve: "Y" },
        { ...base, Line: "L3", Type: "NOT NEEDED", Item: "C", Approve: "Y" },
        { ...base, Line: "L6", Type: "MAKE", Item: "F", "Order Qty": 4, Approve: "Y" },
        { ...base, Line: "L4", Type: "BUY", Item: "D", Vendor: "ACME", "Order Qty": 2, Approve: "Yes please" },
        { ...base, Line: "L5", Type: "BUY", Item: "E", Vendor: "ACME", "Order Qty": 2, Approve: "Y" },
        { ...base, Line: "L5", Type: "BUY", Item: "E", Vendor: "ACME", "Order Qty": 2, Approve: "Y" },
    ]));
    assert.deepEqual(reading.approved.map((l) => l.item), ["E"]);
    const all = reading.problems.join("\n");
    assert.match(all, /A is approved but has no vendor/);
    assert.match(all, /B is approved but Order Qty "0"/);
    assert.match(all, /C is marked approved but is a NOT NEEDED row/);
    assert.doesNotMatch(all, /\bF is marked approved/, "an approved MAKE row is the batch tool's job, not a mistake");
    assert.deepEqual(readSheet(toCsv([{ ...base, Line: "L6", Type: "MAKE", Item: "F", "Order Qty": 4, Approve: "Y" }]), null, "MAKE").approved.map((l) => `${l.item} ${l.qty}`), ["F 4"]);
    assert.match(all, /Approve says "Yes please"/);
    assert.match(all, /worksheet line L5 appears twice/);
    assert.match(readSheet("Name,Qty\r\nx,1\r\n").problems.join("\n"), /does not look like an MRP worksheet/);
});

test("quantities and dates are read plainly or not at all", () => {
    assert.equal(parseQuantity("12"), 12);
    assert.equal(parseQuantity("1.5"), 1.5);
    assert.equal(parseQuantity("1,250"), 1250);
    for (const bad of ["1,5", "1e3", "0x10", "-3", "12 cases", "", "1.2.3"]) assert.equal(parseQuantity(bad), null, bad);
    assert.equal(parseDate("2026-10-05"), "2026-10-05");
    assert.equal(parseDate("10/5/2026"), "2026-10-05");
    for (const bad of ["5-Oct-26", "13/40/2026", "next week", ""]) assert.equal(parseDate(bad), null, bad);
});

test("the cells that tie the file to its run cannot be blanked or changed to order again", () => {
    const blank = readSheet(toCsv([{ ...rows[0], Run: "", Approve: "Y" }]));
    assert.equal(blank.approved.length, 0);
    assert.match(blank.problems.join("\n"), /blank Run or Company/);
    // Run changed on every row, consistently, to something with no record: the row's code no longer fits.
    const original = stamp({ ...rows[0], Approve: "Y" } as SheetRow);
    const edited = readSheet(writeCsv([{ ...original, Run: "mrp-sbx-20260921-999999" }]));
    assert.equal(edited.approved.length, 0);
    assert.match(edited.problems.join("\n"), /does not match the run it claims to belong to/);
    // Run changed to ANOTHER run that exists: its record maps L0001 to another product, and the code does not fit that either.
    const other: RunManifest = { ...manifest, run: "mrp-sbx-20260920-090000", lines: { L0001: { ...(manifest.lines["L0001"] as RunManifest["lines"][string]), item: "BOLT" } } };
    const repointed = readSheet(writeCsv([{ ...original, Run: other.run }]), other);
    assert.equal(repointed.approved.length, 0);
    assert.match(repointed.problems.join("\n"), /does not match the run it claims to belong to/);
    // A row typed in by hand, with no run record to catch it, has no valid code.
    const typed = readSheet(writeCsv([{ ...base, Line: "L0777", Check: "k00000000", Type: "BUY", Item: "SNEAKED", Vendor: "ACME", "Order Qty": 9, Approve: "Y" }]));
    assert.equal(typed.approved.length, 0);
    const added = readSheet(toCsv([{ ...base, Line: "L9999", Type: "BUY", Item: "SNEAKED", Vendor: "ACME", "Order Qty": 9, Approve: "Y" }]), manifest);
    assert.match(added.problems.join("\n"), /L9999 is not part of run/);
});

test("stock units convert into the vendor's unit, whole cases rounded up; the stock unit has a name", () => {
    const units: UnitRow[] = [{ ID: "BAG", UNIT: "EA", MULTIPLIER: 0, MULTIPLY: "Smaller" }, { ID: "BAG", UNIT: "Case", MULTIPLIER: 50, MULTIPLY: "Larger" }, { ID: "ROAST", UNIT: "lb", MULTIPLIER: 0, MULTIPLY: "Smaller" }, { ID: "ROAST", UNIT: "oz", MULTIPLIER: 16, MULTIPLY: "Smaller" }, { ID: "JERSEY", UNIT: "", MULTIPLIER: 0, MULTIPLY: "Smaller" }, { ID: "JERSEY", UNIT: "EA", MULTIPLIER: 0, MULTIPLY: "Larger" }];
    assert.deepEqual(fromBaseUnits("BAG", 60, "Case", units), { qty: 2 });
    assert.deepEqual(fromBaseUnits("BAG", 100, "Case", units), { qty: 2 });
    assert.deepEqual(fromBaseUnits("BAG", 60, "EA", units), { qty: 60 });
    assert.deepEqual(fromBaseUnits("ROAST", 3.75, "oz", units), { qty: 60 });
    assert.match(fromBaseUnits("BAG", 5, "Pallet", units).warning ?? "", /not one of its units/);
    assert.equal(baseUnitOf("BAG", units), "EA");
    assert.equal(baseUnitOf("JERSEY", units), "", "a blank-named stock unit, not the broken EA x0");
    assert.equal(baseUnitOf("NOUNITS", units), null);
});

test("a semicolon-separated save is named for what it is; the vendor survives a long run ID; the earliest need wins", () => {
    const semi = toCsv([{ ...rows[0], Approve: "Y" }]).replace(/,/g, ";");
    assert.match(readSheet(semi).problems.join("\n"), /separated by semicolons/);
    assert.equal(externalIdFor("mrp-acompanywithaverylongidentifier-20260921-140533", "BIKEPARTS"), "mrp-acompanywithaverylongidentifier-2026-BIKEPARTS");
    assert.equal(externalIdFor("mrp-acompanywithaverylongidentifier-20260921-140533", "BIKEPARTS").length, 50);
    const two = readSheet(toCsv([{ ...rows[0], Approve: "Y", "Needed By": "2026-10-20" }, { ...rows[0], Line: "L0008", Approve: "Y", "Needed By": "2026-09-25" }]));
    assert.deepEqual(draftPurchaseOrders(two)[0]?.neededBy, { SADDLE: "2026-09-25" });
});
