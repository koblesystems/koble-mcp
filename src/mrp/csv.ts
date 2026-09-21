import { createHash } from "node:crypto";

/**
 * The planner's worksheet: one CSV with the status of every planned item and a recommendation
 * where there is one. It is written by code and read back by code, so the numbers a person
 * approves in a spreadsheet are exactly the numbers that become purchase orders.
 *
 * Three columns are the planner's to edit — Order Qty, Approve and Notes. Everything else is
 * what EBMS and the plan said at the time of the run.
 */

/**
 * A short code that ties a row to its run: changing the Run, Line or product of a row, or
 * typing a row in by hand, breaks it. It starts with a letter so a spreadsheet leaves it alone.
 * It is a guard against accidents and against a worksheet being re-pointed at another run; it
 * is not a secret.
 */
export function checkCode(run: string, line: string, item: string): string {
    return "k" + createHash("sha256").update(`${run}|${line}|${item}`).digest("hex").slice(0, 8);
}

/** The byte-order mark Excel needs to read UTF-8. Written as a code so no invisible character sits in the source. */
export const BOM = String.fromCharCode(0xfeff);

export const COLUMNS = [
    "Run", "Company", "Line", "Check", "Type", "Item", "Description", "Status", "Recommendation", "Needed By",
    "Recommended Qty (stock unit)", "Vendor", "Vendor Part No", "Purchase Unit", "Order Qty", "Unit Cost", "Est Cost", "Approve",
    "On Hand", "Available", "Minimum", "Maximum", "Reorder Increment", "EBMS Qty To Order", "Demand In Time Frame", "Supply In Time Frame", "Projected Balance",
    "On Order After Time Frame", "Demand After Time Frame", "Document", "Because", "Notes",
] as const;

export type Column = (typeof COLUMNS)[number];
export type SheetRow = Partial<Record<Column, string | number>>;

/** Row types, in the order a planner should read them. */
export const TYPE_ORDER = ["EXPEDITE", "BUY", "MAKE", "NOT NEEDED", "OK"] as const;

/**
 * What the run said about each line, saved beside the worksheet. A spreadsheet reformats dates,
 * turns long product IDs into 3.94E+13 and drops leading zeros; and a cell that was not meant to
 * be edited can be. So when purchase orders are drafted, the item, unit, cost and date come from
 * here, and only Order Qty, Approve and Vendor come from the file.
 */
export interface RunManifest {
    run: string;
    company: string;
    through: string;
    createdAt: string;
    lines: Record<string, { type: string; item: string; vendor: string; partNo: string; purchaseUnit: string; orderQty: number | null; unitCost: number | null; neededBy: string }>;
}

const cell = (value: string | number | undefined): string => {
    if (value === undefined || value === "") return "";
    const text = String(value);
    // A leading = + - @ (or a tab or return before one) would be run as a formula by a spreadsheet; keep it as text.
    const safe = typeof value === "string" && /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(rows: readonly SheetRow[]): string {
    const lines = [COLUMNS.join(","), ...rows.map((row) => COLUMNS.map((column) => cell(row[column])).join(","))];
    // A byte-order mark makes Excel read UTF-8 correctly; CRLF is what it expects.
    return BOM + lines.join("\r\n") + "\r\n";
}

/** RFC 4180 parsing: quoted fields, doubled quotes, commas and line breaks inside quotes. */
export function parseCsv(text: string): Array<Record<string, string>> {
    const records: string[][] = [];
    let field = "";
    let record: string[] = [];
    let quoted = false;
    const source = text.replace(new RegExp("^" + BOM), "");
    for (let i = 0; i < source.length; i += 1) {
        const ch = source[i] as string;
        if (quoted) {
            if (ch === '"' && source[i + 1] === '"') { field += '"'; i += 1; }
            else if (ch === '"') quoted = false;
            else field += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ",") { record.push(field); field = ""; }
        else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && source[i + 1] === "\n") i += 1;
            record.push(field); field = "";
            if (record.some((value) => value !== "")) records.push(record);
            record = [];
        } else field += ch;
    }
    if (field !== "" || record.length > 0) { record.push(field); if (record.some((value) => value !== "")) records.push(record); }
    const [header, ...body] = records;
    if (!header) return [];
    const names = header.map((name) => name.trim());
    return body.map((values) => Object.fromEntries(names.map((name, index) => [name, (values[index] ?? "").trim().replace(/^'(?=[=+\-@])/, "")])));
}

export interface ApprovedLine {
    row: number;
    line: string;
    item: string;
    vendor: string;
    qty: number;
    /** The unit to order in. Null means "not known yet" — the tool looks it up; "" is a real, blank-named stock unit. */
    unit: string | null;
    unitCost: number | null;
    neededBy: string;
    partNo: string;
    /**
     * Set when the planner chose another vendor: the unit Order Qty was written in. The quantity
     * is converted from it into the new vendor's unit, so 2 cases never becomes 2 each.
     */
    originalUnit?: string;
    /** What the planner changed from the run's recommendation. */
    changes: string[];
}

export interface SheetReading {
    run: string;
    company: string;
    /** True when the run's own record was found and used for everything the planner does not edit. */
    fromManifest: boolean;
    approved: ApprovedLine[];
    /** Rows a person marked for ordering that cannot become a purchase-order line as they stand. */
    problems: string[];
    notes: string[];
    counts: { rows: number; candidates: number; approved: number; notApproved: number };
}

const YES = /^(y|yes|true|x|1|approve|approved|ok)$/i;
const NO = /^(|n|no|false|0)$/i;

/** A plain quantity: digits, optional thousands commas, optional decimal point. Nothing a spreadsheet or a locale could make ambiguous. */
export function parseQuantity(text: string): number | null {
    const clean = text.trim();
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(clean)) return Number(clean.replace(/,/g, ""));
    if (/^\d+(\.\d+)?$/.test(clean)) return Number(clean);
    return null;
}

/** ISO, or the M/D/YYYY a US spreadsheet turns it into. Anything else is not guessed at. */
export function parseDate(text: string): string | null {
    const clean = text.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return clean;
    const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(clean);
    if (!us) return null;
    const [, m, d, y] = us;
    const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) || Number(m) > 12 || Number(d) > 31 ? null : iso;
}

/**
 * Picks out the approved rows of one kind — BUY rows for purchase orders, MAKE rows for
 * manufacturing batches — and says what is wrong with any that cannot be acted on. A planner may
 * approve both kinds on one worksheet; each tool takes its own and leaves the other alone.
 */
export function readSheet(text: string, manifest: RunManifest | null = null, want: "BUY" | "MAKE" = "BUY"): SheetReading {
    const rows = parseCsv(text);
    const problems: string[] = [];
    const notes: string[] = [];
    const first = rows[0] ?? {};
    const header = text.replace(new RegExp("^" + BOM), "").split(/\r?\n/, 1)[0] ?? "";
    if (rows.length > 0 && Object.keys(first).length === 1 && header.includes(";")) {
        return { run: "", company: "", fromManifest: false, approved: [], problems: ["The file is separated by semicolons, which is how some spreadsheet settings save CSV. Save it again as comma-separated CSV (in Excel: \"CSV UTF-8 (comma delimited)\")."], notes, counts: { rows: rows.length, candidates: 0, approved: 0, notApproved: 0 } };
    }
    const missing = ["Run", "Company", "Line", "Check", "Type", "Item", "Vendor", "Order Qty", "Approve"].filter((name) => rows.length > 0 && !(name in first));
    if (rows.length === 0) problems.push("The file has no rows.");
    if (missing.length > 0) problems.push(`The file is missing column(s): ${missing.join(", ")}. It does not look like an MRP worksheet.`);
    const runs = new Set(rows.map((row) => row["Run"] ?? ""));
    const companies = new Set(rows.map((row) => (row["Company"] ?? "").toUpperCase()));
    if (rows.length > 0 && missing.length === 0) {
        if (runs.has("") || companies.has("")) problems.push("Some rows have a blank Run or Company cell. Those cells tie the file to its run and must not be changed; use the worksheet as it was written.");
        if (runs.size > 1) problems.push(`The file mixes ${runs.size} runs (${[...runs].filter(Boolean).join(", ")}); use one worksheet at a time.`);
        if (companies.size > 1) problems.push(`The file mixes companies (${[...companies].filter(Boolean).join(", ")}).`);
    }
    const run = [...runs].find(Boolean) ?? "";
    const company = [...companies].find(Boolean) ?? "";
    if (manifest && manifest.run !== run) problems.push(`The file says run ${run || "(blank)"} but the run record found is ${manifest.run}. The Run cell must not be changed.`);
    const blocked = problems.length > 0;

    const approved: ApprovedLine[] = [];
    const seenLines = new Set<string>();
    let candidates = 0;
    let notApproved = 0;
    rows.forEach((row, index) => {
        const at = index + 2; // header is line 1
        const type = (row["Type"] ?? "").toUpperCase();
        const mark = (row["Approve"] ?? "").trim();
        const line = (row["Line"] ?? "").trim();
        const known = manifest?.lines[line];
        const rowType = known?.type ?? type;
        const isBuy = rowType === want;
        if (!YES.test(mark) && !NO.test(mark)) { problems.push(`Line ${at}: Approve says "${mark}". Use Y to approve the row or leave it blank.`); return; }
        if (!isBuy) {
            // The other actionable kind is somebody else's job, not a mistake.
            if (YES.test(mark) && rowType !== "BUY" && rowType !== "MAKE") problems.push(`Line ${at}: ${row["Item"]} is marked approved but is a ${rowType} row; only BUY rows become purchase orders and MAKE rows become batches.`);
            return;
        }
        candidates += 1;
        if (!YES.test(mark)) { notApproved += 1; return; }
        if (blocked) return;
        if (!line) { problems.push(`Line ${at}: the Line cell is blank, so the row cannot be tied to the run.`); return; }
        if (seenLines.has(line)) { problems.push(`Line ${at}: worksheet line ${line} appears twice; the second copy was ignored.`); return; }
        seenLines.add(line);
        if (manifest && !known) { problems.push(`Line ${at}: worksheet line ${line} is not part of run ${manifest.run}. Rows cannot be added by hand; run the plan again.`); return; }
        // The row must carry the code it was written with. With the run record that ties it to the
        // run's own product; without it, to the Run, Line and Item cells exactly as they were written.
        const expected = known ? checkCode(manifest?.run ?? "", line, known.item) : checkCode(row["Run"] ?? "", line, (row["Item"] ?? "").trim());
        if ((row["Check"] ?? "").trim() !== expected) {
            problems.push(`Line ${at}: this row does not match the run it claims to belong to — its Run, Line, Check${known ? "" : " or Item"} cell was changed${known ? "" : " (or a spreadsheet reformatted the product ID)"}, or the row was typed in. It was not ordered. Use the worksheet as it was written, on the computer that ran the plan.`);
            return;
        }

        const changes: string[] = [];
        const item = known?.item ?? (row["Item"] ?? "").trim();
        if (!item) { problems.push(`Line ${at}: no item.`); return; }
        if (!known && /^\d(\.\d+)?E\+\d+$/i.test(item)) { problems.push(`Line ${at}: the item reads "${item}" — a spreadsheet turned the product ID into a number. Re-enter the ID as text, or use the worksheet from the computer that ran the plan.`); return; }
        if (known && (row["Item"] ?? "").trim() !== known.item) notes.push(`Line ${at}: the Item cell reads "${row["Item"]}" but the run planned ${known.item}; the run's product is used (spreadsheets often reformat numeric IDs).`);

        const qty = parseQuantity(row["Order Qty"] ?? "");
        if (qty === null || qty <= 0) { problems.push(`Line ${at}: ${item} is approved but Order Qty "${row["Order Qty"]}" is not a plain quantity above 0 (use digits and a decimal point, e.g. 12 or 1.5).`); return; }
        if (known && known.orderQty !== null && Math.abs(known.orderQty - qty) > 1e-9) changes.push(`quantity ${known.orderQty} → ${qty}`);

        const typed = (row["Vendor"] ?? "").trim().toUpperCase();
        const vendor = want === "MAKE" ? "" : typed && !typed.startsWith("(") ? typed : (known?.vendor ?? "").toUpperCase();
        if (want === "BUY" && (!vendor || vendor.startsWith("("))) { problems.push(`Line ${at}: ${item} is approved but has no vendor. Put a vendor ID in the Vendor column.`); return; }
        const vendorChanged = want === "BUY" && known !== undefined && vendor !== known.vendor.toUpperCase();
        if (vendorChanged) changes.push(known.vendor.startsWith("(") || !known.vendor ? `vendor set to ${vendor}` : `vendor ${known.vendor} → ${vendor}`);

        let neededBy = known?.neededBy ?? "";
        if (!known) {
            const parsed = parseDate(row["Needed By"] ?? "");
            if (parsed === null && (row["Needed By"] ?? "").trim() !== "") notes.push(`Line ${at}: Needed By "${row["Needed By"]}" is not a date this can read, so it cannot be compared with the date EBMS expects the goods.`);
            neededBy = parsed ?? "";
        }
        const costCell = parseQuantity((row["Unit Cost"] ?? "").replace(/[$]/g, ""));
        approved.push({
            row: at, line, item, vendor, qty, changes,
            // A changed vendor may sell in another unit at another price; both are looked up again.
            unit: known ? (vendorChanged ? null : known.purchaseUnit) : ((row["Purchase Unit"] ?? "").trim() || null),
            unitCost: known ? (vendorChanged ? null : known.unitCost) : costCell,
            neededBy,
            partNo: known ? (vendorChanged ? "" : known.partNo) : (row["Vendor Part No"] ?? "").trim(),
            ...(known && vendorChanged ? { originalUnit: known.purchaseUnit } : {}),
        });
    });
    if (!manifest && rows.length > 0 && missing.length === 0) notes.push("The run's own record was not found, so every value was taken from the file. Check the products, units and costs on each draft: a spreadsheet may have changed them.");
    return { run, company, fromManifest: manifest !== null, approved, problems, notes, counts: { rows: rows.length, candidates, approved: approved.length, notApproved } };
}

export interface PurchaseOrderDraft {
    vendor: string;
    /** Item → the day the plan needs it, to hold against the expected date EBMS assigns. */
    neededBy: Record<string, string>;
    externalId: string;
    lines: ApprovedLine[];
    estCost: number | null;
    /** What the planner changed from the recommendation, line by line. */
    changes: string[];
    /** Exactly what to pass to ebms_write as the body of POST APINV. */
    body: Record<string, unknown>;
}

/** EXTERNALID is 50 characters: the vendor is always kept whole, and the run is what gets shortened. */
export function externalIdFor(run: string, vendor: string): string {
    return `${run.slice(0, Math.max(1, 50 - vendor.length - 1))}-${vendor}`.slice(0, 50);
}

/** One purchase order per vendor. The EXTERNALID ties it to the run, so a worksheet handed in twice cannot order twice. */
export function draftPurchaseOrders(reading: SheetReading): PurchaseOrderDraft[] {
    const byVendor = new Map<string, ApprovedLine[]>();
    for (const line of reading.approved) byVendor.set(line.vendor, [...(byVendor.get(line.vendor) ?? []), line]);
    return [...byVendor.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([vendor, lines]) => {
        const costed = lines.every((line) => line.unitCost !== null);
        return {
            vendor,
            externalId: externalIdFor(reading.run, vendor),
            lines,
            // The EARLIEST need per product: a later line for the same product must not hide it.
            neededBy: lines.filter((line) => line.neededBy).reduce<Record<string, string>>((all, line) => ({ ...all, [line.item]: all[line.item] !== undefined && (all[line.item] as string) < line.neededBy ? (all[line.item] as string) : line.neededBy }), {}),
            changes: lines.flatMap((line) => line.changes.map((change) => `${line.item}: ${change}`)),
            estCost: costed ? Math.round(lines.reduce((sum, line) => sum + line.qty * (line.unitCost ?? 0), 0) * 100) / 100 : null,
            body: {
                ID: vendor,
                EXTERNALID: externalIdFor(reading.run, vendor),
                Details: lines.map((line) => ({
                    INVEN: line.item,
                    O_QUAN_VIS: line.qty,
                    ...(line.unit !== null ? { UNIT_MEAS: line.unit } : {}),
                    ...(line.unitCost !== null ? { UNIT_VIS: line.unitCost } : {}),
                    // No ETA_DATE: EBMS sets a purchase line's expected date itself (seen on SBX: a date
                    // sent as the needed-by day came back as the vendor's lead-time date, or empty). The
                    // read-back reports what EBMS chose, to compare with the day the stock is needed.
                })),
            },
        };
    });
}
