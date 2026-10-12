import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDrafts, CHILD_ROWS_PER_PATCH, externalIdFor, type Draft } from "../src/import/drafts.js";
import type { Lookups } from "../src/import/lookups.js";
import { resolveMapping } from "../src/import/mapping.js";
import { RULES } from "../src/import/rules.js";
import { readCsvText } from "../src/import/source.js";
import { validateRows } from "../src/import/validate.js";
import { meta } from "./import-fixtures.js";

const noLookups = (extra: Partial<Lookups> = {}): Lookups => ({ existing: new Map(), created: new Map(), issues: [], resolved: new Map(), replace: new Map(), waiting: new Set(), products: new Map(), notes: [], ...extra });
const opts = { company: "COF", importId: "abc123", maxDrafts: 200 };

function draft(entity: string, csv: string, lookups = noLookups(), options: Partial<typeof opts & { rowsFrom: number; rowsTo: number }> = {}) {
    const source = readCsvText(csv);
    const rule = RULES[entity]!;
    const m = meta(entity);
    const v = validateRows(source.rows, rule, m, resolveMapping(source.headers, rule, m));
    assert.deepEqual(v.issues, []);
    return buildDrafts(rule, m, v.rows, lookups, { ...opts, ...options });
}
const body = (d: Draft | undefined) => d?.write.body ?? {};

test("customer bodies put TREE_ID first, unpadded, then the file's columns, then EXTERNALID", () => {
    const r = draft("ARCUST", "ZIP,Last name,Folder\n17101,Smith,  24\n");
    assert.deepEqual(Object.keys(body(r.drafts[0])), ["TREE_ID", "L_NAME", "ZIP", "EXTERNALID"]);
    assert.equal(body(r.drafts[0])["TREE_ID"], "24");
});

test("product bodies follow the products skill's order, and carry the read-back", () => {
    const r = draft("INVENTRY", "Cost,Classification,Folder,Name,ID\n3.1,Track Count,26,Mug,MUG-12\n");
    assert.deepEqual(Object.keys(body(r.drafts[0])), ["ID", "DESCR_1", "TREE_ID", "C_TYPE", "COST", "EXTERNALID"]);
    assert.equal(body(r.drafts[0])["C_TYPE"], 2);
    assert.deepEqual(r.drafts[0]?.write.readBack, { record: "FOLDERNAME,MARKUP,TAX_GROUP,PUR_ACC,EACH_UNIT,DEF_UNIT" });
    assert.equal(r.drafts[0]?.write.method, "POST");
    assert.equal(r.drafts[0]?.write.path, "INVENTRY");
});

test("EXTERNALID: the import's prefix and the row, no date (a rerun on another day must find it), at most 50 characters; the file's own wins", () => {
    assert.equal(externalIdFor("abc123", 9), "claude-import-abc123-r9");
    assert.ok(externalIdFor("abcdef123456", 1_000_000).length <= 50);
    const r = draft("ARCUST", "Last name,Folder,EXTERNALID\nSmith,1,legacy-77\nJones,1,\n");
    assert.equal(r.drafts[0]?.externalId, "legacy-77");
    assert.equal(r.drafts[1]?.externalId, "claude-import-abc123-r3");
});

test("names and folders a lookup resolved replace what the row said", () => {
    const r = draft("INVENTRY", "ID,Folder,Classification\nMUG,Mugs,2\n", noLookups({ replace: new Map([[2, { TREE_ID: "26" }]]), resolved: new Map([[2, { folder: "26 Mugs" }]]) }));
    assert.equal(body(r.drafts[0])["TREE_ID"], "26");
    assert.deepEqual(r.drafts[0]?.resolved, { folder: "26 Mugs" });
});

test("child rows group per product, at most 50 to a PATCH, without the product ID in each row", () => {
    const lines = ["Product,Unit,Multiply,Multiplier", "A,BOX,Larger,10"];
    for (let i = 0; i < CHILD_ROWS_PER_PATCH + 2; i += 1) lines.push(`B,U${i},Larger,${i + 2}`);
    const r = draft("INVENUNT", lines.join("\n"), noLookups({ products: new Map([["A", "aid"], ["B", "bid"]]) }));
    assert.deepEqual(r.drafts.map((d) => [d.write.path, (d.write.body["INVENUNTs"] as unknown[]).length]), [["INVENTRY('aid')", 1], ["INVENTRY('bid')", 50], ["INVENTRY('bid')", 2]]);
    assert.deepEqual(body(r.drafts[0])["INVENUNTs"], [{ UNIT: "BOX", MULTIPLY: "Larger", MULTIPLIER: 10 }]);
    assert.equal(r.drafts[0]?.write.method, "PATCH");
    assert.deepEqual(r.drafts[2]?.rows, [53, 54]);
});

test("a folder is sent with its parent padded as EBMS stores it, and never its own number", () => {
    const r = draft("INVENTRE", "Folder,Parent,Name\n40,Products,Mugs\n", noLookups({ replace: new Map([[2, { PARENT_ID: "    1" }]]) }));
    assert.deepEqual(body(r.drafts[0]), { PARENT_ID: "    1", TREE_DESCR: "Mugs" });
});

test("a bill-of-materials line is its own POST, product ID included", () => {
    const r = draft("INVENDET", "Product,Component,Qty\nBENCH,LEG,4\n");
    assert.deepEqual(r.drafts[0]?.write, { tool: "ebms_write", method: "POST", path: "INVENDET", body: { ID: "BENCH", COMP_ID: "LEG", QUAN: 4 }, readBack: { record: "CATEGORY" } });
});

test("not-yet-verified entities carry unverified on every draft", () => {
    assert.equal(draft("GLDEPT", "DEPT_ID,DESCR\nD1,Shop\n").drafts[0]?.unverified, true);
    assert.equal(draft("ARCUST", "Last name,Folder\nX,1\n").drafts[0]?.unverified, undefined);
});

test("the window bounds what is returned and says where to continue", () => {
    const csv = ["Last name,Folder", ...Array.from({ length: 6 }, (_, i) => `N${i},1`)].join("\n");
    const first = draft("ARCUST", csv, noLookups(), { maxDrafts: 2 });
    assert.deepEqual(first.drafts.map((d) => d.row), [2, 3]);
    assert.equal(first.nextRowsFrom, 4);
    assert.equal(first.ready, 6);
    const later = draft("ARCUST", csv, noLookups(), { rowsFrom: 4, rowsTo: 5 });
    assert.deepEqual(later.drafts.map((d) => d.row), [4, 5]);
    assert.equal(later.nextRowsFrom, null);
});
