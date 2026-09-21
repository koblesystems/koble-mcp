/**
 * The three tools against a scripted fetch. Nothing here reaches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { configure } from "../src/config.js";
import { resetAuth } from "../src/ebms/client.js";
import { registerProxyTools } from "../src/tools/proxy-tools.js";
import type { McpToolResult } from "../src/tools/types.js";

const textOf = (result: McpToolResult): string => { const [first] = result.content; return first?.type === "text" ? first.text : "{}"; };


type Handler = (args: unknown) => Promise<McpToolResult>;
const tools: Record<string, Handler> = {};
registerProxyTools((name, def, handler) => {
    tools[name] = async (args) => handler(def.inputSchema.parse(args) as never);
});
const call = async (name: string, args: unknown): Promise<Record<string, unknown> & { isError?: boolean | undefined }> => {
    const handler = tools[name];
    assert.ok(handler, name);
    const result = await handler(args);
    return { ...(JSON.parse(textOf(result)) as Record<string, unknown>), isError: result.isError };
};

interface Sent { method: string; url: string; body: unknown }
let sent: Sent[] = [];
let script: Array<(s: Sent) => Response | Error> = [];
const json = (status: number, body: unknown): Response => new Response(body === null ? "" : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/Token")) return json(200, { AccessToken: "a", RefreshToken: "r" });
    const entry: Sent = { method: init?.method ?? "GET", url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    sent.push(entry);
    const next = script.shift() ?? (() => json(200, { value: [] }));
    const out = next(entry);
    if (out instanceof Error) throw out;
    return out;
}) as typeof fetch;

const fresh = (env: Record<string, string> = {}) => {
    configure({ EBMS_SERIAL_NUMBER: "000000000000000", EBMS_USERNAME: "u", EBMS_PASSWORD: "p", EBMS_COMPANIES: "sbx,live", EBMS_SANDBOX: "sbx", ...env });
    resetAuth();
    sent = [];
    script = [];
};

test("in testing mode a write outside the sandbox is refused before any request is sent", async () => {
    fresh();
    const r = await call("ebms_write", { company: "live", method: "PATCH", path: "ARINV('X')", body: { PO_NO: "1" }, verify: false });
    assert.equal(r.isError, true);
    assert.match(String((r.error as { message: string }).message), /restricts writes to SBX/);
    assert.equal(sent.length, 0);
});

test("PROCESS anywhere in a body is refused before any request is sent", async () => {
    fresh();
    const r = await call("ebms_write", { company: "sbx", method: "PATCH", path: "ARINV('X')", body: { "Details@delta": [{ "@id": "L", Process: "Process" }] } });
    assert.match(String((r.error as { message: string }).message), /PROCESS at \$\.Details@delta\[0\]\.Process/);
    assert.equal(sent.length, 0);
});

test("a POST whose EXTERNALID already exists is refused, and the existing record returned", async () => {
    fresh();
    script.push(() => json(200, { value: [{ AUTOID: "O1", INVOICE: "1193", EXTERNALID: "mcp-1" }] }));
    const r = await call("ebms_write", { company: "sbx", method: "POST", path: "ARINV", body: { ID: "SMIJOH", EXTERNALID: "mcp-1", Details: [] } });
    assert.equal(r.refused, true);
    assert.deepEqual((r.existing as unknown[]).length, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.method, "GET");
    assert.match(decodeURIComponent((sent[0]?.url ?? "").replace(/\+/g, " ")), /\$filter=EXTERNALID eq 'mcp-1'/);
});

test("the duplicate check covers every document entity, and nothing else", async () => {
    for (const entity of ["ARINV", "APINV", "INMFG", "TASK"]) {
        fresh();
        script.push(() => json(200, { value: [{ AUTOID: "X1", EXTERNALID: "mcp-1" }] }));
        const r = await call("ebms_write", { company: "sbx", method: "POST", path: entity, body: { EXTERNALID: "mcp-1" } });
        assert.equal(r.refused, true, entity);
        assert.equal(sent.length, 1, `${entity}: checked, nothing sent`);
    }
    fresh();
    script.push(() => json(201, { AUTOID: "V1" }));
    await call("ebms_write", { company: "sbx", method: "POST", path: "APVENDOR", body: { ID: "V", EXTERNALID: "mcp-1" }, verify: false });
    assert.deepEqual(sent.map((s) => s.method), ["POST"], "an entity off the list is not pre-checked");
});

test("a POST with a new EXTERNALID checks first, then creates", async () => {
    fresh();
    script.push(() => json(200, { value: [] }), () => json(201, { AUTOID: "O2", INVOICE: "1194" }));
    const r = await call("ebms_write", { company: "sbx", method: "POST", path: "ARINV", body: { ID: "SMIJOH", EXTERNALID: "mcp-2", Details: [] }, verify: false });
    assert.equal(r.status, 201);
    assert.deepEqual(sent.map((s) => s.method), ["GET", "POST"]);
    assert.deepEqual(sent[1]?.body, { ID: "SMIJOH", EXTERNALID: "mcp-2", Details: [] });
});

test("a timeout or a 5xx comes back uncertain; a 422 does not", async () => {
    fresh();
    script.push(() => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    const t = await call("ebms_write", { company: "sbx", method: "PATCH", path: "ARINV('X')", body: { PO_NO: "1" }, verify: false });
    assert.equal(t.uncertain, true);
    assert.equal((t.error as { kind: string }).kind, "timeout");

    script.push(() => json(504, null));
    const g = await call("ebms_write", { company: "sbx", method: "PATCH", path: "ARINV('X')", body: { PO_NO: "1" }, verify: false });
    assert.equal(g.uncertain, true);

    script.push(() => json(422, { Messages: [{ TextBriefDescription: "Saving has been aborted", TextDetail: "requires a general ledger account" }] }));
    const r = await call("ebms_write", { company: "sbx", method: "PATCH", path: "ARINV('X')", body: { PO_NO: "1" }, verify: false });
    assert.equal(r.uncertain, false);
    assert.equal((r.error as { detail: string }).detail, "requires a general ledger account");
});

test("a 2xx with warnings succeeds and carries them", async () => {
    fresh();
    script.push(() => json(200, { AUTOID: "X", Messages: [{ Severity: "Warning", TextBriefDescription: "Over credit limit" }] }));
    const r = await call("ebms_write", { company: "sbx", method: "PATCH", path: "ARINV('X')", body: { PO_NO: "1" }, verify: false });
    assert.equal(r.isError, undefined);
    assert.deepEqual(r.warnings, ["Warning: Over credit limit"]);
});

test("a command without a body sends no body at all, and actions off the allow-list never go out", async () => {
    fresh();
    script.push(() => json(200, null));
    const ok = await call("ebms_command", { company: "sbx", entity: "ARINV", key: "X", command: "MarkAllAsShipped" });
    assert.equal(ok.status, 200);
    assert.equal(sent[0]?.body, undefined);
    assert.match(sent[0]?.url ?? "", /ARINV\('X'\)\/Model\.Entities\.MarkAllAsShipped$/);
    for (const command of ["Send", "ProcessScanner", "Post"]) {
        const denied = await call("ebms_command", { company: "sbx", entity: "ARINV", key: "X", command });
        assert.match(String((denied.error as { message: string }).message), /not one of the actions this server runs/, command);
    }
    assert.equal(sent.length, 1);
});

test("reads work on a company outside the sandbox, report truncation, and warn without a select", async () => {
    fresh();
    script.push(() => json(200, { "@odata.count": 120, value: [{ AUTOID: "1" }] }));
    const r = await call("ebms_get", { company: "live", path: "ARINV", filter: "STATUS eq 'U'", top: 1 });
    assert.equal(r.truncated, true);
    assert.equal(r.total, 120);
    assert.match((r.warnings as string[]).join(" "), /No select/);
    assert.match(sent[0]?.url ?? "", /\/MyEbms\/LIVE\/OData\/ARINV\?/);
    assert.match(sent[0]?.url ?? "", /%24count=true/);
});

test("with several companies configured, a read without a company is refused", async () => {
    fresh();
    const r = await call("ebms_get", { path: "ARINV", select: "AUTOID" });
    assert.match(String((r.error as { message: string }).message), /Name the company/);
    assert.equal(sent.length, 0);
});

test("a 401 is retried once with a fresh token", async () => {
    fresh();
    script.push(() => json(401, null), () => json(200, { AUTOID: "X" }));
    const r = await call("ebms_get", { company: "sbx", path: "ARINV('X')", select: "AUTOID" });
    assert.deepEqual(r.record, { AUTOID: "X" });
    assert.equal(sent.length, 2);
});

test("a failed read is never described as a write that was or wasn't saved", async () => {
    fresh();
    script.push(() => json(422, { Messages: [{ TextBriefDescription: "Key not found" }] }));
    const refused = await call("ebms_get", { company: "sbx", path: "ARINV('NOPE')", select: "AUTOID" });
    assert.equal(refused.advice, "EBMS refused this request.");
    script.push(() => json(504, null));
    const lost = await call("ebms_get", { company: "sbx", path: "ARINV('X')", select: "AUTOID" });
    assert.equal(lost.uncertain, true);
    assert.match(String(lost.advice), /safe to try again/);
    script.push(() => json(504, null));
    const write = await call("ebms_write", { company: "sbx", method: "PATCH", path: "ARINV('X')", body: { PO_NO: "1" }, verify: false });
    assert.match(String(write.advice), /Read the record back/);
});

test("a crafted path or key cannot reach another company or another action", async () => {
    fresh();
    const write = await call("ebms_write", { company: "sbx", method: "PATCH", path: "ARINV('/../../../LIVE/OData/ARINV(%27K%27)?x=')", body: { MEMO: "x" }, verify: false });
    assert.equal(write.refused, true);
    const command = await call("ebms_command", { company: "sbx", entity: "ARINV", key: "K%27)/Model.Entities.Send#", command: "MarkAllAsShipped" });
    assert.equal(command.refused, true);
    const read = await call("ebms_get", { company: "sbx", path: "ARINV('/../../../LIVE/OData/ARINV?x=')", select: "AUTOID" });
    assert.equal(read.refused, true);
    assert.equal(sent.length, 0, "nothing went on the wire");
});

test("a key with a hash or a space goes out encoded, inside the company", async () => {
    fresh();
    script.push(() => json(200, { AUTOID: "X" }));
    await call("ebms_get", { company: "sbx", path: "INVENTRY('PO#110 A')", select: "ID" });
    assert.match(sent[0]?.url ?? "", /\/MyEbms\/SBX\/OData\/INVENTRY\('PO%23110%20A'\)\?/);
});

test("a write whose response breaks off mid-body is uncertain, never refused", async () => {
    fresh();
    script.push(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"AUTOID":')); controller.error(new TypeError("terminated")); } }), { status: 200 }));
    const r = await call("ebms_write", { company: "sbx", method: "PATCH", path: "ARINV('X')", body: { PO_NO: "1" }, verify: false });
    assert.equal(r.uncertain, true);
    assert.match(String(r.advice), /Read the record back/);
});

test("a 2xx that carries an error message is uncertain too", async () => {
    fresh();
    script.push(() => json(200, { Messages: [{ Severity: "Error", TextBriefDescription: "Saving has been aborted" }] }));
    const r = await call("ebms_write", { company: "sbx", method: "PATCH", path: "ARINV('X')", body: { PO_NO: "1" }, verify: false });
    assert.equal(r.uncertain, true);
});

test("when the check before a write fails, the result says nothing was sent", async () => {
    fresh();
    script.push(() => json(503, null));
    const r = await call("ebms_write", { company: "sbx", method: "POST", path: "ARINV", body: { ID: "SMIJOH", EXTERNALID: "x-1", Details: [] } });
    assert.equal(r.refused, true);
    assert.equal(r.uncertain, false);
    assert.match(String(r.reason), /was NOT sent/);
    assert.deepEqual(sent.map((x) => x.method), ["GET"]);
});

test("every refusal has the same shape", async () => {
    fresh();
    const r = await call("ebms_write", { company: "live", method: "PATCH", path: "ARINV('X')", body: { PO_NO: "1" } });
    assert.equal(r.uncertain, false);
    assert.match(String(r.advice), /nothing was sent/);
});

test("a failure inside this server AFTER the write went out is uncertain, never 'nothing was sent'", async () => {
    fresh();
    // A 200 whose envelope is malformed used to throw a TypeError after the PATCH had been sent.
    script.push(() => json(200, { AUTOID: "X", Messages: [null, { Severity: 3, TextBriefDescription: "odd" }] }));
    const r = await call("ebms_write", { company: "sbx", method: "PATCH", path: "ARINV('X')", body: { PO_NO: "1" }, verify: false });
    assert.notEqual(r.refused, true);
    assert.equal(r.isError === true ? r.uncertain : true, true, "either it succeeds, or it is uncertain — it is never 'not sent'");
});

test("failing to sign in before a write is a refusal with nothing sent, not an unknown outcome", async () => {
    fresh();
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => (String(url).endsWith("/Token") ? new Response("", { status: 503 }) : real(url, init))) as typeof fetch;
    try {
        const r = await call("ebms_write", { company: "sbx", method: "PATCH", path: "ARINV('X')", body: { PO_NO: "1" }, verify: false });
        assert.equal(r.uncertain, false);
        assert.match(String((r.error as { message: string }).message), /Could not sign in.*not sent/);
        assert.equal(sent.length, 0);
    } finally {
        globalThis.fetch = real;
    }
});
