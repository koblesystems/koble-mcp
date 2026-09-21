import { test } from "node:test";
import assert from "node:assert/strict";
import { configure } from "../src/config.js";
import { resetAuth } from "../src/ebms/client.js";
import { readAll } from "../src/mrp/snapshot.js";

let serve: (skip: number, top: number) => { value: unknown[]; count?: number };
globalThis.fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/Token")) return new Response(JSON.stringify({ AccessToken: "a" }), { status: 200 });
    const page = serve(Number(u.searchParams.get("$skip")), Number(u.searchParams.get("$top")));
    assert.match(u.searchParams.get("$select") ?? "", /(^|,)AUTOID(,|$)/, "AUTOID is always selected so rows can be told apart");
    return new Response(JSON.stringify({ value: page.value, ...(page.count === undefined ? {} : { "@odata.count": page.count }) }), { status: 200 });
}) as typeof fetch;
const fresh = () => { configure({ EBMS_SERIAL_NUMBER: "000000000000000", EBMS_USERNAME: "u", EBMS_PASSWORD: "p", EBMS_COMPANIES: "sbx" }); resetAuth(); };
const make = (n: number) => Array.from({ length: n }, (_, i) => ({ AUTOID: `A${i}`, ID: `P${i}` }));

test("every page is read when the server reports a count", async () => {
    fresh();
    const all = make(450);
    serve = (skip, top) => ({ value: all.slice(skip, skip + top), count: all.length });
    assert.equal((await readAll("sbx", "INVENTRY", { $select: "ID" })).length, 450);
});

test("with no count at all, paging carries on until a short page instead of stopping at the first", async () => {
    fresh();
    const all = make(450);
    serve = (skip, top) => ({ value: all.slice(skip, skip + top) });
    assert.equal((await readAll("sbx", "INVENTRY", { $select: "ID" })).length, 450);
});

test("rows that shift between pages are not counted twice, and a read that comes up short is an error, not a smaller company", async () => {
    fresh();
    const all = make(300);
    // Pages that overlap: rows 150-199 come back twice, and are counted once.
    serve = (skip, top) => ({ value: skip === 0 ? all.slice(0, top) : all.slice(skip - 50, skip - 50 + top), count: 300 });
    assert.equal((await readAll("sbx", "INVENTRY", { $select: "ID" })).length, 300);
    // Pages that skip: rows 200-249 never arrive.
    serve = (skip, top) => ({ value: skip === 0 ? all.slice(0, top) : all.slice(skip + 50, skip + 50 + top), count: 300 });
    await assert.rejects(readAll("sbx", "INVENTRY", { $select: "ID" }), /returned 250 distinct rows but EBMS counted 300/);
});
