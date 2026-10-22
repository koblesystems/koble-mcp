/**
 * A nested add under a parent named by `#id` is verified exactly like one under `@id`: the
 * parent is an existing row, so an old child must not be taken for the new one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { configure } from "../src/config.js";
import { resetAuth } from "../src/ebms/client.js";
import { registerProxyTools } from "../src/tools/proxy-tools.js";
import type { McpToolResult } from "../src/tools/types.js";

const textOf = (result: McpToolResult): string => { const [first] = result.content; return first?.type === "text" ? first.text : "{}"; };

// Line L1 already has a BOLT x2 material. EBMS accepts the PATCH with a 200 and changes nothing.
const order = { AUTOID: "O1", Details: [{ AUTOID: "L1", INVEN: "MUG", Materials: [{ AUTOID: "M1", INVEN: "BOLT", M_QUAN_VIS: 2 }] }] };
const pick = (row: Record<string, unknown>, select: string): Record<string, unknown> => Object.fromEntries(select.split(",").filter((f) => f in row).map((f) => [f, row[f]]));
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });

globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/Token")) return json(200, { AccessToken: "a" });
    if ((init?.method ?? "GET") !== "GET") return json(200, { AUTOID: "O1" });
    const record: Record<string, unknown> = { AUTOID: "O1" };
    const expand = u.searchParams.get("$expand") ?? "";
    const m = /^Details\(\$select=([^;)]*)(?:;\$filter=[^;]*)?(?:;\$expand=Materials\(\$select=([^)]*)\))?\)$/.exec(expand);
    if (m) record["Details"] = order.Details.map((row) => ({ ...pick(row, m[1] as string), ...(m[2] ? { Materials: row.Materials.map((kid) => pick(kid, m[2] as string)) } : {}) }));
    return json(200, record);
}) as typeof fetch;

let write: (args: unknown) => Promise<McpToolResult>;
registerProxyTools((name, def, handler) => { if (name === "ebms_write") write = async (args) => handler(def.inputSchema.parse(args) as never); });

for (const key of ["@id", "#id"]) {
    test(`an ignored material add under a ${key} parent is reported, not passed on the strength of an old row`, async () => {
        configure({ EBMS_SERIAL_NUMBER: "000000000000000", EBMS_USERNAME: "u", EBMS_PASSWORD: "p", EBMS_COMPANIES: "sbx" });
        resetAuth();
        const body = { "Details@delta": [{ [key]: "L1", "Materials@delta": [{ INVEN: "BOLT", M_QUAN_VIS: 2 }] }] };
        const r = JSON.parse(textOf(await write({ company: "sbx", method: "PATCH", path: "ARINV('O1')", body }))) as { verification: { ok: boolean; problems: string[] } };
        assert.equal(r.verification.ok, false, JSON.stringify(r.verification));
        assert.match(r.verification.problems[0] ?? "", /no new row appeared/);
    });
}
