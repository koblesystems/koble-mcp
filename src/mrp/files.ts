/** Where worksheets and their run records live on disk. */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseCsv, readRows, readSheet, toCsv, type RunManifest, type SheetReading, type SheetRow } from "./csv.js";
import { buildWorkbook, readWorkbook, type WorkbookContext } from "./workbook.js";

const RUN_ID = /^mrp-[a-z0-9_-]+-\d{8}-\d{4,6}$/i;

/** The newest worksheets in the usual folder, for when nobody says which file. */
export async function recentWorksheets(folder?: string, count = 5): Promise<string[]> {
    const dir = outputDir(folder);
    try {
        const names = (await readdir(dir)).filter((name) => /^mrp-.*\.xlsx$/i.test(name));
        const dated = await Promise.all(names.map(async (name) => ({ path: join(dir, name), at: (await stat(join(dir, name))).mtimeMs })));
        return dated.sort((a, b) => b.at - a.at).slice(0, count).map((file) => file.path);
    } catch {
        return [];
    }
}

/** KOBLE_OUTPUT_DIR, or "Koble MRP" in the user's Documents folder. */
export const outputDir = (given?: string): string => resolve(given?.trim() || process.env["KOBLE_OUTPUT_DIR"] || join(homedir(), "Documents", "Koble MRP"));

/**
 * Writes the worksheet (an Excel workbook), and the run record po_from_csv and batches_from_csv
 * trust over anything a spreadsheet did to the file. The record also goes in the usual folder, so
 * a worksheet that comes back from elsewhere is still matched to its run. Returns the rows as CSV
 * too, for a host that shows a file in the conversation.
 */
export async function saveWorksheet(folder: string | undefined, name: string, rows: readonly SheetRow[], manifest: RunManifest, context: WorkbookContext): Promise<{ path: string; csv: string }> {
    const dir = outputDir(folder);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), await buildWorkbook(rows, context));
    for (const runs of new Set([join(dir, "runs"), join(outputDir(), "runs")])) {
        await mkdir(runs, { recursive: true });
        await writeFile(join(runs, `${manifest.run}.json`), JSON.stringify(manifest, null, 1), "utf8");
    }
    return { path: join(dir, name), csv: toCsv(rows) };
}

async function findManifest(run: string, path: string | undefined): Promise<RunManifest | null> {
    if (!RUN_ID.test(run)) return null;
    const folders = [...(path ? [join(dirname(resolve(path)), "runs")] : []), join(outputDir(), "runs")];
    for (const folder of folders) {
        const record = join(folder, `${run}.json`);
        if (existsSync(record)) return JSON.parse(await readFile(record, "utf8")) as RunManifest;
    }
    return null;
}

/**
 * The approved rows of one kind from a worksheet — the workbook, or a CSV given by path or as
 * text — checked against its run record when one is found beside the file or in the usual folder.
 */
export async function readWorksheet(source: { path?: string | undefined; csv?: string | undefined }, want: "BUY" | "MAKE"): Promise<SheetReading> {
    // The workbook is where a person approves; a CSV copy passed alongside it is ignored.
    if (source.path && /\.xlsx$/i.test(source.path)) {
        const book = await readWorkbook(await readFile(resolve(source.path)), want);
        if (book.rows.length === 0) return { run: "", company: "", fromManifest: false, approved: [], problems: book.problems, notes: [], counts: { rows: 0, candidates: 0, approved: 0, notApproved: 0 } };
        const run = book.rows.map((row) => row["Run"] ?? "").find(Boolean) ?? "";
        const reading = readRows(book.rows, await findManifest(run, source.path), want, (index) => book.where[index] ?? `Row ${index + 2}`, { approveMarks: "yes-no" });
        return { ...reading, problems: [...book.problems, ...reading.problems], notes: [...(source.csv !== undefined ? ["CSV text was also given; the workbook was read instead."] : []), ...reading.notes] };
    }
    const text = source.csv ?? (await readFile(resolve(source.path as string), "utf8"));
    const run = parseCsv(text).map((row) => row["Run"] ?? "").find(Boolean) ?? "";
    return readSheet(text, await findManifest(run, source.path), want);
}
