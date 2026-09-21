/**
 * Unit-of-measure conversion to a product's base unit, from its INVENUNT rows.
 *
 * EBMS stores each unit relative to the base: MULTIPLY "Larger" means one of this unit is
 * MULTIPLIER base units (Case x50); "Smaller" means MULTIPLIER of this unit make one base
 * unit (oz /16). The base unit itself is the "Smaller" row with MULTIPLIER 0. A "Larger" row
 * with MULTIPLIER 0 is a setup mistake — EBMS then stores such a line as quantity 0 — so it
 * is reported rather than trusted.
 */
export interface UnitRow {
    ID: string;
    UNIT: string;
    MULTIPLIER: number;
    MULTIPLY: string;
}

export interface Conversion {
    qty: number;
    /** Set when the number could not be converted with confidence. */
    warning?: string;
}

const norm = (value: string | null | undefined): string => (value ?? "").trim().toLowerCase();
const round = (value: number): number => Math.round(value * 10_000) / 10_000;

export function toBaseUnits(item: string, qty: number, unit: string | null | undefined, rows: readonly UnitRow[]): Conversion {
    const wanted = norm(unit);
    const mine = rows.filter((row) => norm(row.ID) === norm(item));
    if (wanted === "" || mine.length === 0) return { qty: round(qty) };
    const row = mine.find((candidate) => norm(candidate.UNIT) === wanted);
    if (!row) return { qty: round(qty), warning: `${item}: unit "${unit}" is not one of its units; quantity ${qty} was used unconverted.` };
    const larger = norm(row.MULTIPLY) === "larger";
    if (row.MULTIPLIER === 0) {
        if (larger) return { qty: round(qty), warning: `${item}: unit "${unit}" is set up as larger than the base unit with a multiplier of 0, which EBMS stores as quantity 0; quantity ${qty} was used unconverted. Fix the unit on the product.` };
        return { qty: round(qty) };
    }
    return { qty: round(larger ? qty * row.MULTIPLIER : qty / row.MULTIPLIER) };
}
