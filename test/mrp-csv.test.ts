import { test } from "node:test";
import assert from "node:assert/strict";
import { COLUMNS, draftPurchaseOrders, parseCsv, readSheet, toCsv, type SheetRow } from "../src/mrp/csv.js";
import { fromBaseUnits, type UnitRow } from "../src/mrp/units.js";

const base: SheetRow = { Run: "mrp-sbx-20260921-1405", Company: "SBX" };
const rows: SheetRow[] = [
    { ...base, Type: "BUY", Item: "SADDLE", Description: 'Bike Saddle, 10" "pro"', Vendor: "BIKEPARTS", "Purchase Unit": "Each", "Order Qty": 48, "Unit Cost": 22.5, "Needed By": "2026-09-25", Approve: "", Because: "sales 1069: 12; sales 1070: 30" },
    { ...base, Type: "BUY", Item: "12OZBAG", Description: "12 oz Bag", Vendor: "PACKCO", "Purchase Unit": "Case", "Order Qty": 2, "Unit Cost": 40, "Needed By": "2026-09-21" },
    { ...base, Type: "MAKE", Item: "HOUSE-BLEND", Description: "=SUM(A1) looks like a formula" },
];

test("the worksheet survives a round trip through CSV, awkward text included", () => {
    const text = toCsv(rows);
    assert.ok(text.startsWith("﻿" + COLUMNS.join(",")));
    const back = parseCsv(text);
    assert.equal(back.length, 3);
    assert.equal(back[0]?.["Description"], 'Bike Saddle, 10" "pro"');
    assert.equal(back[0]?.["Because"], "sales 1069: 12; sales 1070: 30");
    assert.match(text, /'=SUM\(A1\)/, "a formula-looking cell is written as text");
    assert.equal(back[2]?.["Description"], "=SUM(A1) looks like a formula");
});

test("only approved BUY rows become purchase-order lines, one order per vendor, tied to the run", () => {
    const edited = toCsv([{ ...rows[0], Approve: "Y", "Order Qty": 50 }, { ...rows[1], Approve: "yes" }, { ...rows[2], Approve: "" }, { ...base, Type: "BUY", Item: "LID", Vendor: "PACKCO", "Order Qty": 10, Approve: "" }]);
    const reading = readSheet(edited);
    assert.deepEqual(reading.problems, []);
    assert.deepEqual(reading.counts, { rows: 4, buyRows: 3, approved: 2, notApproved: 1 });
    const drafts = draftPurchaseOrders(reading);
    assert.deepEqual(drafts.map((d) => d.vendor), ["BIKEPARTS", "PACKCO"]);
    assert.equal(drafts[0]?.externalId, "mrp-sbx-20260921-1405-BIKEPARTS");
    assert.equal(drafts[0]?.estCost, 1125);
    assert.deepEqual(drafts[0]?.body, { ID: "BIKEPARTS", EXTERNALID: "mrp-sbx-20260921-1405-BIKEPARTS", Details: [{ INVEN: "SADDLE", O_QUAN_VIS: 50, UNIT_MEAS: "Each", UNIT_VIS: 22.5, ETA_DATE: "2026-09-25T00:00:00Z" }] });
});

test("rows that were approved but cannot be ordered are named, not dropped", () => {
    const reading = readSheet(toCsv([
        { ...base, Type: "BUY", Item: "A", Vendor: "(no primary vendor)", "Order Qty": 5, Approve: "Y" },
        { ...base, Type: "BUY", Item: "B", Vendor: "ACME", "Order Qty": 0, Approve: "Y" },
        { ...base, Type: "MAKE", Item: "C", Approve: "Y" },
    ]));
    assert.equal(reading.approved.length, 0);
    assert.match(reading.problems.join("\n"), /A is approved but has no vendor/);
    assert.match(reading.problems.join("\n"), /B is approved but Order Qty "0"/);
    assert.match(reading.problems.join("\n"), /C is marked approved but is a MAKE row/);
    assert.match(readSheet("Name,Qty\r\nx,1\r\n").problems.join("\n"), /does not look like an MRP worksheet/);
});

test("stock units convert into the vendor's unit, whole cases rounded up", () => {
    const units: UnitRow[] = [{ ID: "BAG", UNIT: "EA", MULTIPLIER: 0, MULTIPLY: "Smaller" }, { ID: "BAG", UNIT: "Case", MULTIPLIER: 50, MULTIPLY: "Larger" }, { ID: "ROAST", UNIT: "lb", MULTIPLIER: 0, MULTIPLY: "Smaller" }, { ID: "ROAST", UNIT: "oz", MULTIPLIER: 16, MULTIPLY: "Smaller" }];
    assert.deepEqual(fromBaseUnits("BAG", 60, "Case", units), { qty: 2 });
    assert.deepEqual(fromBaseUnits("BAG", 100, "Case", units), { qty: 2 });
    assert.deepEqual(fromBaseUnits("BAG", 60, "EA", units), { qty: 60 });
    assert.deepEqual(fromBaseUnits("ROAST", 3.75, "oz", units), { qty: 60 });
    assert.match(fromBaseUnits("BAG", 5, "Pallet", units).warning ?? "", /not one of its units/);
});
