/**
 * A bulk read that goes to disk instead of into the conversation.
 *
 * Pages a collection with $top/$skip, each page one request well inside EBMS's 2-minute limit,
 * and streams the rows to a temporary JSONL file. Once every page is in, that file becomes the
 * export (CSV, XLSX or JSONL) and only a summary comes back: where the file is, how many rows,
 * the columns, a few sample rows and min/max/sum for the numeric columns. The rows themselves
 * never enter the result, and the credentials never leave this server: whatever analyses the
 * file reads the file, it does not call EBMS.
 */
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import ExcelJS from "exceljs";
import { request } from "../ebms/client.js";
import { EbmsError } from "../ebms/errors.js";

type Row = Record<string, unknown>;
export type ExportFormat = "csv" | "xlsx" | "jsonl";

export interface ExportOptions {
    entity: string;
    select: string;
    filter?: string | undefined;
    expand?: string | undefined;
    orderby?: string | undefined;
    format?: ExportFormat | undefined;
    folder?: string | undefined;
    filename?: string | undefined;
    pageSize?: number | undefined;
    maxRows?: number | undefined;
    /** An expanded collection to write one row per child of, with the parent's fields repeated. */
    explode?: string | undefined;
}

export interface NumericSummary { min: number; max: number; sum: number; count: number }

export interface ExportSummary {
    path: string;
    format: ExportFormat;
    rows: number;
    /** Records read from EBMS; more rows than records when explode spreads each over its children. */
    records: number;
    columns: string[];
    sample: Row[];
    numeric: Record<string, NumericSummary>;
    /** Columns with at least one empty value, and how many. */
    empty: Record<string, number>;
    pages: number;
    ordered: boolean;
    notes: string[];
    ms: number;
}

const SAMPLE_ROWS = 5;
const SAMPLE_CELL = 200;
const PAGE_CAP = 5000;
export const DEFAULT_MAX_ROWS = 250_000;
/** Excel's 1,048,576 rows per sheet, less the header. */
export const XLSX_MAX_ROWS = 1_048_575;

/** KOBLE_EXPORT_DIR, or "Koble Exports" in the user's Documents folder, beside "Koble MRP". */
export const exportDir = (given?: string): string => resolve(given?.trim() || process.env["KOBLE_EXPORT_DIR"] || join(homedir(), "Documents", "Koble Exports"));

/**
 * Small enough that one page answers in seconds. An expand multiplies every row by its children,
 * so those pages are much smaller.
 */
export const defaultPageSize = (expand: string | undefined): number => (expand ? 25 : 500);

const stamp = (at: Date): string => at.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/** A plain file name with the format's extension. */
export function exportName(company: string, entity: string, format: ExportFormat, filename: string | undefined, at = new Date()): string {
    let name = (filename ?? "").trim();
    if (name !== "") {
        if (name !== basename(name) || name.includes("\\") || name.startsWith(".")) throw new Error(`filename must be a plain file name, not a path: ${filename}. Use folder for the location.`);
        if (extname(name).toLowerCase() !== `.${format}`) name = `${name}.${format}`;
    } else {
        name = `${company}-${entity}-${stamp(at)}.${format}`.replace(/[^A-Za-z0-9._-]/g, "_");
    }
    return name;
}

/** Text written through a buffer to a file handle; a failed write rejects instead of crashing the server. */
interface Out {
    write(text: string): Promise<void>;
    close(): Promise<void>;
}

function buffered(handle: FileHandle): Out {
    let pending = "";
    let closed = false;
    return {
        async write(text) {
            pending += text;
            if (pending.length >= 64 * 1024) {
                const chunk = pending;
                pending = "";
                await handle.write(chunk);
            }
        },
        async close() {
            if (closed) return;
            closed = true;
            try {
                if (pending !== "") await handle.write(pending);
            } finally {
                await handle.close();
            }
        },
    };
}

const isEexist = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === "EEXIST";

/**
 * Claims the export's file and its .part beside it, both created exclusively, so nothing that is
 * already there (a file, a dangling link, another export running at the same moment) is touched.
 * A name that is taken gets -2, -3 ….
 */
async function reserve(folder: string, name: string): Promise<{ path: string; final: FileHandle; temp: string; tempOut: Out }> {
    const ext = extname(name);
    const stem = name.slice(0, -ext.length);
    for (let n = 1; n < 1000; n += 1) {
        const path = join(folder, n === 1 ? name : `${stem}-${n}${ext}`);
        let final: FileHandle;
        try {
            final = await open(path, "wx");
        } catch (error) {
            if (isEexist(error)) continue;
            throw error;
        }
        try {
            return { path, final, temp: `${path}.part`, tempOut: buffered(await open(`${path}.part`, "wx")) };
        } catch (error) {
            await final.close();
            await rm(path, { force: true });
            if (isEexist(error)) continue;
            throw error;
        }
    }
    throw new Error(`Could not find a free file name for ${name} in ${folder}.`);
}

/**
 * One flat row per record. Nested objects become dotted columns (Customer.NAME); arrays, which
 * a flat file cannot hold, become JSON text in one cell. OData annotations (@odata.etag) go.
 */
export function flatten(row: Row, prefix = "", out: Row = {}): { row: Row; arrays: string[] } {
    const arrays: string[] = [];
    for (const [key, value] of Object.entries(row)) {
        if (key.startsWith("@") || key.includes("@odata.")) continue;
        const name = prefix ? `${prefix}.${key}` : key;
        if (Array.isArray(value)) {
            out[name] = JSON.stringify(value);
            arrays.push(name);
        } else if (value !== null && typeof value === "object") {
            arrays.push(...flatten(value as Row, name, out).arrays);
        } else {
            out[name] = value;
        }
    }
    return { row: out, arrays };
}

/** The record as EBMS sent it, minus OData annotations (@odata.etag) at any depth. */
export function withoutAnnotations(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutAnnotations);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Row).filter(([key]) => !key.startsWith("@") && !key.includes("@odata.")).map(([key, v]) => [key, withoutAnnotations(v)]));
}

/** Text that Excel would run as a formula when the CSV is opened: =, +, -, @, tab or CR first. */
export const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
    if (value === null || value === undefined) return "";
    let text = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
    // A leading apostrophe makes Excel show the text instead of evaluating it. Numbers stay numbers.
    if (typeof value === "string" && FORMULA_START.test(text)) text = `'${text}`;
    return /[",\r\n']/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

async function* linesOf(path: string): AsyncGenerator<Row> {
    const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
    for await (const line of lines) if (line !== "") yield JSON.parse(line) as Row;
}

/** Writes the CSV; returns how many text cells were escaped so Excel would not run them as formulas. */
async function writeCsv(from: string, to: FileHandle, columns: string[]): Promise<number> {
    const out = buffered(to);
    let escaped = 0;
    const cell = (value: unknown): string => {
        if (typeof value === "string" && FORMULA_START.test(value)) escaped += 1;
        return csvCell(value);
    };
    try {
        await out.write(columns.map(csvCell).join(",") + "\r\n");
        for await (const row of linesOf(from)) await out.write(columns.map((c) => cell(row[c])).join(",") + "\r\n");
    } finally {
        await out.close();
    }
    return escaped;
}

async function writeXlsx(from: string, to: FileHandle, columns: string[]): Promise<void> {
    const stream = to.createWriteStream();
    // A stream error is an event, not a rejection: turn it into one so it cannot take the server down.
    const failed = new Promise<never>((_, fail) => stream.on("error", fail));
    failed.catch(() => undefined);
    const book = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true, useSharedStrings: false });
    const build = async (): Promise<void> => {
        const sheet = book.addWorksheet("Export", { views: [{ state: "frozen", ySplit: 1 }] });
        sheet.columns = columns.map((c) => ({ header: c, key: c, width: Math.min(40, Math.max(10, c.length + 2)) }));
        sheet.getRow(1).font = { bold: true };
        sheet.getRow(1).commit();
        for await (const row of linesOf(from)) {
            // Excel cells hold at most 32,767 characters.
            sheet.addRow(columns.map((c) => (typeof row[c] === "string" ? (row[c] as string).slice(0, 32_767) : (row[c] ?? null)))).commit();
        }
        sheet.commit();
        await book.commit();
    };
    try {
        await Promise.race([build(), failed]);
    } finally {
        if (!stream.destroyed) stream.destroy();
    }
}

function clip(row: Row): Row {
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "string" && v.length > SAMPLE_CELL ? `${v.slice(0, SAMPLE_CELL)}…` : v]));
}

/** One row per child of `field`, the child's fields under `field.`; a record with no children keeps one row. */
export function explodeRow(record: Row, field: string): Row[] {
    const children = record[field];
    if (!Array.isArray(children)) return [record];
    const { [field]: _, ...parent } = record;
    return children.length === 0 ? [parent] : children.map((child) => ({ ...parent, [field]: child }));
}

/**
 * Runs the export. `company` is already resolved against the allowlist and `entity` is already
 * a validated collection path; this only reads.
 */
export async function runExport(company: string, options: ExportOptions): Promise<ExportSummary> {
    const started = Date.now();
    const format = options.format ?? "csv";
    const pageSize = options.pageSize ?? defaultPageSize(options.expand);
    const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    const rowLimit = format === "xlsx" ? Math.min(maxRows, XLSX_MAX_ROWS) : maxRows;
    const entity = options.entity;
    const explode = options.explode;

    // AUTOID is read with every row so a row that shifts between pages is written once, and so
    // pages can be read in a fixed order.
    const asked = options.select.split(",").map((name) => name.trim()).filter(Boolean);
    const select = asked.includes("AUTOID") ? asked.join(",") : ["AUTOID", ...asked].join(",");
    let ordered = options.orderby === undefined;
    const params = (withOrder: boolean, skip: number): string => {
        const query = new URLSearchParams();
        if (options.filter) query.set("$filter", options.filter);
        query.set("$select", select);
        if (options.expand) query.set("$expand", options.expand);
        if (options.orderby) query.set("$orderby", options.orderby);
        else if (withOrder) query.set("$orderby", "AUTOID");
        query.set("$top", String(pageSize));
        query.set("$skip", String(skip));
        query.set("$count", "true");
        return `${entity}?${query.toString()}`;
    };

    const folder = exportDir(options.folder);
    if (options.folder?.trim()) {
        // Only the usual folder is created; a folder the caller names must already be there.
        const found = await stat(folder).catch(() => null);
        if (!found?.isDirectory()) throw new Error(`folder ${folder} does not exist. Name an existing folder, or leave folder out to use ${exportDir()}.`);
    } else {
        await mkdir(folder, { recursive: true });
    }
    const { path, final, temp, tempOut } = await reserve(folder, exportName(company, entity, format, options.filename));

    const columns: string[] = [];
    const known = new Set<string>();
    const numeric = new Map<string, NumericSummary>();
    const notNumeric = new Set<string>();
    const empty = new Map<string, number>();
    const arrays = new Set<string>();
    const sample: Row[] = [];
    const seen = new Set<string>();
    const notes: string[] = [];
    let rows = 0;
    let records = 0;
    let exploded = false;
    let fetched = 0;
    let total: number | null = null;
    let pages = 0;

    try {
        for (;;) {
            if (pages >= PAGE_CAP) throw new Error(`The export did not finish after ${PAGE_CAP} pages (${rows} rows). Narrow it with a filter.`);
            let response;
            try {
                response = await request(company, "GET", params(ordered, fetched));
            } catch (error) {
                // Only the first page may fall back to the server's own order: switching part-way would scramble the pages.
                const refusedOrder = ordered && pages === 0 && error instanceof EbmsError && error.status >= 400 && error.status < 500;
                if (!refusedOrder) throw error;
                ordered = false;
                response = await request(company, "GET", params(false, fetched));
            }
            pages += 1;
            const body = response.body as { value?: Row[]; "@odata.count"?: number } | null;
            const batch = Array.isArray(body?.value) ? body.value : [];
            if (typeof body?.["@odata.count"] === "number") total = body["@odata.count"];
            if (pages === 1 && total !== null && total > rowLimit) {
                throw new Error(rowLimit < maxRows
                    ? `${entity} has ${total} rows matching this filter, more than an Excel sheet holds (${XLSX_MAX_ROWS}). Use format csv or jsonl, or narrow the filter and export in parts.`
                    : `${entity} has ${total} rows matching this filter, more than maxRows (${maxRows}). Narrow the filter (by date, folder or status) and export in parts, or raise maxRows.`);
            }
            fetched += batch.length;
            let fresh = 0;
            for (const record of batch) {
                const key = typeof record["AUTOID"] === "string" ? record["AUTOID"] : null;
                if (key !== null && seen.has(key)) continue;
                if (key !== null) seen.add(key);
                fresh += 1;
                records += 1;
                if (explode && Array.isArray(record[explode])) exploded = true;
                const parts = explode ? explodeRow(record, explode) : [record];
                for (const [index, one] of parts.entries()) {
                    const flat = flatten(one);
                    for (const name of flat.arrays) arrays.add(name);
                    for (const [name, value] of Object.entries(flat.row)) {
                        if (!known.has(name)) {
                            known.add(name);
                            columns.push(name);
                        }
                        // The parent's fields repeat on every child row; count them once per record.
                        if (index > 0 && explode && !name.startsWith(`${explode}.`)) continue;
                        if (value === null || value === undefined || value === "") {
                            empty.set(name, (empty.get(name) ?? 0) + 1);
                        } else if (typeof value === "number" && Number.isFinite(value)) {
                            const s = numeric.get(name);
                            if (s) {
                                s.min = Math.min(s.min, value);
                                s.max = Math.max(s.max, value);
                                s.sum += value;
                                s.count += 1;
                            } else {
                                numeric.set(name, { min: value, max: value, sum: value, count: 1 });
                            }
                        } else {
                            notNumeric.add(name);
                        }
                    }
                    if (sample.length < SAMPLE_ROWS) sample.push(clip(flat.row));
                    // JSONL keeps the record's own shape; CSV and Excel are built from the flat row.
                    await tempOut.write(JSON.stringify(format === "jsonl" ? withoutAnnotations(one) : flat.row) + "\n");
                    rows += 1;
                    if (rows > rowLimit) {
                        throw new Error(rowLimit < maxRows
                            ? `The export passed ${XLSX_MAX_ROWS} rows, the most an Excel sheet holds. Use format csv or jsonl, or narrow the filter and export in parts.`
                            : `The export passed maxRows (${maxRows}). Narrow the filter and export in parts, or raise maxRows.`);
                    }
                }
            }
            if (batch.length === 0) break;
            // Every row on this page was already read: EBMS is ignoring $skip, and the loop would never end.
            if (fresh === 0) throw new Error(`EBMS sent the same ${batch.length} rows again at skip ${fetched - batch.length}; it does not seem to page this query. Narrow it with a filter so it fits one page.`);
            // Without a count, a short page may only be the server's own page limit: stop on an empty page.
            if (total !== null && fetched >= total) break;
        }
        await tempOut.close();
        if (total !== null && records < total) {
            throw new Error(`The export read ${records} distinct records but EBMS counted ${total}; the data changed while it was being read. Run it again.`);
        }

        // Columns in the order they were selected, then anything an expand added, in the order first seen.
        const order = rows === 0 ? asked : [...asked.filter((name) => known.has(name)), ...columns.filter((name) => !asked.includes(name))];
        let escaped = 0;
        if (format === "jsonl") {
            await final.close();
            await rename(temp, path);
        } else {
            if (format === "csv") escaped = await writeCsv(temp, final, order);
            else await writeXlsx(temp, final, order);
            await rm(temp, { force: true });
        }

        if (!asked.includes("AUTOID")) notes.push("AUTOID was added to every row so the pages could be read without gaps or repeats.");
        if (!ordered && options.orderby === undefined) notes.push(`${entity} would not sort by AUTOID, so it was read in the server's own order; repeats were still removed by AUTOID.`);
        if (arrays.size > 0 && format !== "jsonl") notes.push(`Expanded collections (${[...arrays].join(", ")}) are JSON text in one cell each. For one row per line, pass explode with the collection's name (e.g. Details).`);
        if (options.explode && !exploded && records > 0) notes.push(`No ${options.explode} collection came back on any record; check that expand names it.`);
        if (rows === 0) notes.push("No rows matched; the file has a header only.");
        if (total === null) notes.push("EBMS did not report a count, so the export read until a page came back empty.");
        if (exploded) notes.push(`The parent's columns repeat on every ${explode} row; their numeric and empty figures count each record once.`);
        if (escaped > 0) notes.push(`${escaped} text cells began with =, +, -, @ or a tab and were prefixed with ' so Excel shows them instead of running them as formulas; strip the leading ' in a script if it matters.`);

        const numericColumns = Object.fromEntries(
            [...numeric]
                .filter(([name]) => !notNumeric.has(name))
                .map(([name, s]) => [name, { min: s.min, max: s.max, sum: Math.round(s.sum * 10_000) / 10_000, count: s.count }]),
        );
        return { path, format, rows, records, columns: order, sample, numeric: numericColumns, empty: Object.fromEntries(empty), pages, ordered: ordered || options.orderby !== undefined, notes, ms: Date.now() - started };
    } catch (error) {
        await tempOut.close().catch(() => undefined);
        await final.close().catch(() => undefined);
        await rm(temp, { force: true });
        await rm(path, { force: true });
        if (error instanceof Error) error.message = `${error.message} (no file was kept; ${rows} rows had been read in ${pages} pages)`;
        throw error;
    }
}
