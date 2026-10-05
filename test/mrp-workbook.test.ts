import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { checkCode, type RunManifest, type SheetRow } from "../src/mrp/csv.js";
import { readWorksheet, saveWorksheet } from "../src/mrp/files.js";
import { buildWorkbook, orderRows, readWorkbook } from "../src/mrp/workbook.js";

const RUN = "mrp-sbx-20261005-120000";
const base = { Run: RUN, Company: "SBX" };
const rows: SheetRow[] = [
    { ...base, Line: "L0001", Type: "BUY", Item: "SADDLE", Description: "Bike saddle", Vendor: "BIKEPARTS", "Purchase Unit": "EA", "Order Qty": 4, "Unit Cost": 22.5, "Needed By": "2026-10-20", Why: "SO 1209 (4)" },
    { ...base, Line: "L0002", Type: "BUY", Item: "CRANK", Vendor: "IKAWA", "Purchase Unit": "EA", "Order Qty": 10, "Needed By": "2026-10-05", "Order By": "2026-06-07", "Lead Days": 120 },
    { ...base, Line: "L0003", Type: "BUY", Item: "0012345", Vendor: "(no primary vendor)", "Order Qty": 1, "Needed By": "2026-10-05" },
    { ...base, Line: "L0004", Type: "MAKE", Item: "BREAD", "Purchase Unit": "EA", "Order Qty": 3, "Needed By": "2026-10-07" },
    { ...base, Line: "L0005", Type: "EXPEDITE", Item: "BAG", Document: "PO#185", Recommendation: "Confirm PO#185 (60) will arrive by 2026-10-05" },
    { ...base, Line: "L0006", Type: "OK", Item: "FLOUR", Recommendation: "Nothing to do" },
];
for (const row of rows) row.Check = checkCode(RUN, String(row.Line), String(row.Item));
const context = { company: "SBX", run: RUN, from: "2026-10-05", through: "2026-11-04", notes: ["13 items have a lead time."] };
const manifest: RunManifest = {
    run: RUN, company: "SBX", through: "2026-11-04", createdAt: "2026-10-05T12:00:00Z",
    lines: Object.fromEntries(rows.map((row) => [String(row.Line), { type: String(row.Type), item: String(row.Item), vendor: String(row.Vendor ?? ""), partNo: "", purchaseUnit: String(row["Purchase Unit"] ?? ""), orderQty: typeof row["Order Qty"] === "number" ? row["Order Qty"] : null, unitCost: typeof row["Unit Cost"] === "number" ? row["Unit Cost"] : null, neededBy: String(row["Needed By"] ?? "") }])),
};

test("buys are grouped by vendor, the most urgent vendor first, and lines with no vendor last", () => {
    assert.deepEqual(orderRows(rows.filter((r) => r.Type === "BUY")).map((r) => r.Item), ["CRANK", "SADDLE", "0012345"]);
});

test("the workbook has a tab per decision, editable cells, a dropdown, a live cost and the run's ids hidden", async () => {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await buildWorkbook(rows, context)) as unknown as ArrayBuffer);
    assert.deepEqual(book.worksheets.map((s) => s.name), ["Summary", "To order", "To make", "Follow up", "All items"]);
    const order = book.getWorksheet("To order")!;
    const header = (order.getRow(1).values as unknown[]).slice(1);
    assert.deepEqual(header.slice(0, 5), ["Approve", "Qty", "Unit", "Vendor", "Item"]);
    const col = (name: string) => order.getColumn(header.indexOf(name) + 1);
    assert.equal(col("Run").hidden, true);
    assert.equal(col("Check").hidden, true);
    assert.equal(col("Vendor part no").hidden, true, "a column empty on every row is hidden");
    assert.equal(col("Order by").hidden, false);
    assert.deepEqual(order.getCell("A2").dataValidation.formulae, ['"Yes,No"']);
    const cost = order.getRow(3).getCell(header.indexOf("Est cost") + 1).value as ExcelJS.CellFormulaValue;
    assert.match(cost.formula, /ISNUMBER\(B3\).*B3\*L3/, "SADDLE's cost is Qty × unit cost, live");
    const late = order.getRow(2).getCell(header.indexOf("Order by") + 1);
    assert.equal((late.value as Date).toISOString().slice(0, 10), "2026-06-07");
    assert.equal(late.font?.bold, true, "an order-by date already passed stands out");
    assert.equal(order.getRow(4).getCell(header.indexOf("Item") + 1).value, "0012345", "a numeric-looking ID stays text");
    assert.equal(book.getWorksheet("Follow up")!.rowCount, 2);
    assert.equal(book.getWorksheet("All items")!.rowCount, rows.length + 1);
});

test("rows approved in the workbook come back through the same checks as the CSV", async () => {
    const dir = await mkdtemp(join(tmpdir(), "koble-wb-"));
    const saved = await saveWorksheet(dir, `${RUN}.xlsx`, rows, manifest, context);
    // What a person does in Excel: approve CRANK with a new quantity, and BREAD on the other tab.
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(saved.path);
    const order = book.getWorksheet("To order")!;
    order.getCell("A2").value = "Yes";
    order.getCell("B2").value = 12;
    book.getWorksheet("To make")!.getCell("A2").value = "Yes";
    await book.xlsx.writeFile(saved.path);

    const buys = await readWorksheet({ path: saved.path }, "BUY");
    assert.deepEqual(buys.problems, []);
    assert.equal(buys.fromManifest, true);
    assert.deepEqual(buys.approved.map((l) => [l.row, l.item, l.vendor, l.qty, l.changes]), [["To order row 2", "CRANK", "IKAWA", 12, ["quantity 10 → 12"]]]);
    const makes = await readWorksheet({ path: saved.path }, "MAKE");
    assert.deepEqual(makes.problems, []);
    assert.deepEqual(makes.approved.map((l) => [l.row, l.item, l.qty]), [["To make row 2", "BREAD", 3]]);
    assert.ok((await readFile(join(dir, "runs", `${RUN}.json`), "utf8")).includes(RUN), "the run record is saved beside it");
});

test("a changed Check cell, a renamed tab and a file that is not a workbook are all refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "koble-wb-"));
    const saved = await saveWorksheet(dir, `${RUN}.xlsx`, rows, manifest, context);
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(saved.path);
    const order = book.getWorksheet("To order")!;
    const header = (order.getRow(1).values as unknown[]).slice(1);
    order.getCell("A3").value = "Yes";
    order.getRow(3).getCell(header.indexOf("Check") + 1).value = "k00000000";
    book.getWorksheet("To make")!.name = "Make";
    await book.xlsx.writeFile(saved.path);
    const reading = await readWorksheet({ path: saved.path }, "BUY");
    assert.equal(reading.approved.length, 0);
    assert.ok(reading.problems.some((p) => p.startsWith("To order row 3: this row does not match")));
    assert.ok(!reading.problems.some((p) => p.includes("To make")), "the other tab is not this tool's business");
    assert.ok((await readWorksheet({ path: saved.path }, "MAKE")).problems.some((p) => p.includes('no "To make" tab')));

    const junk = join(dir, "junk.xlsx");
    await writeFile(junk, "not a zip");
    assert.match((await readWorkbook(await readFile(junk))).problems[0] ?? "", /could not be opened/);
});
