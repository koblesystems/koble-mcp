import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, renderTree, type BomItem } from "../src/mrp/tree.js";

const items: BomItem[] = [
    { id: "SOURDOUGH", make: true, components: [{ item: "WATER", qtyPer: 250 }, { item: "FLOUR", qtyPer: 300 }, { item: "STARTER", qtyPer: 150 }] },
    { id: "STARTER", make: true, components: [{ item: "FLOUR", qtyPer: 0.5 }, { item: "WATER", qtyPer: 0.5 }] },
    { id: "WATER", make: false, components: [] },
    { id: "FLOUR", make: false, components: [] },
];

test("a made component is exploded again, as far down as the bill of materials goes", () => {
    const { root } = buildTree({ item: "SOURDOUGH", qty: 10, items, available: {} });
    const starter = root.children.find((n) => n.item === "STARTER");
    assert.equal(starter?.required, 1500);
    assert.equal(starter?.action, "make");
    assert.deepEqual(starter?.children.map((n) => `${n.item}:${n.required}`), ["FLOUR:750", "WATER:750"]);
    assert.equal(starter?.children[0]?.level, 2);
});

test("stock of a sub-assembly covers its branch, so only the rest is exploded", () => {
    const { root } = buildTree({ item: "SOURDOUGH", qty: 10, items, available: { STARTER: 1000 } });
    const starter = root.children.find((n) => n.item === "STARTER");
    assert.equal(starter?.fromStock, 1000);
    assert.equal(starter?.short, 500);
    assert.deepEqual(starter?.children.map((n) => n.required), [250, 250]);
});

test("stock is one pool: a part used in two branches is not counted twice", () => {
    const { totals, canBuildFromStock } = buildTree({ item: "SOURDOUGH", qty: 10, items, available: { FLOUR: 3200, WATER: 99999 } });
    const flour = totals.find((t) => t.item === "FLOUR");
    assert.equal(flour?.required, 3750); // 3000 direct + 750 through the starter
    assert.equal(flour?.fromStock, 3200);
    assert.equal(flour?.short, 550);
    assert.equal(canBuildFromStock, false);
});

test("with everything on the shelf the answer is yes, and nothing is bought", () => {
    const { totals, canBuildFromStock } = buildTree({ item: "SOURDOUGH", qty: 1, items, available: { FLOUR: 1000, WATER: 1000 } });
    assert.equal(canBuildFromStock, true);
    assert.deepEqual(totals.filter((t) => t.action === "buy").map((t) => t.short), [0, 0]);
});

test("labour is shown but left out, a loop is reported rather than followed, and it renders as an indented list", () => {
    const withLabour: BomItem[] = [
        { id: "BAG12", make: true, components: [{ item: "ROAST", qtyPer: 0.75 }, { item: "LABOUR", qtyPer: 1 }, { item: "BAG12", qtyPer: 5 }] },
        { id: "ROAST", make: false, components: [] },
        { id: "LABOUR", make: false, components: [], nonStock: true },
    ];
    const { root, totals } = buildTree({ item: "BAG12", qty: 4, items: withLabour, available: { ROAST: 1 } });
    assert.equal(totals.some((t) => t.item === "LABOUR"), false);
    assert.match(root.children.find((n) => n.item === "BAG12")?.note ?? "", /loop/);
    assert.deepEqual(renderTree(root).slice(0, 2), ["BAG12  need 4, make 4", "  ROAST  need 3 (0.75 each), 1 from stock, buy 2"]);
});
