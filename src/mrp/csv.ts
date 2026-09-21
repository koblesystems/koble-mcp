/**
 * The planner's worksheet: one CSV with the status of every planned item and a recommendation
 * where there is one. It is written by code and read back by code, so the numbers a person
 * approves in a spreadsheet are exactly the numbers that become purchase orders.
 *
 * Three columns are the planner's to edit — Order Qty, Approve and Notes. Everything else is
 * what EBMS and the plan said at the time of the run.
 */

/** The byte-order mark Excel needs to read UTF-8. Written as a code so no invisible character sits in the source. */
export const BOM = String.fromCharCode(0xfeff);

export const COLUMNS = [
    "Run", "Company", "Line", "Type", "Item", "Description", "Status", "Recommendation", "Needed By",
    "Recommended Qty (stock unit)", "Vendor", "Vendor Part No", "Purchase Unit", "Order Qty", "Unit Cost", "Est Cost", "Approve",
    "On Hand", "Available", "Minimum", "Maximum", "Reorder Increment", "EBMS Qty To Order", "Demand In Time Frame", "Supply In Time Frame", "Projected Balance",
    "On Order After Time Frame", "Document", "Because", "Notes",
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
    counts: { rows: number; buyRows: number; approved: number; notApproved: number };
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

/** Picks out the approved BUY rows and says what is wrong with any that cannot be ordered. */
export function readSheet(text: string, manifest: RunManifest | null = null): SheetReading {
    const rows = parseCsv(text);
    const problems: string[] = [];
    const notes: string[] = [];
    const first = rows[0] ?? {};
    const missing = ["Run", "Company", "Line", "Type", "Item", "Vendor", "Order Qty", "Approve"].filter((name) => rows.length > 0 && !(name in first));
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
    let buyRows = 0;
    let notApproved = 0;
    rows.forEach((row, index) => {
        const at = index + 2; // header is line 1
        const type = (row["Type"] ?? "").toUpperCase();
        const mark = (row["Approve"] ?? "").trim();
        const line = (row["Line"] ?? "").trim();
        const known = manifest?.lines[line];
        const isBuy = (known?.type ?? type) === "BUY";
        if (!YES.test(mark) && !NO.test(mark)) { problems.push(`Line ${at}: Approve says "${mark}". Use Y to order the row or leave it blank.`); return; }
        if (!isBuy) {
            if (YES.test(mark)) problems.push(`Line ${at}: ${row["Item"]} is marked approved but is a ${known?.type ?? row["Type"]} row; only BUY rows become purchase orders.`);
            return;
        }
        buyRows += 1;
        if (!YES.test(mark)) { notApproved += 1; return; }
        if (blocked) return;
        if (!line) { problems.push(`Line ${at}: the Line cell is blank, so the row cannot be tied to the run.`); return; }
        if (seenLines.has(line)) { problems.push(`Line ${at}: worksheet line ${line} appears twice; the second copy was ignored.`); return; }
        seenLines.add(line);
        if (manifest && !known) { problems.push(`Line ${at}: worksheet line ${line} is not part of run ${manifest.run}. Rows cannot be added by hand; run the plan again.`); return; }

        const changes: string[] = [];
        const item = known?.item ?? (row["Item"] ?? "").trim();
        if (!item) { problems.push(`Line ${at}: no item.`); return; }
        if (!known && /^\d(\.\d+)?E\+\d+$/i.test(item)) { problems.push(`Line ${at}: the item reads "${item}" — a spreadsheet turned the product ID into a number. Re-enter the ID as text, or use the worksheet from the computer that ran the plan.`); return; }
        if (known && (row["Item"] ?? "").trim() !== known.item) notes.push(`Line ${at}: the Item cell reads "${row["Item"]}" but the run planned ${known.item}; the run's product is used (spreadsheets often reformat numeric IDs).`);

        const qty = parseQuantity(row["Order Qty"] ?? "");
        if (qty === null || qty <= 0) { problems.push(`Line ${at}: ${item} is approved but Order Qty "${row["Order Qty"]}" is not a plain quantity above 0 (use digits and a decimal point, e.g. 12 or 1.5).`); return; }
        if (known && known.orderQty !== null && Math.abs(known.orderQty - qty) > 1e-9) changes.push(`quantity ${known.orderQty} → ${qty}`);

        const typed = (row["Vendor"] ?? "").trim().toUpperCase();
        const vendor = typed && !typed.startsWith("(") ? typed : (known?.vendor ?? "").toUpperCase();
        if (!vendor || vendor.startsWith("(")) { problems.push(`Line ${at}: ${item} is approved but has no vendor. Put a vendor ID in the Vendor column.`); return; }
        const vendorChanged = known !== undefined && vendor !== known.vendor.toUpperCase();
        if (vendorChanged) changes.push(known.vendor.startsWith("(") || !known.vendor ? `vendor set to ${vendor}` : `vendor ${known.vendor} → ${vendor}`);

        let neededBy = known?.neededBy ?? "";
        if (!known) {
            const parsed = parseDate(row["Needed By"] ?? "");
            if (parsed === null && (row["Needed By"] ?? "").trim() !== "") notes.push(`Line ${at}: Needed By "${row["Needed By"]}" is not a date this can read, so the purchase-order line will have no expected date.`);
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
        });
    });
    if (!manifest && rows.length > 0 && missing.length === 0) notes.push("The run's own record was not found, so every value was taken from the file. Check the products, units and costs on each draft: a spreadsheet may have changed them.");
    return { run, company, fromManifest: manifest !== null, approved, problems, notes, counts: { rows: rows.length, buyRows, approved: approved.length, notApproved } };
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

/** One purchase order per vendor. The EXTERNALID ties it to the run, so a worksheet handed in twice cannot order twice. */
export function draftPurchaseOrders(reading: SheetReading): PurchaseOrderDraft[] {
    const byVendor = new Map<string, ApprovedLine[]>();
    for (const line of reading.approved) byVendor.set(line.vendor, [...(byVendor.get(line.vendor) ?? []), line]);
    return [...byVendor.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([vendor, lines]) => {
        const costed = lines.every((line) => line.unitCost !== null);
        return {
            vendor,
            externalId: `${reading.run}-${vendor}`.slice(0, 50),
            lines,
            neededBy: Object.fromEntries(lines.filter((line) => line.neededBy).map((line) => [line.item, line.neededBy])),
            changes: lines.flatMap((line) => line.changes.map((change) => `${line.item}: ${change}`)),
            estCost: costed ? Math.round(lines.reduce((sum, line) => sum + line.qty * (line.unitCost ?? 0), 0) * 100) / 100 : null,
            body: {
                ID: vendor,
                EXTERNALID: `${reading.run}-${vendor}`.slice(0, 50),
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
