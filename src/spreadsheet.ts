/**
 * Reading a spreadsheet someone hands over, for import and for the MRP worksheet: which files may
 * be read at all, text decoded whatever Excel saved it as, workbooks loaded, cells as the text a
 * person sees, and CSV records.
 *
 * Paths come from the model, and a document can steer a model, so a path is never trusted: only
 * spreadsheet extensions, nothing in koble's own settings, ~/.ssh, ~/.aws or any hidden folder in
 * the home folder, no dotfiles, nothing over 20 MB. Credentials never leave the process.
 */
import { realpathSync } from "node:fs";
import { realpath, stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ExcelJS from "exceljs";
import { configDir } from "./cli/store.js";

export const MAX_BYTES = 20 * 1024 * 1024;
const READABLE = new Set([".csv", ".tsv", ".txt", ".xlsx"]);

const inside = (folder: string, path: string): boolean => {
    const rel = relative(folder, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const same = (path: string): string => (process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path);
/**
 * A path as given and as it really is, so a real path is compared with a real path. The native
 * realpath also expands Windows 8.3 short names (C:\Users\RUNNER~1), which the JavaScript one
 * leaves as they are.
 */
const forms = (path: string): string[] => {
    let real = resolve(path);
    try { real = realpathSync.native(path); } catch { /* not there yet */ }
    return [...new Set([same(resolve(path)), same(real)])];
};

/** Why koble will not read or write here, or null. The folders that hold secrets, and every dotfile. */
export function privatePlace(path: string): string | null {
    if (basename(resolve(path)).startsWith(".")) return "it is a hidden file";
    // A file not written yet is judged by its folder's real path.
    const fulls = [...new Set([...forms(path), ...forms(dirname(path)).map((folder) => join(folder, same(basename(resolve(path)))))])];
    const configs = forms(configDir());
    const homes = forms(homedir());
    for (const full of fulls) {
        if (configs.some((config) => inside(config, full))) return "it is in koble's own settings folder";
        for (const home of homes) {
            const first = inside(home, full) ? relative(home, full).split(sep)[0] ?? "" : "";
            if (first.startsWith(".")) return `it is in a hidden folder (~${sep}${first})`;
        }
    }
    return null;
}

export type Opened = { ok: true; path: string; name: string; data: Buffer } | { ok: false; path: string; name: string; why: string };

/** A spreadsheet's bytes, or why it was not read. Never echoes anything from inside the file. */
export async function openSpreadsheet(given: string): Promise<Opened> {
    const path = resolve(given);
    const name = basename(path);
    const no = (why: string): Opened => ({ ok: false, path, name, why });
    if (!READABLE.has(extname(path).toLowerCase())) return no(`${name} is not read: only .csv, .tsv, .txt and .xlsx files are. Save it as one of those and try again.`);
    let real: string;
    try {
        real = await realpath(path);
    } catch (error) {
        return no(`${name} could not be opened (${(error as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : (error as NodeJS.ErrnoException).code ?? "unreadable"}).`);
    }
    // The link and what it points at: a products.csv that is really ~/.ssh/id_rsa is refused.
    const why = privatePlace(path) ?? privatePlace(real);
    if (why) return no(`${name} is not read: ${why}. Copy the spreadsheet to an ordinary folder, such as Documents, and give that path.`);
    if (!READABLE.has(extname(real).toLowerCase())) return no(`${name} is not read: it links to a file that is not a spreadsheet.`);
    const info = await stat(real);
    if (!info.isFile()) return no(`${name} is not a file.`);
    if (info.size > MAX_BYTES) return no(`${name} is ${Math.round(info.size / 1024 / 1024)} MB; files over ${MAX_BYTES / 1024 / 1024} MB are not read. Split it into smaller files.`);
    return { ok: true, path, name, data: await readFile(real) };
}

/**
 * Text as it was saved: UTF-8 (with or without a byte-order mark), UTF-16 ("Unicode Text" from
 * Excel), or else Windows-1252, which is what Excel for Windows writes as "CSV (Comma delimited)".
 * The last is a guess the caller says out loud.
 */
export function decodeText(data: Uint8Array, name: string): { text: string; note?: string } {
    const utf16 = (encoding: "utf-16le" | "utf-16be") => ({ text: new TextDecoder(encoding).decode(data) });
    if (data[0] === 0xff && data[1] === 0xfe) return utf16("utf-16le");
    if (data[0] === 0xfe && data[1] === 0xff) return utf16("utf-16be");
    // No mark, but every other byte is zero: UTF-16 text of plain letters.
    if (data.length >= 4 && data[1] === 0 && data[3] === 0 && data[0] !== 0) return utf16("utf-16le");
    if (data.length >= 4 && data[0] === 0 && data[2] === 0 && data[1] !== 0) return utf16("utf-16be");
    try {
        return { text: new TextDecoder("utf-8", { fatal: true }).decode(data) };
    } catch {
        return { text: new TextDecoder("windows-1252").decode(data), note: `${name} is not UTF-8 text, so it was read as Windows (Western European) text, which is what Excel's "CSV (Comma delimited)" writes. Check names with accents in the drafts; to be sure, save it as "CSV UTF-8" or .xlsx.` };
    }
}

/** A workbook, or null when the bytes are not one. */
export async function loadWorkbook(data: Buffer): Promise<ExcelJS.Workbook | null> {
    const book = new ExcelJS.Workbook();
    try {
        await book.xlsx.load(data as unknown as ArrayBuffer);
        return book;
    } catch {
        return null;
    }
}

/** A number written out in full: never 1.23456789012e+21 or 1e-7. */
const plain = (n: number): string => (/e/i.test(String(n)) ? n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 100 }) : String(n));

/** A number as its format shows it, where that changes what it means: 6% (not 0.06), 00123 (not 123). */
function formatted(n: number, numFmt: string | undefined): string {
    const format = (numFmt ?? "").split(";")[0]?.replace(/"[^"]*"|\\./g, "") ?? "";
    if (format.includes("%")) return `${plain(Number((n * 100).toPrecision(12)))}%`;
    if (/^0+$/.test(format) && Number.isInteger(n) && n >= 0) return plain(n).padStart(format.length, "0");
    return plain(n);
}

/**
 * A cell as text, the way a person reads it: dates as YYYY-MM-DD, formulas as their result, rich
 * text and links as their text, percentages and zero-padded numbers as formatted.
 */
export function cellText(value: ExcelJS.CellValue, numFmt?: string): string {
    if (value === null || value === undefined) return "";
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === "number") return formatted(value, numFmt);
    if (typeof value === "object") {
        if ("result" in value) return cellText((value as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue, numFmt);
        if ("richText" in value) return (value as ExcelJS.CellRichTextValue).richText.map((part) => part.text).join("");
        // A link's text may itself be rich text.
        if ("text" in value) return cellText((value as ExcelJS.CellHyperlinkValue).text as ExcelJS.CellValue);
        return "";
    }
    return String(value);
}

/** The byte-order mark Excel needs to read UTF-8. Written as a code so no invisible character sits in the source. */
export const BOM = String.fromCharCode(0xfeff);

/**
 * RFC 4180 parsing: quoted fields, doubled quotes, delimiters and line breaks inside quotes. Every
 * record is kept, blank ones too, so record n is row n + 1 of the file as a spreadsheet shows it.
 * A quote opens a quoted field only at the field's start; anywhere else (3/4" bolt) it is a
 * character of the value, and `stray` hears of it so the caller can say so.
 */
export function parseCsvRecords(text: string, delimiter = ",", stray?: (record: number, field: number) => void): string[][] {
    const records: string[][] = [];
    let field = "";
    let record: string[] = [];
    let quoted = false;
    let wasQuoted = false;
    const source = text.startsWith(BOM) ? text.slice(1) : text;
    const end = (): void => { record.push(field); field = ""; wasQuoted = false; };
    for (let i = 0; i < source.length; i += 1) {
        const ch = source[i] as string;
        if (quoted) {
            if (ch === '"' && source[i + 1] === '"') { field += '"'; i += 1; }
            else if (ch === '"') quoted = false;
            else field += ch;
        } else if (ch === '"' && field === "" && !wasQuoted) { quoted = true; wasQuoted = true; }
        else if (ch === delimiter) end();
        else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && source[i + 1] === "\n") i += 1;
            end();
            records.push(record);
            record = [];
        } else {
            if (ch === '"') stray?.(records.length, record.length);
            field += ch;
        }
    }
    if (field !== "" || record.length > 0) { end(); records.push(record); }
    return records;
}
