/**
 * The exceptions workbook: only the rows that need a person, each with its original columns as
 * they were, the row number it had in the file, what is wrong, and an empty Fix column for
 * notes. It can be corrected and handed straight back to import_from_csv, which reads the
 * About sheet to continue the same import and ignores the Row, Problem and Fix columns.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import ExcelJS from "exceljs";
import { outputDir } from "../mrp/files.js";
import { ABOUT_SHEET, EXCEPTIONS_SHEET, type Source } from "./source.js";
import type { Issue, ProblemGroup } from "./validate.js";

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1EFE8" } };
const EDIT_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F0FB" } };
const PROBLEM_FONT: Partial<ExcelJS.Font> = { color: { argb: "FFA32D2D" } };

/** Beside the source as <name>.exceptions.xlsx; a returned exceptions file is replaced in place. */
export function exceptionsPath(source: Source, entity: string, importId: string, given?: string): string {
    if (given?.trim()) return resolve(given.trim());
    if (!source.path) return join(outputDir(), "imports", `${entity.toLowerCase()}-${importId}.exceptions.xlsx`);
    const stem = basename(source.path, extname(source.path)).replace(/\.exceptions$/i, "");
    return join(dirname(source.path), `${stem}.exceptions.xlsx`);
}

export interface ExceptionsInfo {
    company: string;
    entity: string;
    importId: string;
}

/** Rows with problems, worst group first, then by row. Returns how many rows it holds. */
export async function buildExceptions(source: Source, issues: readonly Issue[], groups: readonly ProblemGroup[], info: ExceptionsInfo): Promise<{ data: Buffer; rows: number }> {
    const rank = new Map(groups.map((g, i) => [`${g.kind}|${g.field}`, i]));
    const byRow = new Map<number, Issue[]>();
    for (const issue of issues) byRow.set(issue.row, [...(byRow.get(issue.row) ?? []), issue]);
    const rows = source.rows
        .filter((r) => byRow.has(r.row))
        .map((r) => ({ r, worst: Math.min(...(byRow.get(r.row) ?? []).map((i) => rank.get(`${i.kind}|${i.field}`) ?? 99)) }))
        .sort((a, b) => a.worst - b.worst || a.r.row - b.r.row);

    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet(EXCEPTIONS_SHEET, { views: [{ state: "frozen", ySplit: 1, xSplit: 2 }] });
    sheet.columns = [
        { header: "Row", key: "Row", width: 6 },
        { header: "Problem", key: "Problem", width: 60 },
        { header: "Fix", key: "Fix", width: 24 },
        ...source.headers.map((h) => ({ header: h, key: `c:${h}`, width: Math.min(40, Math.max(10, h.length + 2)) })),
    ];
    const header = sheet.getRow(1);
    header.font = { bold: true };
    header.eachCell((cell, n) => { cell.fill = n === 3 ? EDIT_FILL : HEADER_FILL; });
    header.getCell(3).note = "Your notes. Fix the row's own cells, then hand this file back to import it.";
    for (const { r } of rows) {
        const problems = [...new Set((byRow.get(r.row) ?? []).map((i) => i.text))];
        const added = sheet.addRow({ Row: r.row, Problem: problems.join("; "), Fix: "", ...Object.fromEntries(source.headers.map((h) => [`c:${h}`, r.cells[h] ?? ""])) });
        added.getCell(2).font = PROBLEM_FONT;
        added.getCell(2).alignment = { wrapText: true, vertical: "top" };
        added.getCell(3).fill = EDIT_FILL;
        // Every original cell as text, so an ID like 00123 or a date stays exactly as the file had it.
        for (let c = 4; c <= source.headers.length + 3; c += 1) added.getCell(c).numFmt = "@";
    }
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: source.headers.length + 3 } };

    const about = book.addWorksheet(ABOUT_SHEET);
    about.columns = [{ width: 14 }, { width: 60 }];
    for (const [k, v] of [["Import ID", info.importId], ["Entity", info.entity], ["Company", info.company], ["Source", source.name + (source.sheet ? ` (sheet ${source.sheet})` : "")], ["Written", new Date().toISOString()], ["How to use", "Fix the rows on the first sheet, save, and give this file back to import_from_csv. Rows already created are skipped."]]) about.addRow([k, v]);
    about.getColumn(1).font = { bold: true };
    return { data: Buffer.from(await book.xlsx.writeBuffer()), rows: rows.length };
}

export async function writeExceptions(path: string, data: Buffer): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
}
