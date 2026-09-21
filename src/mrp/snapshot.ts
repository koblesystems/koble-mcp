/**
 * Reads everything a plan needs from one EBMS company and turns it into the engine's input.
 * All quantities leave here in base units. Where each number lives was worked out against
 * SBX with the person who knows the database; the reasons are beside each read.
 */
import { odataString, request } from "../ebms/client.js";
import { EbmsError } from "../ebms/errors.js";
import type { Demand, ItemParams, Supply } from "./engine.js";
import type { BomItem } from "./tree.js";
import { toBaseUnits, type UnitRow } from "./units.js";

type Row = Record<string, unknown>;
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const num = (value: unknown): number => (typeof value === "number" ? value : 0);
const day = (value: unknown): string | null => (typeof value === "string" && value.length >= 10 ? value.slice(0, 10) : null);
const round = (value: number): number => Math.round(value * 10_000) / 10_000;

const PAGE_CAP = 2000;

/**
 * Pages a collection with $skip/$top and refuses to return a partial answer quietly.
 * EBMS has no nextLink, so pages are read in AUTOID order where the entity allows it (it does on
 * SBX's INVENTRY and ARINVDET; not every entity or build accepts it, so a refusal falls back to
 * the server's own order). Rows are still de-duplicated by AUTOID in case pages shift while
 * reading; if the server gives no count, paging continues until a short page; and
 * a read that is still short of the server's count, or that hits the page cap, throws rather
 * than handing the planner half a company.
 */
export async function readAll(company: string, entity: string, params: Record<string, string>, pageSize = 200): Promise<Row[]> {
    const select = params["$select"];
    const withKey = select && !select.split(",").map((name) => name.trim()).includes("AUTOID") ? { ...params, $select: `AUTOID,${select}` } : params;
    let ordered = params["$orderby"] === undefined;
    const seen = new Set<string>();
    const rows: Row[] = [];
    let fetched = 0;
    let total: number | null = null;
    for (let page = 0; ; page += 1) {
        if (page >= PAGE_CAP) throw new Error(`Reading ${entity} did not finish after ${PAGE_CAP} pages (${fetched} rows). Refusing to plan on a partial read; narrow the scope.`);
        const ask = (withOrder: boolean) => request(company, "GET", `${entity}?${new URLSearchParams({ ...withKey, ...(withOrder ? { $orderby: "AUTOID" } : {}), $top: String(pageSize), $skip: String(fetched), $count: "true" }).toString()}`);
        let response;
        try {
            response = await ask(ordered);
        } catch (error) {
            // Only the first page may fall back: changing the order part-way would scramble the pages.
            const refusedOrder = ordered && page === 0 && error instanceof EbmsError && error.status >= 400 && error.status < 500;
            if (!refusedOrder) throw error;
            ordered = false;
            response = await ask(false);
        }
        const body = response.body as { value?: Row[]; "@odata.count"?: number } | null;
        const batch = body?.value ?? [];
        if (typeof body?.["@odata.count"] === "number") total = body["@odata.count"];
        fetched += batch.length;
        for (const row of batch) {
            const key = typeof row["AUTOID"] === "string" ? row["AUTOID"] : null;
            if (key !== null && seen.has(key)) continue;
            if (key !== null) seen.add(key);
            rows.push(row);
        }
        if (batch.length === 0) break;
        if (total !== null ? fetched >= total : batch.length < pageSize) break;
    }
    if (total !== null && rows.length < total) {
        throw new Error(`Reading ${entity} returned ${rows.length} distinct rows but EBMS counted ${total}; the data changed while it was being read. Run the plan again.`);
    }
    return rows;
}

/** Rows of an entity whose `field` is one of `ids`, asked for fifteen at a time to keep the filter short. */
export async function readByIds(company: string, entity: string, field: string, ids: readonly string[], select: string, also = ""): Promise<Row[]> {
    const unique = [...new Set(ids.filter(Boolean))];
    const rows: Row[] = [];
    for (let i = 0; i < unique.length; i += 15) {
        const anyOf = unique.slice(i, i + 15).map((id) => `${field} eq ${odataString(id)}`).join(" or ");
        rows.push(...(await readAll(company, entity, { $filter: also ? `${also} and (${anyOf})` : anyOf, $select: select })));
    }
    return rows;
}

export interface ProductInfo {
    id: string;
    description: string;
    classification: number;
    purchaseMethod: number;
    vendor: string;
    onHand: number;
    /** On hand + incoming − on order, the way EBMS nets it (and the planner's "available"). */
    available: number;
    min: number;
    max: number;
    increment: number;
    /** INVENTRY.QUAN2ORDER: what the EBMS purchasing screen last saved. A reference, not a formula. */
    ebmsQtyToOrder: number;
}

export interface Snapshot {
    company: string;
    takenAt: string;
    products: Map<string, ProductInfo>;
    made: Set<string>;
    bom: BomItem[];
    items: ItemParams[];
    demands: Demand[];
    supplies: Supply[];
    skipped: Record<string, number>;
    warnings: string[];
    timings: Record<string, number>;
}

/** PURC_METH: 0 Stocked, 1 Drop Ship, 2 Sync Quantities, 3 Replenishment, 4 Associated. Only stocked lines are pooled. */
const isStockedLine = (row: Row): boolean => {
    const label = text(row["PURC_M_VIS"]).toLowerCase();
    return label === "" || label.startsWith("stocked");
};

export interface SnapshotOptions {
    today: string;
    /** The end of the time frame. A receipt with no expected date is counted here, the latest it can help. */
    through?: string | undefined;
    includeJobs?: boolean | undefined;
    alsoMade?: readonly string[] | undefined;
    buyInstead?: readonly string[] | undefined;
    leadTimeDays?: number | undefined;
    leadTimes?: Readonly<Record<string, number>> | undefined;
}

export async function takeSnapshot(company: string, options: SnapshotOptions): Promise<Snapshot> {
    const warnings: string[] = [];
    const skipped: Record<string, number> = {};
    const timings: Record<string, number> = {};
    const skip = (why: string): void => void (skipped[why] = (skipped[why] ?? 0) + 1);
    const timed = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
        const started = Date.now();
        try {
            return await work();
        } finally {
            timings[name] = Date.now() - started;
        }
    };

    // One at a time: EBMS works through requests in turn (running these together was measured
    // and gained nothing), and live users share the same server.
    const types = options.includeJobs === false ? "DOC_TYPE eq 'S'" : "(DOC_TYPE eq 'S' or DOC_TYPE eq 'J')";
    const productRows = await timed("products", () =>
        readAll(company, "INVENTRY", {
            $filter: "not startswith(ID,'($)') and INACTIVE eq false",
            $select: "ID,DESCR_1,C_TYPE,PURC_METH,PRI_VENDOR,T_ON_HAND,MIN_INVEN,MAX_INVEN,ORDER_AMT,QUAN2ORDER,PUR_O,PUR_S,M_IN_O,M_IN_S,SALES_O,SALES_S,M_OUT_O,M_OUT_S,JOB_OUT_O,JOB_OUT_S",
        }),
    );
    const bomRows = await timed("bom", () => readAll(company, "INVENDET", { $select: "ID,COMP_ID,QUAN,CATEGORY" }));
    const madeRows = await timed("made", () => readAll(company, "APINVDET", { $filter: "DOC_TYPE eq 'M'", $select: "INVEN" }));
    const lineRows = await timed("sales", () =>
        readAll(company, "ARINVDET", { $filter: `${types} and STATUS eq 'SalesOrder'`, $select: "INVOICE,INVEN,QUAN,SHIP,SHIP_DATE,DOC_TYPE,PURC_M_VIS,PAR_TIME,TIMESTAMP" }),
    );
    const batches = await timed("batches", () =>
        readAll(company, "INMFG", {
            $filter: "STATUS eq 0",
            $select: "AUTOID,BATCH,DATE,END_DATE",
            $expand: "FinishedDetails($select=INVEN,O_QUAN_VIS,SHIP_VIS,UNIT_MEAS,ETA_DATE),ARINVDETs($select=INVEN,QUAN,SHIP)",
        }, 50),
    );
    const orders = await timed("purchases", () =>
        readAll(company, "APINV", { $filter: "STATUS eq 'U'", $select: "AUTOID,INVOICE,ID,INV_DATE", $expand: "Details($select=INVEN,O_QUAN_VIS,SHIP_VIS,UNIT_MEAS,ETA_DATE,DOC_TYPE,PURC_M_VIS)" }, 20),
    );

    // Products: planning parameters and EBMS's own running totals, one paged read.
    const products = new Map<string, ProductInfo>();
    for (const row of productRows) {
        const incoming = num(row["PUR_O"]) - num(row["PUR_S"]) + num(row["M_IN_O"]) - num(row["M_IN_S"]);
        const onOrder = num(row["SALES_O"]) - num(row["SALES_S"]) + num(row["M_OUT_O"]) - num(row["M_OUT_S"]) + num(row["JOB_OUT_O"]) - num(row["JOB_OUT_S"]);
        products.set(text(row["ID"]), {
            id: text(row["ID"]),
            description: text(row["DESCR_1"]),
            classification: num(row["C_TYPE"]),
            purchaseMethod: num(row["PURC_METH"]),
            vendor: text(row["PRI_VENDOR"]),
            onHand: num(row["T_ON_HAND"]),
            available: round(num(row["T_ON_HAND"]) + incoming - onOrder),
            min: num(row["MIN_INVEN"]),
            max: num(row["MAX_INVEN"]),
            increment: num(row["ORDER_AMT"]),
            ebmsQtyToOrder: num(row["QUAN2ORDER"]),
        });
    }

    // Bill of materials. QUAN is per ONE parent, already in the component's base unit.

    // An item is manufactured if it has ever been the finished good of a batch.
    const made = new Set(madeRows.map((row) => text(row["INVEN"])).filter(Boolean));
    for (const id of options.alsoMade ?? []) made.add(id.trim());
    for (const id of options.buyInstead ?? []) made.delete(id.trim());

    // Sales and job demand: QUAN and SHIP are base-unit fields and read correctly standalone;
    // this read also returns materials-list children, which the header's Details does not.
    // A line's TIMESTAMP is only unique within its own document, so the parent rule is too.
    const parents = new Set(lineRows.filter((row) => text(row["PAR_TIME"])).map((row) => `${text(row["INVOICE"])}|${text(row["PAR_TIME"])}`));
    let undatedDemand = 0;
    const demands: Demand[] = [];
    for (const row of lineRows) {
        const item = text(row["INVEN"]);
        const remaining = round(num(row["QUAN"]) - num(row["SHIP"]));
        if (!item) { skip("line without a product"); continue; }
        if (parents.has(`${text(row["INVOICE"])}|${text(row["TIMESTAMP"])}`)) { skip("materials-list parent (its children are counted)"); continue; }
        if (remaining <= 0) { skip("sales line fully shipped"); continue; }
        if (!isStockedLine(row)) { skip(`sales line purchased as "${text(row["PURC_M_VIS"])}"`); continue; }
        if (day(row["SHIP_DATE"]) === null) undatedDemand += 1;
        demands.push({ item, qty: remaining, date: day(row["SHIP_DATE"]) ?? options.today, kind: text(row["DOC_TYPE"]) === "J" ? "job" : "sales", ref: text(row["INVOICE"]) });
    }

    // Open batches: finished goods are supply, consumables are demand; both net of progress.

    // Open purchase orders, through the header: purchase lines only carry _VIS quantities, and
    // those read 0 on a standalone detail query.

    // Units, only for items whose supply is written in a named unit.
    const needUnits = new Set<string>();
    for (const batch of batches) for (const line of (batch["FinishedDetails"] as Row[] | undefined) ?? []) if (text(line["UNIT_MEAS"])) needUnits.add(text(line["INVEN"]));
    for (const order of orders) for (const line of (order["Details"] as Row[] | undefined) ?? []) if (text(line["UNIT_MEAS"])) needUnits.add(text(line["INVEN"]));
    const unitRows = (await timed("units", () => readByIds(company, "INVENUNT", "ID", [...needUnits], "ID,UNIT,MULTIPLIER,MULTIPLY"))) as unknown as UnitRow[];
    const convert = (item: string, qty: number, unit: unknown): number => {
        const result = toBaseUnits(item, qty, text(unit), unitRows);
        if (result.warning && !warnings.includes(result.warning)) warnings.push(result.warning);
        return result.qty;
    };

    // A receipt with no expected date is counted on the LAST day of the time frame: late enough
    // that it cannot quietly cover a shortage it may not arrive for (the plan then asks for it by
    // the date it is needed), early enough that it still counts toward the minimum at the end.
    const noDate = options.through ?? options.today;
    const supplies: Supply[] = [];
    for (const batch of batches) {
        const ref = text(batch["BATCH"]);
        const batchDate = day(batch["DATE"]) ?? options.today;
        const batchEnd = day(batch["END_DATE"]);
        for (const line of (batch["FinishedDetails"] as Row[] | undefined) ?? []) {
            const item = text(line["INVEN"]);
            const remaining = convert(item, num(line["O_QUAN_VIS"]) - num(line["SHIP_VIS"]), line["UNIT_MEAS"]);
            if (!item || remaining <= 0) { skip("batch output already made"); continue; }
            const eta = day(line["ETA_DATE"]);
            const known = eta ?? (batchEnd !== null && batchEnd >= options.today ? batchEnd : null);
            supplies.push({ item, qty: remaining, date: known ?? noDate, kind: "batch", ref, ...(known ? {} : { dateAssumed: true }) });
        }
        for (const line of (batch["ARINVDETs"] as Row[] | undefined) ?? []) {
            const item = text(line["INVEN"]);
            const remaining = round(num(line["QUAN"]) - num(line["SHIP"]));
            if (!item || remaining <= 0) { skip("batch consumable already used"); continue; }
            demands.push({ item, qty: remaining, date: batchDate, kind: "batch", ref });
        }
    }
    for (const order of orders) {
        const ref = text(order["INVOICE"]);
        for (const line of (order["Details"] as Row[] | undefined) ?? []) {
            const item = text(line["INVEN"]);
            if (!item) { skip("purchase line without a product"); continue; }
            if (text(line["DOC_TYPE"]) !== "E") { skip("non-purchase line on a purchase document"); continue; }
            if (!isStockedLine(line)) { skip(`purchase line bought as "${text(line["PURC_M_VIS"])}"`); continue; }
            const remaining = convert(item, num(line["O_QUAN_VIS"]) - num(line["SHIP_VIS"]), line["UNIT_MEAS"]);
            if (remaining <= 0) { skip("purchase line fully received"); continue; }
            const eta = day(line["ETA_DATE"]);
            supplies.push({ item, qty: remaining, date: eta ?? noDate, kind: "purchase", ref, ...(eta ? {} : { dateAssumed: true }) });
        }
    }

    // Planning parameters. Service items are not materials; only stocked products are planned.
    const bom: BomItem[] = [];
    const componentsOf = new Map<string, Array<{ item: string; qtyPer: number }>>();
    for (const row of bomRows) {
        const parent = text(row["ID"]);
        const list = componentsOf.get(parent) ?? [];
        list.push({ item: text(row["COMP_ID"]), qtyPer: num(row["QUAN"]) });
        componentsOf.set(parent, list);
    }
    const involved = new Set<string>([...demands.map((d) => d.item), ...supplies.map((s) => s.item), ...componentsOf.keys(), ...[...componentsOf.values()].flat().map((c) => c.item)]);
    for (const product of products.values()) if (product.min > 0) involved.add(product.id);
    const items: ItemParams[] = [];
    for (const id of involved) {
        const product = products.get(id);
        const service = product?.classification === 0;
        bom.push({ id, make: made.has(id), components: componentsOf.get(id) ?? [], ...(service ? { nonStock: true } : {}) });
        if (!product) { warnings.push(`${id} appears on a document or bill of materials but is not an active product; it was not planned.`); continue; }
        if (service) continue;
        if (product.purchaseMethod !== 0) { skip(`product not planned: purchase method ${product.purchaseMethod}`); continue; }
        const leadTime = options.leadTimes?.[id] ?? options.leadTimeDays;
        items.push({
            id,
            onHand: product.onHand,
            ...(leadTime === undefined ? {} : { leadTimeDays: leadTime }),
            ...(product.min > 0 ? { safetyStock: product.min } : {}),
            ...(product.max > 0 ? { orderUpTo: product.max } : {}),
            ...(product.increment > 0 ? { orderMultiple: product.increment } : {}),
            make: made.has(id),
            components: (componentsOf.get(id) ?? []).filter((c) => products.get(c.item)?.classification !== 0),
        });
    }
    const planned = new Set(items.map((item) => item.id));
    const before = demands.length;
    const keptDemands = demands.filter((d) => planned.has(d.item));
    if (before !== keptDemands.length) skipped["demand on an item that is not planned (service, non-stocked or inactive)"] = before - keptDemands.length;

    const keptSupplies = supplies.filter((s) => planned.has(s.item));
    if (keptSupplies.length !== supplies.length) skipped["incoming supply for an item that is not planned (service, non-stocked or inactive)"] = supplies.length - keptSupplies.length;
    if (undatedDemand > 0) warnings.push(`${undatedDemand} open demand line(s) have no ship date in EBMS and were planned as due today.`);

    return { company, takenAt: new Date().toISOString(), products, made, bom, items, demands: keptDemands, supplies: keptSupplies, skipped, warnings, timings };
}
