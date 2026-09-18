import { test } from "node:test";
import assert from "node:assert/strict";
import { assertWriteCompany, configure, connectionFor, isWriteCompany, loadSettings, resolveCompany } from "../src/config.js";

const base = { EBMS_SERIAL_NUMBER: "000000000000000", EBMS_USERNAME: "u", EBMS_PASSWORD: "p" };

test("one company: it may be omitted, and it may be written to", () => {
    configure({ ...base, EBMS_COMPANIES: "sbx" });
    assert.equal(resolveCompany(undefined), "SBX");
    assert.equal(resolveCompany("Sbx"), "SBX");
    assert.equal(loadSettings().sandbox, null);
    assert.doesNotThrow(() => assertWriteCompany("sbx"));
});

test("every listed company may be read and written", () => {
    configure({ ...base, EBMS_COMPANIES: "sbx,live" });
    assert.equal(isWriteCompany("live"), true);
    assert.equal(isWriteCompany("sbx"), true);
    assert.throws(() => assertWriteCompany("prod"), /not configured/);
});

test("EBMS_SANDBOX restricts writes to one company while testing, and makes it readable", () => {
    configure({ ...base, EBMS_COMPANIES: "live", EBMS_SANDBOX: "sbx" });
    assert.deepEqual(loadSettings().companies, ["LIVE", "SBX"]);
    assert.equal(isWriteCompany("sbx"), true);
    assert.equal(isWriteCompany("live"), false);
    assert.throws(() => assertWriteCompany("live"), /restricts writes to SBX/);
    configure({ ...base, EBMS_SANDBOX: "test" });
    assert.deepEqual(loadSettings().companies, ["TEST"]);
    assert.equal(resolveCompany(undefined), "TEST");
});

test("several companies: the company must be named, and only listed ones resolve", () => {
    configure({ ...base, EBMS_COMPANIES: "sbx, LIVE" });
    assert.throws(() => resolveCompany(undefined), /Name the company/);
    assert.equal(resolveCompany("live"), "LIVE");
    assert.throws(() => resolveCompany("prod"), /not configured/);
});

test("the sandbox is one company, not a list", () => {
    configure({ ...base, EBMS_SANDBOX: "sbx,live" });
    assert.throws(() => loadSettings(), /names one company/);
});

test("the legacy single-company variable still works", () => {
    configure({ ...base, EBMS_COMPANY_ID: "sbx" });
    assert.deepEqual(loadSettings().companies, ["SBX"]);
});

test("per-company credentials override the defaults and never leak into the URL", () => {
    configure({ ...base, EBMS_COMPANIES: "sbx,live", EBMS_LIVE_USERNAME: "lu", EBMS_LIVE_PASSWORD: "lp" });
    assert.equal(connectionFor("sbx").username, "u");
    assert.equal(connectionFor("live").username, "lu");
    assert.equal(connectionFor("live").password, "lp");
    assert.equal(connectionFor("live").baseUrl, "https://000000000000000.koblesystems.dev/MyEbms/LIVE/OData");
});

test("a company with no credentials at all is an error, not a request", () => {
    configure({ EBMS_SERIAL_NUMBER: "000000000000000", EBMS_COMPANIES: "sbx" });
    assert.throws(() => connectionFor("sbx"), /no credentials/);
});
