/**
 * ebms_export against a scripted fetch, and ebms_get's cap that points to it. Nothing here
 * reaches the network; files go to a temporary folder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { configure } from "../src/config.js";
import { resetAuth } from "../src/ebms/client.js";
import { registerExportTools } from "../src/tools/export-tools.js";
import { GET_ROW_CAP, registerProxyTools } from "../src/tools/proxy-tools.js";
import type { McpToolResult } from "../src/tools/types.js";

const out = await mkdtemp(join(tmpdir(), "koble-export-"));
process.env["KOBLE_EXPORT_DIR"] = out;
// A temporary home folder, so the hidden-folder rule is tested without touching the real one, and
// koble's settings in an ordinary-looking folder, so that reason is tested apart on every system.
const home = await mkdtemp(join(tmpdir(), "koble-home-"));
process.env["HOME"] = home;
process.env["USERPROFILE"] = home;
const settings = join(home, "Koble Settings");
process.env["KOBLE_CONFIG_DIR"] = settings;

type Handler = (args: unknown) => Promise<McpToolResult>;
const tools: Record<string, Handler> = {};
const register = (name: string, def: { inputSchema: { parse: (a: unknown) => unknown } }, handler: (a: never) => Promise<McpToolResult>) => {
    tools[name] = async (args) => handler(def.inputSchema.parse(args) as never);
};
registerProxyTools(register as never);
registerExportTools(register as never);
const call = async (name: string, args: unknown): Promise<Record<string, unknown> & { isError?: boolean | undefined; raw: string }> => {
    const result = await (tools[name] as Handler)(args);
    const [first] = result.content;
    const raw = first?.type === "text" ? first.text : "{}";
    return { ...(JSON.parse(raw) as Record<string, unknown>), isError: result.isError, raw };
};

let requests: URL[] = [];
let serve: (u: URL) => Response = () => new Response(JSON.stringify({ value: [] }), { status: 200 });
globalThis.fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/Token")) return new Response(JSON.stringify({ AccessToken: "a" }), { status: 200 });
    requests.push(u);
    return serve(u);
}) as typeof fetch;

/** A collection of `rows`, paged by $skip/$top as EBMS does, with or without a count. */
const pages = (rows: Array<Record<string, unknown>>, withCount = true) => (u: URL): Response => {
    const skip = Number(u.searchParams.get("$skip") ?? 0);
    const top = Number(u.searchParams.get("$top") ?? rows.length);
    return new Response(JSON.stringify({ value: rows.slice(skip, skip + top), ...(withCount ? { "@odata.count": rows.length } : {}) }), { status: 200 });
};
const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ AUTOID: `L${String(i).padStart(5, "0")}`, INVEN: `P${i % 7}`, QUAN: i % 10, DESCR: i === 0 ? 'Bolt, "hex"\nlong' : `Item ${i}` }));

const fresh = (env: Record<string, string> = {}) => {
    configure({ EBMS_SERIAL_NUMBER: "000000000000000", EBMS_USERNAME: "u", EBMS_PASSWORD: "p", EBMS_COMPANIES: "sbx,live", EBMS_SANDBOX: "sbx", ...env });
    resetAuth();
    requests = [];
};

test("an export pages to the end, writes every row to a CSV, and returns only a summary", async () => {
    fresh();
    const all = lines(1234);
    serve = pages(all);
    const r = await call("ebms_export", { company: "live", path: "ARINVDET", select: "INVEN,QUAN,DESCR", filter: "STATUS eq 'SalesOrder'", pageSize: 500 });
    assert.equal(r.isError, undefined, r.raw);
    assert.equal(r.rows, 1234);
    assert.equal(r.pages, 3);
    assert.deepEqual(requests.map((u) => u.searchParams.get("$skip")), ["0", "500", "1000"]);
    assert.ok(requests.every((u) => u.pathname.endsWith("/MyEbms/LIVE/OData/ARINVDET")), "reads are allowed outside the sandbox, as for ebms_get");
    assert.ok(requests.every((u) => u.searchParams.get("$orderby") === "AUTOID" && u.searchParams.get("$filter") === "STATUS eq 'SalesOrder'"));
    assert.equal(requests[0]?.searchParams.get("$select"), "AUTOID,INVEN,QUAN,DESCR");

    assert.deepEqual(r.columns, ["INVEN", "QUAN", "DESCR", "AUTOID"]);
    assert.equal((r.sample as unknown[]).length, 5);
    const quan = (r.numeric as Record<string, { min: number; max: number; sum: number; count: number }>)["QUAN"];
    assert.deepEqual(quan, { min: 0, max: 9, sum: all.reduce((s, row) => s + row.QUAN, 0), count: 1234 });
    assert.equal((r.numeric as Record<string, unknown>)["INVEN"], undefined, "text columns have no numeric summary");
    assert.ok(r.raw.length < 5000, `the result stays small (${r.raw.length} chars)`);
    assert.ok(!r.raw.includes("Item 1000"), "bulk rows never come back");

    const path = String(r.path);
    assert.ok(path.startsWith(out) && path.endsWith(".csv"));
    const csv = (await readFile(path, "utf8")).split("\r\n");
    assert.equal(csv[0], "INVEN,QUAN,DESCR,AUTOID");
    assert.equal(csv[1], 'P0,0,"Bolt, ""hex""\nlong",L00000');
    assert.equal(csv.filter(Boolean).length, 1235);
    assert.deepEqual((await readdir(out)).filter((name) => name.endsWith(".part")), [], "no temporary file is left behind");
});

test("without a count, paging reads on until an empty page; a repeated row is written once", async () => {
    fresh();
    const all = lines(120);
    serve = (u) => {
        const skip = Number(u.searchParams.get("$skip"));
        // The second page overlaps the first by 10 rows, as when a row is inserted mid-read.
        const from = skip === 50 ? 40 : skip;
        return new Response(JSON.stringify({ value: all.slice(from, from + 50) }), { status: 200 });
    };
    const r = await call("ebms_export", { company: "sbx", path: "ARINVDET", select: "AUTOID,QUAN", pageSize: 50, format: "jsonl" });
    assert.equal(r.isError, undefined, r.raw);
    assert.deepEqual(requests.map((u) => u.searchParams.get("$skip")), ["0", "50", "100", "120"]);
    assert.match((r.notes as string[]).join(" "), /did not report a count/);
    const written = (await readFile(String(r.path), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { AUTOID: string });
    assert.equal(new Set(written.map((row) => row.AUTOID)).size, written.length);
    assert.equal(r.rows, written.length);
    assert.equal(written.length, 110, "rows 40-49 came twice and were kept once");
});

test("an entity that will not sort by AUTOID falls back to the server's order on the first page", async () => {
    fresh();
    serve = (u) => (u.searchParams.get("$orderby") ? new Response(JSON.stringify({ Messages: [{ TextBriefDescription: "Invalid query" }] }), { status: 422 }) : pages(lines(30))(u));
    const r = await call("ebms_export", { company: "sbx", path: "INVENTRY", select: "AUTOID,QUAN", pageSize: 20 });
    assert.equal(r.rows, 30);
    assert.equal(r.ordered, false);
    assert.match((r.notes as string[]).join(" "), /would not sort by AUTOID/);
});

test("xlsx is a real workbook with a header row and every row", async () => {
    fresh();
    serve = pages(lines(60).map(({ AUTOID, INVEN, QUAN }) => ({ AUTOID, INVEN, QUAN })));
    const r = await call("ebms_export", { company: "sbx", path: "ARINVDET", select: "AUTOID,INVEN,QUAN", format: "xlsx", filename: "lines" });
    assert.equal(r.isError, undefined, r.raw);
    assert.match(String(r.path), /lines\.xlsx$/);
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(String(r.path));
    const sheet = book.getWorksheet("Export");
    assert.ok(sheet);
    assert.deepEqual((sheet.getRow(1).values as unknown[]).slice(1), ["AUTOID", "INVEN", "QUAN"]);
    assert.equal(sheet.actualRowCount, 61);
    assert.equal(sheet.getRow(3).getCell(3).value, 1);

    // The same name again gets a new file, never an overwrite.
    const again = await call("ebms_export", { company: "sbx", path: "ARINVDET", select: "AUTOID,INVEN,QUAN", format: "xlsx", filename: "lines" });
    assert.match(String(again.path), /lines-2\.xlsx$/);
});

test("expanded collections become JSON text in a cell, and nested objects become dotted columns", async () => {
    fresh();
    serve = pages([{ AUTOID: "O1", INVOICE: "1", "@odata.etag": "x", Customer: { NAME: "Smith" }, Details: [{ INVEN: "A" }] }]);
    const r = await call("ebms_export", { company: "sbx", path: "ARINV", select: "AUTOID,INVOICE", expand: "Details($select=INVEN),Customer($select=NAME)" });
    assert.deepEqual(r.columns, ["AUTOID", "INVOICE", "Customer.NAME", "Details"]);
    assert.equal(requests[0]?.searchParams.get("$top"), "25", "pages are smaller with an expand");
    assert.match((r.notes as string[]).join(" "), /pass explode/);
    const csv = await readFile(String(r.path), "utf8");
    assert.match(csv, /O1,1,Smith,"\[\{""INVEN"":""A""\}\]"/);
});

test("explode writes one row per line through the parent, so line _VIS fields are the real ones", async () => {
    fresh();
    serve = pages([
        { AUTOID: "P1", INVOICE: "182", Details: [{ INVEN: "TUBE", O_QUAN_VIS: 35 }, { INVEN: "TIRE", O_QUAN_VIS: 4 }] },
        { AUTOID: "P2", INVOICE: "183", Details: [] },
    ]);
    const r = await call("ebms_export", { company: "sbx", path: "APINV", select: "AUTOID,INVOICE", expand: "Details($select=INVEN,O_QUAN_VIS)", explode: "Details" });
    assert.equal(r.isError, undefined, r.raw);
    assert.equal(r.records, 2);
    assert.equal(r.rows, 3, "two lines, and the PO with none keeps one row");
    assert.deepEqual(r.columns, ["AUTOID", "INVOICE", "Details.INVEN", "Details.O_QUAN_VIS"]);
    assert.deepEqual((r.numeric as Record<string, unknown>)["Details.O_QUAN_VIS"], { min: 4, max: 35, sum: 39, count: 2 });
    const csv = (await readFile(String(r.path), "utf8")).trim().split("\r\n");
    assert.deepEqual(csv.slice(1), ["P1,182,TUBE,35", "P1,182,TIRE,4", "P2,183,,"]);

    const jsonl = await call("ebms_export", { company: "sbx", path: "APINV", select: "AUTOID,INVOICE", expand: "Details($select=INVEN,O_QUAN_VIS)", format: "jsonl" });
    const first = JSON.parse((await readFile(String(jsonl.path), "utf8")).split("\n")[0] ?? "{}") as { Details: unknown[] };
    assert.equal(first.Details.length, 2, "jsonl keeps the nested lines as they came");

    const wrong = await call("ebms_export", { company: "sbx", path: "APINV", select: "AUTOID", explode: "Details" });
    assert.match(String((wrong.error as { message: string }).message), /expand does not include/);
});

test("the company allowlist applies exactly as for ebms_get, and nothing is sent for a bad request", async () => {
    fresh();
    const unknown = await call("ebms_export", { company: "other", path: "ARINVDET", select: "AUTOID" });
    assert.equal(unknown.isError, true);
    const unnamed = await call("ebms_export", { path: "ARINVDET", select: "AUTOID" });
    assert.match(String((unnamed.error as { message: string }).message), /Name the company/);
    const keyed = await call("ebms_export", { company: "sbx", path: "ARINV('X')", select: "AUTOID" });
    assert.match(String((keyed.error as { message: string }).message), /entity set/);
    const crafted = await call("ebms_export", { company: "sbx", path: "ARINV/../../LIVE/OData/ARINV", select: "AUTOID" });
    assert.equal(crafted.isError, true);
    const path = await call("ebms_export", { company: "sbx", path: "ARINVDET", select: "AUTOID", filename: "../escape" });
    assert.match(String((path.error as { message: string }).message), /plain file name/);
    assert.equal(requests.length, 0);
});

test("an export bigger than maxRows is refused after the first page, and leaves no file", async () => {
    fresh();
    serve = pages(lines(300));
    const before = await readdir(out);
    const r = await call("ebms_export", { company: "sbx", path: "ARINVDET", select: "AUTOID", maxRows: 100, filename: "toobig" });
    assert.equal(r.isError, true);
    assert.match(String((r.error as { message: string }).message), /more than maxRows/);
    assert.equal(requests.length, 1);
    assert.deepEqual(await readdir(out), before);
});

test("a page that fails part-way fails the export and leaves no partial file", async () => {
    fresh();
    const all = lines(100);
    serve = (u) => (u.searchParams.get("$skip") === "50" ? new Response("", { status: 504 }) : pages(all)(u));
    const before = await readdir(out);
    const r = await call("ebms_export", { company: "sbx", path: "ARINVDET", select: "AUTOID", pageSize: 50 });
    assert.equal(r.isError, true);
    assert.equal(r.uncertain, true);
    assert.match(String(r.advice), /safe to try again/);
    assert.deepEqual(await readdir(out), before);
});

test("ebms_get without top shows at most the cap and points to ebms_export", async () => {
    fresh();
    serve = () => new Response(JSON.stringify({ "@odata.count": 900, value: lines(900) }), { status: 200 });
    const r = await call("ebms_get", { company: "sbx", path: "ARINVDET", select: "AUTOID,QUAN" });
    assert.equal(r.returned, GET_ROW_CAP);
    assert.equal(r.received, 900);
    assert.equal(r.truncated, true);
    assert.match((r.warnings as string[]).join(" "), /ebms_export/);

    serve = () => new Response(JSON.stringify({ "@odata.count": 900, value: lines(300) }), { status: 200 });
    const asked = await call("ebms_get", { company: "sbx", path: "ARINVDET", select: "AUTOID,QUAN", top: 300 });
    assert.equal(asked.returned, 300, "an explicit top is honoured while it fits");
    assert.equal(asked.received, undefined);
});

test("ebms_get never returns more than the byte cap, even with a top", async () => {
    fresh();
    const wide = Array.from({ length: 400 }, (_, i) => ({ AUTOID: `W${i}`, NOTE: "x".repeat(1000) }));
    serve = () => new Response(JSON.stringify({ value: wide }), { status: 200 });
    const r = await call("ebms_get", { company: "sbx", path: "ARINVDET", select: "AUTOID,NOTE", top: 400 });
    assert.ok((r.returned as number) < 400 && (r.returned as number) > 100);
    assert.equal(r.truncated, true);
    assert.ok(r.raw.length < 200_000);
});

test("without a count, a server page limit below pageSize does not cut the export short", async () => {
    fresh();
    const all = lines(350);
    // EBMS caps every page at 100 rows whatever $top says, and sends no count.
    serve = (u) => {
        const skip = Number(u.searchParams.get("$skip"));
        return new Response(JSON.stringify({ value: all.slice(skip, skip + 100) }), { status: 200 });
    };
    const r = await call("ebms_export", { company: "sbx", path: "ARINVDET", select: "AUTOID", pageSize: 500, format: "jsonl" });
    assert.equal(r.isError, undefined, r.raw);
    assert.equal(r.rows, 350);
});

test("a server that ignores $skip is stopped after one repeated page, not thousands", async () => {
    fresh();
    const all = lines(100);
    serve = () => new Response(JSON.stringify({ value: all }), { status: 200 });
    const before = await readdir(out);
    const r = await call("ebms_export", { company: "sbx", path: "ARINVDET", select: "AUTOID", pageSize: 100 });
    assert.equal(r.isError, true);
    assert.match(r.raw, /same 100 rows again/);
    assert.equal(requests.length, 2);
    assert.deepEqual(await readdir(out), before);
});

test("CSV cells that Excel would run as formulas are escaped; numbers are not", async () => {
    fresh();
    serve = pages([
        { AUTOID: "F1", DESCR: '=HYPERLINK("http://x","click")', QUAN: -5 },
        { AUTOID: "F2", DESCR: "@SUM(1)", QUAN: 3 },
        { AUTOID: "F3", DESCR: "plain", QUAN: 1 },
    ]);
    const r = await call("ebms_export", { company: "sbx", path: "ARINVDET", select: "AUTOID,DESCR,QUAN", filename: "formulas" });
    assert.equal(r.isError, undefined, r.raw);
    const csv = (await readFile(String(r.path), "utf8")).split("\r\n");
    assert.equal(csv[1], `F1,"'=HYPERLINK(""http://x"",""click"")",-5`);
    assert.equal(csv[2], `F2,"'@SUM(1)",3`);
    assert.equal(csv[3], "F3,plain,1");
    assert.match((r.notes as string[]).join(" "), /2 text cells/);
});

test("with explode, the parent's numbers are summed once per record, not once per line", async () => {
    fresh();
    serve = pages([
        { AUTOID: "I1", TOTAL: 100, Details: [{ QUAN: 1 }, { QUAN: 2 }, { QUAN: 3 }] },
        { AUTOID: "I2", TOTAL: 50, Details: [{ QUAN: 4 }] },
    ]);
    const r = await call("ebms_export", { company: "sbx", path: "ARINV", select: "AUTOID,TOTAL", expand: "Details($select=QUAN)", explode: "Details" });
    assert.equal(r.isError, undefined, r.raw);
    assert.equal(r.rows, 4);
    const numeric = r.numeric as Record<string, { sum: number; count: number }>;
    assert.deepEqual([numeric["TOTAL"]?.sum, numeric["TOTAL"]?.count], [150, 2]);
    assert.deepEqual([numeric["Details.QUAN"]?.sum, numeric["Details.QUAN"]?.count], [10, 4]);
});

test("two exports with the same filename at once each get their own file", async () => {
    fresh();
    serve = pages(lines(300));
    const [a, b] = await Promise.all([
        call("ebms_export", { company: "sbx", path: "ARINVDET", select: "AUTOID,QUAN", pageSize: 50, filename: "same" }),
        call("ebms_export", { company: "sbx", path: "ARINVDET", select: "AUTOID,QUAN", pageSize: 50, filename: "same" }),
    ]);
    assert.equal(a.isError, undefined, a.raw);
    assert.equal(b.isError, undefined, b.raw);
    assert.notEqual(a.path, b.path);
    for (const r of [a, b]) assert.equal((await readFile(String(r.path), "utf8")).split("\r\n").filter(Boolean).length, 301);
});

test("a folder that does not exist is refused, not created", async () => {
    fresh();
    serve = pages(lines(10));
    const missing = await call("ebms_export", { company: "sbx", path: "ARINVDET", select: "AUTOID", folder: join(out, "no", "such") });
    assert.equal(missing.isError, true);
    assert.match(missing.raw, /does not exist/);
});

// chmod does not stop writes on Windows, nor for root.
test("a folder that cannot be written to fails the call, not the server", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
    fresh();
    serve = pages(lines(10));
    const locked = await mkdtemp(join(out, "locked-"));
    await chmod(locked, 0o500);
    try {
        const r = await call("ebms_export", { company: "sbx", path: "ARINVDET", select: "AUTOID", folder: locked });
        assert.equal(r.isError, true);
        assert.match(r.raw, /EACCES|EPERM/);
    } finally {
        await chmod(locked, 0o700);
    }
});

test("a folder named for the export is never koble's settings, ~/.ssh, ~/.aws, another hidden folder, or a link to one", async () => {
    fresh();
    serve = pages(lines(10));
    const documents = join(home, "Documents");
    for (const folder of [settings, join(home, ".ssh"), join(home, ".aws"), join(home, ".config", "other"), documents]) await mkdir(folder, { recursive: true });
    // A junction on Windows needs no special rights; elsewhere the type is ignored.
    await symlink(join(home, ".aws"), join(documents, "reports"), "junction");
    await symlink(settings, join(documents, "settings"), "junction");
    // The real path of the home folder: on Windows the long form of an 8.3 name (RUNNER~1), on macOS /private/var.
    const long = realpathSync.native(home);
    const refused: Array<[string, RegExp]> = [
        [settings, /settings folder/],
        [join(settings, "..", "Koble Settings"), /settings folder/],
        [join(home, ".ssh"), /hidden folder/],
        [join(home, ".config", "other"), /hidden folder/],
        [join(long, ".ssh"), /hidden folder/],
        [join(documents, "reports"), /hidden folder/],
        [join(documents, "settings"), /settings folder/],
    ];
    for (const [folder, why] of refused) {
        requests = [];
        const r = await call("ebms_export", { company: "sbx", path: "ARINVDET", select: "AUTOID", folder });
        assert.equal(r.isError, true, folder);
        assert.match(r.raw, why, folder);
        assert.equal(requests.length, 0, "nothing is read for a refused folder");
    }
    for (const folder of [settings, join(home, ".ssh"), join(home, ".aws")]) assert.deepEqual(await readdir(folder), [], folder);
    // The home folder named the other way round: given in its short (or unresolved) form while the home folder is the long one.
    process.env["HOME"] = long;
    process.env["USERPROFILE"] = long;
    try {
        const r = await call("ebms_export", { company: "sbx", path: "ARINVDET", select: "AUTOID", folder: join(home, ".ssh") });
        assert.match(r.raw, /hidden folder/);
    } finally {
        process.env["HOME"] = home;
        process.env["USERPROFILE"] = home;
    }
    // An ordinary folder is fine, and the usual folder needs no naming.
    const ok = await call("ebms_export", { company: "sbx", path: "ARINVDET", select: "AUTOID", folder: documents });
    assert.equal(ok.isError, undefined, ok.raw);
    assert.equal((await readFile(String(ok.path), "utf8")).split("\r\n").filter(Boolean).length, 11);
});

test("on Windows, a hidden folder named with other capitals or forward slashes is still refused", { skip: process.platform !== "win32" }, async () => {
    fresh();
    serve = pages(lines(10));
    await mkdir(join(home, ".ssh"), { recursive: true });
    for (const folder of [join(home, ".SSH").toUpperCase(), join(home, ".ssh").replace(/\\/g, "/"), `${home}\\Documents\\..\\.ssh`]) {
        const r = await call("ebms_export", { company: "sbx", path: "ARINVDET", select: "AUTOID", folder });
        assert.equal(r.isError, true, folder);
        assert.match(r.raw, /hidden folder/, folder);
    }
});

test("an export never writes over a file that is there, even one a link points at", async () => {
    fresh();
    serve = pages(lines(10));
    const folder = await mkdtemp(join(home, "Documents", "keep-"));
    const kept = join(folder, "source.csv");
    await writeFile(kept, "ID\nmine\n");
    const elsewhere = join(home, "elsewhere.csv");
    await writeFile(elsewhere, "theirs\n");
    await symlink(elsewhere, join(folder, "linked.csv"));
    for (const filename of ["source", "linked"]) {
        const r = await call("ebms_export", { company: "sbx", path: "ARINVDET", select: "AUTOID", folder, filename });
        assert.equal(r.isError, undefined, r.raw);
        assert.equal(r.path, join(folder, `${filename}-2.csv`));
    }
    assert.equal(await readFile(kept, "utf8"), "ID\nmine\n");
    assert.equal(await readFile(elsewhere, "utf8"), "theirs\n");
});
