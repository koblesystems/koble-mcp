/**
 * po_from_csv and batches_from_csv: turn an approved worksheet into drafts, read-only.
 *
 * Neither creates anything. Each returns the exact body to send with ebms_write, so a person
 * sees every purchase order or batch and says yes before it exists. The run and the vendor (or
 * worksheet line) make up the EXTERNALID, which is what stops one worksheet acting twice.
 */
import { z } from "zod/v4";
import { assertWriteCompany, resolveCompany } from "../config.js";
import { odataString } from "../ebms/client.js";
import { draftBatches, type BatchComponent } from "../mrp/batches.js";
import { draftPurchaseOrders, readSheet, type ApprovedLine, type SheetReading } from "../mrp/csv.js";
import { loadWorksheet } from "../mrp/files.js";
import { readAll, readByIds } from "../mrp/snapshot.js";
import { baseUnitOf, fromBaseUnits, toBaseUnits, type UnitRow } from "../mrp/units.js";
import type { McpToolResult, ToolRegistrar } from "./types.js";
import { errorResult, jsonResult } from "./types.js";

type Row = Record<string, unknown>;
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const source = {
    company: z.string().min(1).describe("Required. Company, by ID or name. Must match the worksheet's company."),
    path: z.string().optional().describe("Path of the worksheet CSV on this computer. Give this or csv."),
    csv: z.string().optional().describe("The worksheet's CSV text, exactly as the user attached or pasted it."),
};

/** Problems that mean the file cannot be used at all, as opposed to one row of it. */
const FATAL = ["does not look like", "but this call names", "mixes", "semicolons"];

/** The steps both tools start with. Returns a finished result when there is nothing to draft from. */
async function openWorksheet(args: { company: string; path?: string | undefined; csv?: string | undefined }, want: "BUY" | "MAKE"): Promise<{ company: string; reading: SheetReading; problems: string[] } | McpToolResult> {
    const company = resolveCompany(args.company);
    if (!args.path && !args.csv) return jsonResult({ needsInput: "Give the worksheet's path, or its CSV text." });
    const { text: csv, manifest } = await loadWorksheet(args);
    const reading = readSheet(csv, manifest, want);
    const problems = [...reading.problems];
    try {
        assertWriteCompany(company);
    } catch (error) {
        // Drafting is only reading, so this is reported rather than refused.
        problems.push(`These drafts cannot be created from this server as it is set up: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (reading.company && reading.company !== company) problems.push(`The worksheet is for company ${reading.company}, but this call names ${company}. Nothing was drafted.`);
    if (problems.some((problem) => FATAL.some((sign) => problem.includes(sign)))) return jsonResult({ company, problems, drafts: [] });
    return { company, reading, problems };
}

/** Records already created from this run, by the EXTERNALID each draft would carry. */
async function alreadyCreated(company: string, entity: string, select: string, externalIds: readonly string[]): Promise<Map<string, Row>> {
    const found = new Map<string, Row>();
    for (const id of externalIds) {
        const [row] = await readAll(company, entity, { $filter: `EXTERNALID eq ${odataString(id)}`, $select: select });
        if (row) found.set(id, row);
    }
    return found;
}

/**
 * A line whose unit is not known yet: the planner chose another vendor, or there is no run
 * record. It takes that vendor's unit and cost if the product has them, else the stock unit.
 * A quantity written in the ORIGINAL vendor's unit goes through stock units into the new one,
 * so 2 cases of 24 become 48 each and never 2 each. Lines that cannot be converted are dropped.
 */
async function settleUnits(company: string, lines: ApprovedLine[], problems: string[]): Promise<ApprovedLine[]> {
    const open = lines.filter((line) => line.unit === null);
    if (open.length === 0) return lines;
    const ids = open.map((line) => line.item);
    const vendorRows = await readByIds(company, "INVENDOR", "ID", ids, "ID,VENDOR_ID,UNIT_MEAS,COST,PART_NO");
    const units = (await readByIds(company, "INVENUNT", "ID", ids, "ID,UNIT,MULTIPLIER,MULTIPLY")) as unknown as UnitRow[];
    const dropped = new Set<ApprovedLine>();
    for (const line of open) {
        const theirs = vendorRows.find((row) => text(row["ID"]) === line.item && text(row["VENDOR_ID"]).toUpperCase() === line.vendor);
        const unit = theirs ? text(theirs["UNIT_MEAS"]) : baseUnitOf(line.item, units);
        if (line.originalUnit !== undefined) {
            const stock = toBaseUnits(line.item, line.qty, line.originalUnit, units);
            const converted = fromBaseUnits(line.item, stock.qty, unit ?? "", units);
            if (stock.warning || converted.warning || unit === null) {
                const why = [stock.warning, converted.warning].filter(Boolean).join(" ") || "the product has no units set up.";
                problems.push(`Line ${line.row}: ${line.item} was moved to vendor ${line.vendor}, but its quantity (${line.qty} ${line.originalUnit || "stock units"}) cannot be converted with confidence: ${why} It was not ordered; order it in EBMS.`);
                dropped.add(line);
                continue;
            }
            if (converted.qty !== line.qty || unit !== line.originalUnit) line.changes.push(`${line.qty} ${line.originalUnit || "(stock unit)"} = ${stock.qty} in stock units, ordered from ${line.vendor} as ${converted.qty} ${unit || "(stock unit)"}`);
            line.qty = converted.qty;
        }
        line.unit = unit;
        if (!theirs) {
            line.changes.push(`${line.vendor} has no vendor record for this product, so it is ordered in the stock unit${unit ? ` (${unit})` : ""} with no cost`);
            continue;
        }
        if (line.unitCost === null && typeof theirs["COST"] === "number" && theirs["COST"] > 0) line.unitCost = theirs["COST"];
        line.partNo ||= text(theirs["PART_NO"]);
    }
    return lines.filter((line) => !dropped.has(line));
}

export function registerWorksheetTools(register: ToolRegistrar): void {
    register(
        "po_from_csv",
        {
            description: [
                "Turn an approved MRP worksheet into purchase-order drafts, read-only.",
                "Reads the CSV mrp_plan produced, after the planner set Approve to Y on BUY rows (and perhaps changed Order Qty or Vendor); checks every vendor and product against EBMS; and returns one draft per vendor with the exact body to POST to APINV with ebms_write.",
                "It creates nothing. A worksheet handed in twice cannot order twice: ebms_write refuses the duplicate EXTERNALID.",
                "Show the drafts and get a clear yes per purchase order before writing.",
            ].join(" "),
            inputSchema: z.object(source),
        },
        async (args) => {
            try {
                const opened = await openWorksheet(args, "BUY");
                if ("content" in opened) return opened as McpToolResult;
                const { company, reading, problems } = opened;

                const vendors = new Map((await readByIds(company, "APVENDOR", "ID", reading.approved.map((l) => l.vendor), "ID,F_NAME,L_NAME,INACTIVE")).map((row) => [text(row["ID"]).toUpperCase(), row]));
                const products = new Map((await readByIds(company, "INVENTRY", "ID", reading.approved.map((l) => l.item), "ID,INACTIVE")).map((row) => [text(row["ID"]).toUpperCase(), row]));
                const orderable = reading.approved.filter((line) => {
                    const vendor = vendors.get(line.vendor);
                    const product = products.get(line.item.toUpperCase());
                    const wrong = !vendor ? `vendor "${line.vendor}" is not in EBMS` : vendor["INACTIVE"] === true ? `vendor ${line.vendor} is inactive` : !product ? `product "${line.item}" is not in EBMS` : product["INACTIVE"] === true ? `product ${line.item} is inactive` : null;
                    if (wrong) problems.push(`Line ${line.row}: ${wrong}.`);
                    return wrong === null;
                });
                const drafts = draftPurchaseOrders({ ...reading, approved: await settleUnits(company, orderable, problems) });
                const existing = await alreadyCreated(company, "APINV", "AUTOID,INVOICE,EXTERNALID", drafts.map((d) => d.externalId));
                return jsonResult({
                    company,
                    run: reading.run,
                    counts: reading.counts,
                    runRecordFound: reading.fromManifest,
                    problems,
                    notes: reading.notes,
                    drafts: drafts.map((draft) => ({
                        vendor: draft.vendor,
                        vendorName: `${text(vendors.get(draft.vendor)?.["F_NAME"])} ${text(vendors.get(draft.vendor)?.["L_NAME"])}`.trim(),
                        lines: draft.lines.length,
                        estCost: draft.estCost,
                        changedByPlanner: draft.changes,
                        neededBy: draft.neededBy,
                        alreadyCreated: existing.get(draft.externalId),
                        write: existing.has(draft.externalId) ? "Already created for this run; do not create it again." : { tool: "ebms_write", method: "POST", path: "APINV", body: draft.body, readBack: { record: "INVOICE,ID,TOTAL", lines: "UNIT_MEAS,UNIT_VIS,ETA_DATE" } },
                    })),
                    next: "Nothing was created. Follow the ebms-mrp-purchase-orders skill: problems first, then a clear yes for each purchase order before ebms_write.",
                });
            } catch (error) {
                return errorResult(error);
            }
        },
    );

    register(
        "batches_from_csv",
        {
            description: [
                "Turn approved MAKE rows of an MRP worksheet into manufacturing-batch drafts, read-only.",
                "For each it checks EBMS will accept the product as a finished good (it must be classified Track Count), lists every component from the bill of materials with its quantity per one finished good (EBMS does NOT add consumed materials itself when a batch arrives through the API), picks the warehouse (the one given, else where the product was last made), and returns the exact body to POST to INMFG with ebms_write.",
                "It creates nothing. Drafts mark nothing as made or consumed and never carry PROCESS: finishing and processing a batch is done by a person in EBMS.",
                "Show each draft and get a clear yes before writing it.",
            ].join(" "),
            inputSchema: z.object({ ...source, warehouse: z.string().optional().describe("Warehouse ID for every batch. ASK the user if they have more than one; when omitted, each product's batch goes where it was last made.") }),
        },
        async (args) => {
            try {
                const opened = await openWorksheet(args, "MAKE");
                if ("content" in opened) return opened as McpToolResult;
                const { company, reading, problems } = opened;

                const items = reading.approved.map((line) => line.item);
                const classification: Record<string, number> = {};
                for (const row of await readByIds(company, "INVENTRY", "ID", items, "ID,C_TYPE,INACTIVE")) {
                    if (row["INACTIVE"] !== true) classification[text(row["ID"])] = typeof row["C_TYPE"] === "number" ? row["C_TYPE"] : -1;
                }
                const bom = await readByIds(company, "INVENDET", "ID", items, "ID,COMP_ID,QUAN,CATEGORY");
                const components: Record<string, BatchComponent[]> = {};
                for (const row of bom) (components[text(row["ID"])] ??= []).push({ item: text(row["COMP_ID"]), qtyPer: typeof row["QUAN"] === "number" ? row["QUAN"] : 0, category: text(row["CATEGORY"]) });
                const units = (await readByIds(company, "INVENUNT", "ID", [...items, ...bom.map((row) => text(row["COMP_ID"]))], "ID,UNIT,MULTIPLIER,MULTIPLY")) as unknown as UnitRow[];
                // Oldest first, so the last one written for a product is where it was made most recently.
                const lastWarehouse: Record<string, string> = {};
                const madeBefore = await readByIds(company, "APINVDET", "INVEN", items, "INVEN,WAREHOUSE,INV_DATE", "DOC_TYPE eq 'M'");
                for (const row of madeBefore.sort((a, b) => text(a["INV_DATE"]).localeCompare(text(b["INV_DATE"])))) {
                    if (text(row["WAREHOUSE"])) lastWarehouse[text(row["INVEN"])] = text(row["WAREHOUSE"]);
                }

                const batches = draftBatches(reading.approved, { run: reading.run, classification, components, units, lastWarehouse, warehouse: args.warehouse?.trim() || undefined });
                const existing = await alreadyCreated(company, "INMFG", "AUTOID,BATCH,EXTERNALID", batches.drafts.map((d) => d.externalId));
                return jsonResult({
                    company,
                    run: reading.run,
                    counts: reading.counts,
                    runRecordFound: reading.fromManifest,
                    problems: [...problems, ...batches.problems],
                    notes: reading.notes,
                    drafts: batches.drafts.map((draft) => ({
                        item: draft.item,
                        make: `${draft.qty}${draft.unit ? ` ${draft.unit}` : ""}`,
                        warehouse: draft.warehouse,
                        neededBy: draft.neededBy,
                        consumes: draft.components.map((part) => `${part.item}: ${part.perUnit} each, ${part.total}${part.unit ? ` ${part.unit}` : ""} in all`),
                        changedByPlanner: draft.changes,
                        notes: draft.notes,
                        alreadyCreated: existing.get(draft.externalId),
                        write: existing.has(draft.externalId) ? "Already created for this run; do not create it again." : { tool: "ebms_write", method: "POST", path: "INMFG", body: draft.body, readBack: { record: "BATCH,STAT,WAREHOUSE", lines: "UNIT_MEAS" } },
                    })),
                    next: "Nothing was created. Follow the ebms-mrp-batches skill: problems first, then a clear yes for each batch before ebms_write.",
                });
            } catch (error) {
                return errorResult(error);
            }
        },
    );
}
