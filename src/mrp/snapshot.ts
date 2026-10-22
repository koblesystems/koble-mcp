/**
 * Reads everything a plan needs from one EBMS company and turns it into the engine's input.
 * All quantities leave here in base units. Where each number lives was worked out against
 * SBX with the person who knows the database; the reasons are beside each read.
 */
import { odataString, request } from "../ebms/client.js";
import { EbmsError } from "../ebms/errors.js";
import type { Demand, ItemParams, Supply } from "./engine.js";
import type { BomItem } from "./tree.js";
import { toBaseUnits, unitsByItem, unitsOf, type UnitRow } from "./units.js";
import { num, round, text } from "./values.js";

type Row = Record<string, unknown>;
const day = (value: unknown): string | null => (typeof value === "string" && value.length >= 10 ? value.slice(0, 10) : null);

const PAGE_CAP = 2000;
const refused = (error: unknown): boolean => error instanceof EbmsError && error.status >= 400 && error.status < 500;
const keyOf = (row: Row | undefined): string | null => (typeof row?.["AUTOID"] === "string" ? row["AUTOID"] : null);

/**
 * Reads a whole collection and refuses to return a partial answer quietly. EBMS has no nextLink.
 *
 * Where the entity sorts by AUTOID (SBX's INVENTRY and ARINVDET do; not every entity or build
 * does), pages are read by key: each asks for the rows after the last AUTOID seen. A row that
 * leaves the filtered set while reading (a sales order posted mid-read) then cannot shift a live
 * row out of the next page, as it would with $skip. EBMS's count on such a page is what is left,
 * so the page that holds all of it is the last.
 *
 * Elsewhere it pages with $skip, keeps the highest count EBMS gave, and throws if the distinct
 * rows fall short of it. Without a count only an empty page ends a read, because a server may
 * cap $top below what was asked. Hitting the page cap throws too.
 */
export async function readAll(company: string, entity: string, params: Record<string, string>, pageSize = 200): Promise<Row[]> {
    const select = params["$select"];
    const withKey = select && !select.split(",").map((name) => name.trim()).includes("AUTOID") ? { ...params, $select: `AUTOID,${select}` } : params;
    const page = async (extra: Record<string, string>): Promise<{ rows: Row[]; count: number | null }> => {
        const response = await request(company, "GET", `${entity}?${new URLSearchParams({ ...withKey, $top: String(pageSize), $count: "true", ...extra }).toString()}`);
        const body = response.body as { value?: Row[]; "@odata.count"?: number } | null;
        return { rows: body?.value ?? [], count: typeof body?.["@odata.count"] === "number" ? body["@odata.count"] : null };
    };
    const tooLong = (read: number): Error => new Error(`Reading ${entity} did not finish after ${PAGE_CAP} pages (${read} rows). Refusing to plan on a partial read; narrow the scope.`);

    /** Null when the server will not page by key after all; the read then starts again with $skip. */
    const byKey = async (first: { rows: Row[]; count: number | null }): Promise<Row[] | null> => {
        const rows: Row[] = [];
        const seen = new Set<string>();
        for (let batch = first, pages = 1; ; pages += 1) {
            let added = 0;
            for (const row of batch.rows) {
                const key = keyOf(row);
                if (key === null) return null;
                if (seen.has(key)) continue;
                seen.add(key);
                rows.push(row);
                added += 1;
            }
            if (batch.rows.length === 0 || (batch.count !== null && batch.rows.length >= batch.count)) return rows;
            // A full page of rows already read: the server ignored the key filter.
            if (added === 0) return null;
            if (pages >= PAGE_CAP) throw tooLong(rows.length);
            const after = `AUTOID gt ${odataString(keyOf(batch.rows.at(-1)) ?? "")}`;
            try {
                batch = await page({ $orderby: "AUTOID", $filter: params["$filter"] ? `(${params["$filter"]}) and ${after}` : after });
            } catch (error) {
                if (!refused(error)) throw error;
                return null;
            }
        }
    };

    const bySkip = async (ordered: boolean): Promise<Row[]> => {
        const rows: Row[] = [];
        const seen = new Set<string>();
        let fetched = 0;
        let most: number | null = null;
        for (let pages = 0; ; pages += 1) {
            if (pages >= PAGE_CAP) throw tooLong(fetched);
            const batch = await page({ ...(ordered ? { $orderby: "AUTOID" } : {}), $skip: String(fetched) });
            // The highest count seen: a row that leaves the set mid-read lowers the next one, and
            // would otherwise hide the live row its page shift pushed past.
            if (batch.count !== null) most = Math.max(most ?? 0, batch.count);
            fetched += batch.rows.length;
            for (const row of batch.rows) {
                const key = keyOf(row);
                if (key !== null && seen.has(key)) continue;
                if (key !== null) seen.add(key);
                rows.push(row);
            }
            if (batch.rows.length === 0 || (most !== null && fetched >= most)) break;
        }
        if (most !== null && rows.length < most) {
            throw new Error(`Reading ${entity} returned ${rows.length} distinct rows but EBMS counted ${most}; the data changed while it was being read. Run the plan again.`);
        }
        return rows;
    };

    if (params["$orderby"] !== undefined) return bySkip(false);
    let first;
    try {
        first = await page({ $orderby: "AUTOID" });
    } catch (error) {
        if (!refused(error)) throw error;
        return bySkip(false);
    }
    return (await byKey(first)) ?? bySkip(true);
}

/** IDs per request: about 50, with the filter kept short enough that the URL stays under 2 KB. */
const IDS_PER_READ = 50;
const FILTER_LENGTH = 1500;
/** Requests in flight at once. EBMS works through them largely in turn, so a few is plenty. */
const PARALLEL_READS = 4;
const encodedLength = (value: string): number => new URLSearchParams({ f: value }).toString().length - 2;

/** Rows of an entity whose `field` is one of `ids`, many IDs to a request and a few requests at a time. */
export async function readByIds(company: string, entity: string, field: string, ids: readonly string[], select: string, also = ""): Promise<Row[]> {
    const chunks: string[][] = [];
    let chunk: string[] = [];
    let length = also ? encodedLength(`${also} and ()`) : 0;
    for (const id of new Set(ids.filter(Boolean))) {
        const clause = `${field} eq ${odataString(id)}`;
        const more = encodedLength(clause) + (chunk.length > 0 ? 4 : 0);
        if (chunk.length > 0 && (chunk.length >= IDS_PER_READ || length + more > FILTER_LENGTH)) {
            chunks.push(chunk);
            chunk = [];
            length = also ? encodedLength(`${also} and ()`) : 0;
        }
        chunk.push(clause);
        length += encodedLength(clause) + (chunk.length > 1 ? 4 : 0);
    }
    if (chunk.length > 0) chunks.push(chunk);

    const read = (clauses: string[]): Promise<Row[]> => readAll(company, entity, { $filter: also ? `${also} and (${clauses.join(" or ")})` : clauses.join(" or "), $select: select });
    const results: Row[][] = [];
    // The first alone, so a company that has not signed in yet signs in once.
    if (chunks[0]) results[0] = await read(chunks[0]);
    let next = 1;
    const worker = async (): Promise<void> => {
        while (next < chunks.length) {
            const index = next;
            next += 1;
            results[index] = await read(chunks[index] as string[]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_READS, chunks.length - 1) }, worker));
    return results.flat();
}

/**
 * Every item that has ever been the finished good of a batch, without reading every batch line
 * ever written: lines are read in item order, and each page starts after the last item seen, so
 * a long history costs at most a page per made item. A server that will not sort or filter
 * batch lines that way is read in full.
 */
async function madeItems(company: string): Promise<Set<string>> {
    const made = new Set<string>();
    const readFully = async (): Promise<Set<string>> => new Set((await readAll(company, "APINVDET", { $filter: BATCH_LINES, $select: "INVEN" })).map((row) => text(row["INVEN"])).filter(Boolean));
    let after: string | null = null;
    for (let pages = 0; ; pages += 1) {
        if (pages >= PAGE_CAP) throw new Error(`Reading which items are made did not finish after ${PAGE_CAP} pages.`);
        let response;
        try {
            response = await request(company, "GET", `APINVDET?${new URLSearchParams({ $filter: after === null ? BATCH_LINES : `${BATCH_LINES} and INVEN gt ${odataString(after)}`, $select: "INVEN", $orderby: "INVEN", $top: "200", $count: "true" }).toString()}`);
        } catch (error) {
            if (!refused(error)) throw error;
            return readFully();
        }
        const body = response.body as { value?: Row[]; "@odata.count"?: number } | null;
        const rows = body?.value ?? [];
        for (const row of rows) if (text(row["INVEN"])) made.add(text(row["INVEN"]));
        if (rows.length === 0 || (typeof body?.["@odata.count"] === "number" && rows.length >= body["@odata.count"])) return made;
        const last = rows.at(-1)?.["INVEN"];
        // Not moving forward means the filter was ignored.
        if (typeof last !== "string" || last === after) return readFully();
        after = last;
    }
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
    /** LEAD_DAYS on this product's record for its primary vendor (INVENDOR); 0 when not set there. */
    leadDays: number;
}

export interface Vendor { id: string; name: string; leadDays: number }

/** A product's record for one vendor (INVENDOR): what that vendor sells it in, for how much, as which part. */
export interface VendorRecord { item: string; vendor: string; unit: string; cost: number | null; partNo: string; leadDays: number }

export const vendorRecordOf = (row: Row): VendorRecord => ({
    item: text(row["ID"]),
    vendor: text(row["VENDOR_ID"]),
    unit: text(row["UNIT_MEAS"]),
    cost: num(row["COST"]) > 0 ? num(row["COST"]) : null,
    partNo: text(row["PART_NO"]),
    leadDays: num(row["LEAD_DAYS"]),
});

/** Vendor records by product ID. */
export function recordsByItem(records: readonly VendorRecord[]): Map<string, VendorRecord[]> {
    const byItem = new Map<string, VendorRecord[]>();
    for (const record of records) {
        const list = byItem.get(record.item);
        if (list) list.push(record);
        else byItem.set(record.item, [record]);
    }
    return byItem;
}

/** Where an item's lead time came from, most specific first. */
type LeadSource = "you" | "product" | "vendor" | "your default";
interface LeadTime { days: number; from: LeadSource }

/**
 * A purchased item's lead time: what the user gave for it, else the product's record for its
 * primary vendor, else that vendor's default (EBMS sets a PO line's ETA from the same two, in that
 * order, according to Koble's documentation), else the user's blanket figure. LEAD_DAYS 0 means "not set" in EBMS. A made item, or one
 * with no primary vendor, has no vendor lead time.
 */
export function leadTimeFor(id: string, product: ProductInfo | undefined, made: boolean, vendorLeadDays: ReadonlyMap<string, number>, options: Pick<SnapshotOptions, "leadTimes" | "leadTimeDays">): LeadTime | undefined {
    const yours = options.leadTimes?.[id] ?? Object.entries(options.leadTimes ?? {}).find(([key]) => key.trim().toUpperCase() === id.toUpperCase())?.[1];
    if (yours !== undefined) return { days: yours, from: "you" };
    if (!made && product) {
        if (product.leadDays > 0) return { days: product.leadDays, from: "product" };
        const vendor = vendorLeadDays.get(product.vendor.toUpperCase()) ?? 0;
        if (vendor > 0) return { days: vendor, from: "vendor" };
    }
    return options.leadTimeDays === undefined ? undefined : { days: options.leadTimeDays, from: "your default" };
}

/**
 * EBMS builds before LEAD_DAYS was published refuse a query that names it. A field EBMS does not
 * have is a 400 "Invalid query" with the detail "Could not find a property named 'X' on type …"
 * (seen on SBX for misspelt APVENDOR and INVENDOR fields).
 */
const lacksField = (error: unknown, field: string): boolean => error instanceof EbmsError && error.status === 400 && `${error.message} ${error.detail ?? ""}`.includes(`'${field}'`);

export interface Snapshot {
    company: string;
    takenAt: string;
    /** The planning day, local to the server. */
    today: string;
    products: Map<string, ProductInfo>;
    /** Every vendor, by upper-case ID. */
    vendors: Map<string, Vendor>;
    /** Every product's vendor records, by product ID. */
    vendorRecords: Map<string, VendorRecord[]>;
    /** Every product's units of measure; look one up with unitsOf. */
    units: Map<string, UnitRow[]>;
    /** Every planned item with a known lead time, and where it came from. */
    leadTimes: Map<string, LeadTime>;
    /** False on an EBMS that does not publish LEAD_DAYS through its API. */
    leadDaysPublished: boolean;
    made: Set<string>;
    bom: BomItem[];
    items: ItemParams[];
    demands: Demand[];
    supplies: Supply[];
    skipped: Record<string, number>;
    warnings: string[];
    timings: Record<string, number>;
}

/** Finished-good lines of a manufacturing batch: M, or B when the batch is serialized. */
export const BATCH_LINES = "(DOC_TYPE eq 'M' or DOC_TYPE eq 'B')";

/** PURC_METH: 0 Stocked, 1 Drop Ship, 2 Sync Quantities, 3 Replenishment, 4 Associated. Only stocked lines are pooled. */
const isStockedLine = (row: Row): boolean => {
    const label = text(row["PURC_M_VIS"]).toLowerCase();
    return label === "" || label.startsWith("stocked");
};

interface SnapshotOptions {
    today: string;
    /** The end of the time frame. A receipt with no expected date is counted here, the latest it can help. */
    through?: string | undefined;
    includeJobs?: boolean | undefined;
    alsoMade?: readonly string[] | undefined;
    buyInstead?: readonly string[] | undefined;
    leadTimeDays?: number | undefined;
    leadTimes?: Readonly<Record<string, number>> | undefined;
    /**
     * Default true. False reads only products, bills of materials and which items are made: the
     * item view dates nothing and orders nothing, so it needs no documents, vendors or units.
     */
    documents?: boolean | undefined;
    /**
     * Called once products and vendors are read. True stops the snapshot there, so a question
     * about the scope is asked before the long reads rather than after them.
     */
    stopAfterProducts?: ((found: Pick<Snapshot, "products" | "vendors">) => boolean) | undefined;
}

/** How many inactive items a warning names before it only counts them. */
const NAMED = 5;

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
    const documents = options.documents !== false;
    /** A table read with its LEAD_DAYS where this EBMS publishes it, and without where it does not. */
    let leadDaysPublished = false;
    const withLeadDays = async (name: string, entity: string, select: string): Promise<Row[]> => {
        try {
            const rows = await timed(name, () => readAll(company, entity, { $select: `${select},LEAD_DAYS` }));
            leadDaysPublished = true;
            return rows;
        } catch (error) {
            if (!lacksField(error, "LEAD_DAYS")) throw error;
            warnings.push(`This EBMS version does not publish ${entity}.LEAD_DAYS through its API, so those lead times are not used.`);
            return timed(name, () => readAll(company, entity, { $select: select }));
        }
    };

    // One table at a time: EBMS works through requests in turn (running these together was
    // measured and gained nothing), and live users share the same server.
    const productRows = await timed("products", () =>
        readAll(company, "INVENTRY", {
            $filter: "not startswith(ID,'($)') and INACTIVE eq false",
            $select: "ID,DESCR_1,C_TYPE,PURC_METH,PRI_VENDOR,T_ON_HAND,MIN_INVEN,MAX_INVEN,ORDER_AMT,QUAN2ORDER,PUR_O,PUR_S,M_IN_O,M_IN_S,SALES_O,SALES_S,M_OUT_O,M_OUT_S,JOB_OUT_O,JOB_OUT_S",
        }),
    );
    const vendors = new Map<string, Vendor>();
    for (const row of documents ? await withLeadDays("vendors", "APVENDOR", "ID,F_NAME,L_NAME") : []) {
        vendors.set(text(row["ID"]).toUpperCase(), { id: text(row["ID"]), name: `${text(row["F_NAME"])} ${text(row["L_NAME"])}`.trim(), leadDays: num(row["LEAD_DAYS"]) });
    }
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
            leadDays: 0,
        });
    }
    const empty = (): Snapshot => ({ company, takenAt: new Date().toISOString(), today: options.today, products, vendors, vendorRecords: new Map(), units: new Map(), leadTimes: new Map(), leadDaysPublished, made: new Set(), bom: [], items: [], demands: [], supplies: [], skipped, warnings, timings });
    if (options.stopAfterProducts?.({ products, vendors })) return empty();

    // Read whole, once: the plan's lead days, the worksheet's vendor terms and the supplies' units all come from these.
    const vendorRecords = recordsByItem((documents ? await withLeadDays("vendorRecords", "INVENDOR", "ID,VENDOR_ID,UNIT_MEAS,COST,PART_NO") : []).map(vendorRecordOf));
    const units = unitsByItem(documents ? ((await timed("units", () => readAll(company, "INVENUNT", { $select: "ID,UNIT,MULTIPLIER,MULTIPLY" }))) as unknown as UnitRow[]) : []);
    // The primary vendor's record: the one the worksheet orders from and EBMS dates a PO line by.
    for (const product of products.values()) product.leadDays = vendorRecords.get(product.id)?.find((record) => record.vendor.toUpperCase() === product.vendor.toUpperCase())?.leadDays ?? 0;

    const bomRows = await timed("bom", () => readAll(company, "INVENDET", { $select: "ID,COMP_ID,QUAN,CATEGORY" }));
    // An item is manufactured if it has ever been the finished good of a batch. IDs the planner
    // names are matched to products whatever their case.
    const byUpper = new Map([...products.keys()].map((id) => [id.toUpperCase(), id]));
    const productId = (given: string): string => byUpper.get(given.trim().toUpperCase()) ?? given.trim();
    const made = await timed("made", () => madeItems(company));
    for (const id of options.alsoMade ?? []) made.add(productId(id));
    for (const id of options.buyInstead ?? []) made.delete(productId(id));

    const types = options.includeJobs === false ? "DOC_TYPE eq 'S'" : "(DOC_TYPE eq 'S' or DOC_TYPE eq 'J')";
    const lineRows = documents
        ? await timed("sales", () => readAll(company, "ARINVDET", { $filter: `${types} and STATUS eq 'SalesOrder'`, $select: "INVOICE,INVEN,QUAN,SHIP,SHIP_DATE,DOC_TYPE,PURC_M_VIS,PAR_TIME,TIMESTAMP" }))
        : [];
    // Open batches: finished goods are supply, consumables are demand; both net of progress.
    const batches = documents
        ? await timed("batches", () =>
            readAll(company, "INMFG", {
                $filter: "STATUS eq 0",
                $select: "AUTOID,BATCH,DATE,END_DATE",
                $expand: "FinishedDetails($select=INVEN,O_QUAN_VIS,SHIP_VIS,UNIT_MEAS,ETA_DATE),ARINVDETs($select=INVEN,QUAN,SHIP)",
            }, 50))
        : [];
    // Open purchase orders, through the header: purchase lines only carry _VIS quantities, and
    // those read 0 on a standalone detail query.
    const orders = documents
        ? await timed("purchases", () =>
            readAll(company, "APINV", { $filter: "STATUS eq 'U'", $select: "AUTOID,INVOICE,ID,INV_DATE", $expand: "Details($select=INVEN,O_QUAN_VIS,SHIP_VIS,UNIT_MEAS,ETA_DATE,DOC_TYPE,PURC_M_VIS)" }, 20))
        : [];

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

    const convert = (item: string, qty: number, unit: unknown): number => {
        const result = toBaseUnits(item, qty, text(unit), unitsOf(units, item));
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

    // Bill of materials. QUAN is per ONE parent, already in the component's base unit.
    const componentsOf = new Map<string, Array<{ item: string; qtyPer: number }>>();
    for (const row of bomRows) {
        const parent = text(row["ID"]);
        const list = componentsOf.get(parent) ?? [];
        list.push({ item: text(row["COMP_ID"]), qtyPer: num(row["QUAN"]) });
        componentsOf.set(parent, list);
    }

    // Planning parameters. Service items are not materials; only stocked products are planned.
    const bom: BomItem[] = [];
    const involved = new Set<string>([...demands.map((d) => d.item), ...supplies.map((s) => s.item), ...componentsOf.keys(), ...[...componentsOf.values()].flat().map((c) => c.item)]);
    for (const product of products.values()) if (product.min > 0) involved.add(product.id);
    const vendorLeadDays = new Map([...vendors].map(([id, vendor]) => [id, vendor.leadDays]));
    const items: ItemParams[] = [];
    const leadTimes = new Map<string, LeadTime>();
    const inactive: string[] = [];
    for (const id of involved) {
        const product = products.get(id);
        const service = product?.classification === 0;
        bom.push({ id, make: made.has(id), components: componentsOf.get(id) ?? [], ...(service ? { nonStock: true } : {}) });
        if (!product) { inactive.push(id); continue; }
        if (service) continue;
        if (product.purchaseMethod !== 0) { skip(`product not planned: purchase method ${product.purchaseMethod}`); continue; }
        const leadTime = leadTimeFor(id, product, made.has(id), vendorLeadDays, options);
        if (leadTime) leadTimes.set(id, leadTime);
        items.push({
            id,
            onHand: product.onHand,
            ...(leadTime === undefined ? {} : { leadTimeDays: leadTime.days }),
            ...(product.min > 0 ? { safetyStock: product.min } : {}),
            ...(product.max > 0 ? { orderUpTo: product.max } : {}),
            ...(product.increment > 0 ? { orderMultiple: product.increment } : {}),
            make: made.has(id),
            components: (componentsOf.get(id) ?? []).filter((c) => products.get(c.item)?.classification !== 0),
        });
    }
    // An inactive item matters to the plan when something is due in or out of it; one that is only
    // on old bills of materials is counted, not listed, or a company's history buries the result.
    const moving = new Set([...demands.map((d) => d.item), ...supplies.map((s) => s.item)]);
    for (const id of inactive.filter((id) => moving.has(id))) warnings.push(`${id} has open demand or supply but is not an active product; it was not planned.`);
    const idle = inactive.filter((id) => !moving.has(id));
    if (idle.length > 0) warnings.push(`${idle.length} item(s) on bills of materials are not active products (${idle.slice(0, NAMED).join(", ")}${idle.length > NAMED ? ", …" : ""}); they were not planned.`);

    const planned = new Set(items.map((item) => item.id));
    const before = demands.length;
    const keptDemands = demands.filter((d) => planned.has(d.item));
    if (before !== keptDemands.length) skipped["demand on an item that is not planned (service, non-stocked or inactive)"] = before - keptDemands.length;

    const keptSupplies = supplies.filter((s) => planned.has(s.item));
    if (keptSupplies.length !== supplies.length) skipped["incoming supply for an item that is not planned (service, non-stocked or inactive)"] = supplies.length - keptSupplies.length;
    if (undatedDemand > 0) warnings.push(`${undatedDemand} open demand line(s) have no ship date in EBMS and were planned as due today.`);

    return { ...empty(), vendorRecords, units, leadTimes, made, bom, items, demands: keptDemands, supplies: keptSupplies };
}
