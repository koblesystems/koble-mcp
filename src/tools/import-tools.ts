/**
 * import_from_csv: review a CSV or Excel file of records against EBMS and draft the writes,
 * read-only. It writes nothing to EBMS. It returns what each column maps to, the problems
 * grouped by kind, the rows already in EBMS or created by an earlier run, an exceptions
 * workbook holding only the rows that need fixing, and the exact ebms_write call for each
 * remaining row. The skill (ebms-import) shows these, gets one yes for the file, and writes.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { z } from "zod/v4";
import { assertWriteCompany, resolveCompany } from "../config.js";
import { buildDrafts, externalIdFor } from "../import/drafts.js";
import { buildExceptions, exceptionsPath, writeExceptions } from "../import/exceptions.js";
import { lookUp } from "../import/lookups.js";
import { keyFields, resolveMapping } from "../import/mapping.js";
import { readMetadata, type EntityMeta } from "../import/metadata.js";
import { ENTITIES, RULES } from "../import/rules.js";
import { openSource } from "../import/source.js";
import { groupIssues, validateRows, type Issue } from "../import/validate.js";
import type { ToolRegistrar } from "./types.js";
import { errorResult, jsonResult } from "./types.js";

/** Six hex characters that stay the same for the same entity, file name and header row. */
export const defaultImportId = (entity: string, name: string, headers: readonly string[]): string =>
    createHash("sha256").update(`${entity}|${name}|${headers.join(",")}`).digest("hex").slice(0, 6);

const today = (): string => new Date().toLocaleDateString("en-CA");

const summary = (rows: readonly number[], message: string) => ({ message, count: rows.length, rows: rows.slice(0, 20).map((r) => `Row ${r}`) });

export function registerImportTools(register: ToolRegistrar): void {
    register(
        "import_from_csv",
        {
            description: [
                "Review a CSV or Excel (.xlsx) file of records for one EBMS entity — products, units, vendor records, bills of materials, customers, vendors, workers, folders, tax rates or other configuration — and draft the writes, read-only.",
                "Maps each column to a field (from EBMS's live metadata), checks every row (blanks, types, lengths, duplicates, folders, vendors, products and units that do not exist), skips rows already in EBMS or already created by an earlier run of the same import, writes an exceptions workbook holding only the rows that need fixing, and returns the exact ebms_write call for each remaining row.",
                "It writes nothing to EBMS. Follow the ebms-import skill: show the mapping, problems and a few drafts, get one clear yes for the file, then call ebms_write for each draft in order.",
                "Run it again on the same file (or the corrected exceptions file) to continue: what was created is skipped.",
            ].join(" "),
            inputSchema: z.object({
                company: z.string().min(1).describe("Required. Company, by ID or name."),
                entity: z.enum(ENTITIES).describe("What the file holds: INVENTRY products; INVENUNT units, INVENDOR vendor records, INVENDET bill-of-materials lines (each row names its product in ID); ARCUST customers; APVENDOR vendors; PYEMP workers; INVENTRE / ARCUSTRE / APVENTRE / PYEMPTRE / PYWORKTRE folders; ARTAX tax rates; or a configuration set."),
                path: z.string().optional().describe("Path of the file on this computer: .csv or .xlsx (also an exceptions workbook this tool wrote). Give this or csv."),
                csv: z.string().optional().describe("The file's CSV text, as the user attached or pasted it."),
                sheet: z.string().optional().describe("For a workbook with several sheets: the one to read. Default: the first."),
                mapping: z.record(z.string(), z.string()).optional().describe("Header -> field, overriding the automatic match. Map a header to \"\" to leave the column out."),
                defaults: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Field -> value for every row whose cell is blank or whose column is missing, e.g. {\"TREE_ID\": \"26\", \"C_TYPE\": 2}. Only what the user chose: never a guessed folder or classification."),
                importId: z.string().regex(/^[a-z0-9]{1,12}$/).optional().describe("Continue an earlier import of the same records from a renamed file: the importId an earlier result gave."),
                rowsFrom: z.number().int().min(1).optional().describe("First row number to draft (validation always covers the whole file)."),
                rowsTo: z.number().int().min(1).optional(),
                maxDrafts: z.number().int().min(1).max(500).optional().describe("At most this many drafts in one result. Default 200."),
                failedRows: z.array(z.object({ row: z.number().int(), problem: z.string() })).optional().describe("Rows whose ebms_write failed in this import, with what EBMS said: they go to the exceptions workbook instead of being drafted again."),
                exceptionsTo: z.string().optional().describe("Where to save the exceptions workbook. Default: beside the file as <name>.exceptions.xlsx."),
            }),
        },
        async (args) => {
            try {
                const company = resolveCompany(args.company);
                const rule = RULES[args.entity];
                if (!rule) throw new Error(`${args.entity} is not an entity this tool imports.`);
                if (!args.path && !args.csv) return jsonResult({ needsInput: "Which file? Ask the user for its path on this computer, or to attach or paste it. Don't pick one yourself." });

                const notes: string[] = [];
                let writeBlocked: string | undefined;
                try {
                    assertWriteCompany(company);
                } catch (error) {
                    // Reviewing is only reading, so this is reported rather than refused.
                    writeBlocked = `These drafts cannot be written from this server as it is set up: ${error instanceof Error ? error.message : String(error)}`;
                }

                const source = await openSource(args);
                notes.push(...source.notes);
                const base = { company, entity: rule.entity, tier: rule.tier, source: { name: source.name, ...(source.sheet ? { sheet: source.sheet } : {}) } };
                const blocked = (fatal: string[], extra: Record<string, unknown> = {}) => jsonResult({ ...base, blocked: true, fatal, ...extra, drafts: [], ...(writeBlocked ? { writeBlocked } : {}), next: "Nothing can be drafted from this file until the fatal problems are fixed. Tell the user what they are." });
                if (source.fromExceptions && source.fromExceptions.entity && source.fromExceptions.entity !== rule.entity) {
                    source.fatal.push(`This is an exceptions file from an import of ${source.fromExceptions.entity}, not ${rule.entity}.`);
                }
                if (source.fatal.length > 0) return blocked(source.fatal);

                let meta: EntityMeta;
                try {
                    meta = await readMetadata(company, rule.entity);
                } catch (error) {
                    return blocked([`EBMS's description of ${rule.entity} could not be read (${error instanceof Error ? error.message : String(error)}), so the file cannot be checked. Nothing was drafted.`]);
                }

                const defaults = args.defaults ?? {};
                const mapping = resolveMapping(source.headers, rule, meta, args.mapping, defaults);
                notes.push(...mapping.notes);
                const mappingOut = mapping.columns.map((c) => `${c.header} -> ${c.field}${meta.fields.get(c.field)?.label ? ` (${meta.fields.get(c.field)?.label})` : ""}${c.by === "field name" ? "" : `, by ${c.by}`}`);
                if (mapping.fatal.length > 0) return blocked(mapping.fatal, { mapping: mappingOut, unmapped: mapping.unmapped });

                const importId = args.importId ?? source.fromExceptions?.importId ?? defaultImportId(rule.entity, source.name, source.headers);
                const date = today();
                const validation = validateRows(source.rows, rule, meta, mapping, defaults);
                notes.push(...validation.notes);
                const lookups = await lookUp(company, rule, meta, validation.rows, { importId, externalIdFor: (row) => externalIdFor(importId, date, row) });
                notes.push(...lookups.notes);

                const failed: Issue[] = (args.failedRows ?? [])
                    .filter((f) => source.rows.some((r) => r.row === f.row) && !lookups.created.has(f.row) && !lookups.existing.has(f.row))
                    .map((f) => ({ row: f.row, kind: "write-failed", field: "", value: "", text: `EBMS refused it: ${f.problem}` }));
                const flagged = new Set([...lookups.issues, ...failed].map((i) => i.row));
                const ready = validation.rows.filter((r) => !flagged.has(r.row) && !lookups.existing.has(r.row) && !lookups.created.has(r.row) && !lookups.waiting.has(r.row));
                if (lookups.waiting.size > 0) notes.push(`${lookups.waiting.size} ${rule.plural} wait for a parent folder this import creates (rows ${[...lookups.waiting].sort((a, b) => a - b).slice(0, 20).join(", ")}). Run the import again once these are written: they will be drafted then.`);
                const drafts = buildDrafts(rule, meta, rule.cannotCreate ? [] : ready, lookups, { company, importId, date, rowsFrom: args.rowsFrom, rowsTo: args.rowsTo, maxDrafts: args.maxDrafts ?? 200 });
                notes.push(...drafts.notes);
                if (rule.cannotCreate) notes.unshift(rule.cannotCreate);

                const issues = [...validation.issues, ...lookups.issues, ...failed, ...drafts.issues];
                const problems = groupIssues(issues, { company, maxLength: (field) => meta.fields.get(field)?.maxLength ?? 0 });
                const target = exceptionsPath(source, rule.entity, importId, args.exceptionsTo);
                let exceptionsFile: string | null = null;
                if (issues.length > 0) {
                    const built = await buildExceptions(source, issues, problems, { company, entity: rule.entity, importId });
                    await writeExceptions(target, built.data);
                    exceptionsFile = target;
                } else if (existsSync(target) && target !== source.path) {
                    notes.push(`Every row passes now, so ${target} from an earlier review is out of date and was left as it is.`);
                }

                const problemRows = new Set(issues.map((i) => i.row));
                const existingRows = [...lookups.existing.keys()].sort((a, b) => a - b);
                const createdRows = [...lookups.created.keys()].sort((a, b) => a - b);
                const keyName = keyFields(rule, meta).join(" / ");
                return jsonResult({
                    ...base,
                    importId,
                    ...(writeBlocked ? { writeBlocked } : {}),
                    blocked: false,
                    counts: {
                        rows: source.rows.filter((r) => !r.blank).length,
                        blankRowsSkipped: validation.blank,
                        problemRows: problemRows.size,
                        alreadyInEbms: existingRows.length,
                        createdEarlier: createdRows.length,
                        waitingForParent: lookups.waiting.size,
                        ready: drafts.ready,
                        drafted: drafts.drafts.length,
                    },
                    mapping: mappingOut,
                    unmapped: mapping.unmapped,
                    ...(Object.keys(defaults).length > 0 ? { defaultsUsed: defaults } : {}),
                    problems,
                    ...(existingRows.length > 0 ? { existing: summary(existingRows, `${existingRows.length} ${rule.plural} already exist in ${company} (same ${keyName}); they are skipped, not changed`) } : {}),
                    ...(createdRows.length > 0 ? { alreadyCreated: summary(createdRows, `${createdRows.length} rows were created by an earlier run of this import; they are skipped`) } : {}),
                    notes: [...new Set([...(rule.note ? [rule.note] : []), ...notes])],
                    exceptionsFile,
                    drafts: drafts.drafts,
                    nextRowsFrom: drafts.nextRowsFrom,
                    next: rule.cannotCreate
                        ? `Review only: ${rule.plural} cannot be created through the API. Tell the user what the problems are, where the exceptions file is, and that the good rows are entered in EBMS.`
                        : drafts.drafts.length === 0
                        ? problemRows.size > 0
                            ? "Nothing is ready to create. Tell the user what the problems are and where the exceptions file is."
                            : lookups.waiting.size > 0 ? "Nothing is ready yet." : "Nothing is left to create from this file."
                        : "Nothing was written. Follow the ebms-import skill: mapping and problems first, three sample drafts, one clear yes for the file, then ebms_write for each draft in order, exactly as given.",
                });
            } catch (error) {
                return errorResult(error);
            }
        },
    );
}
