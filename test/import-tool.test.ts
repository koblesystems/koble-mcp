/**
 * import_from_csv end to end against a scripted EBMS, with real files on disk. It must never
 * write: every test ends with the write log empty.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { configure } from "../src/config.js";
import { resetAuth } from "../src/ebms/client.js";
import { registerImportTools } from "../src/tools/import-tools.js";
import type { McpToolResult } from "../src/tools/types.js";
import { RAW } from "./import-fixtures.js";

process.env["KOBLE_OUTPUT_DIR"] = await mkdtemp(join(tmpdir(), "koble-imp-out-"));

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
const writes: string[] = [];
const reads: string[] = [];
let startswithWorks = true;
let metadataFails = false;

function reset(): void {
    Object.assign(tables, {
        INVENTRE: [{ AUTOID: "f0", TREE_ID: "($)    1" }, { AUTOID: "f1", TREE_ID: "    1", PARENT_ID: "    0", TREE_DESCR: "Products" }, { AUTOID: "f26", TREE_ID: "   26", PARENT_ID: "    1", TREE_DESCR: "Mugs" }],
        INVENDET: [{ AUTOID: "b1", ID: "BENCH", COMP_ID: "SEAT", QUAN: 1 }],
        APVENDOR: [{ AUTOID: "v1", ID: "BEANCO", F_NAME: "", L_NAME: "Bean Co" }],
        ARTAXGROUP: [{ AUTOID: "t1", TAX_GROUP: "Taxable" }],
        INVENTRY: [
            { AUTOID: "p0", ID: "($)    1", EXTERNALID: "" },
            { AUTOID: "p1", ID: "OLDMUG", EXTERNALID: "" },
            { AUTOID: "p2", ID: "MADE-BEFORE", EXTERNALID: "" },
        ],
        INVENUNT: [{ AUTOID: "u1", ID: "OLDMUG", UNIT: "EA" }, { AUTOID: "u2", ID: "OLDMUG", UNIT: "CASE" }],
        INVENDOR: [{ AUTOID: "d1", ID: "OLDMUG", VENDOR_ID: "BEANCO" }],
        ARCUSTRE: [{ AUTOID: "c1", TREE_ID: "    1", TREE_DESCR: "Retail" }],
        ARCUST: [],
        PYEMPTRE: [{ AUTOID: "w1", TREE_ID: "    1", TREE_DESCR: "Workers" }],
        PYEMP: [],
    });
    writes.length = 0;
    reads.length = 0;
    startswithWorks = true;
    metadataFails = false;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const matches = (row: Row, filter: string): boolean => {
    if (!filter) return true;
    const starts = /startswith\((\w+),'([^']*)'\)/.exec(filter);
    if (starts) return String(row[starts[1] as string] ?? "").startsWith(starts[2] as string);
    // Like EBMS: `eq` is case-sensitive; `toupper(F) eq` compares upper-cased.
    const ors = [...filter.matchAll(/(?:toupper\((\w+)\)|(\w+)) eq '([^']*)'/g)];
    return ors.some(([, upperField, field, value]) => upperField
        ? String(row[upperField] ?? "").trim().toUpperCase() === String(value)
        : String(row[field as string] ?? "").trim() === String(value));
};
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/Token")) return json(200, { AccessToken: "a" });
    if ((init?.method ?? "GET") !== "GET") { writes.push(`${init?.method} ${u.pathname}`); return json(200, {}); }
    const last = decodeURIComponent(u.pathname.split("/").pop() ?? "");
    const filter = u.searchParams.get("$filter") ?? "";
    reads.push(`${last}${filter ? ` ${filter}` : ""}`);
    const meta = /^EntityMetaData\('(\w+)'\)$/.exec(last);
    if (meta) return metadataFails ? json(404, { Messages: [{ Type: "Error", Message: "Not found" }] }) : json(200, { EntityName: meta[1], ...RAW[meta[1] as string] });
    if (filter.startsWith("startswith") && !startswithWorks) return json(400, { Messages: [{ Type: "Error", Message: "Invalid query" }] });
    const rows = (tables[last] ?? []).filter((row) => matches(row, filter));
    return json(200, { "@odata.count": rows.length, value: rows });
}) as typeof fetch;

let tool: (args: unknown) => Promise<McpToolResult>;
registerImportTools((name, def, handler) => { if (name === "import_from_csv") tool = async (args) => handler(def.inputSchema.parse(args) as never); });
const textOf = (r: McpToolResult): string => { const [first] = r.content; return first?.type === "text" ? first.text : "{}"; };
const call = async (args: Record<string, unknown>) => JSON.parse(textOf(await tool({ company: "cof", ...args }))) as Record<string, any>;
const fresh = (env: Record<string, string> = {}) => { configure({ EBMS_SERIAL_NUMBER: "000000000000000", EBMS_USERNAME: "u", EBMS_PASSWORD: "p", EBMS_COMPANIES: "cof,sbx", ...env }); resetAuth(); reset(); };
const file = async (name: string, text: string) => { const dir = await mkdtemp(join(tmpdir(), "koble-imp-")); const path = join(dir, name); await writeFile(path, text); return path; };

const PRODUCTS = [
    "Part Number,Name,Folder,Classification,Cost,Vendor",
    "NEWMUG,New mug,26,2,3.10,BEANCO",
    "BYNAME,Folder by name,Mugs,2,1,",
    "OLDMUG,Already there,26,2,1,",
    "NOFOLDER,Missing folder,Wholesale,2,1,",
    "NOVENDOR,Missing vendor,26,2,1,NOBODY",
    ",,,,,",
    "BADCOST,Bad cost,26,2,ten,",
].join("\n");

test("a product file: mapping, grouped problems, existing rows skipped, names resolved, nothing written", async () => {
    fresh();
    const path = await file("products.csv", PRODUCTS);
    const r = await call({ entity: "INVENTRY", path });
    assert.equal(r.blocked, false);
    assert.ok(r.mapping.includes("Part Number -> ID (Product), by alias"));
    assert.deepEqual(r.counts, { rows: 6, blankRowsSkipped: 1, problemRows: 3, alreadyInEbms: 1, createdEarlier: 0, waitingForParent: 0, ready: 2, drafted: 2 });
    assert.deepEqual(r.drafts.map((d: any) => d.key), ["NEWMUG", "BYNAME"]);
    assert.equal(r.drafts[1].write.body.TREE_ID, "26", "a folder named in the file is sent as its number");
    assert.equal(r.drafts[1].resolved.folder, "26 Mugs");
    assert.equal(r.drafts[0].resolved.vendor, "BEANCO Bean Co");
    assert.match(r.drafts[0].externalId, /^claude-import-[0-9a-f]{6}-r2$/);
    const messages = r.problems.map((p: any) => p.message).join(" | ");
    assert.match(messages, /1 row names a folder that is not in COF: "Wholesale"/);
    assert.match(messages, /1 row names a vendor that is not in COF: "NOBODY"/);
    assert.match(messages, /COST EBMS cannot read: "ten"/);
    assert.match(r.existing.message, /1 products already exist in COF/);
    assert.deepEqual(r.existing.rows, ["Row 4"]);
    assert.equal(r.exceptionsFile, path.replace(/\.csv$/, ".exceptions.xlsx"));
    assert.ok(existsSync(r.exceptionsFile));
    assert.ok(reads.some((x) => x.startsWith("INVENTRY startswith(EXTERNALID,'claude-import-")), "one startswith read for what this import created");
    assert.ok(!reads.some((x) => x.includes("($)")), "the existing check is by key, not a read of folder-default rows");
    assert.deepEqual(writes, []);
});

test("a rerun skips what this import created; a ($) defaults row never counts as existing", async () => {
    fresh();
    const path = await file("products.csv", PRODUCTS);
    const first = await call({ entity: "INVENTRY", path });
    tables["INVENTRY"]!.push({ AUTOID: "n1", ID: "NEWMUG", EXTERNALID: first.drafts[0].externalId });
    const again = await call({ entity: "INVENTRY", path });
    assert.equal(again.importId, first.importId);
    assert.equal(again.counts.createdEarlier, 1);
    assert.deepEqual(again.alreadyCreated.rows, ["Row 2"]);
    assert.deepEqual(again.drafts.map((d: any) => d.key), ["BYNAME"]);
    assert.deepEqual(writes, []);
});

test("where startswith is refused, what was created is found by exact EXTERNALID reads", async () => {
    fresh();
    startswithWorks = false;
    const r = await call({ entity: "INVENTRY", path: await file("products.csv", PRODUCTS) });
    assert.equal(r.blocked, false);
    assert.ok(reads.some((x) => /^INVENTRY EXTERNALID eq 'claude-import-/.test(x)));
    assert.deepEqual(writes, []);
});

test("an xlsx file is read like a CSV, with the sheet's own row numbers", async () => {
    fresh();
    const dir = await mkdtemp(join(tmpdir(), "koble-imp-x-"));
    const book = new ExcelJS.Workbook();
    book.addWorksheet("Items").addRows([["ID", "Name", "Folder", "Classification"], ["XMUG", "x", 26, "Track Count"], ["XLONG-ID-THAT-IS-FAR-TOO-LONG", "y", 26, 2]]);
    const path = join(dir, "items.xlsx");
    await book.xlsx.writeFile(path);
    const r = await call({ entity: "INVENTRY", path });
    assert.deepEqual(r.drafts.map((d: any) => [d.row, d.write.body.C_TYPE, d.write.body.TREE_ID]), [[2, 2, "26"]]);
    assert.deepEqual(r.problems[0].rows, ["Row 3"]);
    assert.deepEqual(writes, []);
});

test("fatal: a semicolon file, a metadata failure, no file at all", async () => {
    fresh();
    const semi = await call({ entity: "INVENTRY", csv: "ID;Name\nA;a\n" });
    assert.equal(semi.blocked, true);
    assert.deepEqual(semi.drafts, []);
    assert.match(semi.fatal[0], /semicolons/);
    metadataFails = true;
    const noMeta = await call({ entity: "INVENTRY", csv: "ID,Name\nA,a\n" });
    assert.equal(noMeta.blocked, true);
    assert.match(noMeta.fatal[0], /could not be read/);
    const none = await call({ entity: "INVENTRY" });
    assert.match(none.needsInput, /Which file/);
    assert.deepEqual(writes, []);
});

test("a sandbox restriction is reported and the drafts still come back", async () => {
    fresh({ EBMS_SANDBOX: "sbx" });
    const r = await call({ entity: "ARCUST", csv: "Last name,Folder\nSmith,Retail\n" });
    assert.match(r.writeBlocked, /EBMS_SANDBOX restricts writes to SBX/);
    assert.equal(r.drafts.length, 1);
    assert.deepEqual(Object.keys(r.drafts[0].write.body), ["TREE_ID", "L_NAME", "EXTERNALID"]);
    assert.equal(r.drafts[0].write.body.TREE_ID, "1");
    assert.equal(r.exceptionsFile, null);
    assert.deepEqual(writes, []);
});

test("child rows: a missing product, a unit the product lacks, and rows already on the product", async () => {
    fresh();
    tables["INVENTRY"]!.push({ AUTOID: "p9", ID: "NEWMUG" });
    const csv = ["Product,Vendor,Part Number,Unit,Cost", "OLDMUG,BEANCO,X1,EA,1", "NEWMUG,BEANCO,N1,BOX,2", "GHOST,BEANCO,G1,,1", "NEWMUG,NOBODY,N2,,1"].join("\n");
    const r = await call({ entity: "INVENDOR", csv });
    assert.equal(r.counts.alreadyInEbms, 1, "OLDMUG already has a BEANCO record");
    const messages = r.problems.map((p: any) => p.message).join(" | ");
    assert.match(messages, /names a product that is not in COF: "GHOST"/);
    assert.match(messages, /names a vendor that is not in COF: "NOBODY"/);
    assert.match(messages, /a unit the product does not have: "BOX"/);
    assert.deepEqual(r.drafts, []);
    assert.deepEqual(writes, []);
});

test("bill of materials: one POST per line; a line the product already has is skipped; a missing component is a problem", async () => {
    fresh();
    tables["INVENTRY"]!.push({ AUTOID: "pb", ID: "BENCH" }, { AUTOID: "pl", ID: "LEG" }, { AUTOID: "ps", ID: "SEAT" });
    const r = await call({ entity: "INVENDET", csv: "Product,Component,Qty\nBENCH,LEG,4\nBENCH,TOP,1\nBENCH,SEAT,1\n" });
    assert.deepEqual(r.drafts.map((d: any) => [d.write.method, d.write.path, d.write.body]), [["POST", "INVENDET", { ID: "BENCH", COMP_ID: "LEG", QUAN: 4 }]]);
    assert.equal(r.counts.alreadyInEbms, 1);
    assert.match(r.problems[0].message, /component product that is not in COF: "TOP"/);
    assert.deepEqual(writes, []);
});

test("folders: matched by name under their parent; a parent in the same file makes the child wait; loops and unknown parents are problems", async () => {
    fresh();
    const csv = ["Folder,Parent,Name", "40,Products,New A", "41,40,Child of A", "42,99,Orphan", ",1,Mugs", "50,51,Loop X", "51,50,Loop Y", ",Mugs,Handles"].join("\n");
    const r = await call({ entity: "INVENTRE", csv });
    assert.deepEqual(r.drafts.map((d: any) => d.write.body), [{ PARENT_ID: "    1", TREE_DESCR: "New A" }, { PARENT_ID: "   26", TREE_DESCR: "Handles" }]);
    assert.equal(r.counts.alreadyInEbms, 1, "Mugs under folder 1 is already there, though EBMS pads its numbers");
    assert.equal(r.counts.waitingForParent, 1);
    const messages = r.problems.map((p: any) => p.message).join(" | ");
    assert.match(messages, /parent folder that is not in COF: "99"/);
    assert.match(messages, /2 folders are their own ancestor/);
    tables["INVENTRE"]!.push({ AUTOID: "f40", TREE_ID: "   40", PARENT_ID: "    1", TREE_DESCR: "New A" });
    const again = await call({ entity: "INVENTRE", csv });
    assert.deepEqual(again.drafts.map((d: any) => d.write.body), [{ PARENT_ID: "   40", TREE_DESCR: "Child of A" }, { PARENT_ID: "   26", TREE_DESCR: "Handles" }], "once its parent exists the child is drafted under EBMS's number");
    assert.deepEqual(writes, []);
});

test("rows whose write failed go to the exceptions file instead of being drafted again", async () => {
    fresh();
    const r = await call({ entity: "ARCUST", path: await file("cust.csv", "Last name,Folder\nSmith,1\nJones,1\n"), failedRows: [{ row: 3, problem: "Could not find customer defaults" }] });
    assert.deepEqual(r.drafts.map((d: any) => d.row), [2]);
    assert.match(r.problems[0].message, /could not be written to EBMS last time/);
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(r.exceptionsFile);
    assert.match(String(book.getWorksheet("Fix these")!.getRow(2).getCell(2).value), /Could not find customer defaults/);
    assert.deepEqual(writes, []);
});

test("workers are reviewed but never drafted: EBMS refuses every worker create through the API", async () => {
    fresh();
    const r = await call({ entity: "PYEMP", csv: "Folder,Last Name,Pay,Frequency,Hire Date\n1,Smith,Hourly,Weekly,2026-10-01\n1,Jones,,Weekly,2026-10-01\n" });
    assert.equal(r.blocked, false);
    assert.deepEqual(r.drafts, []);
    assert.equal(r.counts.problemRows, 1);
    assert.match(r.notes[0], /refuses every worker create/);
    assert.match(r.next, /Review only/);
    assert.deepEqual(writes, []);
});

test("an exceptions file handed back continues the same import and counts only its own rows", async () => {
    fresh();
    const path = await file("products.csv", PRODUCTS);
    const first = await call({ entity: "INVENTRY", path });
    for (const d of first.drafts) tables["INVENTRY"]!.push({ AUTOID: `n${d.row}`, ID: d.key, EXTERNALID: d.externalId });
    const back = await call({ entity: "INVENTRY", path: first.exceptionsFile });
    assert.equal(back.importId, first.importId);
    assert.equal(back.counts.rows, 3);
    assert.equal(back.counts.createdEarlier, 0, "rows created from the original file are not this file's rows");
    assert.deepEqual(back.problems.flatMap((p: any) => p.rows).sort(), ["Row 5", "Row 6", "Row 8"]);
    assert.deepEqual(writes, []);
});

// --- From the adversarial review of PR #11: each of these once went wrong. ---

test("a different file under the same name: rows whose marker sits on another record are flagged, never skipped; newImportId starts afresh", async () => {
    fresh();
    const january = await file("new-customers.csv", "Last name,Folder\nSmith,1\nJones,1\n");
    const first = await call({ entity: "ARCUST", path: january });
    for (const d of first.drafts) tables["ARCUST"]!.push({ AUTOID: `c${d.row}`, ID: "", L_NAME: d.label, EXTERNALID: d.externalId });
    const february = await file("new-customers.csv", "Last name,Folder\nBrown,1\nGreen,1\nWhite,1\n");
    const r = await call({ entity: "ARCUST", path: february });
    assert.equal(r.importId, first.importId, "same name and headers: same import ID");
    assert.equal(r.counts.createdEarlier, 0, "Brown and Green are not reported as created");
    assert.deepEqual(r.problems.find((p: any) => p.kind === "id-taken")?.rows, ["Row 2", "Row 3"]);
    assert.deepEqual(r.drafts.map((d: any) => d.label), ["White"]);
    assert.match(r.newImportId, /^[0-9a-f]{6}$/);
    const fresh2 = await call({ entity: "ARCUST", path: february, importId: r.newImportId });
    assert.deepEqual(fresh2.drafts.map((d: any) => d.label), ["Brown", "Green", "White"]);
    assert.deepEqual(writes, []);
});

test("a row deleted between runs does not hide the row that moves up into its place", async () => {
    fresh();
    const dir = await mkdtemp(join(tmpdir(), "koble-imp-del-"));
    const path = join(dir, "products.csv");
    await writeFile(path, "ID,Folder,Classification\nALPHA,26,2\nBETA,26,2\nGAMMA,26,2\n");
    const first = await call({ entity: "INVENTRY", path });
    for (const d of first.drafts.slice(0, 2)) tables["INVENTRY"]!.push({ AUTOID: `x${d.row}`, ID: d.key, EXTERNALID: d.externalId });
    await writeFile(path, "ID,Folder,Classification\nALPHA,26,2\nGAMMA,26,2\n");
    const r = await call({ entity: "INVENTRY", path });
    assert.equal(r.counts.createdEarlier, 1, "ALPHA only");
    assert.deepEqual(r.problems.find((p: any) => p.kind === "id-taken")?.rows, ["Row 3"], "GAMMA sits on BETA's marker: flagged, not skipped");
    assert.deepEqual(writes, []);
});

test("customers without an ID are recognised on a rerun by name", async () => {
    fresh();
    const path = await file("cust.csv", "Last name,Folder\nSmith,1\nJones,1\n");
    const first = await call({ entity: "ARCUST", path });
    for (const d of first.drafts) tables["ARCUST"]!.push({ AUTOID: `c${d.row}`, ID: `GEN${d.row}`, L_NAME: d.label.toUpperCase(), EXTERNALID: d.externalId });
    const again = await call({ entity: "ARCUST", path });
    assert.equal(again.counts.createdEarlier, 2);
    assert.deepEqual(again.drafts, []);
    assert.deepEqual(writes, []);
});

test("where startswith is refused, an earlier day's creates are still found (the EXTERNALID carries no date)", async () => {
    fresh();
    const path = await file("cust.csv", "Last name,Folder\nSmith,1\n");
    const first = await call({ entity: "ARCUST", path });
    tables["ARCUST"]!.push({ AUTOID: "c2", ID: "SMI", L_NAME: "Smith", EXTERNALID: first.drafts[0].externalId });
    startswithWorks = false;
    const again = await call({ entity: "ARCUST", path });
    assert.equal(again.counts.createdEarlier, 1);
    assert.deepEqual(again.drafts, []);
    assert.deepEqual(writes, []);
});

test("an ID that differs only in case from one in EBMS is the same record (EBMS's eq is case-sensitive)", async () => {
    fresh();
    const r = await call({ entity: "INVENTRY", csv: "ID,Folder,Classification\noldmug,26,2\n" });
    assert.equal(r.counts.alreadyInEbms, 1);
    assert.ok(reads.some((x) => x.includes("toupper(ID) eq 'OLDMUG'")));
    const units = await call({ entity: "INVENUNT", csv: "Product,Unit,Multiply,Multiplier\noldmug,case,Larger,12\n" });
    assert.equal(units.counts.alreadyInEbms, 1, "OLDMUG already has CASE");
    assert.deepEqual(writes, []);
});

test("the same new folder named twice, its parent by number on one row and by name on the other, is drafted once", async () => {
    fresh();
    const r = await call({ entity: "INVENTRE", csv: "Folder,Parent,Name\n,1,Handles\n,Products,Handles\n" });
    assert.equal(r.drafts.length, 1);
    assert.deepEqual(r.problems.find((p: any) => p.kind === "duplicate")?.rows, ["Row 3"]);
    assert.deepEqual(writes, []);
});

test("a parent named by two rows of the file is ambiguous, as it is when both are in EBMS", async () => {
    fresh();
    const r = await call({ entity: "INVENTRE", csv: "Folder,Parent,Name\n,1,Accessories\n,26,Accessories\n,Accessories,Lights\n" });
    assert.deepEqual(r.problems.find((p: any) => p.kind === "ambiguous")?.rows, ["Row 4"]);
    assert.equal(r.counts.waitingForParent, 0);
    assert.deepEqual(writes, []);
});

test("an Excel error or an uncalculated formula is a problem, never a blank", async () => {
    fresh();
    const dir = await mkdtemp(join(tmpdir(), "koble-imp-f-"));
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Items");
    sheet.addRows([["ID", "Folder", "Classification", "Cost"], ["F1", 26, 2, 1], ["F2", 26, 2, 1], ["F3", 26, 2, 1]]);
    sheet.getCell("D3").value = { formula: "1/0", result: { error: "#DIV/0!" } } as ExcelJS.CellFormulaValue;
    sheet.getCell("D4").value = { formula: "A1*2" } as ExcelJS.CellFormulaValue;
    const path = join(dir, "f.xlsx");
    await book.xlsx.writeFile(path);
    const r = await call({ entity: "INVENTRY", path, defaults: { COST: 9 } });
    assert.deepEqual(r.drafts.map((d: any) => d.key), ["F1"]);
    const cell = r.problems.find((p: any) => p.kind === "cell-error");
    assert.deepEqual(cell?.rows, ["Row 3", "Row 4"]);
    assert.match(cell?.message, /#DIV\/0!/);
    assert.deepEqual(writes, []);
});

test("a product without an AUTOID is never PATCHed at INVENTRY('')", async () => {
    fresh();
    tables["INVENTRY"]!.push({ AUTOID: "", ID: "NOAID" });
    const r = await call({ entity: "INVENUNT", csv: "Product,Unit,Multiply,Multiplier\nNOAID,BOX,Larger,6\n" });
    assert.deepEqual(r.drafts, []);
    assert.match(r.problems[0].message, /product that is not in COF: "NOAID"/);
    assert.deepEqual(writes, []);
});

test("a row window on a units file takes every row inside it, whatever row its product starts on", async () => {
    fresh();
    tables["INVENTRY"]!.push({ AUTOID: "pa", ID: "A" }, { AUTOID: "pb", ID: "B" });
    const csv = "Product,Unit,Multiply,Multiplier\nA,U1,Larger,2\nB,U2,Larger,3\nB,U3,Larger,4\nA,U4,Larger,5\n";
    const r = await call({ entity: "INVENUNT", csv, rowsFrom: 4, rowsTo: 5 });
    assert.deepEqual(r.drafts.map((d: any) => d.rows), [[4], [5]]);
    const capped = await call({ entity: "INVENUNT", csv, maxDrafts: 1 });
    assert.deepEqual(capped.drafts.map((d: any) => d.rows), [[2, 5]]);
    assert.equal(capped.nextRowsFrom, 3);
    assert.deepEqual(writes, []);
});

// --- From the October 2026 code review. ---

test("a path into koble's settings or a hidden folder is refused before anything is read, and nothing of it comes back", async () => {
    fresh();
    const settings = await mkdtemp(join(tmpdir(), "koble-cfg-"));
    process.env["KOBLE_CONFIG_DIR"] = settings;
    try {
        await writeFile(join(settings, "credentials.json"), '{"koble-mcp:cof":"b64:c2VjcmV0"}');
        await writeFile(join(settings, "copy.csv"), "{,x\nb64:c2VjcmV0,1\n");
        for (const path of [join(settings, "credentials.json"), join(settings, "copy.csv")]) {
            const r = await call({ entity: "ARCUST", path, mapping: { "{": "L_NAME" } });
            assert.equal(r.blocked, true);
            assert.deepEqual(r.drafts, []);
            assert.ok(!JSON.stringify(r).includes("c2VjcmV0"), path);
        }
        assert.equal(reads.length, 0, "not even EBMS's metadata is read");
    } finally {
        delete process.env["KOBLE_CONFIG_DIR"];
    }
});

test("pasted text corrected and pasted again continues the same import; a customer by the same name and ZIP is reported", async () => {
    fresh();
    const csv = "Last name,Folder,ZIP\nSmith,1,11111\nJones,1,22222\n";
    const first = await call({ entity: "ARCUST", csv });
    for (const d of first.drafts) tables["ARCUST"]!.push({ AUTOID: `c${d.row}`, ID: `GEN${d.row}`, L_NAME: d.label, EXTERNALID: d.externalId });
    const again = await call({ entity: "ARCUST", csv: csv.replace("22222", "22223") });
    assert.equal(again.importId, first.importId);
    assert.equal(again.counts.createdEarlier, 2);
    assert.deepEqual(again.drafts, []);

    fresh();
    tables["ARCUST"]!.push({ AUTOID: "c9", ID: "C0012", L_NAME: "Bean Co", ZIP: "12345-6789" }, { AUTOID: "c10", ID: "C0013", L_NAME: "Other", ZIP: "99999" });
    const r = await call({ entity: "ARCUST", csv: "Last name,Folder,ZIP\nBean Co,1,12345\nOther,1,11111\nNew Co,1,\n" });
    assert.equal(r.counts.drafted, 3, "reported, not skipped: two customers can share a name");
    assert.deepEqual(r.likelyExisting.rows, ["Row 2"]);
    assert.match(r.likelyExisting.matches[0], /^Row 2: C0012 Bean Co 12345-6789$/);
    assert.deepEqual(writes, []);
});

test("an exceptions file handed back for another company is refused", async () => {
    fresh();
    const first = await call({ entity: "INVENTRY", path: await file("products.csv", "ID,Folder,Classification\nGOOD,26,2\nBAD,26,Widget\n") });
    assert.ok(first.exceptionsFile);
    const r = await call({ company: "sbx", entity: "INVENTRY", path: first.exceptionsFile });
    assert.equal(r.blocked, true);
    assert.match(r.fatal.join(" "), /import into COF, not SBX/);
});

test("when the exceptions file cannot be saved beside the source, it goes to the usual folder and the review still comes back", async () => {
    fresh();
    const path = await file("products.csv", "ID,Folder,Classification\nGOOD,26,2\nBAD,26,Widget\n");
    await chmod(join(path, ".."), 0o555);
    try {
        const r = await call({ entity: "INVENTRY", path });
        assert.equal(r.blocked, false);
        assert.equal(r.counts.drafted, 1);
        assert.equal(r.exceptionsFile, join(process.env["KOBLE_OUTPUT_DIR"] as string, "imports", `inventry-${r.importId}.exceptions.xlsx`));
        assert.ok(existsSync(r.exceptionsFile));
        assert.match(r.notes.join(" "), /could not be saved beside the source/);
    } finally {
        await chmod(join(path, ".."), 0o755);
    }
});

test("the exceptions round trip survives a file with its own Row column, and a row the person adds is numbered past the original", async () => {
    fresh();
    const path = await file("products.csv", "Row,ID,Folder,Classification\n1,GOOD,26,2\n2,BAD,26,Widget\n3,ALSO,26,2\n4,WORSE,26,Gadget\n");
    const first = await call({ entity: "INVENTRY", path, mapping: { Row: "" } });
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(first.exceptionsFile);
    const sheet = book.getWorksheet("Fix these")!;
    assert.deepEqual((sheet.getRow(1).values as unknown[]).slice(1), ["⚑ Row", "⚑ Problem", "⚑ Fix", "Row", "ID", "Folder", "Classification"]);
    sheet.getRow(2).getCell(7).value = "2";
    sheet.getRow(3).getCell(7).value = "2";
    sheet.addRow([null, null, null, "9", "EXTRA", "26", "2"]);
    await book.xlsx.writeFile(first.exceptionsFile);
    const back = await call({ entity: "INVENTRY", path: first.exceptionsFile, mapping: { Row: "" } });
    assert.equal(back.blocked, false, JSON.stringify(back.fatal));
    assert.deepEqual(back.drafts.map((d: any) => [d.row, d.key, d.externalId]), [[3, "BAD", `claude-import-${first.importId}-r3`], [5, "WORSE", `claude-import-${first.importId}-r5`], [6, "EXTRA", `claude-import-${first.importId}-r6`]]);
    assert.match(back.notes.join(" "), /numbered from row 6/);
});

test("a later window reads EBMS for its own rows only and leaves the full review's exceptions file alone; a bill of materials reads its products once", async () => {
    fresh();
    const path = await file("products.csv", "ID,Folder,Classification\nA,26,2\nB,26,Widget\nC,26,2\nD,26,2\nE,26,2\n");
    const first = await call({ entity: "INVENTRY", path });
    assert.ok(first.exceptionsFile);
    reads.length = 0;
    const later = await call({ entity: "INVENTRY", path, rowsFrom: 5 });
    assert.deepEqual(later.drafts.map((d: any) => d.key), ["D", "E"]);
    const keyReads = reads.filter((x) => x.startsWith("INVENTRY toupper(ID)")).join(" ");
    assert.match(keyReads, /'D'/);
    assert.doesNotMatch(keyReads, /'A'|'C'/);
    assert.equal(later.exceptionsFile, first.exceptionsFile);
    assert.match(later.notes.join(" "), /left as it is/);

    fresh();
    tables["INVENTRY"]!.push({ AUTOID: "pl", ID: "LEG" });
    await call({ entity: "INVENDET", csv: "Product,Component,Qty\nBENCH,LEG,4\nBENCH,TOP,1\n" });
    assert.equal(reads.filter((x) => x.startsWith("INVENTRY ")).length, 1, "the product and its components in one read");
    assert.deepEqual(writes, []);
});

test("exceptionsTo never overwrites the file being imported, and never goes to a hidden or settings folder", async () => {
    fresh();
    const path = await file("products.csv", "ID,Folder,Classification\nBAD,26,Widget\n");
    const onSource = JSON.parse(textOf(await tool({ company: "cof", entity: "INVENTRY", path, exceptionsTo: path })));
    assert.match(onSource.error.message, /exceptionsTo must name an \.xlsx file/);
    const sameXlsx = await file("book.xlsx", "");
    const book = new ExcelJS.Workbook();
    book.addWorksheet("S").addRow(["ID", "Folder", "Classification"]).worksheet.addRow(["BAD", "26", "Widget"]);
    await book.xlsx.writeFile(sameXlsx);
    assert.match(JSON.parse(textOf(await tool({ company: "cof", entity: "INVENTRY", path: sameXlsx, exceptionsTo: sameXlsx }))).error.message, /would be overwritten/);
    assert.match(JSON.parse(textOf(await tool({ company: "cof", entity: "INVENTRY", path, exceptionsTo: join(homedir(), ".ssh", "x.xlsx") }))).error.message, /hidden folder/);
    assert.equal(existsSync(path), true);
});
