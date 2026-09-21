/**
 * The total view of one finished good: everything it takes to build a quantity of it, all
 * the way down, against what is actually available.
 *
 * Pure, like the engine. Two things make it more than an indented parts list:
 *   - it is NET: stock of a sub-assembly covers that branch, so only the uncovered part is
 *     exploded further (10 starters on the shelf means 10 fewer starters' worth of flour);
 *   - stock is a shared pool: a part used in two branches is only counted once, so the
 *     second branch sees what the first one left.
 * "Available" is what the caller says it is — on hand, or on hand plus incoming minus
 * already-promised — which is a planning choice, not arithmetic.
 */

export interface BomItem {
    id: string;
    /** True when the item is made rather than bought; only made items are exploded. */
    make: boolean;
    components: Array<{ item: string; qtyPer: number }>;
    /** Left out of material planning: labour, colour and other non-stock lines. */
    nonStock?: boolean;
}

export interface TreeNode {
    item: string;
    level: number;
    /** Quantity of this item per ONE of its parent. */
    qtyPer: number;
    /** Needed for this branch, before looking at stock. */
    required: number;
    /** Taken from the shared pool for this branch. */
    fromStock: number;
    /** Still missing after stock: made (and exploded below) or bought. */
    short: number;
    action: "make" | "buy" | "none";
    note?: string;
    children: TreeNode[];
}

export interface TreeSummary {
    item: string;
    action: "make" | "buy";
    required: number;
    fromStock: number;
    short: number;
}

const round = (value: number): number => Math.round(value * 10_000) / 10_000;

export function buildTree(input: { item: string; qty: number; items: readonly BomItem[]; available: Readonly<Record<string, number>> }): { root: TreeNode; totals: TreeSummary[]; canBuildFromStock: boolean } {
    const byId = new Map(input.items.map((item) => [item.id, item]));
    const pool = new Map(Object.entries(input.available).map(([id, qty]) => [id, Math.max(0, qty)]));
    const totals = new Map<string, TreeSummary>();

    const visit = (id: string, qtyPer: number, required: number, level: number, path: readonly string[]): TreeNode => {
        const item = byId.get(id);
        const node: TreeNode = { item: id, level, qtyPer, required: round(required), fromStock: 0, short: 0, action: "none", children: [] };
        if (item?.nonStock) return { ...node, note: "not a stocked material; left out of the plan" };
        if (path.includes(id)) return { ...node, short: node.required, note: `loop: ${[...path, id].join(" → ")}; not followed further` };

        // The finished good itself is what is being built, so its own stock is not consumed at level 0.
        const have = level === 0 ? 0 : (pool.get(id) ?? 0);
        node.fromStock = round(Math.min(have, required));
        if (level > 0) pool.set(id, round(have - node.fromStock));
        node.short = round(required - node.fromStock);
        const make = item?.make === true && item.components.length > 0;
        node.action = node.short > 0 ? (make ? "make" : "buy") : "none";
        if (!item) node.note = "no product record found";

        if (level > 0 || node.short > 0) {
            const total = totals.get(id) ?? { item: id, action: make ? "make" : "buy", required: 0, fromStock: 0, short: 0 };
            total.required = round(total.required + node.required);
            total.fromStock = round(total.fromStock + node.fromStock);
            total.short = round(total.short + node.short);
            totals.set(id, total);
        }
        if (make && node.short > 0) {
            node.children = item.components.map((component) => visit(component.item, component.qtyPer, node.short * component.qtyPer, level + 1, [...path, id]));
        }
        return node;
    };

    const root = visit(input.item, 1, input.qty, 0, []);
    const list = [...totals.values()].filter((row) => row.item !== input.item);
    return { root, totals: list, canBuildFromStock: list.every((row) => row.action === "make" || row.short === 0) && list.filter((row) => row.action === "buy").every((row) => row.short === 0) };
}

/** An indented text rendering, for a tool result or a report. */
export function renderTree(node: TreeNode): string[] {
    const line = `${"  ".repeat(node.level)}${node.item}  need ${node.required}${node.level > 0 ? ` (${node.qtyPer} each)` : ""}` + (node.fromStock > 0 ? `, ${node.fromStock} from stock` : "") + (node.short > 0 ? `, ${node.action} ${node.short}` : node.level > 0 && !node.note ? ", covered" : "") + (node.note ? `  [${node.note}]` : "");
    return [line, ...node.children.flatMap(renderTree)];
}
