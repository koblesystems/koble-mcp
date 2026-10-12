/**
 * import_from_csv end to end against a scripted EBMS, with real files on disk. It must never
 * write: every test ends with the write log empty.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    const ors = [...filter.matchAll(/(\w+) eq '([^']*)'/g)];
    return ors.some(([, field, value]) => String(row[field as string] ?? "").trim().toUpperCase() === String(value).toUpperCase());
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
    assert.match(r.drafts[0].externalId, /^claude-import-[0-9a-f]{6}-\d{4}-\d{2}-\d{2}-r2$/);
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
