/**
 * Drafting manufacturing batches from approved MAKE rows. Pure: everything EBMS knows arrives as
 * arguments, so the rules are unit-tested.
 *
 * What was learned by creating batches in a test company (EBMS 1.8.148):
 *   - the finished good must be a Track Count product; anything else is refused;
 *   - EBMS does NOT add the consumed materials itself when a batch arrives through the API (its
 *     own screens do), so every component is sent, from the product's bill of materials;
 *   - a consumed line's M_QUAN_VIS is the amount for ONE finished good; EBMS works out the batch
 *     total (3 finished goods x 2 per unit came back as QUAN 6);
 *   - nothing is marked as made or consumed, and PROCESS is never sent: completing and processing
 *     a batch is done by a person in EBMS.
 * Every line states its unit — the product's own stock unit — so EBMS cannot default it to
 * something the quantity was not written in.
 */
import { externalIdFor, type ApprovedLine } from "./csv.js";
import { baseUnitOf, type UnitRow } from "./units.js";

export interface BatchComponent {
    item: string;
    /** Per ONE finished good, in the component's stock unit (INVENDET.QUAN). */
    qtyPer: number;
    /** INVENDET.CATEGORY: "(Single Component)" or the name of an option group on a configure-to-order item. */
    category: string;
}

export interface BatchInputs {
    run: string;
    /** Classification per product ID (INVENTRY.C_TYPE); 2 is Track Count. */
    classification: Readonly<Record<string, number>>;
    components: Readonly<Record<string, readonly BatchComponent[]>>;
    units: readonly UnitRow[];
    /** Where each product was last made, used when the planner names no warehouse. */
    lastWarehouse: Readonly<Record<string, string>>;
    warehouse?: string | undefined;
}

export interface BatchDraft {
    line: string;
    item: string;
    qty: number;
    unit: string;
    warehouse: string;
    neededBy: string;
    externalId: string;
    components: Array<{ item: string; perUnit: number; total: number; unit: string }>;
    changes: string[];
    notes: string[];
    /** Exactly what to pass to ebms_write as the body of POST INMFG. */
    body: Record<string, unknown>;
}

const round = (value: number): number => Math.round(value * 10_000) / 10_000;

export function draftBatches(lines: readonly ApprovedLine[], inputs: BatchInputs): { drafts: BatchDraft[]; problems: string[] } {
    const drafts: BatchDraft[] = [];
    const problems: string[] = [];
    for (const line of lines) {
        const kind = inputs.classification[line.item];
        if (kind === undefined) { problems.push(`Line ${line.row}: product "${line.item}" is not an active product in EBMS.`); continue; }
        if (kind !== 2) { problems.push(`Line ${line.row}: ${line.item} cannot be made through EBMS's API because it is not classified Track Count (its classification is ${kind}). Create this batch in EBMS.`); continue; }
        const all = inputs.components[line.item] ?? [];
        const parts = all.filter((part) => part.item !== line.item && part.category.trim().toLowerCase() === "(single component)" && part.qtyPer > 0);
        const notes: string[] = [];
        const options = all.filter((part) => part.category.trim().toLowerCase() !== "(single component)");
        if (options.length > 0) notes.push(`${options.length} component(s) belong to option groups (${[...new Set(options.map((part) => part.category.trim()))].join(", ")}) and were left off: which option applies is chosen per order.`);
        const zero = all.filter((part) => part.category.trim().toLowerCase() === "(single component)" && part.item !== line.item && part.qtyPer <= 0);
        if (zero.length > 0) notes.push(`${zero.map((part) => part.item).join(", ")} ${zero.length === 1 ? "has" : "have"} a quantity of 0 on the bill of materials and ${zero.length === 1 ? "was" : "were"} left off.`);
        if (all.some((part) => part.item === line.item)) notes.push(`${line.item} lists itself as a component; that line was left off.`);
        if (parts.length === 0) { problems.push(`Line ${line.row}: ${line.item} has no components on its bill of materials, so a batch would consume nothing. Set up its components in EBMS, or create the batch there.`); continue; }
        const warehouse = (inputs.warehouse ?? inputs.lastWarehouse[line.item] ?? "").trim();
        if (!warehouse) { problems.push(`Line ${line.row}: no warehouse is known for ${line.item} (it has not been made before). Ask which warehouse the batch is for.`); continue; }
        if (!inputs.warehouse) notes.push(`Warehouse ${warehouse} is where ${line.item} was last made.`);

        const unit = baseUnitOf(line.item, inputs.units) ?? "";
        const components = parts.map((part) => ({ item: part.item, perUnit: part.qtyPer, total: round(part.qtyPer * line.qty), unit: baseUnitOf(part.item, inputs.units) ?? "" }));
        const externalId = externalIdFor(inputs.run, `make-${line.line}`);
        drafts.push({
            line: line.line, item: line.item, qty: line.qty, unit, warehouse, neededBy: line.neededBy, externalId, components, changes: line.changes, notes,
            body: {
                EXTERNALID: externalId,
                WAREHOUSE: warehouse,
                MEMO: `MRP ${inputs.run}${line.neededBy ? `, needed by ${line.neededBy}` : ""}`,
                FinishedDetails: [
                    {
                        INVEN: line.item,
                        O_QUAN_VIS: line.qty,
                        SHIP_VIS: 0,
                        UNIT_MEAS: unit,
                        ConsumedDetails: components.map((part) => ({ INVEN: part.item, M_QUAN_VIS: part.perUnit, M_SHIP_VIS: 0, UNIT_MEAS: part.unit })),
                    },
                ],
            },
        });
    }
    return { drafts, problems };
}
