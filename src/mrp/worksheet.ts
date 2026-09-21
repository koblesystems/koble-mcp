/**
 * Turns a plan into the planner's worksheet rows. Does the two extra reads a purchase order
 * needs that a plan does not: the vendor's unit, part number and cost for each item to buy
 * (INVENDOR), and those items' units (INVENUNT) so stock quantities become order quantities.
 */
import { TYPE_ORDER, checkCode, type RunManifest, type SheetRow } from "./csv.js";
import type { Plan } from "./engine.js";
import { readByIds, type Snapshot } from "./snapshot.js";
import { baseUnitOf, fromBaseUnits, type UnitRow } from "./units.js";

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Local date and time to the second, so two runs a moment apart never share an ID. */
export function runId(company: string, now = new Date()): string {
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `mrp-${company.toLowerCase()}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export async function buildWorksheet(company: string, run: string, snapshot: Snapshot, plan: Plan, include: (item: string, type: string) => boolean = () => true): Promise<{ rows: SheetRow[]; warnings: string[]; manifest: RunManifest }> {
    const warnings: string[] = [];
    // The items that get a unit and, for purchases, a vendor: everything the plan orders within scope.
    const buyIds = [...new Set(plan.plannedOrders.filter((order) => include(order.item, order.action === "buy" ? "BUY" : "MAKE")).map((order) => order.item))];
    const vendorRows = await readByIds(company, "INVENDOR", "ID", buyIds, "ID,VENDOR_ID,UNIT_MEAS,COST,PART_NO");
    const unitRows = (await readByIds(company, "INVENUNT", "ID", buyIds, "ID,UNIT,MULTIPLIER,MULTIPLY")) as unknown as UnitRow[];
    const vendorFor = (item: string): { vendor: string; unit: string; cost: number | null; partNo: string } => {
        const product = snapshot.products.get(item);
        const mine = vendorRows.filter((row) => text(row["ID"]) === item);
        const chosen = mine.find((row) => text(row["VENDOR_ID"]).toUpperCase() === (product?.vendor ?? "").toUpperCase()) ?? (product?.vendor ? undefined : mine[0]);
        const cost = typeof chosen?.["COST"] === "number" && chosen["COST"] > 0 ? chosen["COST"] : null;
        // With no vendor record to say otherwise, order in the product's own stock unit — and say
        // so on the purchase order, so EBMS cannot default the line to a case.
        const unit = chosen ? text(chosen["UNIT_MEAS"]) : (baseUnitOf(item, unitRows) ?? "");
        return { vendor: product?.vendor || text(chosen?.["VENDOR_ID"]) || "(no primary vendor)", unit, cost, partNo: text(chosen?.["PART_NO"]) };
    };

    const base = { Run: run, Company: company };
    const later = new Map(plan.beyondHorizon.filter((row) => row.supplies.length > 0).map((row) => [row.item, row.supplies.map((supply) => `${supply.ref}: ${supply.qty} on ${supply.date}`).join("; ")]));
    const laterDemand = new Map(plan.beyondHorizon.filter((row) => row.demandQty > 0).map((row) => [row.item, `${row.demandQty} from ${row.firstDemandDate}`]));
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
            "EBMS Qty To Order": product?.ebmsQtyToOrder || "",
            "On Order After Time Frame": later.get(id) ?? "",
            "Demand After Time Frame": laterDemand.get(id) ?? "",
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
            const product = snapshot.products.get(order.item);
            // EBMS only accepts a Track Count product (classification 2) as a batch's finished good through its API.
            const makeable = product?.classification === 2;
            rows.push({
                ...base, Type: "MAKE", Item: order.item, ...figures(order.item),
                Status: stockOut ? "Stock-out" : "Below minimum",
                Recommendation: `Make ${order.qty} by ${order.receiptDate}`,
                "Needed By": order.receiptDate,
                "Recommended Qty (stock unit)": order.qty,
                "Purchase Unit": baseUnitOf(order.item, unitRows) ?? "",
                "Order Qty": order.qty,
                Approve: "",
                Because: because,
                Notes: [makeable ? "" : "Cannot be created as a batch through EBMS's API: the product is not classified Track Count. Create it in EBMS.", product?.vendor ? "Also purchased; could be bought instead." : ""].filter(Boolean).join(" "),
            });
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
            Notes: [
                converted.warning ? "Check the unit before ordering." : "",
                later.has(order.item) ? "Already on order after the time frame (see On Order After Time Frame) — consider moving that order up instead of buying more." : "",
            ].filter(Boolean).join(" "),
        });
    }
    for (const exception of plan.exceptions) {
        if (exception.type === "expedite") {
            touched.add(exception.item);
            const receipt = `${exception.ref} (${exception.qty})`;
            rows.push({
                ...base,
                Type: "EXPEDITE",
                Item: exception.item,
                ...figures(exception.item),
                Status: exception.dateAssumed ? "On order with no expected date in EBMS" : "Receipt arrives after it is needed",
                Recommendation: exception.dateAssumed ? `Confirm ${receipt} will arrive by ${exception.to}` : `Move ${receipt} from ${exception.from} to ${exception.to}`,
                "Needed By": exception.to ?? "",
                Document: exception.ref,
                Because: exception.message,
            });
        } else if (exception.type === "not-needed") {
            touched.add(exception.item);
            rows.push({
                ...base,
                Type: "NOT NEEDED",
                Item: exception.item,
                ...figures(exception.item),
                Status: "On order but nothing needs it",
                Recommendation: `Defer or cancel ${exception.ref} (${exception.qty})`,
                Document: exception.ref,
                Because: exception.message,
            });
        }
    }
    for (const item of plan.items) {
        if (touched.has(item.item)) continue;
        const hasActivity = item.timeline.length > 1 || (snapshot.products.get(item.item)?.min ?? 0) > 0;
        if (hasActivity) rows.push({ ...base, Type: "OK", Item: item.item, ...figures(item.item), Status: "Covered", Recommendation: "Nothing to do" });
    }
    // The planner's scope: the plan is always worked out for everything, because demand flows
    // between items, but the worksheet holds only the rows they asked to see.
    const scoped = rows.filter((row) => include(String(row.Item ?? ""), String(row.Type ?? "")));
    rows.length = 0;
    rows.push(...scoped);
    const rank = (row: SheetRow): number => TYPE_ORDER.indexOf(String(row.Type) as (typeof TYPE_ORDER)[number]);
    rows.sort((a, b) => rank(a) - rank(b) || String(a.Vendor ?? "").localeCompare(String(b.Vendor ?? "")) || String(a.Item).localeCompare(String(b.Item)) || String(a.Document ?? "").localeCompare(String(b.Document ?? "")));

    const manifest: RunManifest = { run, company, through: plan.through ?? "", createdAt: new Date().toISOString(), lines: {} };
    rows.forEach((row, index) => {
        const line = `L${String(index + 1).padStart(4, "0")}`;
        row.Line = line;
        row.Check = checkCode(run, line, String(row.Item ?? ""));
        manifest.lines[line] = {
            type: String(row.Type ?? ""),
            item: String(row.Item ?? ""),
            vendor: String(row.Vendor ?? ""),
            partNo: String(row["Vendor Part No"] ?? ""),
            purchaseUnit: String(row["Purchase Unit"] ?? ""),
            orderQty: typeof row["Order Qty"] === "number" ? row["Order Qty"] : null,
            unitCost: typeof row["Unit Cost"] === "number" ? row["Unit Cost"] : null,
            neededBy: String(row["Needed By"] ?? ""),
        };
    });
    return { rows, warnings, manifest };
}
