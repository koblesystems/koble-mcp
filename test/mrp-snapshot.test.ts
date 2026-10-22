/**
 * The snapshot and the planning tools against a scripted company of 620 products that answers
 * $filter, $orderby, $top, $skip and $count the way EBMS does. EBMS answers one request at a
 * time, so how many a tool makes is what a planner waits for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configure } from "../src/config.js";
import { resetAuth } from "../src/ebms/client.js";
import { runMrp, type Supply } from "../src/mrp/engine.js";
import type { Snapshot } from "../src/mrp/snapshot.js";
import { buildWorksheet } from "../src/mrp/worksheet.js";
import { registerMrpTools } from "../src/tools/mrp-tools.js";
import type { McpToolResult } from "../src/tools/types.js";

type Row = Record<string, unknown>;
const pad = (n: number, width = 4): string => String(n).padStart(width, "0");
const products = Array.from({ length: 600 }, (_, i) => `P${pad(i)}`);
const madeItems = Array.from({ length: 20 }, (_, i) => `M${pad(i)}`);
const stock = { C_TYPE: 2, PURC_METH: 0, T_ON_HAND: 0, MIN_INVEN: 0, MAX_INVEN: 0, ORDER_AMT: 0, INACTIVE: false };
const tables: Record<string, Row[]> = {
    INVENTRY: [...products, ...madeItems].map((ID, i) => ({ AUTOID: `a${pad(i)}`, ID, DESCR_1: ID, PRI_VENDOR: ID.startsWith("P") ? `V${i % 10}` : "", ...stock })),
    INVENDOR: products.map((ID, i) => ({ AUTOID: `d${pad(i)}`, ID, VENDOR_ID: `V${i % 10}`, UNIT_MEAS: "EA", COST: 1, PART_NO: `X-${ID}`, LEAD_DAYS: i % 3 === 0 ? 10 : 0 })),
    INVENUNT: [...products, ...madeItems].map((ID, i) => ({ AUTOID: `u${pad(i)}`, ID, UNIT: "EA", MULTIPLIER: 0, MULTIPLY: "Smaller" })),
    APVENDOR: Array.from({ length: 10 }, (_, i) => ({ AUTOID: `v${i}`, ID: `V${i}`, F_NAME: "", L_NAME: `Vendor ${i}`, LEAD_DAYS: 7 })),
    INVENDET: [
        ...madeItems.flatMap((ID, m) => [0, 1, 2].map((c) => ({ AUTOID: `b${pad(m * 3 + c)}`, ID, COMP_ID: products[(m * 3 + c) % 600], QUAN: 2, CATEGORY: "(Single Component)" }))),
        // Bills of materials of thirty discontinued products, still on file.
        ...Array.from({ length: 30 }, (_, i) => ({ AUTOID: `x${pad(i)}`, ID: `OLD${pad(i, 2)}`, COMP_ID: "P0001", QUAN: 1, CATEGORY: "(Single Component)" })),
    ],
    // Years of batches: five hundred finished-good lines for each made item.
    APINVDET: Array.from({ length: 10_000 }, (_, i) => ({ AUTOID: `h${pad(i, 5)}`, INVEN: madeItems[i % 20], DOC_TYPE: "M", WAREHOUSE: "MAIN", INV_DATE: "2020-01-01T00:00:00Z" })),
    ARINVDET: [...products, ...madeItems, "GONE"].map((INVEN, i) => ({ AUTOID: `s${pad(i)}`, INVOICE: `SO-${i}`, INVEN, QUAN: 5, SHIP: 0, SHIP_DATE: "2026-11-01T00:00:00Z", DOC_TYPE: "S", PURC_M_VIS: "Stocked", PAR_TIME: "", TIMESTAMP: `t${i}` })),
    INMFG: Array.from({ length: 5 }, (_, i) => ({ AUTOID: `f${i}`, BATCH: `${900 + i}`, DATE: "2026-10-01T00:00:00Z", END_DATE: "2026-10-30T00:00:00Z", FinishedDetails: [{ INVEN: madeItems[i], O_QUAN_VIS: 2, SHIP_VIS: 0, UNIT_MEAS: "", ETA_DATE: null }], ARINVDETs: [] })),
    APINV: Array.from({ length: 10 }, (_, i) => ({ AUTOID: `o${i}`, INVOICE: `${700 + i}`, ID: `V${i}`, INV_DATE: "2026-10-01T00:00:00Z", Details: [0, 1, 2, 3, 4].map((l) => ({ INVEN: products[i * 5 + l], O_QUAN_VIS: 3, SHIP_VIS: 0, UNIT_MEAS: "EA", ETA_DATE: "2026-10-20T00:00:00Z", DOC_TYPE: "E", PURC_M_VIS: "Stocked" })) })),
};

/** Just enough of $filter: lists of `X eq '…'`, and `X gt '…'` / `X gt n`. Everything else matches. */
function matches(row: Row, filter: string): boolean {
    const lists = new Map<string, string[]>();
    for (const [, field, value] of filter.matchAll(/\b(ID|INVEN|EXTERNALID) eq '([^']*)'/g)) lists.set(field as string, [...(lists.get(field as string) ?? []), value as string]);
    for (const [field, values] of lists) if (!values.includes(String(row[field]))) return false;
    for (const [, field, value] of filter.matchAll(/\b(\w+) gt '([^']*)'/g)) if (!(String(row[field as string]) > (value as string))) return false;
    for (const [, field, value] of filter.matchAll(/\b(\w+) gt (\d+)\b/g)) if (!(Number(row[field as string] ?? 0) > Number(value))) return false;
    return true;
}

const requests: Record<string, number> = {};
globalThis.fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/Token")) return new Response(JSON.stringify({ AccessToken: "a" }), { status: 200 });
    const entity = u.pathname.split("/").pop() ?? "";
    requests[entity] = (requests[entity] ?? 0) + 1;
    const order = u.searchParams.get("$orderby");
    const found = (tables[entity] ?? []).filter((row) => matches(row, u.searchParams.get("$filter") ?? ""));
    if (order) found.sort((a, b) => (String(a[order]) < String(b[order]) ? -1 : String(a[order]) > String(b[order]) ? 1 : 0));
    const skip = Number(u.searchParams.get("$skip") ?? 0);
    const fields = (u.searchParams.get("$select") ?? "").split(",");
    const value = found.slice(skip, skip + Number(u.searchParams.get("$top") ?? 1000)).map((row) => Object.fromEntries(Object.entries(row).filter(([field]) => !u.searchParams.has("$select") || fields.includes(field) || field === "FinishedDetails" || field === "ARINVDETs" || field === "Details")));
    return new Response(JSON.stringify({ value, "@odata.count": found.length }), { status: 200 });
}) as typeof fetch;

const textOf = (result: McpToolResult): string => { const [first] = result.content; return first?.type === "text" ? first.text : "{}"; };
const handlers: Record<string, (args: unknown) => Promise<McpToolResult>> = {};
registerMrpTools((name, def, handler) => { handlers[name] = async (args) => handler(def.inputSchema.parse(args) as never); });
const run = async (tool: string, args: Record<string, unknown>) => {
    configure({ EBMS_SERIAL_NUMBER: "000000000000000", EBMS_USERNAME: "u", EBMS_PASSWORD: "p", EBMS_COMPANIES: "sbx" });
    resetAuth();
    for (const key of Object.keys(requests)) delete requests[key];
    const result = JSON.parse(textOf(await (handlers[tool] as (args: unknown) => Promise<McpToolResult>)(args))) as Record<string, any>;
    const total = Object.values(requests).reduce((n, count) => n + count, 0);
    console.log(`${tool} ${JSON.stringify(args.scope ?? args.item)}: ${total} requests ${JSON.stringify(requests)}`);
    return { result, total, byEntity: { ...requests } };
};

const documents = ["ARINVDET", "INMFG", "APINV"];

test("a 60-day plan of 620 products reads each table once, and the same plan for one vendor costs no more", async () => {
    const saveTo = mkdtempSync(join(tmpdir(), "koble-requests-"));
    const everything = await run("mrp_plan", { company: "sbx", days: 60, scope: "everything", saveTo, inChat: false });
    assert.equal(everything.result.counts.toBuy, 600);
    assert.equal(everything.result.counts.toMake, 20);
    // 106 requests before (with 1,000 batch lines; 151 with these 10,000), most of them INVENDOR and INVENUNT 15 IDs at a time.
    assert.ok(everything.total <= 40, `${everything.total} requests`);
    assert.ok((everything.byEntity["APINVDET"] ?? 0) <= 21, "which items are made costs a page per made item at most, not a page per 200 batch lines ever written");
    const oneVendor = await run("mrp_plan", { company: "sbx", days: 60, scope: "vendors", vendors: ["Vendor 3"], saveTo, inChat: false });
    assert.equal(oneVendor.result.counts.toBuy, 60);
    assert.equal(oneVendor.total, everything.total);
});

test("the item view reads products, bills of materials and which items are made, and nothing else", async () => {
    const view = await run("mrp_item_view", { company: "sbx", item: "m0000", qty: 2 });
    assert.equal(view.result.item, "M0000", "the product ID is matched whatever its case");
    assert.equal(view.result.buy.length, 3);
    assert.deepEqual(Object.keys(view.byEntity).sort(), ["APINVDET", "INVENDET", "INVENTRY"]);
    const bare = await run("mrp_item_view", { company: "sbx", item: "P0599", qty: 1 });
    assert.deepEqual(bare.result.tree, ["P0599  need 1, buy 1  [no bill of materials, so there is nothing to build it from]"]);
});

test("an unclear vendor is asked about before the documents are read, not after the plan is finished", async () => {
    const asked = await run("mrp_plan", { company: "sbx", days: 60, scope: "vendors", vendors: ["Vendor"] });
    assert.match(asked.result.needsInput, /could be V0 \(Vendor 0\), V1 \(Vendor 1\)/);
    assert.equal(asked.result.vendorsWithProducts.length, 10);
    assert.deepEqual(Object.keys(asked.byEntity).sort(), ["APVENDOR", "INVENTRY"]);
});

test("products are matched whatever their case, and one that does not exist is asked about rather than reported as nothing to do", async () => {
    const asked = await run("mrp_plan", { company: "sbx", days: 60, scope: "products", items: ["p0001", "NOSUCH", "m00"] });
    assert.match(asked.result.needsInput, /"NOSUCH", "m00": no active product has those IDs/);
    assert.deepEqual(asked.result.similarProducts.slice(0, 2), ["M0000", "M0001"]);
    assert.ok(documents.every((entity) => !asked.byEntity[entity]));
    const plan = await run("mrp_plan", { company: "sbx", days: 60, scope: "products", items: [" p0001"], worksheet: false });
    assert.deepEqual(plan.result.scope, { products: ["P0001"] });
    assert.deepEqual(plan.result.buy.map((row: { item: string }) => row.item), ["P0001"]);
});

test("an inactive item with demand is named; inactive items only on old bills of materials are counted", async () => {
    const plan = await run("mrp_plan", { company: "sbx", days: 60, scope: "everything", worksheet: false });
    const warnings = plan.result.warnings as string[];
    assert.ok(warnings.includes("GONE has open demand or supply but is not an active product; it was not planned."));
    assert.ok(warnings.includes("30 item(s) on bills of materials are not active products (OLD00, OLD01, OLD02, OLD03, OLD04, …); they were not planned."));
    assert.equal(warnings.filter((w) => /OLD/.test(w)).length, 1);
});

test("on the worksheet a negative on-hand balance is a stock-out, and a PO and a batch that share a number are told apart", () => {
    const today = "2026-10-05";
    const supplies: Supply[] = [{ item: "B", qty: 5, date: "2026-10-20", kind: "purchase", ref: "900" }, { item: "C", qty: 5, date: "2026-10-20", kind: "batch", ref: "900" }];
    const plan = runMrp({ today, items: [{ id: "A", onHand: -4 }, { id: "B", onHand: 10 }, { id: "C", onHand: 10, make: true }], demands: [], supplies });
    const snapshot = { today, products: new Map(), vendors: new Map(), vendorRecords: new Map(), units: new Map(), leadTimes: new Map(), items: [], supplies } as unknown as Snapshot;
    const { rows } = buildWorksheet("sbx", "run-1", snapshot, plan);
    const a = rows.find((row) => row.Item === "A");
    assert.equal(a?.Status, "Stock-out", "not 'Below minimum': A has no minimum");
    assert.equal(a?.Why, "On hand is negative (4)");
    assert.deepEqual(rows.filter((row) => row.Type === "NOT NEEDED").map((row) => `${row.Item} ${row.Document}`), ["B PO 900", "C Batch 900"]);
});
