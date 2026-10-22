/**
 * Turns a plan into the planner's worksheet rows. A purchase order needs what a plan does not:
 * the vendor's unit, part number and cost for each item to buy (its vendor record), and the
 * item's units so stock quantities become order quantities. The snapshot has read both.
 */
import { TYPE_ORDER, checkCode, type RunManifest, type SheetRow } from "./csv.js";
import type { Peg, Plan, PlannedOrder } from "./engine.js";
import { orderBeforeFrameEnds } from "./report.js";
import type { Snapshot, VendorRecord } from "./snapshot.js";
import { baseUnitOf, fromBaseUnits, unitsOf, type UnitRow } from "./units.js";
import { round } from "./values.js";

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Local date and time to the second, so two runs a moment apart never share an ID. */
export function runId(company: string, now = new Date()): string {
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `mrp-${company.toLowerCase()}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * What a vendor sells an item in, for how much and as which part: its record for that vendor,
 * or with none, the item's stock unit and no cost. The unit is null when the item has no units set up.
 */
export function purchaseTerms(item: string, vendor: string, records: ReadonlyMap<string, readonly VendorRecord[]>, units: readonly UnitRow[]): { record: VendorRecord | undefined; unit: string | null; cost: number | null; partNo: string } {
    const record = records.get(item)?.find((candidate) => candidate.vendor.toUpperCase() === vendor.toUpperCase());
    return { record, unit: record ? record.unit : baseUnitOf(item, units), cost: record?.cost ?? null, partNo: record?.partNo ?? "" };
}

/** "1209" → "SO 1209"; a batch's or job's number with its kind; a minimum in words. */
function pegLabel(peg: Peg): string {
    if (peg.kind === "sales") return `SO ${peg.ref}`;
    if (peg.kind === "job") return `Job ${peg.ref}`;
    if (peg.kind === "batch") return `Batch ${peg.ref}`;
    if (peg.kind === "forecast") return `Forecast ${peg.ref}`.trim();
    if (peg.kind === "dependent") return `To make ${/^make (.+?) x[\d.]+ for /.exec(peg.ref)?.[1] ?? peg.ref}`;
    if (peg.kind === "negative") return "On hand is negative";
    return `Back to minimum ${peg.ref}`;
}

/** Why a row is there, short enough to read in a cell: the first few reasons, quantities added up. */
function whyText(pegs: readonly Peg[], max = 3): string {
    const totals = new Map<string, number>();
    for (const peg of pegs) totals.set(pegLabel(peg), round((totals.get(pegLabel(peg)) ?? 0) + peg.qty));
    const parts = [...totals].map(([label, qty]) => `${label} (${qty})`);
    return parts.length > max ? `${parts.slice(0, max).join(" · ")} · and ${parts.length - max} more` : parts.join(" · ");
}

export function buildWorksheet(company: string, run: string, snapshot: Snapshot, plan: Plan, include: (item: string, type: string) => boolean = () => true): { rows: SheetRow[]; warnings: string[]; manifest: RunManifest } {
    const warnings: string[] = [];
    const vendorFor = (item: string): { vendor: string; unit: string; cost: number | null; partNo: string } => {
        // The primary vendor; with none, the first vendor the product has a record for.
        const vendor = snapshot.products.get(item)?.vendor || snapshot.vendorRecords.get(item)?.[0]?.vendor || "";
        // With no vendor record to say otherwise, order in the product's own stock unit — and say
        // so on the purchase order, so EBMS cannot default the line to a case.
        const terms = purchaseTerms(item, vendor, snapshot.vendorRecords, unitsOf(snapshot.units, item));
        return { vendor: vendor || "(no primary vendor)", unit: terms.unit ?? "", cost: terms.cost, partNo: terms.partNo };
    };

    const base = { Run: run, Company: company };
    const later = new Map(plan.beyondHorizon.filter((row) => row.supplies.length > 0).map((row) => [row.item, row.supplies.map((supply) => `${supply.ref}: ${supply.qty} on ${supply.date}`).join("; ")]));
    const laterDemand = new Map(plan.beyondHorizon.filter((row) => row.demandQty > 0).map((row) => [row.item, `${row.demandQty} from ${row.firstDemandDate}`]));
    const itemPlan = new Map(plan.items.map((item) => [item.item, item]));
    const LEAD_FROM = { you: "you", product: "product vendor record", vendor: "vendor", "your default": "your default" } as const;
    // When to place the order, once a lead time is known; with none, only when the stock is needed.
    const timing = (order: PlannedOrder, verb: string): SheetRow => {
        const lead = snapshot.leadTimes.get(order.item);
        if (!lead) return { Recommendation: `${verb} ${order.qty} by ${order.receiptDate}` };
        const recommendation = order.pastDue
            ? `${verb} ${order.qty} now: needed ${order.receiptDate}, but ${lead.days} days' lead time should have meant ${order.releaseDate}`
            : `${verb} ${order.qty} by ${order.releaseDate} to have them ${order.receiptDate}`;
        return { Recommendation: recommendation, "Order By": order.releaseDate, "Lead Days": lead.days, "Lead From": LEAD_FROM[lead.from] };
    };
    const windowNotes = new Map(orderBeforeFrameEnds(plan, snapshot).map((row) => {
        const verb = row.make ? "started" : "ordered";
        const late = row.orderBy < snapshot.today ? `; that date has passed, so ${row.make ? "start" : "order"} now` : "";
        return [row.item, `${row.qty} more needed from ${row.neededFrom}, after the time frame. With ${row.leadDays} days' lead time it must be ${verb} by ${row.orderBy}${late}. Extend the time frame to plan it.`];
    }));
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
                ...timing(order, "Start"),
                "Needed By": order.receiptDate,
                "Recommended Qty (stock unit)": order.qty,
                "Purchase Unit": baseUnitOf(order.item, unitsOf(snapshot.units, order.item)) ?? "",
                "Order Qty": order.qty,
                Approve: "",
                Why: whyText(order.pegs),
                Because: because,
                Notes: [makeable ? "" : "Cannot be created as a batch through EBMS's API: the product is not classified Track Count. Create it in EBMS.", product?.vendor ? "Also purchased; could be bought instead." : "", windowNotes.get(order.item) ?? ""].filter(Boolean).join(" "),
            });
            continue;
        }
        const vendor = vendorFor(order.item);
        const converted = fromBaseUnits(order.item, order.qty, vendor.unit, unitsOf(snapshot.units, order.item));
        if (converted.warning && !warnings.includes(converted.warning)) warnings.push(converted.warning);
        rows.push({
            ...base, Type: "BUY", Item: order.item, ...figures(order.item),
            Status: stockOut ? "Stock-out" : "Below minimum",
            ...timing(order, "Order"),
            "Needed By": order.receiptDate,
            "Recommended Qty (stock unit)": order.qty,
            Vendor: vendor.vendor, "Vendor Part No": vendor.partNo, "Purchase Unit": vendor.unit,
            "Order Qty": converted.qty,
            "Unit Cost": vendor.cost ?? "",
            "Est Cost": vendor.cost === null ? "" : round2(vendor.cost * converted.qty),
            Approve: "",
            Why: whyText(order.pegs),
            Because: because,
            Notes: [
                converted.warning ? "Check the unit before ordering." : "",
                !snapshot.products.get(order.item)?.vendor && !snapshot.leadTimes.has(order.item) ? "No primary vendor, so no vendor lead time was used." : "",
                later.has(order.item) ? "Already on order after the time frame (see On Order After Time Frame) — consider moving that order up instead of buying more." : "",
                windowNotes.get(order.item) ?? "",
            ].filter(Boolean).join(" "),
        });
    }
    // "178" alone does not say what it is: a batch or a purchase order. The two can share a number.
    const documentLabel = ({ ref, kind }: { ref: string; kind?: string | undefined }): string => (kind === "batch" ? `Batch ${ref}` : /^PO/i.test(ref) ? ref : `PO ${ref}`);
    for (const exception of plan.exceptions) {
        if (exception.type === "expedite") {
            touched.add(exception.item);
            const receipt = `${documentLabel(exception)} (${exception.qty})`;
            rows.push({
                ...base,
                Type: "EXPEDITE",
                Item: exception.item,
                ...figures(exception.item),
                Status: exception.dateAssumed ? "On order with no expected date in EBMS" : "Receipt arrives after it is needed",
                Recommendation: exception.dateAssumed ? `Confirm ${receipt} will arrive by ${exception.to}` : `Move ${receipt} from ${exception.from} to ${exception.to}`,
                "Needed By": exception.to ?? "",
                Document: documentLabel(exception),
                Because: exception.message,
                Notes: windowNotes.get(exception.item) ?? "",
            });
        } else if (exception.type === "not-needed") {
            touched.add(exception.item);
            rows.push({
                ...base,
                Type: "NOT NEEDED",
                Item: exception.item,
                ...figures(exception.item),
                Status: "On order but nothing needs it",
                Recommendation: `Defer or cancel ${documentLabel(exception)} (${exception.qty})`,
                Document: documentLabel(exception),
                Because: exception.message,
                Notes: windowNotes.get(exception.item) ?? "",
            });
        }
    }
    for (const item of plan.items) {
        if (touched.has(item.item)) continue;
        const hasActivity = item.timeline.length > 1 || (snapshot.products.get(item.item)?.min ?? 0) > 0;
        const window = windowNotes.get(item.item);
        if (hasActivity || window) rows.push({ ...base, Type: "OK", Item: item.item, ...figures(item.item), Status: "Covered", Recommendation: window ? "Plan now for demand after the time frame" : "Nothing to do", ...(window ? { Notes: window } : {}) });
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
