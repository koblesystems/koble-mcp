/**
 * Opens the file an import reads: a CSV (by path or as text) or one sheet of an Excel workbook.
 * Every row keeps the number a person sees in their spreadsheet, so a message about "Row 9"
 * points at row 9. An exceptions workbook this tool wrote is accepted back: its ⚑ Row column
 * carries the original row numbers and its ⚑ columns are not data.
 */
import { basename } from "node:path";
import type ExcelJS from "exceljs";
import { cellText, decodeText, loadWorkbook, openSpreadsheet, parseCsvRecords } from "../spreadsheet.js";

/** Columns the exceptions workbook adds; never mapped to a field. Marked so no file's own column has the same name. */
export const EXCEPTION_COLUMNS = { row: "⚑ Row", problem: "⚑ Problem", fix: "⚑ Fix" } as const;
/** What exceptions files written before the ⚑ called them. */
const OLD_EXCEPTION_COLUMNS = { row: "Row", problem: "Problem", fix: "Fix" } as const;
export const EXCEPTIONS_SHEET = "Fix these";
export const ABOUT_SHEET = "About";

export interface SourceRow {
    /** The row number in the original file. */
    row: number;
    /** Header -> cell text, trimmed. */
    cells: Record<string, string>;
    /** Header -> what is wrong with a cell that has no usable value: an Excel error or a formula never calculated. */
    errors?: Record<string, string>;
    /** Header (or "*" for the whole row) -> why the CSV could not be read cleanly there: the row is not safe to import as read. */
    flags?: Record<string, string>;
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
    fromExceptions: { importId: string; entity: string; company: string; lastRow: number } | null;
    fatal: string[];
    notes: string[];
}

interface Table {
    values: string[][];
    /** Per cell, as values: an Excel error. */
    errors?: Array<Array<string | undefined>>;
    /** Per cell, as values ("*" in column -1 for the row): why the text could not be read cleanly. */
    flags?: Map<number, Record<number, string>>;
}

const empty = (name: string, path: string | null, fatal: string): Source => ({ name, path, sheet: null, headers: [], rows: [], fromExceptions: null, fatal: [fatal], notes: [] });

/** A leading apostrophe a spreadsheet uses to keep "=…" as text is not part of the value. */
const unguard = (value: string): string => value.trim().replace(/^'(?=[=+\-@])/, "");
const filled = (record: readonly string[] | undefined): number => (record ?? []).filter((value) => value.trim() !== "").length;

/** The header row's index, past a title above it ("Price list 2026", often merged across the columns): one cell, then a row of several. */
function headerAt(values: readonly string[][]): { at: number; title?: number } {
    const at = values.findIndex((record) => filled(record) > 0);
    const next = values.findIndex((record, i) => i > at && filled(record) > 0);
    return at >= 0 && filled(values[at]) === 1 && next > at && filled(values[next]) > 1 ? { at: next, title: at } : { at };
}

function fromTable(name: string, path: string | null, sheet: string | null, table: Table, fromExceptions: Source["fromExceptions"]): Source {
    const { values } = table;
    const notes: string[] = [];
    const { at, title } = headerAt(values);
    if (at < 0) return empty(name, path, `${name} is empty: there is no header row.`);
    if (title !== undefined) notes.push(`Row ${title + 1} ("${(values[title] ?? []).find((v) => v.trim())?.trim()}") reads as a title, not column headers; the headers were taken from row ${at + 1}.`);
    const headers = (values[at] ?? []).map((h) => h.trim());
    if (headers.filter(Boolean).length === 1 && (headers.find(Boolean) ?? "").includes(";")) {
        return empty(name, path, `${name} is separated by semicolons, which is how some spreadsheet settings save CSV. Save it again as comma-separated CSV (in Excel: "CSV UTF-8 (comma delimited)"), or as .xlsx.`);
    }
    const marks = fromExceptions ? (headers.includes(EXCEPTION_COLUMNS.row) ? EXCEPTION_COLUMNS : OLD_EXCEPTION_COLUMNS) : null;
    const ours = new Set<string>(marks ? Object.values(marks) : []);
    const seen = new Set<string>();
    const repeated = headers.filter((h) => h && (seen.has(h.toLowerCase()) || !seen.add(h.toLowerCase())));
    const rowColumn = marks ? headers.indexOf(marks.row) : -1;
    // A row a person added to an exceptions file has no row number: it is numbered past every row of the original.
    let added = fromExceptions?.lastRow ?? 0;
    let addedCount = 0;
    const rows: SourceRow[] = [];
    for (let i = at + 1; i < values.length; i += 1) {
        const record = values[i] ?? [];
        const cells: Record<string, string> = {};
        const errors: Record<string, string> = {};
        const flags: Record<string, string> = {};
        headers.forEach((h, c) => {
            if (!h || cells[h] !== undefined) return;
            cells[h] = unguard(record[c] ?? "");
            const error = table.errors?.[i]?.[c];
            if (error) errors[h] = error;
            const flag = table.flags?.get(i)?.[c];
            if (flag) flags[h] = flag;
        });
        const rowFlag = table.flags?.get(i)?.[-1];
        if (rowFlag) flags["*"] = rowFlag;
        const blank = Object.entries(cells).every(([h, v]) => v === "" || ours.has(h)) && Object.keys(errors).length === 0;
        const original = rowColumn >= 0 ? Number.parseInt(record[rowColumn] ?? "", 10) : NaN;
        let row = i + 1;
        if (fromExceptions) {
            if (Number.isFinite(original)) row = original;
            else if (!blank) { added += 1; addedCount += 1; row = added; }
        }
        rows.push({ row, cells, ...(Object.keys(errors).length > 0 ? { errors } : {}), ...(Object.keys(flags).length > 0 ? { flags } : {}), blank });
    }
    // Trailing blank rows are the end of the sheet, not rows anyone left blank.
    while (rows.length > 0 && rows[rows.length - 1]?.blank) rows.pop();
    if (addedCount > 0) notes.push(`${addedCount} row(s) were added to the exceptions file; they are numbered from row ${added - addedCount + 1}, after the last row of the original file.`);
    const fatal = [
        ...(repeated.length > 0 ? [`The header row names ${[...new Set(repeated)].map((h) => `"${h}"`).join(", ")} more than once. Rename one of each.`] : []),
        ...(rows.every((r) => r.blank) ? [`${name} has a header row but no rows.`] : []),
    ];
    return { name, path, sheet, headers: headers.filter((h) => h && !ours.has(h)), rows, fromExceptions, fatal, notes };
}

/**
 * A CSV's text, comma- or tab-separated (tabs are what a paste from a spreadsheet carries).
 * Record n of the text is row n + 1 in a spreadsheet.
 */
export function readCsvText(text: string, name = "pasted CSV", path: string | null = null, delimiter?: string): Source {
    const firstLine = /^[^\r\n]*/.exec(text.replace(/^\s+/, ""))?.[0] ?? "";
    const separator = delimiter ?? ((firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? "\t" : ",");
    const strays: Array<[number, number]> = [];
    const values = parseCsvRecords(text, separator, (record, field) => strays.push([record, field]));
    const flags = new Map<number, Record<number, string>>();
    const flag = (record: number, field: number, why: string): void => { flags.set(record, { ...(flags.get(record) ?? {}), [field]: why }); };
    const inches = new Set<number>();
    for (const [record, field] of strays) {
        // ` "B, C"`: a space before the opening quote, so the quote did not open and the comma split the value.
        if ((values[record]?.[field] ?? "").trimStart().startsWith('"')) flag(record, field, "a space comes before the cell's opening quote, so a comma inside it split the row; put the quote first");
        else inches.add(record + 1);
    }
    const width = values[headerAt(values).at]?.length ?? 0;
    values.forEach((record, r) => {
        if (width > 0 && record.slice(width).some((value) => value.trim() !== "")) flag(r, -1, "the row has more cells than the header row has columns (a comma inside a value that is not in quotes?); the extra cells would be lost");
    });
    const source = fromTable(name, path, null, { values, flags }, null);
    if (inches.size > 0) source.notes.push(`${plural(inches.size, "Row", "Rows")} ${[...inches].slice(0, 10).join(", ")}${inches.size > 10 ? "…" : ""} ${plural(inches.size, "has", "have")} a " inside a cell that is not in quotes; it was kept as part of the value (as in 3/4" bolt).`);
    return source;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * A cell with no usable value that would otherwise read as blank: an Excel error (#DIV/0!, #N/A)
 * or a formula whose result was never calculated and saved (a file written by a program, not Excel).
 */
function cellError(value: ExcelJS.CellValue): string | undefined {
    if (!value || typeof value !== "object" || value instanceof Date) return undefined;
    if ("error" in value) return String((value as ExcelJS.CellErrorValue).error);
    if ("formula" in value || "sharedFormula" in value) {
        const result = (value as ExcelJS.CellFormulaValue).result as unknown;
        if (result === undefined || result === null) return "a formula with no saved result";
        if (typeof result === "object" && result !== null && "error" in result) return String((result as { error: unknown }).error);
    }
    return undefined;
}

async function readXlsx(file: { name: string; path: string; data: Buffer }, wanted: string | undefined): Promise<Source> {
    const { name, path } = file;
    const book = await loadWorkbook(file.data);
    if (!book) return empty(name, path, `${name} could not be opened as an Excel workbook (.xlsx). Save it from Excel or Google Sheets as .xlsx, or as CSV, and try again.`);
    let fromExceptions: Source["fromExceptions"] = null;
    const about = book.getWorksheet(ABOUT_SHEET);
    if (about && book.getWorksheet(EXCEPTIONS_SHEET)) {
        const facts = new Map<string, string>();
        about.eachRow((row) => facts.set(cellText(row.getCell(1).value).trim(), cellText(row.getCell(2).value).trim()));
        const importId = facts.get("Import ID") ?? "";
        if (importId) fromExceptions = { importId, entity: facts.get("Entity") ?? "", company: facts.get("Company") ?? "", lastRow: Number.parseInt(facts.get("Last row") ?? "", 10) || 0 };
    }
    // Hidden sheets are not what a person means by "the first sheet".
    const sheets = book.worksheets.filter((s) => s.state === "visible" && (s.name !== ABOUT_SHEET || !fromExceptions));
    const sheet = wanted ? book.getWorksheet(wanted) : fromExceptions ? book.getWorksheet(EXCEPTIONS_SHEET) : sheets[0];
    if (!sheet) {
        return empty(name, path, wanted ? `${name} has no sheet named "${wanted}". Its sheets: ${book.worksheets.map((s) => `"${s.name}"`).join(", ")}.` : `${name} has no sheets.`);
    }
    const values: string[][] = [];
    const errors: Array<Array<string | undefined>> = [];
    for (let r = 1; r <= sheet.rowCount; r += 1) {
        const row = sheet.getRow(r);
        const texts: string[] = [];
        const rowErrors: Array<string | undefined> = [];
        for (let c = 1; c <= Math.max(sheet.columnCount, row.cellCount); c += 1) {
            const cell = row.getCell(c);
            // A cell merged into the one to its left is part of that cell, not a copy of its value.
            if (cell.isMerged && cell.master.row === cell.row && cell.master.col !== cell.col) { texts.push(""); rowErrors.push(undefined); continue; }
            const error = cellError(cell.value);
            texts.push(error ? error : cellText(cell.value, cell.numFmt));
            rowErrors.push(error);
        }
        values.push(texts);
        errors.push(rowErrors);
    }
    // The About sheet's last row, else the highest row number the file carries.
    if (fromExceptions && !fromExceptions.lastRow) {
        const column = (values[0] ?? []).findIndex((h) => h.trim() === EXCEPTION_COLUMNS.row || h.trim() === OLD_EXCEPTION_COLUMNS.row);
        fromExceptions.lastRow = Math.max(0, ...values.slice(1).map((record) => Number.parseInt(record[column] ?? "", 10) || 0));
    }
    const source = fromTable(name, path, sheet.name, { values, errors }, fromExceptions);
    if (!wanted && sheets.length > 1 && !fromExceptions) source.notes.push(`${name} has ${sheets.length} sheets; the first, "${sheet.name}", was read. Pass sheet to read another.`);
    if (!wanted && book.worksheets[0] !== sheet && !fromExceptions) source.notes.push(`Hidden sheets were passed over; "${sheet.name}" was read.`);
    return source;
}

/** The file to import, from a path (.csv, .tsv, .txt or .xlsx) or CSV text. */
export async function openSource(args: { path?: string | undefined; csv?: string | undefined; sheet?: string | undefined }): Promise<Source> {
    if (!args.path) return readCsvText(args.csv ?? "");
    if (/\.xls$/i.test(args.path)) return empty(basename(args.path), args.path, `${basename(args.path)} is an old-style Excel file (.xls). Save it as .xlsx or as CSV and try again.`);
    const file = await openSpreadsheet(args.path);
    if (!file.ok) return empty(file.name, file.path, file.why);
    if (/\.xlsx$/i.test(file.path)) return readXlsx(file, args.sheet);
    const decoded = decodeText(file.data, file.name);
    const source = readCsvText(decoded.text, file.name, file.path, /\.tsv$/i.test(file.path) ? "\t" : undefined);
    if (decoded.note) source.notes.push(decoded.note);
    return source;
}
