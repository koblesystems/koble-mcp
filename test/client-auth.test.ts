/**
 * The client's sign-in paths against a scripted fetch: Bearer with refresh, the Basic fallback
 * and its recheck, and redirects refused on every request.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { configure } from "../src/config.js";
import { request, resetAuth } from "../src/ebms/client.js";

interface Seen { path: string; auth: string | undefined; redirect: RequestRedirect | undefined; body: unknown }
let seen: Seen[] = [];
let token: () => Response;
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });

globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace(/^.*\/OData\//, "").replace(/^.*\/(Token|RefreshToken)$/, "$1");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ path, auth: headers["Authorization"], redirect: init?.redirect, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "Token") return token();
    if (path === "RefreshToken") return json(200, { AccessToken: "fresh" });
    return json(200, { value: [] });
}) as typeof fetch;

const fresh = (answer: () => Response) => {
    configure({ EBMS_SERIAL_NUMBER: "000000000000000", EBMS_USERNAME: "u", EBMS_PASSWORD: "p", EBMS_COMPANIES: "sbx" });
    resetAuth();
    seen = [];
    token = answer;
};
const read = async () => request("sbx", "GET", "ARINV?$select=AUTOID");
const basic = "Basic " + Buffer.from("u:p").toString("base64");

test("every request, /Token included, refuses to follow a redirect", async () => {
    fresh(() => json(200, { AccessToken: "a" }));
    await read();
    assert.deepEqual(seen.map((s) => [s.path, s.redirect]), [["Token", "error"], ["ARINV", "error"]]);
});

test("a 404 from /Token means Basic, but only until /Token is tried again ten minutes later", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    try {
        fresh(() => new Response("", { status: 404 }));
        await read();
        await read();
        assert.deepEqual(seen.map((s) => [s.path, s.auth]), [["Token", undefined], ["ARINV", basic], ["ARINV", basic]], "one probe, then Basic");

        seen = [];
        token = () => json(200, { AccessToken: "a" });
        mock.timers.tick(10 * 60 * 1000 + 1);
        await read();
        assert.deepEqual(seen.map((s) => [s.path, s.auth]), [["Token", undefined], ["ARINV", "Bearer a"]]);
    } finally {
        mock.timers.reset();
    }
});

test("a token older than its lifetime is refreshed with the refresh token before the next request", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    try {
        fresh(() => json(200, { AccessToken: "a", RefreshToken: "r" }));
        await read();
        mock.timers.tick(9 * 60 * 1000 + 1);
        await read();
        assert.deepEqual(seen.map((s) => [s.path, s.auth]), [["Token", undefined], ["ARINV", "Bearer a"], ["RefreshToken", undefined], ["ARINV", "Bearer fresh"]]);
        assert.deepEqual(seen[2]?.body, { RefreshToken: "r" });
    } finally {
        mock.timers.reset();
    }
});
