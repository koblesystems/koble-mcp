import { test } from "node:test";
import assert from "node:assert/strict";
import { draftBatches, type BatchInputs } from "../src/mrp/batches.js";
import type { ApprovedLine } from "../src/mrp/csv.js";

const line = (over: Partial<ApprovedLine>): ApprovedLine => ({ row: 2, line: "L0007", item: "JCOMPOUND", vendor: "", qty: 3, unit: "5 GAL", unitCost: null, neededBy: "2026-10-05", partNo: "", changes: [], ...over });
const inputs: BatchInputs = {
    run: "mrp-sbx-20260921-140533",
    classification: { JCOMPOUND: 2, "12 OZ HSBLEND": 1, BIKEKIT: 2, EMPTY: 2, NEWITEM: 2 },
    components: {
        JCOMPOUND: [{ item: "INPUTA", qtyPer: 1, category: "(Single Component)" }, { item: "INPUTB", qtyPer: 2, category: "(Single Component)" }],
        "12 OZ HSBLEND": [{ item: "12OZBAG", qtyPer: 1, category: "(Single Component)" }],
        BIKEKIT: [{ item: "WHITE", qtyPer: 1, category: "Color" }, { item: "BIKE", qtyPer: 1, category: "(Single Component)" }, { item: "BIKEKIT", qtyPer: 1, category: "(Single Component)" }, { item: "DECAL", qtyPer: 0, category: "(Single Component)" }],
        NEWITEM: [{ item: "INPUTA", qtyPer: 4, category: "(Single Component)" }],
    },
    units: [{ ID: "JCOMPOUND", UNIT: "5 GAL", MULTIPLIER: 0, MULTIPLY: "Smaller" }, { ID: "JCOMPOUND", UNIT: "1 Gal", MULTIPLIER: 5, MULTIPLY: "Smaller" }, { ID: "INPUTB", UNIT: "lb", MULTIPLIER: 0, MULTIPLY: "Smaller" }],
    lastWarehouse: { JCOMPOUND: "MAINSHOP", BIKEKIT: "WESTSIDE" },
};

test("a batch draft lists every component, per one finished good, each line in its own stock unit, with nothing made or consumed", () => {
    const { drafts, problems } = draftBatches([line({})], inputs);
    assert.deepEqual(problems, []);
    assert.deepEqual(drafts[0]?.body, {
        EXTERNALID: "mrp-sbx-20260921-140533-make-L0007",
        WAREHOUSE: "MAINSHOP",
        MEMO: "MRP mrp-sbx-20260921-140533, needed by 2026-10-05",
        FinishedDetails: [{
            INVEN: "JCOMPOUND", O_QUAN_VIS: 3, SHIP_VIS: 0, UNIT_MEAS: "5 GAL",
            ConsumedDetails: [{ INVEN: "INPUTA", M_QUAN_VIS: 1, M_SHIP_VIS: 0, UNIT_MEAS: "" }, { INVEN: "INPUTB", M_QUAN_VIS: 2, M_SHIP_VIS: 0, UNIT_MEAS: "lb" }],
        }],
    });
    assert.deepEqual(drafts[0]?.components.map((c) => `${c.item} ${c.total}`), ["INPUTA 3", "INPUTB 6"], "the totals shown to the planner are what EBMS will work out");
    assert.equal(JSON.stringify(drafts[0]?.body).includes("PROCESS"), false);
    assert.match(drafts[0]?.notes.join(" ") ?? "", /MAINSHOP is where JCOMPOUND was last made/);
});

test("a product EBMS will not accept as a finished good is named, not sent", () => {
    const { drafts, problems } = draftBatches([line({ item: "12 OZ HSBLEND" }), line({ item: "GHOST", row: 3 }), line({ item: "EMPTY", row: 4 }), line({ item: "NEWITEM", row: 5 })], inputs);
    assert.deepEqual(drafts, []);
    assert.match(problems[0] ?? "", /12 OZ HSBLEND cannot be made through EBMS's API because it is not classified Track Count/);
    assert.match(problems[1] ?? "", /"GHOST" is not an active product/);
    assert.match(problems[2] ?? "", /EMPTY has no components/);
    assert.match(problems[3] ?? "", /no warehouse is known for NEWITEM/);
    assert.equal(draftBatches([line({ item: "NEWITEM" })], { ...inputs, warehouse: "MAIN" }).drafts[0]?.warehouse, "MAIN");
});

test("option groups, a self-reference and zero-quantity components are left off and said so", () => {
    const { drafts } = draftBatches([line({ item: "BIKEKIT", qty: 2 })], inputs);
    assert.deepEqual((drafts[0]?.body["FinishedDetails"] as Array<{ ConsumedDetails: Array<{ INVEN: string }> }>)[0]?.ConsumedDetails.map((c) => c.INVEN), ["BIKE"]);
    const notes = drafts[0]?.notes.join(" ") ?? "";
    assert.match(notes, /option groups \(Color\)/);
    assert.match(notes, /DECAL has a quantity of 0/);
    assert.match(notes, /lists itself as a component/);
});
