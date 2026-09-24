/** Where worksheets and their run records live on disk. */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseCsv, toCsv, type RunManifest, type SheetRow } from "./csv.js";

const RUN_ID = /^mrp-[a-z0-9_-]+-\d{8}-\d{4,6}$/i;

/** KOBLE_OUTPUT_DIR, or "Koble MRP" in the user's Documents folder. */
export const outputDir = (given?: string): string => resolve(given?.trim() || process.env["KOBLE_OUTPUT_DIR"] || join(homedir(), "Documents", "Koble MRP"));

/**
 * Writes the worksheet, and the run record po_from_csv and batches_from_csv trust over anything
 * a spreadsheet did to the file. The record also goes in the usual folder, so a worksheet that
 * comes back as pasted text is still matched to its run.
 */
export async function saveWorksheet(folder: string | undefined, name: string, rows: readonly SheetRow[], manifest: RunManifest): Promise<{ path: string; csv: string }> {
    const dir = outputDir(folder);
    const csv = toCsv(rows);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), csv, "utf8");
    for (const runs of new Set([join(dir, "runs"), join(outputDir(), "runs")])) {
        await mkdir(runs, { recursive: true });
        await writeFile(join(runs, `${manifest.run}.json`), JSON.stringify(manifest, null, 1), "utf8");
    }
    return { path: join(dir, name), csv };
}

/** The worksheet's text, and its run record if one is beside the file or in the usual folder. */
export async function loadWorksheet(source: { path?: string | undefined; csv?: string | undefined }): Promise<{ text: string; manifest: RunManifest | null }> {
    const text = source.csv ?? (await readFile(resolve(source.path as string), "utf8"));
    const run = parseCsv(text).map((row) => row["Run"] ?? "").find(Boolean) ?? "";
    if (!RUN_ID.test(run)) return { text, manifest: null };
    const folders = [...(source.path ? [join(dirname(resolve(source.path)), "runs")] : []), join(outputDir(), "runs")];
    for (const folder of folders) {
        const record = join(folder, `${run}.json`);
        if (existsSync(record)) return { text, manifest: JSON.parse(await readFile(record, "utf8")) as RunManifest };
    }
    return { text, manifest: null };
}
