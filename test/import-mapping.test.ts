import { test } from "node:test";
import assert from "node:assert/strict";
import { coerce, parseNumber, resolveMapping } from "../src/import/mapping.js";
import { RULES } from "../src/import/rules.js";
import { meta } from "./import-fixtures.js";

const products = RULES["INVENTRY"]!;
const fieldOf = (m: ReturnType<typeof resolveMapping>, header: string) => m.columns.find((c) => c.header === header)?.field;

test("headers match by field name, ignoring case and punctuation", () => {
    const m = resolveMapping(["id", "Descr 1", "tree_id", "c-type"], products, meta("INVENTRY"));
    assert.deepEqual(m.columns.map((c) => c.field), ["ID", "DESCR_1", "TREE_ID", "C_TYPE"]);
    assert.deepEqual(m.fatal, []);
});

test("aliases are scoped to the entity: Part Number is the product ID on INVENTRY", () => {
    const m = resolveMapping(["Part Number", "Name", "Folder", "Cost"], products, meta("INVENTRY"));
    assert.equal(fieldOf(m, "Part Number"), "ID");
    assert.equal(fieldOf(m, "Name"), "DESCR_1");
    assert.equal(fieldOf(m, "Folder"), "TREE_ID");
    const c = resolveMapping(["Name", "Folder"], RULES["ARCUST"]!, meta("ARCUST"));
    assert.equal(fieldOf(c, "Name"), "L_NAME", "the same header means the customer's name on ARCUST");
});

test("an EBMS label matches when nothing else does", () => {
    const m = resolveMapping(["ID", "Expiration", "Base price"], products, meta("INVENTRY"));
    assert.equal(fieldOf(m, "Expiration"), "E_DATE");
    assert.equal(m.columns.find((c) => c.header === "Expiration")?.by, "EBMS label");
    assert.equal(fieldOf(m, "Base price"), "BASE");
});

test("an explicit mapping wins, and \"\" leaves a column out", () => {
    const m = resolveMapping(["ID", "Cost", "Old cost"], products, meta("INVENTRY"), { "Old cost": "COST", Cost: "" });
    assert.equal(fieldOf(m, "Old cost"), "COST");
    assert.ok(m.unmapped.includes("Cost"));
    assert.deepEqual(m.fatal, []);
});

test("two headers on one field is fatal", () => {
    const m = resolveMapping(["ID", "SKU"], products, meta("INVENTRY"));
    assert.match(m.fatal.join(" "), /Two columns, "ID" and "SKU", both map to ID/);
});

test("an explicit mapping to a read-only or virtual field is fatal; an automatic one is dropped with a note", () => {
    assert.match(resolveMapping(["ID", "Folder name"], products, meta("INVENTRY"), { "Folder name": "FOLDERNAME" }).fatal.join(" "), /does not let you write/);
    assert.match(resolveMapping(["ID", "x"], products, meta("INVENTRY"), { x: "Title" }).fatal.join(" "), /computes/);
    const auto = resolveMapping(["ID", "FOLDERNAME"], products, meta("INVENTRY"));
    assert.deepEqual(auto.fatal, []);
    assert.equal(fieldOf(auto, "FOLDERNAME"), undefined);
    assert.match(auto.notes.join(" "), /FOLDERNAME.*left out/);
});

test("a missing key column is fatal unless defaults supply it; a mapping to an unknown column or field is fatal", () => {
    assert.match(resolveMapping(["Name"], products, meta("INVENTRY")).fatal.join(" "), /No column holds ID/);
    assert.deepEqual(resolveMapping(["Name"], RULES["ARCUST"]!, meta("ARCUST")).fatal, [], "a customer ID may be left to EBMS");
    assert.match(resolveMapping(["ID"], products, meta("INVENTRY"), { Nope: "COST" }).fatal.join(" "), /column "nope" that is not in the file/);
    assert.match(resolveMapping(["ID", "x"], products, meta("INVENTRY"), { x: "NOPE" }).fatal.join(" "), /not a field of INVENTRY/);
    assert.match(resolveMapping(["ID"], products, meta("INVENTRY"), {}, { WRONG: 1 }).fatal.join(" "), /defaults names WRONG/);
});

test("a set whose key EBMS will not take from the API cannot be imported", () => {
    assert.match(resolveMapping(["Level", "Round"], RULES["INPRICE"]!, meta("INPRICE")).fatal.join(" "), /does not let the API set LEVEL.*Set them up in EBMS/);
});

test("a configuration set is keyed on its live natural key", () => {
    const m = resolveMapping(["Department", "Description"], RULES["GLDEPT"]!, meta("GLDEPT"));
    assert.deepEqual(m.columns.map((c) => c.field), ["DEPT_ID", "DESCR"]);
    assert.deepEqual(m.fatal, []);
});

test("numbers as people type them, and nothing ambiguous", () => {
    assert.equal(parseNumber("$1,250.00"), 1250);
    assert.equal(parseNumber("-3"), -3);
    assert.equal(parseNumber("(3.50)"), -3.5);
    assert.equal(parseNumber("-$4"), -4);
    assert.equal(parseNumber("6%"), 6);
    assert.equal(parseNumber(".5"), 0.5);
    assert.equal(parseNumber("1.250,00"), null);
    assert.equal(parseNumber("12,34"), null);
    assert.equal(parseNumber("abc"), null);
});

test("cells coerce by field type, and a refusal quotes the cell", () => {
    const m = meta("INVENTRY");
    assert.deepEqual(coerce("$1,250.00", m.fields.get("COST")!), { ok: true, value: 1250 });
    assert.deepEqual(coerce("2026-10-12", m.fields.get("E_DATE")!), { ok: true, value: "2026-10-12" });
    assert.deepEqual(coerce("10/12/2026", m.fields.get("E_DATE")!), { ok: true, value: "2026-10-12" });
    assert.deepEqual(coerce("12.10.2026", m.fields.get("E_DATE")!).ok, false);
    assert.equal(coerce("2026-02-30", m.fields.get("E_DATE")!).ok, false, "a date that does not exist");
    assert.equal(coerce("4/31/2026", m.fields.get("E_DATE")!).ok, false);
    assert.deepEqual(coerce("2/29/2028", m.fields.get("E_DATE")!), { ok: true, value: "2028-02-29" }, "a leap day does");
    assert.deepEqual(coerce("Yes", m.fields.get("INACTIVE")!), { ok: true, value: true });
    assert.deepEqual(coerce("n", m.fields.get("INACTIVE")!), { ok: true, value: false });
    const bad = coerce("maybe", m.fields.get("INACTIVE")!);
    assert.ok(!bad.ok && bad.why.includes('"maybe"'));
    const cost = coerce("ten", m.fields.get("COST")!);
    assert.ok(!cost.ok && cost.why.includes('"ten"'));
});

test("enums match by name or number; a closed list refuses anything else", () => {
    const m = meta("INVENTRY");
    const spec = RULES["INVENTRY"]!.enums["C_TYPE"];
    assert.deepEqual(coerce("Track Count", m.fields.get("C_TYPE")!, spec), { ok: true, value: 2 });
    assert.deepEqual(coerce("2", m.fields.get("C_TYPE")!, spec), { ok: true, value: 2 });
    assert.deepEqual(coerce("track-count", m.fields.get("C_TYPE")!, spec), { ok: true, value: 2 });
    assert.equal(coerce("Widget", m.fields.get("C_TYPE")!, spec).ok, false);
    assert.equal(coerce("12", m.fields.get("C_TYPE")!, spec).ok, false);
    const unit = meta("INVENUNT");
    assert.deepEqual(coerce("larger", unit.fields.get("MULTIPLY")!, RULES["INVENUNT"]!.enums["MULTIPLY"]), { ok: true, value: "Larger" });
    const pay = meta("PYEMP");
    assert.deepEqual(coerce("Biweekly", pay.fields.get("PAY_TYPE")!, RULES["PYEMP"]!.enums["PAY_TYPE"]), { ok: true, value: "Biweekly", unlisted: true }, "an open list passes an unseen value, flagged");
});
