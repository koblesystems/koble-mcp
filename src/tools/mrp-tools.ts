/**
 * mrp_plan and mrp_item_view: read-only planning tools over one company.
 *
 * They belong in the server for the same reason write verification does: it is arithmetic
 * over hundreds of rows that must be exact, and doing it through a model would cost a great
 * many tokens to get a worse answer. They write nothing. Turning a planned order into a
 * purchase order is a separate, confirmed step through ebms_write, guided by a skill.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod/v4";
import { assertWriteCompany, resolveCompany } from "../config.js";
import { odataString } from "../ebms/client.js";
import { draftPurchaseOrders, parseCsv, readSheet, toCsv, type RunManifest } from "../mrp/csv.js";
import { baseUnitOf, type UnitRow } from "../mrp/units.js";
import { readAll } from "../mrp/snapshot.js";
import { buildWorksheet, runId } from "../mrp/worksheet.js";
import { addDays, runMrp, type PlannedOrder } from "../mrp/engine.js";
import { takeSnapshot } from "../mrp/snapshot.js";
import { buildTree, renderTree } from "../mrp/tree.js";
import type { ToolRegistrar } from "./types.js";
import { errorResult, jsonResult } from "./types.js";

/** Today where the planner is, not in UTC: after 5 pm Pacific, UTC is already tomorrow. */
const today = (): string => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
const isRealDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
/** Where worksheets go: KOBLE_OUTPUT_DIR, or "Koble MRP" in the user's Documents folder. */
const outputDir = (given: string | undefined): string => resolve(given?.trim() || process.env["KOBLE_OUTPUT_DIR"] || join(homedir(), "Documents", "Koble MRP"));
const cap = <T>(list: readonly T[], max: number): { shown: T[]; more: number } => ({ shown: list.slice(0, max), more: Math.max(0, list.length - max) });

const common = {
    company: z.string().optional().describe("Company, by ID or name. May be omitted only when one company is available."),
    alsoMade: z.array(z.string()).optional().describe("Product IDs to treat as manufactured although they have never been on a batch."),
    buyInstead: z.array(z.string()).optional().describe("Made products to plan as purchased for this run (not exploded into components)."),
};

export function registerMrpTools(register: ToolRegistrar): void {
    register(
        "mrp_plan",
        {
            description:
                "Material requirements plan for one company, read-only. Nets open sales and job demand, open manufacturing batches and open purchase orders against stock, day by day, through the bill of materials, and returns what to buy and make, by when, and why. ALWAYS ask the user for the time frame first (through, or days): it is 'buy and make what is needed to cover everything due by this date'. EBMS does not publish vendor lead times, so orders carry a needed-by date; pass leadTimeDays only if the user gives one. Minimums (MIN_INVEN), order-up-to (MAX_INVEN) and the reorder increment (ORDER_AMT) come from the product. Only stocked products and stocked lines are planned; drop-ship, associated and sync lines are tied to their own orders and are left out.",
            inputSchema: z.object({
                ...common,
                through: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Last date to cover, yyyy-mm-dd. Give this or days."),
                days: z.number().int().min(1).max(730).optional().describe("Time frame as days from today. Give this or through."),
                includeJobs: z.boolean().optional().describe("Count job transfers as demand. Default true."),
                leadTimeDays: z.number().int().min(0).max(365).optional().describe("A lead time to assume for every item, only if the user states one."),
                leadTimes: z.record(z.string(), z.number().int().min(0).max(365)).optional().describe("Lead time in days per product ID, overriding leadTimeDays."),
                vendor: z.string().optional().describe("Show only purchases whose primary vendor is this vendor ID. Planning still covers everything, because demand flows between items."),
                items: z.array(z.string()).optional().describe("Show only these product IDs."),
                maxRows: z.number().int().min(5).max(500).optional().describe("Rows per section in this result, default 25. The worksheet always has every row."),
                worksheet: z.boolean().optional().describe("Default true: write the planner's worksheet (CSV) and return its path. It lists every planned item with its status and recommendation; the planner edits Order Qty, Approve and Notes, and po_from_csv turns the approved rows into purchase orders."),
                saveTo: z.string().optional().describe("Folder for the worksheet. Default: KOBLE_OUTPUT_DIR, or 'Koble MRP' in the user's Documents."),
            }),
        },
        async (args) => {
            try {
                const company = resolveCompany(args.company);
                if (!args.through && !args.days) return jsonResult({ needsInput: "Ask the user for the time frame: a date to cover through, or a number of days. Do not assume one." });
                const now = today();
                const through = args.through ?? addDays(now, args.days ?? 30);
                if (!isRealDate(through)) return jsonResult({ needsInput: `"${through}" is not a calendar date. Ask the user for the time frame again, as yyyy-mm-dd or a number of days.` });
                if (through < now) return jsonResult({ needsInput: `${through} is already in the past (today is ${now}). Ask the user how far ahead the plan should cover.` });
                const started = Date.now();
                const snapshot = await takeSnapshot(company, { today: now, through, includeJobs: args.includeJobs, alsoMade: args.alsoMade, buyInstead: args.buyInstead, leadTimeDays: args.leadTimeDays, leadTimes: args.leadTimes });
                const plan = runMrp({ today: now, through, items: snapshot.items, demands: snapshot.demands, supplies: snapshot.supplies });

                const wanted = args.items ? new Set(args.items.map((id) => id.trim())) : null;
                const show = (order: PlannedOrder): boolean => (wanted === null || wanted.has(order.item)) && (!args.vendor || order.action === "make" || snapshot.products.get(order.item)?.vendor.toLowerCase() === args.vendor.trim().toLowerCase());
                const describe = (order: PlannedOrder) => {
                    const product = snapshot.products.get(order.item);
                    return {
                        item: order.item,
                        description: product?.description ?? "",
                        qty: order.qty,
                        neededBy: order.receiptDate,
                        ...(order.leadTimeKnown ? { releaseBy: order.releaseDate, pastDue: order.pastDue } : {}),
                        ...(order.action === "buy" ? { vendor: product?.vendor || "(no primary vendor)" } : { alsoPurchased: Boolean(product?.vendor) }),
                        because: order.pegs.slice(0, 3).map((peg) => `${peg.kind} ${peg.ref}: ${peg.qty} on ${peg.date}`),
                    };
                };
                const max = args.maxRows ?? 25;
                const orders = plan.plannedOrders.filter(show).sort((a, b) => a.receiptDate.localeCompare(b.receiptDate) || a.item.localeCompare(b.item));
                const buys = cap(orders.filter((o) => o.action === "buy").map(describe), max);
                const makes = cap(orders.filter((o) => o.action === "make").map(describe), max);
                const exceptions = plan.exceptions.filter((e) => wanted === null || wanted.has(e.item));
                const byType: Record<string, number> = {};
                for (const e of exceptions) byType[e.type] = (byType[e.type] ?? 0) + 1;
                const quiet = new Set(["assumed-date", "past-due-demand"]);
                const important = cap(exceptions.filter((e) => !quiet.has(e.type)).map((e) => ({ type: e.type, item: e.item, message: e.message })), max);
                const late = exceptions.filter((e) => e.type === "past-due-demand");
                const oldest = late.map((e) => e.from ?? "").filter(Boolean).sort()[0];
                const beyond = cap(plan.beyondHorizon.filter((b) => b.demandQty > 0 && (wanted === null || wanted.has(b.item))).map(({ supplies: _s, ...rest }) => rest), 20);
                const buying = new Set(orders.filter((o) => o.action === "buy").map((o) => o.item));
                const alreadyOnOrder = cap(plan.beyondHorizon.filter((b) => b.supplies.length > 0 && buying.has(b.item)).map((b) => ({ item: b.item, onOrder: b.supplies.map((sup) => `${sup.ref}: ${sup.qty} on ${sup.date}`) })), max);

                let worksheet: Record<string, unknown> | undefined;
                if (args.worksheet ?? true) {
                    const run = runId(company);
                    const sheet = await buildWorksheet(company, run, snapshot, plan);
                    const dir = outputDir(args.saveTo);
                    await mkdir(dir, { recursive: true });
                    const file = join(dir, `${run} through ${through}.csv`);
                    await writeFile(file, toCsv(sheet.rows), "utf8");
                    // The run's own record, which po_from_csv trusts over anything a spreadsheet did to the file.
                    await mkdir(join(dir, "runs"), { recursive: true });
                    await writeFile(join(dir, "runs", `${run}.json`), JSON.stringify(sheet.manifest, null, 1), "utf8");
                    const byType: Record<string, number> = {};
                    for (const row of sheet.rows) byType[String(row.Type)] = (byType[String(row.Type)] ?? 0) + 1;
                    worksheet = { path: file, run, rows: sheet.rows.length, byType, editableColumns: ["Order Qty", "Approve", "Notes"], warnings: sheet.warnings };
                }

                return jsonResult({
                    company,
                    ...(worksheet ? { worksheet } : {}),
                    timeFrame: { from: now, through },
                    leadTimes: args.leadTimeDays === undefined && !args.leadTimes ? "unknown — EBMS does not publish them; orders show when stock is needed, not when to order" : "as supplied by the user",
                    counts: { productsPlanned: snapshot.items.length, demandLines: snapshot.demands.length, supplyLines: snapshot.supplies.length, toBuy: orders.filter((o) => o.action === "buy").length, toMake: orders.filter((o) => o.action === "make").length, exceptions: byType },
                    buy: buys.shown,
                    ...(buys.more ? { buyNotShown: buys.more } : {}),
                    make: makes.shown,
                    ...(makes.more ? { makeNotShown: makes.more } : {}),
                    exceptions: important.shown,
                    ...(important.more ? { exceptionsNotShown: important.more } : {}),
                    ...(late.length > 0 ? { pastDueDemand: `${late.length} open demand lines were already due before today (oldest ${oldest}); they are planned as due now.` } : {}),
                    ...((byType["assumed-date"] ?? 0) > 0 ? { assumedDates: `${byType["assumed-date"]} incoming receipts have no expected date in EBMS. They are counted on the last day of the time frame, so they cannot hide a shortage: where one is needed sooner, the plan asks you to confirm it by that date.` } : {}),
                    ...(alreadyOnOrder.shown.length > 0 ? { alreadyOnOrderJustAfterTimeFrame: alreadyOnOrder.shown, alreadyOnOrderNote: "These items are recommended to BUY but already have receipts dated after the time frame. Tell the user: moving that order up may be better than buying more." } : {}),
                    demandAfterTimeFrame: beyond.shown,
                    leftOut: snapshot.skipped,
                    warnings: snapshot.warnings,
                    ms: { ...snapshot.timings, total: Date.now() - started },
                    next: "Nothing was written to EBMS. Give the user the worksheet path and a short summary: expedites and stock-outs first, then buys by vendor. They review it in a spreadsheet, set Approve to Y (and adjust Order Qty) on the BUY rows they want, save it as CSV, and hand it back; po_from_csv then drafts the purchase orders. Use mrp_item_view to explain one finished good.",
                });
            } catch (error) {
                return errorResult(error);
            }
        },
    );

    register(
        "po_from_csv",
        {
            description:
                "Turn an approved MRP worksheet into purchase-order drafts, read-only. Reads the CSV mrp_plan wrote (after the planner set Approve to Y and adjusted Order Qty on BUY rows), checks every vendor and product against EBMS, groups the approved rows into one purchase order per vendor, and returns for each the exact body to POST to APINV with ebms_write. It creates nothing itself. Each draft carries an EXTERNALID made from the run and the vendor, so a worksheet handed in twice cannot order twice — ebms_write refuses the duplicate. Show the drafts and get a clear yes per purchase order before writing.",
            inputSchema: z.object({
                company: z.string().min(1).describe("Required. Company, by ID or name. Must match the worksheet's company."),
                path: z.string().optional().describe("Path of the worksheet CSV on this computer. Give this or csv."),
                csv: z.string().optional().describe("The worksheet's CSV text, when the user pasted or attached it instead."),
            }),
        },
        async (args) => {
            try {
                const company = resolveCompany(args.company);
                let cannotWrite: string | null = null;
                try {
                    assertWriteCompany(company);
                } catch (error) {
                    cannotWrite = error instanceof Error ? error.message : String(error);
                }
                if (!args.path && !args.csv) return jsonResult({ needsInput: "Give the worksheet's path, or its CSV text." });
                const textIn = args.csv ?? (await readFile(resolve(args.path as string), "utf8"));
                // Find the run's own record: beside the file, or in the usual output folder.
                const runInFile = parseCsv(textIn).map((row) => row["Run"] ?? "").find(Boolean) ?? "";
                let manifest: RunManifest | null = null;
                if (/^mrp-[a-z0-9_-]+-\d{8}-\d{4,6}$/i.test(runInFile)) {
                    const places = [...(args.path ? [join(dirname(resolve(args.path)), "runs")] : []), join(outputDir(undefined), "runs")];
                    for (const place of places) {
                        const candidate = join(place, `${runInFile}.json`);
                        if (existsSync(candidate)) { manifest = JSON.parse(await readFile(candidate, "utf8")) as RunManifest; break; }
                    }
                }
                const reading = readSheet(textIn, manifest);
                const problems = [...reading.problems];
                if (cannotWrite) problems.push(`These drafts cannot be created from this server as it is set up: ${cannotWrite}`);
                if (reading.company && reading.company !== company) problems.push(`The worksheet is for company ${reading.company}, but this call names ${company}. Nothing was drafted.`);
                if (problems.some((p) => p.includes("does not look like") || p.includes("but this call names") || p.includes("mixes"))) return jsonResult({ company, problems, drafts: [] });

                // Check vendors and products against EBMS before anything is drafted.
                const check = async (entity: string, ids: string[], select: string): Promise<Map<string, Record<string, unknown>>> => {
                    const found = new Map<string, Record<string, unknown>>();
                    for (let i = 0; i < ids.length; i += 15) {
                        const filter = ids.slice(i, i + 15).map((id) => `ID eq ${odataString(id)}`).join(" or ");
                        for (const row of await readAll(company, entity, { $filter: filter, $select: select })) found.set(String(row["ID"] ?? "").trim().toUpperCase(), row);
                    }
                    return found;
                };
                const vendors = await check("APVENDOR", [...new Set(reading.approved.map((line) => line.vendor))], "ID,F_NAME,L_NAME,INACTIVE");
                const products = await check("INVENTRY", [...new Set(reading.approved.map((line) => line.item))], "ID,DESCR_1,INACTIVE");
                const usable = reading.approved.filter((line) => {
                    const vendor = vendors.get(line.vendor.toUpperCase());
                    const product = products.get(line.item.toUpperCase());
                    if (!vendor) { problems.push(`Line ${line.row}: vendor "${line.vendor}" is not in EBMS.`); return false; }
                    if (vendor["INACTIVE"] === true) { problems.push(`Line ${line.row}: vendor ${line.vendor} is inactive.`); return false; }
                    if (!product) { problems.push(`Line ${line.row}: product "${line.item}" is not in EBMS.`); return false; }
                    if (product["INACTIVE"] === true) { problems.push(`Line ${line.row}: product ${line.item} is inactive.`); return false; }
                    return true;
                });
                // Lines whose unit is not known (a vendor the planner chose, or no run record): use that
                // vendor's unit and cost if the product has them, otherwise the product's stock unit.
                const open = usable.filter((line) => line.unit === null);
                if (open.length > 0) {
                    const ids = [...new Set(open.map((line) => line.item))];
                    const vendorRows: Array<Record<string, unknown>> = [];
                    const unitRows: UnitRow[] = [];
                    for (let i = 0; i < ids.length; i += 15) {
                        const filter = ids.slice(i, i + 15).map((id) => `ID eq ${odataString(id)}`).join(" or ");
                        vendorRows.push(...(await readAll(company, "INVENDOR", { $filter: filter, $select: "ID,VENDOR_ID,UNIT_MEAS,COST,PART_NO" })));
                        unitRows.push(...((await readAll(company, "INVENUNT", { $filter: filter, $select: "ID,UNIT,MULTIPLIER,MULTIPLY" })) as unknown as UnitRow[]));
                    }
                    for (const line of open) {
                        const theirs = vendorRows.find((row) => String(row["ID"] ?? "").trim() === line.item && String(row["VENDOR_ID"] ?? "").trim().toUpperCase() === line.vendor);
                        if (theirs) {
                            line.unit = String(theirs["UNIT_MEAS"] ?? "").trim();
                            if (line.unitCost === null && typeof theirs["COST"] === "number" && theirs["COST"] > 0) line.unitCost = theirs["COST"];
                            line.partNo = line.partNo || String(theirs["PART_NO"] ?? "").trim();
                        } else {
                            line.unit = baseUnitOf(line.item, unitRows);
                            line.changes.push(`${line.vendor} has no vendor record for this product, so it is ordered in the stock unit${line.unit ? ` (${line.unit})` : ""} with no cost — check the quantity means what you intend`);
                        }
                    }
                }
                const drafts = draftPurchaseOrders({ ...reading, approved: usable });
                const existing = new Map<string, Record<string, unknown>>();
                for (const draft of drafts) {
                    const rows = await readAll(company, "APINV", { $filter: `EXTERNALID eq ${odataString(draft.externalId)}`, $select: "AUTOID,INVOICE,EXTERNALID" });
                    if (rows[0]) existing.set(draft.externalId, rows[0]);
                }
                return jsonResult({
                    company,
                    run: reading.run,
                    counts: reading.counts,
                    runRecordFound: reading.fromManifest,
                    problems,
                    notes: reading.notes,
                    drafts: drafts.map((draft) => ({
                        vendor: draft.vendor,
                        vendorName: `${String(vendors.get(draft.vendor)?.["F_NAME"] ?? "").trim()} ${String(vendors.get(draft.vendor)?.["L_NAME"] ?? "").trim()}`.trim(),
                        lines: draft.lines.length,
                        estCost: draft.estCost,
                        changedByPlanner: draft.changes,
                        neededBy: draft.neededBy,
                        alreadyCreated: existing.has(draft.externalId) ? existing.get(draft.externalId) : undefined,
                        write: existing.has(draft.externalId) ? "This purchase order already exists for this run; do not create it again." : { tool: "ebms_write", method: "POST", path: "APINV", body: draft.body, readBack: { record: "INVOICE,ID,TOTAL", lines: "UNIT_MEAS,UNIT_VIS,ETA_DATE" } },
                    })),
                    next: "Nothing was created. Show each draft — vendor, lines, quantities, units, cost — and get a clear yes for each purchase order. Then call ebms_write with that draft's body exactly as given, and report the PO number and the verification. EBMS sets each line's expected date (ETA_DATE) itself from the vendor's lead time: compare it with the draft's neededBy and tell the user about any line expected later than it is needed, or with no expected date at all. If a verification is not ok, stop and tell the user before doing the next one.",
                });
            } catch (error) {
                return errorResult(error);
            }
        },
    );

    register(
        "mrp_item_view",
        {
            description:
                "The total view of one finished good, read-only: everything needed to build a quantity of it, down every level of its bill of materials, against what is available (on hand + incoming − on order). Stock of a sub-assembly covers its branch before anything is exploded further, and a part used in two branches is only counted once. Returns an indented tree, what to make, what to buy, and canBuildWithoutBuying: true when every purchased part is available, even if sub-assemblies still have to be made from them.",
            inputSchema: z.object({
                ...common,
                item: z.string().min(1).describe("Required. Product ID of the finished good."),
                qty: z.number().positive().describe("Required. How many to build."),
                availability: z.enum(["available", "onHand"]).optional().describe("'available' (default) = on hand + incoming − on order; 'onHand' = what is on the shelf now."),
            }),
        },
        async (args) => {
            try {
                const company = resolveCompany(args.company);
                const snapshot = await takeSnapshot(company, { today: today(), alsoMade: args.alsoMade, buyInstead: args.buyInstead });
                const id = args.item.trim();
                if (!snapshot.products.has(id)) return jsonResult({ company, error: `No active product "${id}".` });
                const mode = args.availability ?? "available";
                const available = Object.fromEntries([...snapshot.products.values()].map((p) => [p.id, mode === "onHand" ? p.onHand : p.available]));
                const { root, totals, canBuildFromStock } = buildTree({ item: id, qty: args.qty, items: snapshot.bom, available });
                const overPromised = totals.filter((t) => (available[t.item] ?? 0) < 0).map((t) => `${t.item} is already short by ${-(available[t.item] ?? 0)} before this build`);
                return jsonResult({
                    company,
                    item: id,
                    qty: args.qty,
                    availability: mode === "onHand" ? "on hand" : "on hand + incoming − on order",
                    canBuildWithoutBuying: canBuildFromStock,
                    tree: renderTree(root),
                    make: totals.filter((t) => t.action === "make" && t.short > 0).map((t) => ({ item: t.item, qty: t.short })),
                    buy: totals.filter((t) => t.action === "buy" && t.short > 0).map((t) => ({ item: t.item, qty: t.short, vendor: snapshot.products.get(t.item)?.vendor || "(no primary vendor)" })),
                    notes: [...overPromised, ...(snapshot.made.has(id) ? [] : [`${id} has never been the finished good of a batch, so it is treated as a kit: pass alsoMade to explode it as a manufactured item.`])],
                    warnings: snapshot.warnings,
                });
            } catch (error) {
                return errorResult(error);
            }
        },
    );
}
