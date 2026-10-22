import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMapping } from "../src/import/mapping.js";
import { RULES } from "../src/import/rules.js";
import { readCsvText } from "../src/import/source.js";
import { groupIssues, validateRows } from "../src/import/validate.js";
import { meta } from "./import-fixtures.js";

function check(entity: string, csv: string, defaults: Record<string, unknown> = {}) {
    const source = readCsvText(csv);
    const rule = RULES[entity]!;
    const m = meta(entity);
    const mapping = resolveMapping(source.headers, rule, m, {}, defaults);
    assert.deepEqual(mapping.fatal, []);
    const result = validateRows(source.rows, rule, m, mapping, defaults);
    return { ...result, groups: groupIssues(result.issues, { company: "COF", maxLength: (f) => m.fields.get(f)?.maxLength ?? 0 }), source };
}
const kinds = (r: { issues: Array<{ row: number; kind: string }> }) => r.issues.map((i) => `${i.row}:${i.kind}`);

test("row numbers are the spreadsheet's: blank rows are counted and skipped, not renumbered", () => {
    const r = check("INVENTRY", "ID,Name,Folder,Classification\nA,a,1,2\n,,,\nB,b,1,2\n");
    assert.equal(r.blank, 1);
    assert.deepEqual(r.rows.map((x) => x.row), [2, 4]);
});

test("required fields: blank after defaults is a problem; defaults fill blanks only", () => {
    const r = check("INVENTRY", "ID,Name,Folder,Classification\nA,a,,\nB,b,7,1\n", { TREE_ID: "3", C_TYPE: 2 });
    assert.deepEqual(r.issues, []);
    assert.equal(r.rows[0]?.values["TREE_ID"], "3");
    assert.equal(r.rows[0]?.values["C_TYPE"], 2);
    assert.equal(r.rows[1]?.values["TREE_ID"], "7", "a value in the file is never replaced by a default");
    assert.equal(r.rows[1]?.values["C_TYPE"], 1);
    const missing = check("INVENTRY", "ID,Name\nA,a\n");
    assert.deepEqual(kinds(missing).sort(), ["2:required", "2:required"]);
    assert.deepEqual(missing.issues.map((i) => i.field).sort(), ["C_TYPE", "TREE_ID"], "a required date EBMS defaults to today is not asked for");
});

test("unparseable cells, long values, rewritten IDs and duplicates are each a kind", () => {
    const r = check("INVENTRY", [
        "ID,Name,Folder,Classification,Cost",
        "GOOD,ok,1,2,5",
        "BADCOST,x,1,2,ten",
        "THIS-ID-IS-WAY-TOO-LONG-FOR-EBMS,x,1,2,1",
        "1.23E+13,x,1,2,1",
        "GOOD,again,1,2,1",
        "BADTYPE,x,1,Widget,1",
    ].join("\n"));
    assert.deepEqual(kinds(r), ["3:type", "4:too-long", "5:scientific", "6:duplicate", "7:type"]);
    assert.deepEqual(r.rows.map((x) => x.row), [2]);
    const groups = Object.fromEntries(r.groups.map((g) => [`${g.kind}|${g.field}`, g]));
    assert.match(groups["too-long|ID"]!.message, /1 ID value is over 24 characters; EBMS would cut it silently/);
    assert.match(groups["type|COST"]!.message, /"ten"/);
    assert.match(groups["duplicate|ID"]!.message, /appears twice in the file; the second copy is ignored/);
    assert.deepEqual(groups["duplicate|ID"]!.rows, ["Row 6"]);
});

test("problems group by kind and field, largest first, with counts and rows", () => {
    const r = check("INVENTRY", "ID,Name,Folder,Classification,Cost\nA,a,1,2,x\nB,b,1,2,y\nC,c,1,2,z\nD,d,1,9x,1\n");
    assert.equal(r.groups[0]?.count, 3);
    assert.deepEqual(r.groups[0]?.rows, ["Row 2", "Row 3", "Row 4"]);
    assert.equal(r.groups[1]?.count, 1);
});

test("unit rows: a Larger unit with multiplier 0 is refused", () => {
    const r = check("INVENUNT", "Product,Unit,Multiply,Multiplier\nMUG,CASE,Larger,0\nMUG,BOX,Larger,12\nMUG,EA,Smaller,0\n");
    assert.deepEqual(kinds(r), ["2:larger-zero"]);
});

test("bill of materials: a product cannot be its own component, and quantities must be above 0", () => {
    const r = check("INVENDET", "ID,Component,Qty\nBENCH,BENCH,1\nBENCH,LEG,0\nBENCH,TOP,1\n");
    assert.deepEqual(kinds(r), ["2:self-component", "3:quantity"]);
});

test("customers need a name; workers need pay, frequency and hire date", () => {
    const c = check("ARCUST", "Folder,ZIP\n1,17101\n");
    assert.deepEqual(kinds(c), ["2:one-of"]);
    const w = check("PYEMP", "Folder,Last name\n1,Smith\n");
    assert.deepEqual(w.issues.map((i) => i.field).sort(), ["DEF_PAY", "HIRE_DATE", "PAY_TYPE"]);
    assert.ok(!w.issues.some((i) => i.field === "ID"), "PYEMP.ID is required in metadata but EBMS may assign it");
});

test("an unseen value of an open enum passes with a note", () => {
    const w = check("PYEMP", "Folder,Last name,DEF_PAY,PAY_TYPE,HIRE_DATE\n1,Smith,Hourly,Biweekly,2026-01-05\n");
    assert.deepEqual(w.issues, []);
    assert.equal(w.rows[0]?.values["PAY_TYPE"], "Biweekly");
    assert.match(w.notes.join(" "), /PAY_TYPE "Biweekly" is not a value seen in EBMS before/);
});

test("a cell the text could not be read cleanly at, a lost character, or a line break in a one-line field is a problem, never imported as read", () => {
    const r = check("INVENTRY", [
        "ID,Name,Folder,Classification,Cost",
        'GOOD,3/4" bolt,1,2,5',
        '"BROKEN","Two\nlines",1,2,5',
        "LOST,Caf�,1,2,5",
        'SPLIT, "Big, red",1,2,5',
    ].join("\n"));
    assert.deepEqual(kinds(r), ["3:line-break", "4:unreadable", "5:unreadable", "5:unreadable"]);
    assert.deepEqual(r.rows.map((x) => [x.row, x.values["DESCR_1"]]), [[2, '3/4" bolt']]);
    const groups = Object.fromEntries(r.groups.map((g) => [`${g.kind}|${g.field}`, g]));
    assert.match(groups["line-break|DESCR_1"]!.message, /more than one line/);
    assert.match(r.issues.find((i) => i.row === 4)!.text, /lost before the file reached here/);
});

test("a date that reads two ways is read as month/day, with a note; a percent typed with its sign is the percent", () => {
    const r = check("ARTAX", "ID,Rate,Eff date\nST,6%,03/04/2026\nCO,1.5,2026-03-04\nCI,2,13/04/2026\n");
    assert.deepEqual(r.rows.map((x) => [x.values["RATE"], x.values["EFF_DATE"]]), [[6, "2026-03-04"], [1.5, "2026-03-04"]]);
    assert.deepEqual(kinds(r), ["4:type"], "13/04 is no month/day date");
    assert.match(r.notes.join(" "), /EFF_DATE: dates like "03\/04\/2026" were read as month\/day \(2026-03-04\)/);
});
