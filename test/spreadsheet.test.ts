/**
 * The shared spreadsheet reader and the import's view of a file: which paths are refused, how
 * text is decoded, how CSV and xlsx cells read. Fixtures are written to a temporary home folder,
 * so the hidden-folder rules are tested without touching the real one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { openSource, readCsvText } from "../src/import/source.js";
import { readWorksheet, saveWorksheet } from "../src/mrp/files.js";
import { cellText, decodeText, openSpreadsheet, parseCsvRecords } from "../src/spreadsheet.js";

const home = await mkdtemp(join(tmpdir(), "koble-home-"));
process.env["HOME"] = home;
process.env["USERPROFILE"] = home;
delete process.env["XDG_CONFIG_HOME"];
delete process.env["KOBLE_CONFIG_DIR"];
const SECRET = "koble-mcp:cof: b64:c2VjcmV0";

const put = async (path: string, data: string | Uint8Array): Promise<string> => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, data);
    return path;
};

test("only spreadsheets are read: not koble's settings, ~/.ssh, ~/.aws, other hidden folders, dotfiles, links to them, or anything over 20 MB", async () => {
    const credentials = await put(join(home, ".config", "koble", "credentials.json"), `{"a":"${SECRET}"}`);
    const disguised = await put(join(home, ".config", "koble", "creds.csv"), `{,${SECRET}\n`);
    const refused = [
        credentials,
        disguised,
        await put(join(home, ".ssh", "keys.csv"), "a,b\n1,2\n"),
        await put(join(home, ".aws", "credentials.txt"), "[default]\n"),
        await put(join(home, ".gnupg", "list.csv"), "a,b\n1,2\n"),
        await put(join(home, "Documents", ".env.csv"), "a,b\n1,2\n"),
        await put(join(home, "Documents", "notes.json"), "{}"),
    ];
    const link = join(home, "Documents", "products.csv");
    await symlink(disguised, link);
    refused.push(link);
    for (const path of refused) {
        const opened = await openSpreadsheet(path);
        assert.equal(opened.ok, false, path);
        assert.ok(!JSON.stringify(opened).includes("c2VjcmV0"), "nothing from inside the file comes back");
        const source = await openSource({ path });
        assert.equal(source.fatal.length, 1, path);
        assert.deepEqual(source.rows, []);
        assert.ok(!JSON.stringify(source).includes("c2VjcmV0"));
    }
    assert.match((await openSource({ path: credentials })).fatal[0] ?? "", /only \.csv, \.tsv, \.txt and \.xlsx/);
    assert.match((await openSource({ path: link })).fatal[0] ?? "", /settings folder/);

    const big = await put(join(home, "Documents", "big.csv"), "");
    await truncate(big, 21 * 1024 * 1024);
    assert.match((await openSource({ path: big })).fatal[0] ?? "", /over 20 MB/);
    assert.equal((await openSpreadsheet(await put(join(home, "Documents", "fine.tsv"), "a\tb\n"))).ok, true);

    // The MRP worksheet reader and writer keep the same rule.
    assert.match((await readWorksheet({ path: disguised }, "BUY")).problems.join(" "), /settings folder/);
    await assert.rejects(saveWorksheet(join(home, ".ssh"), "mrp-x.xlsx", [], { run: "mrp-x-20260101-000000", company: "X", through: "", createdAt: "", lines: {} }, { company: "X", run: "r", from: "", through: "", notes: [] }), /hidden folder/);
});

test("a bare quote inside an unquoted cell is an inch mark, not the start of a quoted field", () => {
    assert.deepEqual(parseCsvRecords('BOLT1,3/4" bolt,1.00\nBOLT2,1/2" bolt,2.00\nBOLT3,washer,3.00'), [["BOLT1", '3/4" bolt', "1.00"], ["BOLT2", '1/2" bolt', "2.00"], ["BOLT3", "washer", "3.00"]]);
    const source = readCsvText('ID,Name,Cost\nBOLT1,3/4" bolt,1.00\nBOLT2,1/2" bolt,2.00\nBOLT3,washer,3.00\n');
    assert.deepEqual(source.rows.map((r) => [r.row, r.cells["ID"], r.cells["Name"]]), [[2, "BOLT1", '3/4" bolt'], [3, "BOLT2", '1/2" bolt'], [4, "BOLT3", "washer"]]);
    assert.match(source.notes.join(" "), /Rows 2, 3 have a " inside a cell/);
    assert.equal(source.rows.some((r) => r.flags), false);
    // Quoted fields still work, doubled quotes and all.
    assert.deepEqual(parseCsvRecords('"a, b","say ""hi""",c'), [["a, b", 'say "hi"', "c"]]);
    // A space before the opening quote: the comma inside splits the row, and the row says so.
    const split = readCsvText('ID,Name,Cost\nA, "Big, red",1\n');
    assert.ok(split.rows[0]?.flags?.["Name"]?.includes("space comes before"));
    assert.ok(split.rows[0]?.flags?.["*"]?.includes("more cells than the header"));
});

test("text is decoded as it was saved: UTF-8, Windows-1252 (with a note), UTF-16 with or without a byte-order mark", async () => {
    const cp1252 = Uint8Array.from([...Buffer.from("ID,Name\nC1,Caf"), 0xe9, ...Buffer.from(" Ren"), 0xe9, 0x0a]);
    const decoded = decodeText(cp1252, "customers.csv");
    assert.equal(decoded.text, "ID,Name\nC1,Café René\n");
    assert.match(decoded.note ?? "", /not UTF-8/);
    assert.equal(decodeText(Buffer.from("ID,Name\nC1,Café René\n"), "x").note, undefined);
    const text = "ID\tName\r\nC1\tCafé René\r\n";
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    assert.equal(decodeText(le, "x").text.replace(/^﻿/, ""), text);
    assert.equal(decodeText(Buffer.from(text, "utf16le"), "x").text, text);
    const be = Buffer.from(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]));
    assert.equal(decodeText(be, "x").text.replace(/^﻿/, ""), text);

    const dir = join(home, "Documents");
    const fromExcel = await openSource({ path: await put(join(dir, "cp1252.csv"), cp1252) });
    assert.equal(fromExcel.rows[0]?.cells["Name"], "Café René");
    assert.match(fromExcel.notes.join(" "), /Windows/);
    const unicode = await openSource({ path: await put(join(dir, "unicode.txt"), le) });
    assert.deepEqual(unicode.headers, ["ID", "Name"], "Excel's Unicode Text: UTF-16, tab-separated, no NULs in the headers");
    assert.equal(unicode.rows[0]?.cells["Name"], "Café René");
});

test("tab-separated text, as a paste from a spreadsheet carries it, is read like CSV", () => {
    const source = readCsvText("ID\tName\tCost\nMUG\tBlue mug, large\t4.50\n");
    assert.deepEqual(source.headers, ["ID", "Name", "Cost"]);
    assert.deepEqual(source.rows[0]?.cells, { ID: "MUG", Name: "Blue mug, large", Cost: "4.50" });
    assert.deepEqual(readCsvText("ID,Name\nA,b\tc\n").headers, ["ID", "Name"], "a stray tab does not make a comma file tab-separated");
});

test("xlsx cells read as a person sees them: 6% is 6%, 00123 keeps its zeros, long numbers in full, a rich-text link as its text", () => {
    assert.equal(cellText(0.06, "0%"), "6%");
    assert.equal(cellText(0.0625, "0.00%"), "6.25%");
    assert.equal(cellText(0.07, '0.0" %"'), "0.07", "a % inside quotes is text, not a percent format");
    assert.equal(cellText(123, "00000"), "00123");
    assert.equal(cellText(1250, "#,##0.00"), "1250");
    assert.equal(cellText(1.23456789012e21), "1234567890120000000000");
    assert.equal(cellText(1e-7), "0.0000001");
    assert.equal(cellText({ text: { richText: [{ text: "Bean " }, { text: "Co" }] }, hyperlink: "https://example.com" } as unknown as ExcelJS.CellValue), "Bean Co");
    assert.equal(cellText({ formula: "A1", result: 0.06 } as ExcelJS.CellValue, "0%"), "6%");
});

test("a workbook: the first visible sheet is read, a title above the headers is passed over, formatted cells keep their meaning", async () => {
    const book = new ExcelJS.Workbook();
    const hidden = book.addWorksheet("Lookups", { state: "hidden" });
    hidden.addRow(["Not", "this"]);
    const sheet = book.addWorksheet("Rates");
    sheet.addRow(["Tax rates 2026"]);
    sheet.mergeCells("A1:C1");
    sheet.addRow(["ID", "Rate", "ZIP"]);
    const row = sheet.addRow(["ST", 0.06, 123]);
    row.getCell(2).numFmt = "0%";
    row.getCell(3).numFmt = "00000";
    const path = join(home, "Documents", "rates.xlsx");
    await book.xlsx.writeFile(path);
    const source = await openSource({ path });
    assert.equal(source.sheet, "Rates");
    assert.deepEqual(source.fatal, []);
    assert.deepEqual(source.headers, ["ID", "Rate", "ZIP"]);
    assert.deepEqual(source.rows.map((r) => [r.row, r.cells]), [[3, { ID: "ST", Rate: "6%", ZIP: "00123" }]]);
    assert.match(source.notes.join(" "), /reads as a title/);
    assert.match(source.notes.join(" "), /Hidden sheets were passed over/);
    assert.equal((await openSource({ path, sheet: "Lookups" })).headers[0], "Not", "a hidden sheet can still be asked for by name");
});
