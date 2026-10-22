import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { buildExceptions, exceptionsPath, writeExceptions } from "../src/import/exceptions.js";
import { resolveMapping } from "../src/import/mapping.js";
import { RULES } from "../src/import/rules.js";
import { openSource, readCsvText } from "../src/import/source.js";
import { groupIssues, validateRows } from "../src/import/validate.js";
import { meta } from "./import-fixtures.js";

const CSV = "ID,Name,Folder,Classification,Cost\nGOOD,ok,1,2,5\nBAD,x,1,2,ten\nGOOD2,ok,1,2,5\n00123,leading zeros,1,Widget,1\n";

async function review(source: ReturnType<typeof readCsvText>) {
    const rule = RULES["INVENTRY"]!;
    const m = meta("INVENTRY");
    const v = validateRows(source.rows, rule, m, resolveMapping(source.headers, rule, m));
    const groups = groupIssues(v.issues, { company: "COF", maxLength: () => 0 });
    return { v, built: await buildExceptions(source, v.issues, groups, { company: "COF", entity: "INVENTRY", importId: "abc123" }) };
}

test("the workbook holds only the problem rows: Row, Problem, Fix, then the original columns as they were", async () => {
    const { built } = await review(readCsvText(CSV));
    assert.equal(built.rows, 2);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(built.data as unknown as ArrayBuffer);
    const sheet = book.getWorksheet("Fix these")!;
    const header = (sheet.getRow(1).values as unknown[]).slice(1);
    assert.deepEqual(header, ["Row", "Problem", "Fix", "ID", "Name", "Folder", "Classification", "Cost"]);
    assert.equal(sheet.rowCount, 3);
    assert.deepEqual([sheet.getRow(2).getCell(1).value, sheet.getRow(3).getCell(1).value].sort(), [3, 5]);
    const zeros = [2, 3].map((n) => sheet.getRow(n)).find((r) => r.getCell(1).value === 5)!;
    assert.equal(zeros.getCell(4).value, "00123", "an ID stays text, leading zeros and all");
    assert.match(String(zeros.getCell(2).value), /C_TYPE: "Widget"/);
    assert.deepEqual(sheet.views[0]?.state, "frozen");
    assert.equal(book.getWorksheet("About")!.getRow(1).getCell(2).value, "abc123");
});

test("read back as a source, it keeps the original row numbers and ignores Row, Problem and Fix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "koble-exc-"));
    const original = join(dir, "products.csv");
    await writeFile(original, CSV);
    const source = await openSource({ path: original });
    const { built } = await review(source);
    const path = exceptionsPath(source, "INVENTRY", "abc123");
    assert.equal(path, join(dir, "products.exceptions.xlsx"));
    await writeExceptions(path, built.data);

    const back = await openSource({ path });
    assert.deepEqual(back.fatal, []);
    assert.deepEqual(back.fromExceptions, { importId: "abc123", entity: "INVENTRY" });
    assert.deepEqual(back.headers, ["ID", "Name", "Folder", "Classification", "Cost"]);
    assert.deepEqual(back.rows.map((r) => r.row).sort(), [3, 5]);
    assert.equal(exceptionsPath(back, "INVENTRY", "abc123"), path, "a returned exceptions file is replaced in place, not nested");
    const { v } = await review(back);
    assert.deepEqual(v.issues.map((i) => i.row).sort(), [3, 5], "the messages name the original rows");
});

test("an xlsx source: first sheet by default, a named one on request, a missing one is fatal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "koble-xlsx-"));
    const book = new ExcelJS.Workbook();
    book.addWorksheet("Products").addRows([["ID", "Name"], ["A", "a"], [], ["B", "b"]]);
    book.addWorksheet("Other").addRows([["X"], ["1"]]);
    const path = join(dir, "p.xlsx");
    await book.xlsx.writeFile(path);
    const first = await openSource({ path });
    assert.equal(first.sheet, "Products");
    assert.deepEqual(first.rows.map((r) => [r.row, r.blank]), [[2, false], [3, true], [4, false]]);
    assert.match(first.notes.join(" "), /2 sheets/);
    assert.equal((await openSource({ path, sheet: "Other" })).headers[0], "X");
    assert.match((await openSource({ path, sheet: "Nope" })).fatal.join(" "), /no sheet named "Nope"/);
});

test("a semicolon CSV, an empty file and repeated headers are fatal", () => {
    assert.match(readCsvText("ID;Name\nA;a\n").fatal.join(" "), /semicolons/);
    assert.match(readCsvText("").fatal.join(" "), /no header row/);
    assert.match(readCsvText("ID,Name\n").fatal.join(" "), /no rows/);
    assert.match(readCsvText("ID,id\nA,B\n").fatal.join(" "), /more than once/);
});
