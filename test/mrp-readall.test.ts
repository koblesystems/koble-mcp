import { test } from "node:test";
import assert from "node:assert/strict";
import { configure } from "../src/config.js";
import { resetAuth } from "../src/ebms/client.js";
import { readAll, readByIds } from "../src/mrp/snapshot.js";

type Row = { AUTOID: string; ID: string };
/** The collection as it stands when each request arrives; a test may change it between pages. */
let table: Row[] = [];
/** A server-side cap on $top, as some servers have. */
let maxTop = Infinity;
let withCount = true;
let refuseOrderBy = false;
let refuseKeyFilter = false;
/** For the $skip tests: a server that pages however it likes. */
let serve: ((skip: number, top: number) => Row[]) | null = null;
let beforeEachPage: (page: number) => void = () => {};
const urls: URL[] = [];
globalThis.fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/Token")) return new Response(JSON.stringify({ AccessToken: "a" }), { status: 200 });
    beforeEachPage(urls.length);
    urls.push(u);
    const filter = u.searchParams.get("$filter") ?? "";
    const invalid = new Response(JSON.stringify({ Messages: [{ TextBriefDescription: "Invalid query" }] }), { status: 422 });
    if (refuseOrderBy && u.searchParams.get("$orderby")) return invalid;
    if (refuseKeyFilter && filter.includes("AUTOID gt")) return invalid;
    assert.match(u.searchParams.get("$select") ?? "", /(^|,)\s*AUTOID\s*(,|$)/, "AUTOID is always selected so rows can be told apart");
    const after = /AUTOID gt '([^']*)'/.exec(filter)?.[1];
    const ids = [...filter.matchAll(/ID eq '([^']*)'/g)].map((m) => m[1]);
    const found = table.filter((row) => (after === undefined || row.AUTOID > after) && (ids.length === 0 || ids.includes(row.ID)));
    const skip = Number(u.searchParams.get("$skip") ?? 0);
    const top = Math.min(maxTop, Number(u.searchParams.get("$top")));
    const value = serve ? serve(skip, top) : found.slice(skip, skip + top);
    return new Response(JSON.stringify({ value, ...(withCount ? { "@odata.count": found.length } : {}) }), { status: 200 });
}) as typeof fetch;
const fresh = () => {
    maxTop = Infinity; withCount = true; refuseOrderBy = false; refuseKeyFilter = false; serve = null; beforeEachPage = () => {}; urls.length = 0;
    configure({ EBMS_SERIAL_NUMBER: "000000000000000", EBMS_USERNAME: "u", EBMS_PASSWORD: "p", EBMS_COMPANIES: "sbx" });
    resetAuth();
};
const make = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ AUTOID: `A${String(i).padStart(4, "0")}`, ID: `P${i}` }));
const read = async () => (await readAll("sbx", "INVENTRY", { $select: "ID" })).map((row) => row["AUTOID"]);

test("pages are read by key in AUTOID order, and the count of what is left ends the read without an extra request", async () => {
    fresh();
    table = make(450);
    assert.equal((await readAll("sbx", "INVENTRY", { $select: "ID, AUTOID", $filter: "INACTIVE eq false" })).length, 450);
    assert.equal(urls.length, 3, "AUTOID was already selected (with a space) and is not added twice, and three pages cover 450 rows");
    assert.ok(urls.every((u) => u.searchParams.get("$orderby") === "AUTOID" && !u.searchParams.has("$skip")));
    assert.deepEqual(urls.map((u) => u.searchParams.get("$filter")), ["INACTIVE eq false", "(INACTIVE eq false) and AUTOID gt 'A0199'", "(INACTIVE eq false) and AUTOID gt 'A0399'"]);
});

test("a row that leaves the set mid-read does not push a live row out of the next page", async () => {
    fresh();
    table = make(450);
    // After the first page, a sales order is posted: its line A0050 leaves STATUS eq 'SalesOrder'.
    beforeEachPage = (page) => { if (page === 1) table = table.filter((row) => row.AUTOID !== "A0050"); };
    const rows = await read();
    assert.equal(rows.length, 450, "A0050 was read before it left, and every live row after it");
    assert.ok(rows.includes("A0200"), "with $skip, A0200 would have been skipped");
});

test("a server that caps the page size is read to the end, with a count or without one", async () => {
    fresh();
    table = make(450);
    maxTop = 100;
    assert.equal((await read()).length, 450);
    fresh();
    table = make(450);
    maxTop = 100;
    withCount = false;
    assert.equal((await read()).length, 450, "a short page is not the end when there is no count");
    assert.equal(urls.length, 6, "five pages, then an empty one");
});

test("an entity that will not sort by AUTOID is read with $skip, and a row that leaves mid-read is an error, not a smaller company", async () => {
    fresh();
    table = make(450);
    refuseOrderBy = true;
    assert.equal((await read()).length, 450);
    assert.deepEqual(urls.map((u) => u.searchParams.get("$orderby")), ["AUTOID", null, null, null]);
    fresh();
    table = make(450);
    refuseOrderBy = true;
    beforeEachPage = (page) => { if (page === 2) table = table.filter((row) => row.AUTOID !== "A0050"); };
    // The count drops to 449, but the highest count seen is kept: A0200 went missing.
    await assert.rejects(read(), /returned 449 distinct rows but EBMS counted 450/);
});

test("with $skip, rows that shift between pages are not counted twice, and rows that never arrive are an error", async () => {
    fresh();
    table = make(300);
    refuseOrderBy = true;
    // Pages that overlap: rows 150-199 come back twice, and are counted once.
    serve = (skip, top) => (skip === 0 ? table.slice(0, top) : table.slice(skip - 50, skip - 50 + top));
    assert.equal((await read()).length, 300);
    // Pages that skip: rows 200-249 never arrive.
    serve = (skip, top) => (skip === 0 ? table.slice(0, top) : table.slice(skip + 50, skip + 50 + top));
    await assert.rejects(read(), /returned 250 distinct rows but EBMS counted 300/);
});

test("a server that refuses the key filter after the first page is read again with $skip, in AUTOID order", async () => {
    fresh();
    table = make(450);
    refuseKeyFilter = true;
    assert.equal((await read()).length, 450);
    assert.deepEqual(urls.map((u) => u.searchParams.get("$skip")), [null, null, "0", "200", "400"]);
    assert.ok(urls.every((u) => u.searchParams.get("$orderby") === "AUTOID"));
});

test("IDs are asked for about fifty at a time, with every URL under 2 KB", async () => {
    fresh();
    table = make(500);
    const ids = table.map((row) => row.ID);
    const rows = await readByIds("sbx", "INVENTRY", "ID", [...ids, ...ids.slice(0, 10), ""], "ID");
    assert.deepEqual(rows.map((row) => row["ID"]), ids, "every row once, in the order asked");
    assert.equal(urls.length, 10);
    fresh();
    const long = Array.from({ length: 120 }, (_, i) => `A-VERY-LONG-PRODUCT-ID-${String(i).padStart(3, "0")}`);
    table = long.map((ID, i) => ({ AUTOID: `B${String(i).padStart(4, "0")}`, ID }));
    await readByIds("sbx", "INVENTRY", "toupper(ID)", long, "ID", "INACTIVE eq false");
    assert.ok(urls.length > 3, "long IDs make smaller chunks");
    assert.ok(urls.every((u) => u.href.length < 2048), `longest URL ${Math.max(...urls.map((u) => u.href.length))}`);
});
