/**
 * The EXTERNALID guard around the edges the plain check leaves open: parallel creates, a resend
 * after an unknown outcome, other spellings of the key. Plus the wording of this server's own
 * refusals. Nothing here reaches the network.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { configure } from "../src/config.js";
import { resetAuth } from "../src/ebms/client.js";
import { EbmsError } from "../src/ebms/errors.js";
import { registerProxyTools } from "../src/tools/proxy-tools.js";
import { errorResult, type McpToolResult } from "../src/tools/types.js";

const textOf = (result: McpToolResult): string => { const [first] = result.content; return first?.type === "text" ? first.text : "{}"; };

type Handler = (args: unknown) => Promise<McpToolResult>;
const tools: Record<string, Handler> = {};
registerProxyTools((name, def, handler) => {
    tools[name] = async (args) => handler(def.inputSchema.parse(args) as never);
});
const call = async (name: string, args: unknown): Promise<Record<string, any>> => JSON.parse(textOf(await (tools[name] as Handler)(args))) as Record<string, any>;

interface Sent { method: string; url: string }
let sent: Sent[] = [];
let script: Array<(s: Sent) => Response | Error> = [];
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });

globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/Token")) return json(200, { AccessToken: "a" });
    const entry: Sent = { method: init?.method ?? "GET", url: decodeURIComponent(u.replace(/\+/g, " ")) };
    sent.push(entry);
    await new Promise((resolve) => setImmediate(resolve)); // let a parallel call run in between
    const out = (script.shift() ?? (() => json(200, { value: [] })))(entry);
    if (out instanceof Error) throw out;
    return out;
}) as typeof fetch;

const fresh = () => {
    configure({ EBMS_SERIAL_NUMBER: "000000000000000", EBMS_USERNAME: "u", EBMS_PASSWORD: "p", EBMS_COMPANIES: "sbx" });
    resetAuth();
    sent = [];
    script = [];
};
const create = (externalId: string, extra: Record<string, unknown> = {}) => call("ebms_write", { company: "sbx", method: "POST", path: "ARINV", body: { ID: "C", EXTERNALID: externalId, ...extra }, verify: false });

test("two creates with one EXTERNALID sent in parallel make one order, not two", async () => {
    fresh();
    script.push(() => json(200, { value: [] }), () => json(201, { AUTOID: "O1" }));
    const [a, b] = await Promise.all([create("par-1"), create("par-1")]);
    assert.deepEqual(sent.map((s) => s.method), ["GET", "POST"]);
    assert.equal(a?.status, 201);
    assert.equal(b?.refused, true);
    assert.match(String(b?.reason), /still in progress\. Nothing was sent/);
    // Once the first is done, a resend gets the ordinary duplicate check.
    script.push(() => json(200, { value: [{ AUTOID: "O1", EXTERNALID: "par-1" }] }));
    assert.match(String((await create("par-1")).reason), /already exists/);
});

test("after a create comes back uncertain, a resend is refused until a read finds the record", async () => {
    fresh();
    script.push(() => json(200, { value: [] }), () => new TypeError("fetch failed"));
    assert.equal((await create("unk-1")).uncertain, true);

    const resend = await create("unk-1");
    assert.equal(resend.refused, true);
    assert.match(String(resend.reason), /Read back first/);
    assert.equal(sent.length, 2, "the resend sent nothing");

    script.push(() => json(200, { value: [{ AUTOID: "O1", EXTERNALID: "unk-1" }] }));
    await call("ebms_get", { company: "sbx", path: "ARINV", filter: "EXTERNALID eq 'unk-1'", select: "AUTOID,EXTERNALID" });
    script.push(() => json(200, { value: [{ AUTOID: "O1", EXTERNALID: "unk-1" }] }));
    assert.match(String((await create("unk-1")).reason), /already exists/, "the read cleared the hold; the duplicate check now finds it");
});

test("an empty read clears the hold only once EBMS has had time to finish the first request", async () => {
    mock.timers.enable({ apis: ["Date"], now: 5_000_000 });
    try {
        fresh();
        script.push(() => json(200, { value: [] }), () => new Response("", { status: 504 }));
        assert.equal((await create("unk-2")).uncertain, true);
        const readBack = () => call("ebms_get", { company: "sbx", path: "ARINV", filter: "EXTERNALID eq 'unk-2'", select: "AUTOID" });

        await readBack();
        assert.match(String((await create("unk-2")).reason), /Read back first/, "too soon: the first create may still land");

        mock.timers.tick(3 * 60 * 1000);
        await readBack();
        script.push(() => json(200, { value: [] }), () => json(201, { AUTOID: "O2" }));
        assert.equal((await create("unk-2")).status, 201);
    } finally {
        mock.timers.reset();
    }
});

test("the hold lapses after ten minutes without a read", async () => {
    mock.timers.enable({ apis: ["Date"], now: 9_000_000 });
    try {
        fresh();
        script.push(() => json(200, { value: [] }), () => new TypeError("fetch failed"));
        await create("unk-3");
        mock.timers.tick(10 * 60 * 1000 + 1);
        script.push(() => json(200, { value: [{ AUTOID: "O3", EXTERNALID: "unk-3" }] }));
        assert.match(String((await create("unk-3")).reason), /already exists/);
    } finally {
        mock.timers.reset();
    }
});

test("a refused or failed create is not held", async () => {
    fresh();
    script.push(() => json(200, { value: [] }), () => json(422, { Messages: [{ TextBriefDescription: "Customer not found" }] }));
    assert.equal((await create("no-1")).uncertain, false);
    script.push(() => json(200, { value: [] }), () => json(201, { AUTOID: "O4" }));
    assert.equal((await create("no-1")).status, 201);
});

test("EXTERNALID is found under any spelling, and two spellings at once are refused", async () => {
    fresh();
    script.push(() => json(200, { value: [{ AUTOID: "O1", EXTERNALID: "mcp-1" }] }));
    const r = await call("ebms_write", { company: "sbx", method: "POST", path: "ARINV", body: { ID: "C", ExternalId: "mcp-1" } });
    assert.match(String(r.reason), /already exists/);
    assert.match(sent[0]?.url ?? "", /\$filter=EXTERNALID eq 'mcp-1'/);

    sent = [];
    const both = await call("ebms_write", { company: "sbx", method: "POST", path: "ARINV", body: { ID: "C", EXTERNALID: "mcp-2", externalId: "mcp-3" } });
    assert.equal(both.refused, true);
    assert.match(String(both.error.message), /EXTERNALID more than once/);
    assert.equal(sent.length, 0);
});

test("the vendor ID check reads the ID under any spelling", async () => {
    fresh();
    script.push(() => json(201, { AUTOID: "V1" }));
    assert.equal((await call("ebms_write", { company: "sbx", method: "POST", path: "APVENDOR", body: { Id: "ACME" }, verify: false })).status, 201);
    const blank = await call("ebms_write", { company: "sbx", method: "POST", path: "APVENDOR", body: { id: " " }, verify: false });
    assert.match(String(blank.error.message), /a new vendor needs an ID/);
    const both = await call("ebms_write", { company: "sbx", method: "POST", path: "APVENDOR", body: { ID: "ACME", id: "" }, verify: false });
    assert.match(String(both.error.message), /ID more than once/);
});

test("this server's own refusal to send a request is not described as EBMS refusing it", () => {
    const r = JSON.parse(textOf(errorResult(new EbmsError("Refused: the request would leave this company's OData root. Nothing was sent.", 0, { kind: "refused" }), { method: "PATCH" }))) as Record<string, unknown>;
    assert.equal(r["advice"], "This server refused the request; nothing was sent to EBMS.");
    assert.equal(r["refused"], true);
    assert.equal(r["uncertain"], false);
});
