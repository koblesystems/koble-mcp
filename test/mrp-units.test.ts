import { test } from "node:test";
import assert from "node:assert/strict";
import { toBaseUnits, type UnitRow } from "../src/mrp/units.js";

const rows: UnitRow[] = [
    { ID: "TUBE700C", UNIT: "EA", MULTIPLIER: 0, MULTIPLY: "Smaller" },
    { ID: "TUBE700C", UNIT: "Case", MULTIPLIER: 50, MULTIPLY: "Larger" },
    { ID: "HOUSE-BLEND", UNIT: "5llb Batch", MULTIPLIER: 0, MULTIPLY: "Smaller" },
    { ID: "HOUSE-BLEND", UNIT: "oz", MULTIPLIER: 16, MULTIPLY: "Smaller" },
    { ID: "TEAMJERSEY", UNIT: "", MULTIPLIER: 0, MULTIPLY: "Smaller" },
    { ID: "TEAMJERSEY", UNIT: "EA", MULTIPLIER: 0, MULTIPLY: "Larger" },
];

test("larger units multiply, smaller units divide, the base unit and a blank unit pass through", () => {
    assert.deepEqual(toBaseUnits("TUBE700C", 2, "Case", rows), { qty: 100 });
    assert.deepEqual(toBaseUnits("HOUSE-BLEND", 60, "oz", rows), { qty: 3.75 }); // the batch 162 number
    assert.deepEqual(toBaseUnits("TUBE700C", 35, "EA", rows), { qty: 35 });
    assert.deepEqual(toBaseUnits("TUBE700C", 35, "", rows), { qty: 35 });
    assert.deepEqual(toBaseUnits("tube700c", 1, "case ", rows), { qty: 50 });
});

test("a unit the product does not have, or one set up as larger x0, is used unconverted and reported", () => {
    assert.match(toBaseUnits("TUBE700C", 3, "Pallet", rows).warning ?? "", /not one of its units/);
    const broken = toBaseUnits("TEAMJERSEY", 1, "EA", rows);
    assert.equal(broken.qty, 1);
    assert.match(broken.warning ?? "", /multiplier of 0/);
    assert.deepEqual(toBaseUnits("NOUNITS", 4, "EA", rows), { qty: 4 });
});
