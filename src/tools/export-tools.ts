/**
 * ebms_export: a read too big for the conversation, written to a file instead. Read-only, and the
 * company is resolved exactly as ebms_get resolves it. Only a summary comes back.
 */
import { z } from "zod/v4";
import { resolveCompany } from "../config.js";
import { DEFAULT_MAX_ROWS, runExport } from "../export/export.js";
import { entityOf, validatePath } from "../guards.js";
import type { ToolRegistrar } from "./types.js";
import { errorResult, jsonResult } from "./types.js";

/** The navigation names an $expand reads at its top level: commas inside (...) are not separators. */
export function topLevel(expand: string): string[] {
    const names: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of expand) {
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
        if (ch === "," && depth === 0) {
            names.push(current);
            current = "";
        } else current += ch;
    }
    names.push(current);
    return names.map((part) => (part.split("(")[0] ?? "").trim()).filter(Boolean);
}

export function registerExportTools(register: ToolRegistrar): void {
    register(
        "ebms_export",
        {
            description: [
                "Read a whole EBMS collection to a file (CSV, Excel or JSONL) instead of into the conversation, for anything more than a few hundred rows: sales history, every product, all open lines.",
                "The server pages through it itself and returns only the file's path, the row count, the columns, five sample rows and min/max/sum of each numeric column — never the rows.",
                "Analyse the file with a script (pandas, duckdb) and read back only the aggregates; never write a script that calls EBMS.",
                "Count first with ebms_get (top 1). Select only the fields you need. Read-only.",
            ].join(" "),
            inputSchema: z.object({
                company: z.string().optional().describe("Company, by ID or name as ebms_companies lists them. May be omitted only when one company is available."),
                path: z.string().min(1).describe("Required. An entity set, e.g. ARINVDET, INVENTRY. Not a keyed path."),
                select: z.string().min(1).describe("Required. $select, comma-separated. AUTOID is added if missing."),
                filter: z.string().optional().describe("$filter, unencoded."),
                expand: z.string().optional().describe("$expand, with a select inside, e.g. Details($select=INVEN,O_QUAN_VIS). Line _VIS fields read 0 unless read through the parent like this."),
                explode: z.string().optional().describe("An expanded collection, e.g. Details: one row per child, with the parent's fields repeated and the child's as Details.<FIELD>. Without it an expanded collection is JSON text in one cell."),
                orderby: z.string().optional().describe("Default AUTOID, so pages do not shift while being read; where EBMS refuses that sort, the server's own order is used and repeats are still removed by AUTOID (the result says ordered: false)."),
                format: z.enum(["csv", "xlsx", "jsonl"]).optional().describe("Default csv."),
                folder: z.string().optional().describe("Only a folder the user named: an existing one, not hidden and not koble's settings. Default: KOBLE_EXPORT_DIR, or 'Koble Exports' in the user's Documents (created if missing)."),
                filename: z.string().optional().describe("File name only. Default <company>-<entity>-<timestamp>. An existing file is never overwritten."),
                pageSize: z.number().int().min(1).max(1000).optional().describe("Rows per request. Default 500, or 25 with an expand. Lower it if a page times out."),
                maxRows: z.number().int().min(1).optional().describe(`Refuse an export larger than this. Default ${DEFAULT_MAX_ROWS}.`),
            }),
        },
        async (args) => {
            try {
                const company = resolveCompany(args.company);
                const path = validatePath(args.path);
                if (path.includes("(") || path === "$metadata") throw new Error("ebms_export reads an entity set, such as ARINVDET. Read one record with ebms_get.");
                if (args.explode !== undefined && !topLevel(args.expand ?? "").includes(args.explode)) throw new Error(`explode names ${args.explode}, which expand does not include. Expand it too, e.g. expand: ${args.explode}($select=...).`);
                const summary = await runExport(company, { ...args, entity: entityOf(path) });
                return jsonResult({
                    company,
                    entity: entityOf(path),
                    ...summary,
                    next: `The rows are in ${summary.path}, not here. Analyse the file with a script (Python with pandas, or duckdb) via Bash and read back only the aggregates you need. Do not paste the file into the conversation, and do not call EBMS from the script.`,
                });
            } catch (error) {
                return errorResult(error, { company: args.company, path: args.path });
            }
        },
    );
}
