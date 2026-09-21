/**
 * Turns a plan into the planner's worksheet rows. Does the two extra reads a purchase order
 * needs that a plan does not: the vendor's unit, part number and cost for each item to buy
 * (INVENDOR), and those items' units (INVENUNT) so stock quantities become order quantities.
 */
import { odataString } from "../ebms/client.js";
import { TYPE_ORDER, type SheetRow } from "./csv.js";
import type { Plan } from "./engine.js";
import { readAll, type Snapshot } from "./snapshot.js";
import { fromBaseUnits, type UnitRow } from "./units.js";

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const round2 = (value: number): number => Math.round(value * 100) / 100;

export function runId(company: string, now = new Date()): string {
    const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 12);
    return `mrp-${company.toLowerCase()}-${stamp.slice(0, 8)}-${stamp.slice(8, 12)}`;
}

export async function buildWorksheet(company: string, run: string, snapshot: Snapshot, plan: Plan): Promise<{ rows: SheetRow[]; warnings: string[] }> {
    const warnings: string[] = [];
    const buyIds = [...new Set(plan.plannedOrders.filter((order) => order.action === "buy").map((order) => order.item))];
    const vendorRows: Array<Record<string, unknown>> = [];
    const unitRows: UnitRow[] = [];
    for (let i = 0; i < buyIds.length; i += 15) {
        const filter = buyIds.slice(i, i + 15).map((id) => `ID eq ${odataString(id)}`).join(" or ");
        vendorRows.push(...(await readAll(company, "INVENDOR", { $filter: filter, $select: "ID,VENDOR_ID,UNIT_MEAS,COST,PART_NO" })));
        unitRows.push(...((await readAll(company, "INVENUNT", { $filter: filter, $select: "ID,UNIT,MULTIPLIER,MULTIPLY" })) as unknown as UnitRow[]));
    }
    const vendorFor = (item: string): { vendor: string; unit: string; cost: number | null; partNo: string } => {
        const product = snapshot.products.get(item);
        const mine = vendorRows.filter((row) => text(row["ID"]) === item);
        const chosen = mine.find((row) => text(row["VENDOR_ID"]).toUpperCase() === (product?.vendor ?? "").toUpperCase()) ?? (product?.vendor ? undefined : mine[0]);
        const cost = typeof chosen?.["COST"] === "number" && chosen["COST"] > 0 ? chosen["COST"] : null;
        return { vendor: product?.vendor || text(chosen?.["VENDOR_ID"]) || "(no primary vendor)", unit: text(chosen?.["UNIT_MEAS"]), cost, partNo: text(chosen?.["PART_NO"]) };
    };

    const base = { Run: run, Company: company };
    const itemPlan = new Map(plan.items.map((item) => [item.item, item]));
    const figures = (id: string): SheetRow => {
        const product = snapshot.products.get(id);
        const timeline = itemPlan.get(id)?.timeline.slice(1) ?? [];
        const demand = timeline.filter((row) => row.change < 0).reduce((sum, row) => sum - row.change, 0);
        const supply = timeline.filter((row) => row.change > 0 && !row.what.startsWith("planned")).reduce((sum, row) => sum + row.change, 0);
        return {
            Description: product?.description ?? "",
            "On Hand": product?.onHand ?? "",
            Available: product?.available ?? "",
            Minimum: product?.min || "",
            Maximum: product?.max || "",
            "Reorder Increment": product?.increment || "",
            "Demand In Time Frame": round2(demand),
            "Supply In Time Frame": round2(supply),
            "Projected Balance": itemPlan.get(id)?.endingBalance ?? "",
        };
    };

    const rows: SheetRow[] = [];
    const touched = new Set<string>();
    for (const order of plan.plannedOrders) {
        touched.add(order.item);
        const stockOut = order.pegs.some((peg) => peg.kind !== "minimum");
        const because = order.pegs.map((peg) => `${peg.kind} ${peg.ref}: ${peg.qty}`).join("; ");
        if (order.action === "make") {
            rows.push({ ...base, Type: "MAKE", Item: order.item, ...figures(order.item), Status: stockOut ? "Stock-out" : "Below minimum", Recommendation: `Make ${order.qty} by ${order.receiptDate}`, "Needed By": order.receiptDate, "Recommended Qty (stock unit)": order.qty, Because: because, Notes: snapshot.products.get(order.item)?.vendor ? "Also purchased; could be bought instead" : "" });
            continue;
        }
        const vendor = vendorFor(order.item);
        const converted = fromBaseUnits(order.item, order.qty, vendor.unit, unitRows);
        if (converted.warning && !warnings.includes(converted.warning)) warnings.push(converted.warning);
        rows.push({
            ...base, Type: "BUY", Item: order.item, ...figures(order.item),
            Status: stockOut ? "Stock-out" : "Below minimum",
            Recommendation: `Buy ${order.qty} by ${order.receiptDate}`,
            "Needed By": order.receiptDate,
            "Recommended Qty (stock unit)": order.qty,
            Vendor: vendor.vendor, "Vendor Part No": vendor.partNo, "Purchase Unit": vendor.unit,
            "Order Qty": converted.qty,
            "Unit Cost": vendor.cost ?? "",
            "Est Cost": vendor.cost === null ? "" : round2(vendor.cost * converted.qty),
            Approve: "",
            Because: because,
            Notes: converted.warning ? "Check the unit before ordering" : "",
        });
    }
    for (const exception of plan.exceptions) {
        if (exception.type === "expedite") {
            touched.add(exception.item);
            rows.push({ ...base, Type: "EXPEDITE", Item: exception.item, ...figures(exception.item), Status: "Receipt arrives after it is needed", Recommendation: `Move ${exception.ref} (${exception.qty}) from ${exception.from} to ${exception.to}`, "Needed By": exception.to ?? "", Document: exception.ref, Because: exception.message });
        } else if (exception.type === "not-needed") {
            touched.add(exception.item);
            rows.push({ ...base, Type: "NOT NEEDED", Item: exception.item, ...figures(exception.item), Status: "On order but nothing needs it", Recommendation: `Defer or cancel ${exception.ref} (${exception.qty})`, Document: exception.ref, Because: exception.message });
        }
    }
    for (const item of plan.items) {
        if (touched.has(item.item)) continue;
        const hasActivity = item.timeline.length > 1 || (snapshot.products.get(item.item)?.min ?? 0) > 0;
        if (hasActivity) rows.push({ ...base, Type: "OK", Item: item.item, ...figures(item.item), Status: "Covered", Recommendation: "Nothing to do" });
    }
    const rank = (row: SheetRow): number => TYPE_ORDER.indexOf(String(row.Type) as (typeof TYPE_ORDER)[number]);
    rows.sort((a, b) => rank(a) - rank(b) || String(a.Vendor ?? "").localeCompare(String(b.Vendor ?? "")) || String(a.Item).localeCompare(String(b.Item)));
    return { rows, warnings };
}
