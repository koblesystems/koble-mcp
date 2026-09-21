import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRecord, checkRows, emptyVerification, fieldsOf, finish, sameValue, shapeOf } from "../src/verify.js";

test("values compare the way EBMS stores them", () => {
    assert.equal(sameValue(8.33, 8.330001), true);
    assert.equal(sameValue(1, 0), false);
    assert.equal(sameValue("PO-1", "PO-1      "), true);
    assert.equal(sameValue("a\nb", "a\r\nb"), true);
    assert.equal(sameValue("", null), true);
    assert.equal(sameValue(true, false), false);
    assert.equal(sameValue(12.5, "12.50"), true);
    assert.equal(sameValue(0.004, 0), false, "a small quantity EBMS zeroed is still zeroed");
    assert.equal(sameValue(0, 0.004), true);
    assert.equal(sameValue("2026-10-05", "2026-10-05T00:00:00Z"), true);
    assert.equal(sameValue("2026-10-05", "2026-10-06T00:00:00Z"), false);
});

test("a body splits into scalars, deltas and create arrays; control keys are ignored", () => {
    const shape = shapeOf({ PO_NO: "1", "@odata.type": "x", "Details@delta": [{ "@id": "L1", M_QUAN_VIS: 2 }], Details: [{ INVEN: "A" }] });
    assert.deepEqual(shape.scalars, { PO_NO: "1" });
    assert.deepEqual(Object.keys(shape.deltas), ["Details"]);
    assert.deepEqual(Object.keys(shape.creates), ["Details"]);
    assert.deepEqual(fieldsOf([{ "@id": "L1", M_QUAN_VIS: 2, Materials: [] }, { INVEN: "A" }]), ["M_QUAN_VIS", "INVEN"]);
});

test("a quantity EBMS zeroed is a mismatch, with both numbers", () => {
    const out = emptyVerification();
    checkRows("", "Details", [{ INVEN: "TEAMJERSEY", M_QUAN_VIS: 1 }], [{ AUTOID: "N1", INVEN: "TEAMJERSEY", M_QUAN_VIS: 0 }], new Set(["L1"]), out);
    finish(out);
    assert.equal(out.ok, false);
    assert.deepEqual(out.mismatches, [{ where: "Details[1] TEAMJERSEY", field: "M_QUAN_VIS", sent: 1, stored: 0 }]);
});

test("an unknown @id, a removal that did not happen, and an add that never appeared are problems", () => {
    const out = emptyVerification();
    const stored = [{ AUTOID: "L1", M_QUAN_VIS: 5 }, { AUTOID: "L2", M_QUAN_VIS: 1 }];
    checkRows("", "Details", [{ "@id": "TYPO", M_QUAN_VIS: 3 }, { "@id": "L2", "@removed": true }, { INVEN: "NEW", M_QUAN_VIS: 1 }], stored, new Set(["L1", "L2"]), out);
    finish(out);
    assert.equal(out.ok, false);
    assert.match(out.problems.join("\n"), /no row with @id TYPO/);
    assert.match(out.problems.join("\n"), /L2 was to be removed but is still there/);
    assert.match(out.problems.join("\n"), /no new row appeared/);
});

test("two identical adds each claim their own new row, and rows EBMS added are noted, not failed", () => {
    const out = emptyVerification();
    const stored = [{ AUTOID: "L1", INVEN: "OLD", M_QUAN_VIS: 1 }, { AUTOID: "N1", INVEN: "MUG", M_QUAN_VIS: 1 }, { AUTOID: "N2", INVEN: "WATERBOTTLE", M_QUAN_VIS: 1 }, { AUTOID: "N3", INVEN: "MUG", M_QUAN_VIS: 1 }];
    const matched = checkRows("", "Details", [{ INVEN: "MUG", M_QUAN_VIS: 1 }, { INVEN: "MUG", M_QUAN_VIS: 1 }], stored, new Set(["L1"]), out);
    finish(out);
    assert.deepEqual(matched.map((row) => row?.["AUTOID"]), ["N1", "N3"]);
    assert.equal(out.ok, true);
    assert.match(out.notes.join("\n"), /EBMS added 1 row\(s\) that were not in the request \(WATERBOTTLE\)/);
});

test("top-level fields are compared, truncation included", () => {
    const out = emptyVerification();
    checkRecord({ PO_NO: "PO-123456789012345678901" }, { PO_NO: "PO-12345678901234567" }, out);
    finish(out);
    assert.equal(out.mismatches[0]?.field, "PO_NO");
});
