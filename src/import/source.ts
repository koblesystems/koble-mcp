/**
 * Opens the file an import reads: a CSV (by path or as text) or one sheet of an Excel workbook.
 * Every row keeps the number a person sees in their spreadsheet, so a message about "Row 9"
 * points at row 9. An exceptions workbook this tool wrote is accepted back: its Row column
 * carries the original row numbers and its Row, Problem and Fix columns are not data.
 */
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import ExcelJS from "exceljs";
import { parseCsvRecords } from "../mrp/csv.js";
import { cellText } from "../mrp/workbook.js";

/** Columns the exceptions workbook adds; never mapped to a field. */
export const EXCEPTION_COLUMNS = ["Row", "Problem", "Fix"] as const;
export const EXCEPTIONS_SHEET = "Fix these";
export const ABOUT_SHEET = "About";

export interface SourceRow {
    /** The row number in the original file. */
    row: number;
    /** Header -> cell text, trimmed. */
    cells: Record<string, string>;
    blank: boolean;
}

export interface Source {
    /** File name, or "pasted CSV". */
    name: string;
    path: string | null;
    sheet: string | null;
    headers: string[];
    rows: SourceRow[];
    /** Set when the file is an exceptions workbook from an earlier review. */
    fromExceptions: { importId: string; entity: string } | null;
    fatal: string[];
    notes: string[];
}

const empty = (name: string, path: string | null, fatal: string): Source => ({ name, path, sheet: null, headers: [], rows: [], fromExceptions: null, fatal: [fatal], notes: [] });

/** A leading apostrophe a spreadsheet uses to keep "=…" as text is not part of the value. */
const unguard = (value: string): string => value.trim().replace(/^'(?=[=+\-@])/, "");

function fromTable(name: string, path: string | null, sheet: string | null, table: string[][], firstRow: number, fromExceptions: Source["fromExceptions"]): Source {
    const at = table.findIndex((record) => record.some((value) => value.trim() !== ""));
    if (at < 0) return empty(name, path, `${name} is empty: there is no header row.`);
    const header = table[at] ?? [];
    const headers = header.map((h) => h.trim());
    if (headers.filter(Boolean).length === 1 && (headers.find(Boolean) ?? "").includes(";")) {
        return empty(name, path, `${name} is separated by semicolons, which is how some spreadsheet settings save CSV. Save it again as comma-separated CSV (in Excel: "CSV UTF-8 (comma delimited)"), or as .xlsx.`);
    }
    const seen = new Set<string>();
    const repeated = headers.filter((h) => h && (seen.has(h.toLowerCase()) || !seen.add(h.toLowerCase())));
    const rowColumn = fromExceptions ? headers.indexOf("Row") : -1;
    const rows: SourceRow[] = [];
    for (let i = at + 1; i < table.length; i += 1) {
        const record = table[i] ?? [];
        const cells: Record<string, string> = {};
        headers.forEach((h, c) => { if (h && cells[h] === undefined) cells[h] = unguard(record[c] ?? ""); });
        const original = rowColumn >= 0 ? Number.parseInt(record[rowColumn] ?? "", 10) : NaN;
        const dataCells = Object.entries(cells).filter(([h]) => !fromExceptions || !(EXCEPTION_COLUMNS as readonly string[]).includes(h));
        rows.push({ row: Number.isFinite(original) ? original : i + firstRow, cells, blank: dataCells.every(([, v]) => v === "") });
    }
    // Trailing blank rows are the end of the sheet, not rows anyone left blank.
    while (rows.length > 0 && rows[rows.length - 1]?.blank) rows.pop();
    const fatal = [
        ...(repeated.length > 0 ? [`The header row names ${[...new Set(repeated)].map((h) => `"${h}"`).join(", ")} more than once. Rename one of each.`] : []),
        ...(rows.every((r) => r.blank) ? [`${name} has a header row but no rows.`] : []),
    ];
    return { name, path, sheet, headers: headers.filter((h) => h && !(fromExceptions && (EXCEPTION_COLUMNS as readonly string[]).includes(h))), rows, fromExceptions, fatal, notes: [] };
}

/** A CSV's text. Record n of the text is row n + 1 in a spreadsheet. */
export function readCsvText(text: string, name = "pasted CSV", path: string | null = null): Source {
    return fromTable(name, path, null, parseCsvRecords(text), 1, null);
}

async function readXlsx(path: string, wanted: string | undefined): Promise<Source> {
    const name = basename(path);
    const book = new ExcelJS.Workbook();
    try {
        await book.xlsx.load((await readFile(path)) as unknown as ArrayBuffer);
    } catch {
        return empty(name, path, `${name} could not be opened as an Excel workbook (.xlsx). Save it from Excel or Google Sheets as .xlsx, or as CSV, and try again.`);
    }
    let fromExceptions: Source["fromExceptions"] = null;
    const about = book.getWorksheet(ABOUT_SHEET);
    if (about && book.getWorksheet(EXCEPTIONS_SHEET)) {
        const facts = new Map<string, string>();
        about.eachRow((row) => facts.set(cellText(row.getCell(1).value).trim(), cellText(row.getCell(2).value).trim()));
        const importId = facts.get("Import ID") ?? "";
        if (importId) fromExceptions = { importId, entity: facts.get("Entity") ?? "" };
    }
    const sheets = book.worksheets.filter((s) => s.name !== ABOUT_SHEET || !fromExceptions);
    const sheet = wanted ? book.getWorksheet(wanted) : fromExceptions ? book.getWorksheet(EXCEPTIONS_SHEET) : sheets[0];
    if (!sheet) {
        return empty(name, path, wanted ? `${name} has no sheet named "${wanted}". Its sheets: ${book.worksheets.map((s) => `"${s.name}"`).join(", ")}.` : `${name} has no sheets.`);
    }
    const table: string[][] = [];
    for (let r = 1; r <= sheet.rowCount; r += 1) {
        const row = sheet.getRow(r);
        const values: string[] = [];
        for (let c = 1; c <= Math.max(sheet.columnCount, row.cellCount); c += 1) values.push(cellText(row.getCell(c).value));
        table.push(values);
    }
    const source = fromTable(name, path, sheet.name, table, 1, fromExceptions);
    if (!wanted && sheets.length > 1 && !fromExceptions) source.notes.push(`${name} has ${sheets.length} sheets; the first, "${sheet.name}", was read. Pass sheet to read another.`);
    return source;
}

/** The file to import, from a path (.csv or .xlsx) or CSV text. */
export async function openSource(args: { path?: string | undefined; csv?: string | undefined; sheet?: string | undefined }): Promise<Source> {
    if (args.path) {
        const path = resolve(args.path);
        if (/\.xlsx$/i.test(path)) return readXlsx(path, args.sheet);
        if (/\.xls$/i.test(path)) return empty(basename(path), path, `${basename(path)} is an old-style Excel file (.xls). Save it as .xlsx or as CSV and try again.`);
        let text: string;
        try {
            text = await readFile(path, "utf8");
        } catch (error) {
            return empty(basename(path), path, `${basename(path)} could not be opened (${error instanceof Error ? error.message : String(error)}).`);
        }
        return readCsvText(text, basename(path), path);
    }
    return readCsvText(args.csv ?? "");
}
