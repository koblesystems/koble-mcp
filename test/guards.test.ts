import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeKey, entityOf, externalIdOf, findProcessKeys, isAllowedCommand, validatePath } from "../src/guards.js";
import { safeUrl } from "../src/ebms/client.js";
import { errorFromBody, warningsFromBody, EbmsError } from "../src/ebms/errors.js";

test("entity paths are parsed and rebuilt, so a key can never add a segment, a query or a fragment", () => {
    assert.equal(validatePath("/ARINV"), "ARINV");
    assert.equal(validatePath("ARINV('7XQPR42LM8W91000')"), "ARINV('7XQPR42LM8W91000')");
    assert.equal(validatePath("ARINV('O''Brien')"), "ARINV('O''Brien')");
    assert.equal(validatePath("INVENTRY('12 OZ HSBLEND')"), "INVENTRY('12%20OZ%20HSBLEND')");
    assert.equal(validatePath("APINV(ID='AMERET',INVOICE='PO#110')"), "APINV(ID='AMERET',INVOICE='PO%23110')");
    assert.equal(validatePath("$metadata"), "$metadata");
    assert.equal(entityOf("ARINV('x')"), "ARINV");
    for (const bad of ["ARINV?$select=AUTOID", "ARINV('x')/Model.Entities.Send", "../Token", "ARINV(7XQPR42LM8W91000)", "ARINV('x') or 1", "", "ARINV('a'b')", "ARINV('x'", "1ARINV"]) {
        assert.throws(() => validatePath(bad), /not an entity path/, bad);
    }
});

test("the traversal the review found is refused at the guard, whatever shape it takes", () => {
    const attacks = [
        "ARINV('/../../../LIVE/OData/ARINV(%27K%27)?x=')",
        "ARINV('/../../../LIVE/OData/ARINV(%27K%27)#')",
        "ARINV('..')",
        "ARINV('a\\..\\b')",
        "ARINV('K%27)/Model.Entities.Send')",
        "ARINV('x?y=1')",
        "ARINV(ID='a/b')",
    ];
    for (const path of attacks) assert.throws(() => validatePath(path), /not allowed in a record key/, path);
    for (const key of ["K%27)/Model.Entities.Send#", "/../../../LIVE/OData/ARINV(%27K%27)/Model.Entities.Send#", "a/b", "a?b", "a..b", "tab\there".replace("\\t", String.fromCharCode(9))]) {
        assert.throws(() => encodeKey(key), /not allowed in a record key/, key);
    }
    assert.equal(encodeKey("K#1"), "'K%231'", "a hash is data, not a fragment");
    assert.equal(encodeKey("it's"), "'it''s'");
});

test("the finished URL must stay inside the company's OData root", () => {
    const base = "https://000.koblesystems.dev/MyEbms/SANDBOX/OData";
    assert.equal(safeUrl(base, "ARINV('K')?%24select=AUTOID"), `${base}/ARINV('K')?%24select=AUTOID`);
    for (const path of ["../../LIVE/OData/ARINV('K')", "ARINV/../../../LIVE/OData/ARINV", "ARINV('K')#frag", "//evil.example/x", "..", ""]) {
        assert.throws(() => safeUrl(base, path), /leave this company/, path);
    }
});

test("PROCESS is found at any depth, in any case, with or without a prefix", () => {
    assert.deepEqual(findProcessKeys({ PROCESS: "Process" }), ["$.PROCESS"]);
    assert.deepEqual(findProcessKeys({ Details: [{ INVEN: "X" }], nested: { process: "Unprocess" } }), ["$.nested.process"]);
    assert.deepEqual(findProcessKeys({ "Details@delta": [{ "@id": "L1", "@PROCESS": true }] }), ["$.Details@delta[0].@PROCESS"]);
    assert.deepEqual(findProcessKeys({ ID: "SMIJOH", Details: [{ INVEN: "MUG", M_QUAN_VIS: 1 }] }), []);
    assert.deepEqual(findProcessKeys(undefined), []);
});

test("commands are allowed by name; posting, processing and sending actions are not on the list", () => {
    const allowed = ["MarkAllAsShipped", "RecalculateAllPrices", "CalculateFreight", "ChangeCustomer"];
    assert.equal(isAllowedCommand("markallasshipped", allowed), true);
    for (const command of ["Send", "RecordPayment", "ProcessScanner", "ProcessAndPrintScanner", "Process", "Unprocess", "Post", "Unpost", "PrintReport"]) {
        assert.equal(isAllowedCommand(command, allowed), false, command);
    }
});

test("EXTERNALID is read only from a non-empty top-level string", () => {
    assert.equal(externalIdOf({ EXTERNALID: " abc " }), "abc");
    assert.equal(externalIdOf({ EXTERNALID: "" }), undefined);
    assert.equal(externalIdOf({ Details: [{ EXTERNALID: "x" }] }), undefined);
});

test("warnings on a 2xx are not errors; on a 4xx every message is", () => {
    const warn = { Messages: [{ Severity: "Warning", TextBriefDescription: "Over credit limit" }] };
    assert.equal(errorFromBody(warn, 200), null);
    assert.deepEqual(warningsFromBody(warn, 200), ["Warning: Over credit limit"]);
    assert.match(errorFromBody(warn, 422)?.message ?? "", /Over credit limit/);
    const err = { Messages: [{ Severity: "Error", TextBriefDescription: "Saving has been aborted", TextDetail: "requires a general ledger account" }] };
    const e = errorFromBody(err, 200);
    assert.ok(e);
    assert.equal(e.detail, "requires a general ledger account");
    assert.equal(errorFromBody({ Messages: [{ TextBriefDescription: "no severity" }] }, 200), null);
});

test("uncertain means a timeout, a network failure, a 408 or a 5xx — never a 4xx", () => {
    assert.equal(new EbmsError("x", 0, { kind: "timeout" }).uncertain, true);
    assert.equal(new EbmsError("x", 0, { kind: "network" }).uncertain, true);
    assert.equal(new EbmsError("x", 504).uncertain, true);
    assert.equal(new EbmsError("x", 500).uncertain, true);
    assert.equal(new EbmsError("x", 422).uncertain, false);
    assert.equal(new EbmsError("x", 403).uncertain, false);
    assert.equal(new EbmsError("x", 200, { kind: "embedded" }).uncertain, true, "a 2xx carrying an error may still have saved");
    assert.equal(new EbmsError("x", 0, { kind: "refused" }).uncertain, false);
});
