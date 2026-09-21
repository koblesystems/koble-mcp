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
    "Run", "Company", "Type", "Item", "Description", "Status", "Recommendation", "Needed By",
    "Recommended Qty (stock unit)", "Vendor", "Vendor Part No", "Purchase Unit", "Order Qty", "Unit Cost", "Est Cost", "Approve",
    "On Hand", "Available", "Minimum", "Maximum", "Reorder Increment", "Demand In Time Frame", "Supply In Time Frame", "Projected Balance",
    "Document", "Because", "Notes",
] as const;

export type Column = (typeof COLUMNS)[number];
export type SheetRow = Partial<Record<Column, string | number>>;

/** Row types, in the order a planner should read them. */
export const TYPE_ORDER = ["EXPEDITE", "BUY", "MAKE", "NOT NEEDED", "OK"] as const;

const cell = (value: string | number | undefined): string => {
    if (value === undefined || value === "") return "";
    const text = String(value);
    // A leading = + - @ would be run as a formula by a spreadsheet; keep it as text.
    const safe = typeof value === "string" && /^[=+\-@]/.test(text) ? `'${text}` : text;
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
    item: string;
    vendor: string;
    qty: number;
    unit: string;
    unitCost: number | null;
    neededBy: string;
    partNo: string;
}

export interface SheetReading {
    run: string;
    company: string;
    approved: ApprovedLine[];
    /** Rows a person marked for ordering that cannot become a purchase-order line as they stand. */
    problems: string[];
    counts: { rows: number; buyRows: number; approved: number; notApproved: number };
}

const yes = (value: string | undefined): boolean => /^(y|yes|true|x|1|approve|approved)$/i.test((value ?? "").trim());

/** Picks out the approved BUY rows and says what is wrong with any that cannot be ordered. */
export function readSheet(text: string): SheetReading {
    const rows = parseCsv(text);
    const problems: string[] = [];
    const missing = ["Run", "Company", "Type", "Item", "Vendor", "Order Qty", "Approve"].filter((name) => rows.length > 0 && !(name in (rows[0] ?? {})));
    if (rows.length === 0) problems.push("The file has no rows.");
    if (missing.length > 0) problems.push(`The file is missing column(s): ${missing.join(", ")}. It does not look like an MRP worksheet.`);
    const runs = new Set(rows.map((row) => row["Run"] ?? "").filter(Boolean));
    const companies = new Set(rows.map((row) => (row["Company"] ?? "").toUpperCase()).filter(Boolean));
    if (runs.size > 1) problems.push(`The file mixes ${runs.size} runs (${[...runs].join(", ")}); use one worksheet at a time.`);
    if (companies.size > 1) problems.push(`The file mixes companies (${[...companies].join(", ")}).`);

    const approved: ApprovedLine[] = [];
    let buyRows = 0;
    let notApproved = 0;
    rows.forEach((row, index) => {
        const line = index + 2; // header is line 1
        if ((row["Type"] ?? "").toUpperCase() !== "BUY") {
            if (yes(row["Approve"])) problems.push(`Line ${line}: ${row["Item"]} is marked approved but is a ${row["Type"]} row; only BUY rows become purchase orders.`);
            return;
        }
        buyRows += 1;
        if (!yes(row["Approve"])) { notApproved += 1; return; }
        const qty = Number((row["Order Qty"] ?? "").replace(/,/g, ""));
        const vendor = (row["Vendor"] ?? "").trim();
        if (!row["Item"]) { problems.push(`Line ${line}: no item.`); return; }
        if (!Number.isFinite(qty) || qty <= 0) { problems.push(`Line ${line}: ${row["Item"]} is approved but Order Qty "${row["Order Qty"]}" is not a quantity above 0.`); return; }
        if (!vendor || vendor.startsWith("(")) { problems.push(`Line ${line}: ${row["Item"]} is approved but has no vendor. Put a vendor ID in the Vendor column.`); return; }
        const cost = Number((row["Unit Cost"] ?? "").replace(/[$,]/g, ""));
        approved.push({ row: line, item: row["Item"], vendor: vendor.toUpperCase(), qty, unit: row["Purchase Unit"] ?? "", unitCost: row["Unit Cost"] && Number.isFinite(cost) ? cost : null, neededBy: row["Needed By"] ?? "", partNo: row["Vendor Part No"] ?? "" });
    });
    return { run: [...runs][0] ?? "", company: [...companies][0] ?? "", approved, problems, counts: { rows: rows.length, buyRows, approved: approved.length, notApproved } };
}

export interface PurchaseOrderDraft {
    vendor: string;
    externalId: string;
    lines: ApprovedLine[];
    estCost: number | null;
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
            estCost: costed ? Math.round(lines.reduce((sum, line) => sum + line.qty * (line.unitCost ?? 0), 0) * 100) / 100 : null,
            body: {
                ID: vendor,
                EXTERNALID: `${reading.run}-${vendor}`.slice(0, 50),
                Details: lines.map((line) => ({
                    INVEN: line.item,
                    O_QUAN_VIS: line.qty,
                    ...(line.unit ? { UNIT_MEAS: line.unit } : {}),
                    ...(line.unitCost !== null ? { UNIT_VIS: line.unitCost } : {}),
                    ...(/^\d{4}-\d{2}-\d{2}$/.test(line.neededBy) ? { ETA_DATE: `${line.neededBy}T00:00:00Z` } : {}),
                })),
            },
        };
    });
}
