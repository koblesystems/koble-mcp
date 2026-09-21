import { test } from "node:test";
import assert from "node:assert/strict";
import { availableCompanies, configure, isWriteCompany, resolveCompany, setDiscoveredCompanies } from "../src/config.js";
import { parseCompanyList } from "../src/ebms/companies.js";

const base = { EBMS_SERIAL_NUMBER: "000000000000000", EBMS_USERNAME: "u", EBMS_PASSWORD: "p" };
const found = parseCompanyList([
    { Id: "SBX", Name: "Sample Coffee Co", Version: "1.8.148", ApiVersion: "4" },
    { Id: "LIVE", Name: "Acme Hardware", Version: "1.8.148" },
    { Name: "no id, dropped" },
]);

test("the company list parses into id, name and version", () => {
    assert.deepEqual(found, [
        { id: "SBX", name: "Sample Coffee Co", version: "1.8.148" },
        { id: "LIVE", name: "Acme Hardware", version: "1.8.148" },
    ]);
});

test("with nothing configured, every discovered company is available, by ID or by name", () => {
    configure(base);
    setDiscoveredCompanies(found);
    assert.deepEqual(availableCompanies().map((c) => c.id), ["SBX", "LIVE"]);
    assert.equal(resolveCompany("acme hardware"), "LIVE");
    assert.equal(resolveCompany("live"), "LIVE");
    assert.throws(() => resolveCompany(undefined), /Name the company. Available: SBX \(Sample Coffee Co\), LIVE \(Acme Hardware\)/);
    assert.throws(() => resolveCompany("Bakery"), /not available/);
    assert.equal(isWriteCompany("live"), true);
});

test("EBMS_COMPANIES narrows discovery, and discovery supplies the names", () => {
    configure({ ...base, EBMS_COMPANIES: "sbx" });
    setDiscoveredCompanies(found);
    assert.deepEqual(availableCompanies(), [{ id: "SBX", name: "Sample Coffee Co", version: "1.8.148" }]);
    assert.equal(resolveCompany(undefined), "SBX");
    assert.throws(() => resolveCompany("Acme Hardware"), /not available/);
});

test("before discovery, configured IDs still work and nothing else does", () => {
    configure({ ...base, EBMS_COMPANIES: "sbx" });
    assert.equal(resolveCompany("sbx"), "SBX");
    configure(base);
    assert.throws(() => resolveCompany("sbx"), /No companies are known/);
});

test("the sandbox is available even when discovery did not list it", () => {
    configure({ ...base, EBMS_SANDBOX: "test" });
    setDiscoveredCompanies(found);
    assert.deepEqual(availableCompanies().map((c) => c.id), ["SBX", "LIVE", "TEST"]);
    assert.equal(isWriteCompany("sbx"), false);
    assert.equal(isWriteCompany("test"), true);
});

test("a name shared by two companies is refused; the ID still works; IDs that are not plain are never used", () => {
    configure(base);
    setDiscoveredCompanies([{ id: "LIVE", name: "Acme Bikes", version: null }, { id: "TESTCOPY", name: "Acme Bikes", version: null }, { id: "SBX/../LIVE", name: "Trick", version: null }]);
    assert.throws(() => resolveCompany("acme bikes"), /is the name of 2 companies \(LIVE, TESTCOPY\)/);
    assert.equal(resolveCompany("testcopy"), "TESTCOPY");
    assert.deepEqual(availableCompanies().map((c) => c.id), ["LIVE", "TESTCOPY"]);
    configure({ ...base, EBMS_SANDBOX: "sbx/../live" });
    assert.throws(() => availableCompanies(), /not a company ID/);
    configure({ ...base, EBMS_COMPANIES: "sbx,li ve" });
    assert.throws(() => availableCompanies(), /not a company ID/);
});
