/**
 * po_from_csv end to end against a scripted EBMS, with a real worksheet and run record on disk.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configure } from "../src/config.js";
import { resetAuth } from "../src/ebms/client.js";
import { checkCode, toCsv, type RunManifest, type SheetRow } from "../src/mrp/csv.js";
import { registerMrpTools } from "../src/tools/mrp-tools.js";
import type { McpToolResult } from "../src/tools/types.js";

const textOf = (result: McpToolResult): string => { const [first] = result.content; return first?.type === "text" ? first.text : "{}"; };


const tables: Record<string, Array<Record<string, unknown>>> = {
    APVENDOR: ["V1", "V2", "V3"].map((ID) => ({ AUTOID: `v${ID}`, ID, F_NAME: "", L_NAME: ID, INACTIVE: false })),
    INVENTRY: ["WIDGET", "BOLT"].map((ID) => ({ AUTOID: `p${ID}`, ID, DESCR_1: ID, INACTIVE: false })),
    INVENDOR: [
        { AUTOID: "iv1", ID: "WIDGET", VENDOR_ID: "V1", UNIT_MEAS: "CASE", COST: 48, PART_NO: "W-C" },
        { AUTOID: "iv2", ID: "WIDGET", VENDOR_ID: "V2", UNIT_MEAS: "EA", COST: 2.1, PART_NO: "W-E" },
        { AUTOID: "iv3", ID: "BOLT", VENDOR_ID: "V1", UNIT_MEAS: "BOX", COST: 9, PART_NO: "B-B" },
    ],
    INVENUNT: [
        { AUTOID: "u1", ID: "WIDGET", UNIT: "EA", MULTIPLIER: 0, MULTIPLY: "Smaller" }, { AUTOID: "u2", ID: "WIDGET", UNIT: "CASE", MULTIPLIER: 24, MULTIPLY: "Larger" },
        { AUTOID: "u3", ID: "BOLT", UNIT: "EA", MULTIPLIER: 0, MULTIPLY: "Smaller" }, { AUTOID: "u4", ID: "BOLT", UNIT: "BOX", MULTIPLIER: 100, MULTIPLY: "Larger" },
    ],
    APINV: [],
};
const writes: string[] = [];
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/Token")) return new Response(JSON.stringify({ AccessToken: "a" }), { status: 200 });
    if ((init?.method ?? "GET") !== "GET") { writes.push(`${init?.method} ${u.pathname}`); return new Response("{}", { status: 200 }); }
    const entity = u.pathname.split("/").pop() ?? "";
    const filter = u.searchParams.get("$filter") ?? "";
    const ids = [...filter.matchAll(/ID eq '([^']*)'/g)].map((m) => m[1]);
    const rows = (tables[entity] ?? []).filter((row) => ids.length === 0 || ids.includes(String(row["ID"])));
    return new Response(JSON.stringify({ "@odata.count": rows.length, value: rows }), { status: 200 });
}) as typeof fetch;

let po: (args: unknown) => Promise<McpToolResult>;
let planTool: (args: unknown) => Promise<McpToolResult>;
registerMrpTools((name, def, handler) => {
    if (name === "po_from_csv") po = async (args) => handler(def.inputSchema.parse(args) as never);
    if (name === "mrp_plan") planTool = async (args) => handler(def.inputSchema.parse(args) as never);
});
const call = async (args: unknown) => JSON.parse(textOf(await po(args))) as Record<string, any>;

const RUN = "mrp-sbx-20260921-140533";
function worksheet(edits: Record<string, Partial<SheetRow>>): string {
    const dir = mkdtempSync(join(tmpdir(), "koble-po-"));
    const base: SheetRow[] = [
        { Run: RUN, Company: "SBX", Line: "L0001", Type: "BUY", Item: "WIDGET", Vendor: "V1", "Purchase Unit": "CASE", "Order Qty": 2, "Unit Cost": 48, "Needed By": "2026-10-01" },
        { Run: RUN, Company: "SBX", Line: "L0002", Type: "BUY", Item: "BOLT", Vendor: "V3", "Purchase Unit": "EA", "Order Qty": 250, "Needed By": "2026-10-01" },
    ];
    const manifest: RunManifest = { run: RUN, company: "SBX", through: "2026-11-20", createdAt: "", lines: {} };
    for (const row of base) {
        row.Check = checkCode(RUN, String(row.Line), String(row.Item));
        manifest.lines[String(row.Line)] = { type: "BUY", item: String(row.Item), vendor: String(row.Vendor), partNo: "", purchaseUnit: String(row["Purchase Unit"]), orderQty: Number(row["Order Qty"]), unitCost: typeof row["Unit Cost"] === "number" ? row["Unit Cost"] : null, neededBy: String(row["Needed By"]) };
    }
    mkdirSync(join(dir, "runs"));
    writeFileSync(join(dir, "runs", `${RUN}.json`), JSON.stringify(manifest));
    const file = join(dir, "sheet.csv");
    writeFileSync(file, toCsv(base.map((row) => ({ ...row, ...(edits[String(row.Line)] ?? {}) }))));
    return file;
}
const fresh = () => { configure({ EBMS_SERIAL_NUMBER: "000000000000000", EBMS_USERNAME: "u", EBMS_PASSWORD: "p", EBMS_COMPANIES: "sbx" }); resetAuth(); writes.length = 0; };

test("moving a line to another vendor converts the quantity with it: 2 cases of 24 is 48 each, never 2 each", async () => {
    fresh();
    const r = await call({ company: "sbx", path: worksheet({ L0001: { Approve: "Y", Vendor: "V2" } }) });
    assert.deepEqual(r.problems, []);
    const [draft] = r.drafts;
    assert.equal(draft.vendor, "V2");
    assert.deepEqual(draft.write.body.Details, [{ INVEN: "WIDGET", O_QUAN_VIS: 48, UNIT_MEAS: "EA", UNIT_VIS: 2.1 }]);
    assert.match(draft.changedByPlanner.join("\n"), /vendor V1 → V2/);
    assert.match(draft.changedByPlanner.join("\n"), /2 CASE = 48 in stock units, ordered from V2 as 48 EA/);
});

test("and the other way: 250 each moved to a vendor who sells boxes of 100 is 3 boxes, never 250 boxes", async () => {
    fresh();
    const r = await call({ company: "sbx", path: worksheet({ L0002: { Approve: "Y", Vendor: "v1" } }) });
    assert.deepEqual(r.drafts[0].write.body.Details, [{ INVEN: "BOLT", O_QUAN_VIS: 3, UNIT_MEAS: "BOX", UNIT_VIS: 9 }]);
    assert.match(r.drafts[0].changedByPlanner.join("\n"), /250 EA = 250 in stock units, ordered from V1 as 3 BOX/);
});

test("a changed quantity AND vendor is read in the unit the row showed", async () => {
    fresh();
    const r = await call({ company: "sbx", path: worksheet({ L0001: { Approve: "Y", Vendor: "V2", "Order Qty": 3 } }) });
    assert.equal(r.drafts[0].write.body.Details[0].O_QUAN_VIS, 72);
});

test("an untouched row is ordered exactly as the run wrote it, and the tool never writes", async () => {
    fresh();
    const r = await call({ company: "sbx", path: worksheet({ L0001: { Approve: "Y" } }) });
    assert.equal(r.runRecordFound, true);
    assert.deepEqual(r.drafts[0].write.body, { ID: "V1", EXTERNALID: `${RUN}-V1`, Details: [{ INVEN: "WIDGET", O_QUAN_VIS: 2, UNIT_MEAS: "CASE", UNIT_VIS: 48 }] });
    assert.deepEqual(r.drafts[0].changedByPlanner, []);
    assert.deepEqual(writes, []);
});

test("mrp_plan will not guess the two things only the planner knows: the time frame and the scope", async () => {
    fresh();
    const ask = async (args: unknown) => JSON.parse(textOf(await planTool(args))) as Record<string, string>;
    assert.match((await ask({ company: "sbx" })).needsInput ?? "", /time frame/);
    assert.match((await ask({ company: "sbx", days: 30 })).needsInput ?? "", /everything, particular vendors .* or particular products/);
    assert.match((await ask({ company: "sbx", days: 30, scope: "vendors" })).needsInput ?? "", /which vendor/);
    assert.match((await ask({ company: "sbx", days: 30, scope: "products", items: [] })).needsInput ?? "", /which products/);
    assert.match((await ask({ company: "sbx", through: "2026-02-30", scope: "everything" })).needsInput ?? "", /not a calendar date/);
    assert.deepEqual(writes, []);
});
