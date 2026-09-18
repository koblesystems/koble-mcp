import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertWriteCompany, configure, connectionFor, isWriteCompany, loadEnvFile, loadSettings, parseEnvFile, resolveCompany } from "../src/config.js";

const base = { EBMS_SERIAL_NUMBER: "000000000000000", EBMS_USERNAME: "u", EBMS_PASSWORD: "p" };

test("one company: it may be omitted, and sbx is the default write company", () => {
    configure({ ...base, EBMS_COMPANIES: "sbx" });
    assert.equal(resolveCompany(undefined), "SBX");
    assert.equal(resolveCompany("Sbx"), "SBX");
    assert.deepEqual(loadSettings().writeCompanies, ["SBX"]);
    assert.doesNotThrow(() => assertWriteCompany("sbx"));
});

test("several companies: the company must be named, and only listed ones resolve", () => {
    configure({ ...base, EBMS_COMPANIES: "sbx, LIVE" });
    assert.throws(() => resolveCompany(undefined), /Name the company/);
    assert.equal(resolveCompany("live"), "LIVE");
    assert.throws(() => resolveCompany("prod"), /not configured/);
});

test("writes are refused outside the allowlist, even for a readable company", () => {
    configure({ ...base, EBMS_COMPANIES: "sbx,live" });
    assert.equal(isWriteCompany("live"), false);
    assert.throws(() => assertWriteCompany("live"), /not in the write allowlist/);
    assert.equal(isWriteCompany("sbx"), true);
});

test("a write company that is not readable is dropped from the allowlist", () => {
    configure({ ...base, EBMS_COMPANIES: "live", EBMS_WRITE_COMPANIES: "sbx" });
    assert.deepEqual(loadSettings().writeCompanies, []);
    assert.throws(() => assertWriteCompany("live"), /allowlist \[\]/);
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

test("an env file fills in what the process environment lacks, and never overrides it", () => {
    const parsed = parseEnvFile('# creds\nexport EBMS_USERNAME="alice"\nEBMS_PASSWORD=\'p#ss word\'\nEBMS_COMPANIES=sbx\nnot a line\n');
    assert.deepEqual(parsed, { EBMS_USERNAME: "alice", EBMS_PASSWORD: "p#ss word", EBMS_COMPANIES: "sbx" });
});

test("loadEnvFile reads the named file into the configured environment, process values winning", () => {
    const dir = mkdtempSync(join(tmpdir(), "koble-mcp-"));
    const file = join(dir, ".env");
    writeFileSync(file, "EBMS_SERIAL_NUMBER=000000000000000\nEBMS_USERNAME=filed\nEBMS_PASSWORD=secret\nEBMS_COMPANIES=sbx\n");
    const env: Record<string, string | undefined> = { EBMS_USERNAME: "fromclient" };
    configure(env);
    assert.equal(loadEnvFile(file), file);
    assert.equal(env["EBMS_USERNAME"], "fromclient");
    assert.equal(env["EBMS_PASSWORD"], "secret");
    assert.equal(connectionFor("sbx").password, "secret");
    assert.equal(loadEnvFile(join(dir, "missing.env")), null);
});
