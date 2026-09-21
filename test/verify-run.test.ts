/**
 * ebms_write with verification on, against a small in-memory EBMS that can be told to
 * misbehave the ways the real one does: zero a quantity, ignore an @id, add rows of its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { configure } from "../src/config.js";
import { resetAuth } from "../src/ebms/client.js";
import { registerProxyTools } from "../src/tools/proxy-tools.js";
import type { McpToolResult } from "../src/tools/types.js";

type Row = Record<string, unknown> & { AUTOID: string; Materials: Row[] };
interface Order { AUTOID: string; INVOICE: string; ID: string; PO_NO: string; EXTERNALID: string; Details: Row[] }

let seq = 0;
const id = (p: string) => `${p}${++seq}`;
let order: Order;
let quirks: { zeroQuantityFor?: string; autoMaterials?: Record<string, string[]>; failReadsAfterWrite?: boolean } = {};
let wrote = false;
const gets: string[] = [];

const newRow = (entry: Record<string, unknown>): Row => {
    const inven = String(entry["INVEN"] ?? "");
    const zero = quirks.zeroQuantityFor === inven;
    const row: Row = { AUTOID: id("R"), INVEN: inven, DESCR: String(entry["DESCR"] ?? inven), M_QUAN_VIS: zero ? 0 : (entry["M_QUAN_VIS"] ?? 1), UNIT_MEAS: "EA", UNIT_VIS: zero ? 0 : (entry["UNIT_VIS"] ?? 10), Materials: [] };
    const kids = (entry["Materials"] as Array<Record<string, unknown>> | undefined) ?? (quirks.autoMaterials?.[inven] ?? []).map((m) => ({ INVEN: m, M_QUAN_VIS: 1 }));
    row.Materials = kids.map(newRow);
    return row;
};
const applyDelta = (rows: Row[], delta: Array<Record<string, unknown>>): void => {
    for (const entry of delta) {
        const at = typeof entry["@id"] === "string" ? rows.findIndex((r) => r.AUTOID === entry["@id"]) : -1;
        if (typeof entry["@id"] === "string") {
            if (at < 0) continue; // silently ignored
            if (entry["@removed"] === true) { rows.splice(at, 1); continue; }
            const row = rows[at] as Row;
            for (const [k, v] of Object.entries(entry)) if (!k.includes("@") && typeof v !== "object") row[k] = v;
            if (Array.isArray(entry["Materials@delta"])) applyDelta(row.Materials, entry["Materials@delta"] as Array<Record<string, unknown>>);
        } else rows.push(newRow(entry));
    }
};
const pick = (row: Record<string, unknown>, select: string): Record<string, unknown> => Object.fromEntries(select.split(",").filter((f) => f in row).map((f) => [f, row[f]]));
const parseExpand = (expand: string): { nav: string; select: string; filterIds: string[] | null; child: { nav: string; select: string } | null } => {
    const m = /^(\w+)\(\$select=([^;)]*)(?:;\$filter=([^;]*?))?(?:;\$expand=(\w+)\(\$select=([^)]*)\))?\)$/.exec(expand);
    assert.ok(m, `unparsed expand: ${expand}`);
    return { nav: m[1] as string, select: m[2] as string, filterIds: m[3] ? [...m[3].matchAll(/AUTOID eq '([^']*)'/g)].map((x) => x[1] as string) : null, child: m[4] ? { nav: m[4], select: m[5] as string } : null };
};
const json = (status: number, body: unknown): Response => new Response(body === null ? "" : JSON.stringify(body), { status });

globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/Token")) return json(200, { AccessToken: "a" });
    const method = init?.method ?? "GET";
    const path = decodeURIComponent(u.pathname.replace(/^.*\/OData\//, ""));
    if (method === "GET") {
        gets.push(`${path}${decodeURIComponent(u.search.replace(/\+/g, " "))}`);
        if (wrote && quirks.failReadsAfterWrite) throw new TypeError("fetch failed");
        if (path === "ARINV") return json(200, { value: [] });
        const record: Record<string, unknown> = pick(order as unknown as Record<string, unknown>, u.searchParams.get("$select") ?? "AUTOID");
        const expand = u.searchParams.get("$expand");
        if (expand) {
            const e = parseExpand(expand);
            record[e.nav] = order.Details.filter((r) => e.filterIds === null || e.filterIds.includes(r.AUTOID)).map((r) => ({ ...pick(r, e.select), ...(e.child ? { [e.child.nav]: r.Materials.map((m) => pick(m, (e.child as { select: string }).select)) } : {}) }));
        }
        return json(200, record);
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    wrote = true;
    if (method === "POST") {
        order = { AUTOID: "O1", INVOICE: "2001", ID: String(body["ID"] ?? ""), PO_NO: String(body["PO_NO"] ?? ""), EXTERNALID: String(body["EXTERNALID"] ?? ""), Details: ((body["Details"] as Array<Record<string, unknown>>) ?? []).map(newRow) };
        return json(201, { AUTOID: order.AUTOID, INVOICE: order.INVOICE, ID: body["ID"], lots: "of", other: "fields" });
    }
    if (typeof body["PO_NO"] === "string") order.PO_NO = body["PO_NO"].slice(0, 20);
    if (Array.isArray(body["Details@delta"])) applyDelta(order.Details, body["Details@delta"] as Array<Record<string, unknown>>);
    return json(200, { AUTOID: order.AUTOID, INVOICE: order.INVOICE, lots: "of", other: "fields" });
}) as typeof fetch;

let write: (args: unknown) => Promise<McpToolResult>;
registerProxyTools((name, def, handler) => { if (name === "ebms_write") write = async (args) => handler(def.inputSchema.parse(args) as never); });
const call = async (args: unknown) => JSON.parse((await write(args)).content[0]?.text ?? "{}") as Record<string, any>;

const fresh = (q: typeof quirks = {}) => {
    configure({ EBMS_SERIAL_NUMBER: "000000000000000", EBMS_USERNAME: "u", EBMS_PASSWORD: "p", EBMS_COMPANIES: "sbx" });
    resetAuth();
    quirks = q; wrote = false; gets.length = 0; seq = 0;
    order = { AUTOID: "O1", INVOICE: "2001", ID: "ROSMAR", PO_NO: "", EXTERNALID: "x", Details: [{ AUTOID: "L1", INVEN: "MUG", DESCR: "Mug", M_QUAN_VIS: 24, UNIT_MEAS: "EA", UNIT_VIS: 5, Materials: [] }, { AUTOID: "K1", INVEN: "", DESCR: "Kit", M_QUAN_VIS: 1, UNIT_MEAS: "", UNIT_VIS: 9, Materials: [{ AUTOID: "M1", INVEN: "LEG", DESCR: "Leg", M_QUAN_VIS: 4, UNIT_MEAS: "EA", UNIT_VIS: 1, Materials: [] }] }] };
};

test("a clean PATCH verifies ok, returns the stored rows, and no longer dumps the whole record", async () => {
    fresh();
    const r = await call({ company: "sbx", method: "PATCH", path: "ARINV('O1')", body: { PO_NO: "PO-7", "Details@delta": [{ "@id": "L1", M_QUAN_VIS: 30 }, { INVEN: "LID", M_QUAN_VIS: 30 }] }, readBack: { lines: "UNIT_MEAS,UNIT_VIS" } });
    assert.equal(r.verification.ok, true);
    assert.equal(r.verification.checked, 4);
    assert.deepEqual(r.record, { AUTOID: "O1", INVOICE: "2001" });
    const added = r.verification.rows.find((row: any) => row.where.includes("LID"));
    assert.equal(added.stored.UNIT_MEAS, "EA");
    assert.equal(added.stored.UNIT_VIS, 10);
});

test("the unit-of-measure anomaly: a line EBMS stored at quantity 0 comes back as a mismatch", async () => {
    fresh({ zeroQuantityFor: "TEAMJERSEY" });
    const r = await call({ company: "sbx", method: "PATCH", path: "ARINV('O1')", body: { "Details@delta": [{ INVEN: "TEAMJERSEY", M_QUAN_VIS: 1 }] } });
    assert.equal(r.status, 200);
    assert.equal(r.verification.ok, false);
    assert.deepEqual(r.verification.mismatches, [{ where: "Details[1] TEAMJERSEY", field: "M_QUAN_VIS", sent: 1, stored: 0 }]);
    assert.match(r.next, /did not store everything as sent/);
});

test("a mistyped @id, which EBMS ignores with a 200, is reported", async () => {
    fresh();
    const r = await call({ company: "sbx", method: "PATCH", path: "ARINV('O1')", body: { "Details@delta": [{ "@id": "TYPO", M_QUAN_VIS: 3 }] } });
    assert.equal(r.verification.ok, false);
    assert.match(r.verification.problems[0], /no row with @id TYPO/);
});

test("a truncated header value is a mismatch", async () => {
    fresh();
    const r = await call({ company: "sbx", method: "PATCH", path: "ARINV('O1')", body: { PO_NO: "PO-123456789012345678901234" } });
    assert.equal(r.verification.mismatches[0].field, "PO_NO");
    assert.equal(r.verification.mismatches[0].stored, "PO-12345678901234567");
});

test("materials are verified under their parent, reading only the parents touched", async () => {
    fresh({ zeroQuantityFor: "SEAT" });
    const r = await call({ company: "sbx", method: "PATCH", path: "ARINV('O1')", body: { "Details@delta": [{ "@id": "K1", "Materials@delta": [{ "@id": "M1", M_QUAN_VIS: 6 }, { INVEN: "SEAT", M_QUAN_VIS: 1 }] }] } });
    assert.equal(r.verification.ok, false);
    assert.deepEqual(r.verification.mismatches, [{ where: "Details[1] › Materials[2] SEAT", field: "M_QUAN_VIS", sent: 1, stored: 0 }]);
    assert.equal(r.verification.checked, 3);
    const nested = gets.filter((g) => g.includes("$expand=Details($select=AUTOID;$filter="));
    assert.equal(nested.length, 2, "one nested read before, one after");
    assert.ok(nested.every((g) => g.includes("AUTOID eq 'K1'") && !g.includes("'L1'")));
});

test("a create is verified line by line, and rows EBMS adds itself are noted rather than failed", async () => {
    fresh({ autoMaterials: { FLATREPAIR: ["TUBE-26", "TUBE700C"] } });
    const r = await call({ company: "sbx", method: "POST", path: "ARINV", body: { ID: "ROSMAR", EXTERNALID: "new-1", Details: [{ INVEN: "FLATREPAIR", M_QUAN_VIS: 1 }, { DESCR: "Ad hoc list", M_QUAN_VIS: 2, Materials: [{ INVEN: "LEG", M_QUAN_VIS: 4 }] }] }, readBack: { children: "Materials", lines: "INVEN" } });
    assert.equal(r.status, 201);
    assert.deepEqual([r.verification.mismatches, r.verification.problems], [[], []], JSON.stringify(r.verification));
    assert.deepEqual(r.record, { AUTOID: "O1", INVOICE: "2001", ID: "ROSMAR" });
    assert.ok(r.verification.rows.some((row: any) => row.where === "Details[2] › Materials[1] LEG"));
    assert.equal(r.verification.ok, true);
    assert.deepEqual(r.verification.notes, ["Details[1] › Materials: EBMS added 2 row(s) that were not in the request (TUBE-26, TUBE700C)."]);
});

test("when only the read-back fails, the write is not called failed and the advice is not to resend", async () => {
    fresh({ failReadsAfterWrite: true });
    const r = await call({ company: "sbx", method: "PATCH", path: "ARINV('O1')", body: { "Details@delta": [{ "@id": "L1", M_QUAN_VIS: 30 }] } });
    assert.equal(r.status, 200);
    assert.equal(r.verification, null);
    assert.match(r.next, /only the read-back failed.*do not resend/);
    assert.equal(order.Details[0]?.M_QUAN_VIS, 30);
});

test("a PATCH that sends a plain Details array cannot pass by pointing at a row that was already there", async () => {
    fresh();
    const ignoring = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => ((init?.method ?? "GET") === "PATCH" ? new Response(JSON.stringify({ AUTOID: "O1" }), { status: 200 }) : ignoring(url, init))) as typeof fetch;
    try {
        const r = await call({ company: "sbx", method: "PATCH", path: "ARINV('O1')", body: { Details: [{ INVEN: "MUG", M_QUAN_VIS: 24 }] } });
        assert.equal(r.verification.ok, false);
        assert.match(r.verification.problems[0], /no new row appeared/);
    } finally {
        globalThis.fetch = ignoring;
    }
});

test("a DELETE is only verified by 'not found'; a read-back that fails some other way is not proof", async () => {
    fresh();
    const real = globalThis.fetch;
    let mode: "gone" | "timeout" | "still" = "gone";
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (String(url).endsWith("/Token")) return real(url, init);
        if (method === "DELETE") return new Response(null, { status: 204 });
        if (mode === "gone") return new Response(JSON.stringify({ Messages: [{ TextBriefDescription: "Key not found" }] }), { status: 422 });
        if (mode === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
        return new Response(JSON.stringify({ AUTOID: "O1" }), { status: 200 });
    }) as typeof fetch;
    try {
        assert.equal((await call({ company: "sbx", method: "DELETE", path: "ARINV('O1')" })).verification.ok, true);
        mode = "timeout";
        const unsure = await call({ company: "sbx", method: "DELETE", path: "ARINV('O1')" });
        assert.equal(unsure.verification.ok, false);
        assert.match(unsure.verification.problems[0], /Could not confirm the record is gone/);
        mode = "still";
        assert.match((await call({ company: "sbx", method: "DELETE", path: "ARINV('O1')" })).verification.problems[0], /still there/);
    } finally {
        globalThis.fetch = real;
    }
});
