/**
 * mrp_plan and mrp_item_view: read-only planning over one company.
 *
 * They live in the server for the same reason write verification does: arithmetic over
 * hundreds of rows has to be exact, and doing it through a model would cost many tokens for a
 * worse answer. What to ask the planner and how to present the result is the ebms-mrp skill's job.
 */
import { pathToFileURL } from "node:url";
import { z } from "zod/v4";
import { resolveCompany } from "../config.js";
import { addDays, runMrp } from "../mrp/engine.js";
import { saveWorksheet } from "../mrp/files.js";
import { summarise } from "../mrp/report.js";
import { resolveScope } from "../mrp/scope.js";
import { takeSnapshot } from "../mrp/snapshot.js";
import { buildTree, renderTree } from "../mrp/tree.js";
import { toCsv } from "../mrp/csv.js";
import { buildWorksheet, runId } from "../mrp/worksheet.js";
import type { ToolRegistrar } from "./types.js";
import { errorResult, jsonResult, jsonResultWithFile } from "./types.js";

/** Past this size only the rows that need a decision are attached, to keep the conversation affordable. */
const ATTACH_LIMIT = 150_000;

/** Today where the planner is, not in UTC: after 5 pm Pacific, UTC is already tomorrow. */
function today(): string {
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const isCalendarDate = (value: string): boolean => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const ask = (question: string, extra: Record<string, unknown> = {}) => jsonResult({ needsInput: question, ...extra });

const company = z.string().optional().describe("Company, by ID or name. May be omitted only when one company is available.");
const alsoMade = z.array(z.string()).optional().describe("Product IDs to treat as manufactured although they have never been on a batch.");
const buyInstead = z.array(z.string()).optional().describe("Made products to plan as purchased for this run (not exploded into components).");

export function registerMrpTools(register: ToolRegistrar): void {
    register(
        "mrp_plan",
        {
            description: [
                "Material requirements plan for one company, read-only: nets open sales and job demand, open manufacturing batches and open purchase orders against stock, day by day, through the bill of materials, and returns what to buy and make, by when, and why.",
                "ALWAYS ask the user two things first and never assume either: the time frame (through, or days) — 'buy and make what is needed to cover everything due by this date' — and the scope: everything, particular vendors, or particular products.",
                "EBMS does not publish vendor lead times, so orders carry a needed-by date; pass leadTimeDays only if the user gives one.",
                "Only stocked products and stocked lines are planned; drop-ship, associated and sync lines belong to their own orders.",
                "The planner's worksheet comes back attached as CSV: give it to the user as a file in the conversation, unchanged.",
            ].join(" "),
            inputSchema: z.object({
                company,
                alsoMade,
                buyInstead,
                through: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Last date to cover, yyyy-mm-dd. Give this or days."),
                days: z.number().int().min(1).max(730).optional().describe("Time frame as days from today. Give this or through."),
                scope: z.enum(["everything", "vendors", "products"]).optional().describe("Required. ASK the user: everything, particular vendors, or particular products? Buyers often work one vendor at a time. The whole company is always planned; the scope decides what is reported."),
                vendors: z.array(z.string()).optional().describe("With scope 'vendors': vendor IDs or names. A product belongs to its primary vendor."),
                items: z.array(z.string()).optional().describe("With scope 'products': the product IDs to report."),
                includeJobs: z.boolean().optional().describe("Count job transfers as demand. Default true."),
                minimumRule: z.enum(["when-crossed", "by-end"]).optional().describe("How an item that ends the time frame under its minimum is restored. when-crossed (default): the minimum is a reorder point, so the order is dated the day the item went under and can replace an expedite. by-end: the minimum is a level to be back at by the end of the time frame, so the order is dated its last day. It is a company policy; ask once."),
                leadTimeDays: z.number().int().min(0).max(365).optional().describe("A lead time to assume for every item, only if the user states one."),
                leadTimes: z.record(z.string(), z.number().int().min(0).max(365)).optional().describe("Lead time in days per product ID, overriding leadTimeDays."),
                maxRows: z.number().int().min(5).max(500).optional().describe("Rows per section in this result, default 25. The worksheet always has every row."),
                worksheet: z.boolean().optional().describe("Default true: write the planner's worksheet (CSV)."),
                saveTo: z.string().optional().describe("Folder for the worksheet. Default: KOBLE_OUTPUT_DIR, or 'Koble MRP' in the user's Documents."),
                inChat: z.boolean().optional().describe("Default true: attach the worksheet's CSV to this result."),
            }),
        },
        async (args) => {
            try {
                const id = resolveCompany(args.company);
                if (!args.through && !args.days) return ask("Ask the user for the time frame: a date to cover through, or a number of days. Do not assume one.");
                if (!args.scope) return ask("Ask the user what this plan is for: everything, particular vendors (which ones?), or particular products (which ones?). Do not assume 'everything'.");
                if (args.scope === "vendors" && !args.vendors?.some((v) => v.trim())) return ask("Ask the user which vendor or vendors, by ID or name.");
                if (args.scope === "products" && !args.items?.some((v) => v.trim())) return ask("Ask the user which products, by product ID.");
                const now = today();
                const through = args.through ?? addDays(now, args.days ?? 0);
                if (!isCalendarDate(through)) return ask(`"${through}" is not a calendar date. Ask the user for the time frame again, as yyyy-mm-dd or a number of days.`);
                if (through < now) return ask(`${through} is already in the past (today is ${now}). Ask the user how far ahead the plan should cover.`);

                const started = Date.now();
                const snapshot = await takeSnapshot(id, { today: now, through, includeJobs: args.includeJobs, alsoMade: args.alsoMade, buyInstead: args.buyInstead, leadTimeDays: args.leadTimeDays, leadTimes: args.leadTimes });
                const plan = runMrp({ today: now, through, minimumRule: args.minimumRule, items: snapshot.items, demands: snapshot.demands, supplies: snapshot.supplies });
                const scope = await resolveScope(id, snapshot, { scope: args.scope, vendors: args.vendors, items: args.items });
                if ("ask" in scope) return ask(scope.ask, { vendorsWithProducts: scope.vendorsWithProducts });

                const result: Record<string, unknown> = {
                    company: id,
                    scope: scope.label,
                    timeFrame: { from: now, through },
                    minimumRule: args.minimumRule ?? "when-crossed",
                    leadTimes: args.leadTimeDays === undefined && !args.leadTimes ? "unknown: EBMS does not publish them, so orders show when stock is needed, not when to order" : "as supplied by the user",
                    ...summarise(plan, snapshot, scope.inScope, args.maxRows ?? 25),
                };
                if (args.worksheet === false) return jsonResult({ ...result, ms: { ...snapshot.timings, total: Date.now() - started } });

                const run = runId(id);
                const sheet = await buildWorksheet(id, run, snapshot, plan, scope.inScope);
                const fileName = `${run} through ${through}.csv`;
                const saved = await saveWorksheet(args.saveTo, fileName, sheet.rows, sheet.manifest);
                const byType: Record<string, number> = {};
                for (const row of sheet.rows) byType[String(row.Type)] = (byType[String(row.Type)] ?? 0) + 1;
                const decisions = sheet.rows.filter((row) => row.Type !== "OK");
                const attached = args.inChat === false ? null : saved.csv.length <= ATTACH_LIMIT ? saved.csv : toCsv(decisions);
                const attach = attached !== null && attached.length <= ATTACH_LIMIT;
                result["worksheet"] = {
                    fileName,
                    savedAt: saved.path,
                    run,
                    rows: sheet.rows.length,
                    byType,
                    editableColumns: ["Order Qty", "Approve", "Vendor", "Notes"],
                    warnings: sheet.warnings,
                    inChat: !attach ? "Not attached; give the user the savedAt path." : attached === saved.csv ? "The full worksheet is attached as CSV." : `Only the ${decisions.length} rows that need a decision are attached; the full file is at savedAt.`,
                };
                result["ms"] = { ...snapshot.timings, total: Date.now() - started };
                result["next"] = "Nothing was written to EBMS. Follow the ebms-mrp skill: hand over the worksheet unchanged, then summarise expedites, buys by vendor and makes.";
                return attach ? jsonResultWithFile(result, { uri: pathToFileURL(saved.path).toString(), mimeType: "text/csv", text: attached as string }) : jsonResult(result);
            } catch (error) {
                return errorResult(error);
            }
        },
    );

    register(
        "mrp_item_view",
        {
            description: [
                "The total view of one finished good, read-only: everything needed to build a quantity of it, down every level of its bill of materials, against what is available (on hand + incoming − on order).",
                "Stock of a sub-assembly covers its branch before anything is exploded further, and a part used in two branches is only counted once.",
                "Returns an indented tree, what to make, what to buy, and canBuildWithoutBuying: true when every purchased part is available, even if sub-assemblies still have to be made from them.",
            ].join(" "),
            inputSchema: z.object({
                company,
                alsoMade,
                buyInstead,
                item: z.string().min(1).describe("Required. Product ID of the finished good."),
                qty: z.number().positive().describe("Required. How many to build."),
                availability: z.enum(["available", "onHand"]).optional().describe("'available' (default) = on hand + incoming − on order; 'onHand' = what is on the shelf now."),
            }),
        },
        async (args) => {
            try {
                const id = resolveCompany(args.company);
                const snapshot = await takeSnapshot(id, { today: today(), alsoMade: args.alsoMade, buyInstead: args.buyInstead });
                const item = args.item.trim();
                if (!snapshot.products.has(item)) return jsonResult({ company: id, error: `No active product "${item}".` });
                const onHandOnly = args.availability === "onHand";
                const available = Object.fromEntries([...snapshot.products.values()].map((p) => [p.id, onHandOnly ? p.onHand : p.available]));
                const { root, totals, canBuildFromStock } = buildTree({ item, qty: args.qty, items: snapshot.bom, available });
                const short = totals.filter((t) => t.short > 0);
                return jsonResult({
                    company: id,
                    item,
                    qty: args.qty,
                    availability: onHandOnly ? "on hand" : "on hand + incoming − on order",
                    canBuildWithoutBuying: canBuildFromStock,
                    tree: renderTree(root),
                    make: short.filter((t) => t.action === "make").map((t) => ({ item: t.item, qty: t.short })),
                    buy: short.filter((t) => t.action === "buy").map((t) => ({ item: t.item, qty: t.short, vendor: snapshot.products.get(t.item)?.vendor || "(no primary vendor)" })),
                    notes: [
                        ...totals.filter((t) => (available[t.item] ?? 0) < 0).map((t) => `${t.item} is already short by ${-(available[t.item] ?? 0)} before this build`),
                        ...(snapshot.made.has(item) ? [] : [`${item} has never been the finished good of a batch. Its bill of materials is opened here because you asked about it, but mrp_plan treats it as a kit or a purchased item (alsoMade changes that).`]),
                    ],
                    warnings: snapshot.warnings,
                });
            } catch (error) {
                return errorResult(error);
            }
        },
    );
}
