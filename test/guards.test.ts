import { test } from "node:test";
import assert from "node:assert/strict";
import { entityOf, externalIdOf, findProcessKeys, isDeniedCommand, validatePath } from "../src/guards.js";
import { errorFromBody, warningsFromBody, EbmsError } from "../src/ebms/errors.js";

test("entity paths are accepted; anything with a query, a slash or an action is not", () => {
    assert.equal(validatePath("/ARINV"), "ARINV");
    assert.equal(validatePath("ARINV('7XQPR42LM8W91000')"), "ARINV('7XQPR42LM8W91000')");
    assert.equal(validatePath("ARINV('O''Brien')"), "ARINV('O''Brien')");
    assert.equal(validatePath("APINV(ID='AMERET',INVOICE='1234')"), "APINV(ID='AMERET',INVOICE='1234')");
    assert.equal(validatePath("$metadata"), "$metadata");
    for (const bad of ["ARINV?$select=AUTOID", "ARINV('x')/Model.Entities.Send", "../Token", "ARINV(7XQPR42LM8W91000)", "ARINV('x') or 1", ""]) {
        assert.throws(() => validatePath(bad), /not an entity path/, bad);
    }
    assert.equal(entityOf("ARINV('x')"), "ARINV");
});

test("PROCESS is found at any depth, in any case, with or without a prefix", () => {
    assert.deepEqual(findProcessKeys({ PROCESS: "Process" }), ["$.PROCESS"]);
    assert.deepEqual(findProcessKeys({ Details: [{ INVEN: "X" }], nested: { process: "Unprocess" } }), ["$.nested.process"]);
    assert.deepEqual(findProcessKeys({ "Details@delta": [{ "@id": "L1", "@PROCESS": true }] }), ["$.Details@delta[0].@PROCESS"]);
    assert.deepEqual(findProcessKeys({ ID: "SMIJOH", Details: [{ INVEN: "MUG", M_QUAN_VIS: 1 }] }), []);
    assert.deepEqual(findProcessKeys(undefined), []);
});

test("denied commands match case-insensitively", () => {
    assert.equal(isDeniedCommand("send", ["Send", "RecordPayment"]), true);
    assert.equal(isDeniedCommand("MarkAllAsShipped", ["Send"]), false);
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
});
