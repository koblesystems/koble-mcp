/**
 * The planner's worksheet as an Excel workbook: one tab per kind of decision, the cells a person
 * edits shaded, late dates in red, and the columns that tie a row to its run kept but hidden.
 * Opens in Excel and Google Sheets. It is read back by the same rules as the CSV, through the
 * same column names, so the numbers a person approves are the numbers that become orders.
 */
import ExcelJS from "exceljs";
import type { Column, SheetRow } from "./csv.js";

interface Col {
    key: Column;
    header: string;
    width: number;
    edit?: boolean;
    hidden?: boolean;
    kind?: "date" | "money" | "qty" | "text";
    wrap?: boolean;
    note?: string;
}

/** Ties a row to its run; read back, never shown. */
const IDS: Col[] = [
    { key: "Run", header: "Run", width: 24, hidden: true },
    { key: "Company", header: "Company", width: 8, hidden: true },
    { key: "Line", header: "Line", width: 8, hidden: true },
    { key: "Check", header: "Check", width: 11, hidden: true },
    { key: "Type", header: "Type", width: 8, hidden: true },
];

const ORDER: Col[] = [
    { key: "Approve", header: "Approve", width: 10, edit: true, note: "Choose Yes for each line to order. Blank or No leaves it out." },
    { key: "Order Qty", header: "Qty", width: 8, edit: true, kind: "qty", note: "In the Unit shown. Change it if you want a different amount." },
    { key: "Purchase Unit", header: "Unit", width: 9 },
    { key: "Vendor", header: "Vendor", width: 19, edit: true, note: "Type another vendor ID to order from them instead; their unit and cost are looked up again." },
    { key: "Item", header: "Item", width: 26 },
    { key: "Description", header: "Description", width: 34 },
    { key: "Vendor Part No", header: "Vendor part no", width: 14 },
    { key: "Order By", header: "Order by", width: 12, kind: "date", note: "Needed by minus the lead time. Red: this date has already passed." },
    { key: "Needed By", header: "Needed by", width: 12, kind: "date", note: "When the stock has to be on the shelf." },
    { key: "Lead Days", header: "Lead days", width: 9, kind: "qty" },
    { key: "Lead From", header: "Lead from", width: 12 },
    { key: "Unit Cost", header: "Unit cost", width: 10, kind: "money", note: "The vendor's cost on the product's vendor record. Blank: none recorded; EBMS fills it in." },
    { key: "Est Cost", header: "Est cost", width: 11, kind: "money", note: "Qty × unit cost. Updates when you change Qty." },
    { key: "Why", header: "Why", width: 34, wrap: true },
    { key: "Notes", header: "Notes", width: 40, edit: true, wrap: true },
    { key: "Recommended Qty (stock unit)", header: "Recommended qty (stock unit)", width: 12, kind: "qty", hidden: true },
    ...IDS,
];

const MAKE: Col[] = [
    { key: "Approve", header: "Approve", width: 10, edit: true, note: "Choose Yes for each batch to create. Blank or No leaves it out." },
    { key: "Order Qty", header: "Qty", width: 8, edit: true, kind: "qty" },
    { key: "Purchase Unit", header: "Unit", width: 9 },
    { key: "Item", header: "Item", width: 26 },
    { key: "Description", header: "Description", width: 34 },
    { key: "Order By", header: "Start by", width: 12, kind: "date", note: "Only when a lead time was given for the item." },
    { key: "Needed By", header: "Needed by", width: 12, kind: "date" },
    { key: "Why", header: "Why", width: 34, wrap: true },
    { key: "Notes", header: "Notes", width: 40, edit: true, wrap: true },
    { key: "Recommended Qty (stock unit)", header: "Recommended qty (stock unit)", width: 12, kind: "qty", hidden: true },
    ...IDS,
];

const FOLLOW_UP: Col[] = [
    { key: "Recommendation", header: "What to do", width: 44, wrap: true },
    { key: "Item", header: "Item", width: 24 },
    { key: "Description", header: "Description", width: 28 },
    { key: "Document", header: "Document", width: 14 },
    { key: "Needed By", header: "Needed by", width: 12, kind: "date" },
    { key: "Status", header: "Situation", width: 26, wrap: true },
    { key: "Because", header: "Why", width: 50, wrap: true },
    { key: "Notes", header: "Notes", width: 30, edit: true, wrap: true },
    ...IDS,
];

const ALL: Col[] = [
    { key: "Type", header: "Type", width: 12 },
    { key: "Item", header: "Item", width: 24 },
    { key: "Description", header: "Description", width: 28 },
    { key: "Status", header: "Status", width: 22 },
    { key: "Recommendation", header: "Recommendation", width: 36, wrap: true },
    { key: "Vendor", header: "Vendor", width: 14 },
    { key: "On Hand", header: "On hand", width: 9, kind: "qty" },
    { key: "Available", header: "Available", width: 10, kind: "qty", note: "EBMS's figure: on hand + incoming − committed to orders. Negative: more is committed than you have or expect." },
    { key: "Minimum", header: "Minimum", width: 9, kind: "qty" },
    { key: "Maximum", header: "Maximum", width: 9, kind: "qty" },
    { key: "Reorder Increment", header: "Reorder increment", width: 10, kind: "qty" },
    { key: "EBMS Qty To Order", header: "EBMS qty to order", width: 10, kind: "qty", note: "What EBMS's own purchasing screen last saved. For reference only." },
    { key: "Demand In Time Frame", header: "Demand in time frame", width: 11, kind: "qty" },
    { key: "Supply In Time Frame", header: "Supply in time frame", width: 11, kind: "qty" },
    { key: "Projected Balance", header: "Projected balance", width: 11, kind: "qty", note: "Stock at the end of the time frame, with this plan's orders." },
    { key: "On Order After Time Frame", header: "On order after time frame", width: 24, wrap: true },
    { key: "Demand After Time Frame", header: "Demand after time frame", width: 18 },
    { key: "Needed By", header: "Needed by", width: 12, kind: "date" },
    { key: "Order By", header: "Order by", width: 12, kind: "date" },
];

/** The tabs a person approves on, and the row type each holds. Read back in this order. */
export const ACTION_SHEETS = [
    { name: "To order", type: "BUY", columns: ORDER },
    { name: "To make", type: "MAKE", columns: MAKE },
] as const;

export interface WorkbookContext {
    company: string;
    run: string;
    from: string;
    through: string;
    /** Plain sentences for the summary: lead times, warnings, what was left out. */
    notes: string[];
}

const EDIT_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F0FB" } };
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1EFE8" } };
const BAND_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8F7F4" } };
const LATE = { argb: "FFA32D2D" };

const asDate = (value: unknown): Date | null => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null);
const letter = (index: number): string => {
    let n = index + 1;
    let out = "";
    while (n > 0) { out = String.fromCharCode(65 + ((n - 1) % 26)) + out; n = Math.floor((n - 1) / 26); }
    return out;
};
/** A column nobody would miss: every row blank. Hidden, not removed, so the layout stays the same between runs. */
const empty = (rows: readonly SheetRow[], key: Column): boolean => rows.every((row) => row[key] === undefined || row[key] === "");

function addTable(book: ExcelJS.Workbook, name: string, columns: readonly Col[], rows: readonly SheetRow[], today: string, group?: (row: SheetRow) => string): ExcelJS.Worksheet {
    const sheet = book.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1, xSplit: columns.findIndex((c) => c.key === "Item") + 1 }] });
    sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width, hidden: c.hidden === true || (!c.edit && empty(rows, c.key) && c.key !== "Item") }));
    const header = sheet.getRow(1);
    header.font = { bold: true };
    header.alignment = { vertical: "middle", wrapText: true };
    header.height = 30;
    columns.forEach((c, i) => {
        const cell = header.getCell(i + 1);
        cell.fill = c.edit ? EDIT_FILL : HEADER_FILL;
        if (c.note) cell.note = c.note;
    });
    const at = (key: Column): number => columns.findIndex((c) => c.key === key);
    let band = false;
    let previous: string | null = null;
    rows.forEach((row, index) => {
        const r = sheet.getRow(index + 2);
        const groupKey = group ? group(row) : null;
        const startsGroup = group !== undefined && groupKey !== previous;
        if (startsGroup && previous !== null) band = !band;
        previous = groupKey;
        columns.forEach((c, i) => {
            const cell = r.getCell(i + 1);
            const value = row[c.key];
            if (c.key === "Est Cost" && at("Unit Cost") >= 0 && at("Order Qty") >= 0) {
                // A live formula, so changing the quantity changes the cost.
                const q = `${letter(at("Order Qty"))}${index + 2}`;
                const u = `${letter(at("Unit Cost"))}${index + 2}`;
                cell.value = { formula: `IF(AND(ISNUMBER(${q}),ISNUMBER(${u})),${q}*${u},"")`, result: typeof value === "number" ? value : "" } as ExcelJS.CellFormulaValue;
            } else if (c.kind === "date") cell.value = asDate(value) ?? (value === undefined ? null : String(value));
            else cell.value = value === undefined || value === "" ? null : value;
            if (c.kind === "date") cell.numFmt = "d mmm yyyy";
            if (c.kind === "money") cell.numFmt = "#,##0.00";
            cell.alignment = { vertical: "top", wrapText: c.wrap === true };
            if (c.edit) cell.fill = EDIT_FILL;
            else if (band) cell.fill = BAND_FILL;
            if (startsGroup && index > 0) cell.border = { top: { style: "thin", color: { argb: "FF888780" } } };
        });
        const approve = at("Approve");
        if (approve >= 0) r.getCell(approve + 1).dataValidation = { type: "list", allowBlank: true, formulae: ['"Yes,No"'], showErrorMessage: true, errorTitle: "Approve", error: "Choose Yes, No, or leave it blank." };
        const orderBy = at("Order By");
        if (orderBy >= 0 && typeof row["Order By"] === "string" && row["Order By"] < today) r.getCell(orderBy + 1).font = { color: LATE, bold: true };
    });
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: columns.length } };
    return sheet;
}

/** Earliest date a row needs acting on: its order-by date if it has one, else when it is needed. */
const urgency = (row: SheetRow): string => String(row["Order By"] || row["Needed By"] || "9999-12-31");
const NO_VENDOR = (vendor: string): boolean => !vendor || vendor.startsWith("(");

/**
 * Buys grouped by vendor, so each group is one purchase order, and ordered by urgency within a
 * group and between groups. Lines with no primary vendor come last: they cannot be ordered until
 * someone names one.
 */
export function orderRows(rows: readonly SheetRow[]): SheetRow[] {
    const firstNeed = new Map<string, string>();
    for (const row of rows) {
        const vendor = String(row.Vendor ?? "");
        const when = urgency(row);
        if (!firstNeed.has(vendor) || when < (firstNeed.get(vendor) as string)) firstNeed.set(vendor, when);
    }
    const rank = (vendor: string): string => `${NO_VENDOR(vendor) ? 1 : 0}|${firstNeed.get(vendor)}|${vendor}`;
    return [...rows].sort((a, b) => rank(String(a.Vendor ?? "")).localeCompare(rank(String(b.Vendor ?? ""))) || urgency(a).localeCompare(urgency(b)) || String(a.Item).localeCompare(String(b.Item)));
}

export async function buildWorkbook(rows: readonly SheetRow[], context: WorkbookContext): Promise<Buffer> {
    const book = new ExcelJS.Workbook();
    book.creator = "koble";
    book.created = new Date();
    // The vendor totals are formulas over the approvals; Excel recalculates them on opening.
    book.calcProperties.fullCalcOnLoad = true;
    const buys = orderRows(rows.filter((row) => row.Type === "BUY"));
    const makes = rows.filter((row) => row.Type === "MAKE").sort((a, b) => urgency(a).localeCompare(urgency(b)));
    const followUps = rows.filter((row) => row.Type === "EXPEDITE" || row.Type === "NOT NEEDED");

    const summary = book.addWorksheet("Summary");
    addTable(book, `To order`, ORDER, buys, context.from, (row) => String(row.Vendor ?? ""));
    addTable(book, "To make", MAKE, makes, context.from);
    addTable(book, "Follow up", FOLLOW_UP, followUps, context.from);
    addTable(book, "All items", ALL, rows, context.from);

    summary.columns = [{ width: 26 }, { width: 10 }, { width: 11 }, { width: 19 }, { width: 18 }, { width: 30 }];
    const line = (values: unknown[], style?: Partial<ExcelJS.Style>) => {
        const r = summary.addRow(values);
        if (style?.font) r.font = style.font;
        return r;
    };
    /** A sentence across the whole width, wrapped. */
    const sentence = (text: string, style?: Partial<ExcelJS.Style>) => {
        const r = line([text], style);
        summary.mergeCells(r.number, 1, r.number, 6);
        r.getCell(1).alignment = { wrapText: true, vertical: "top" };
        r.height = 15 * Math.max(1, Math.ceil(text.length / 120));
        return r;
    };
    const longDate = (iso: string): string => asDate(iso)?.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) ?? iso;
    line([`MRP worksheet · ${context.company}`], { font: { bold: true, size: 14 } });
    line([`Plan from ${longDate(context.from)} through ${longDate(context.through)}`]);
    line([`Run ${context.run}`], { font: { color: { argb: "FF5F5E5A" } } });
    line([]);
    line(["What to do"], { font: { bold: true } });
    const vendors = new Set(buys.map((row) => String(row.Vendor ?? "")).filter((v) => !NO_VENDOR(v)));
    const late = buys.filter((row) => typeof row["Order By"] === "string" && row["Order By"] < context.from).length;
    const noVendor = buys.filter((row) => NO_VENDOR(String(row.Vendor ?? ""))).length;
    sentence(`1. To order: ${buys.length} line(s) from ${vendors.size} vendor(s)${late ? `; ${late} already late to order (red)` : ""}${noVendor ? `; ${noVendor} with no primary vendor, which need a vendor ID typed in before they can be ordered` : ""}. Set Approve to Yes, change Qty if you want, and save.`);
    sentence(`2. To make: ${makes.length} batch(es). Approve them the same way.`);
    sentence(`3. Follow up: ${followUps.filter((r) => r.Type === "EXPEDITE").length} receipt(s) to chase and ${followUps.filter((r) => r.Type === "NOT NEEDED").length} to review. That is done in EBMS or with the vendor; nothing on that tab is ordered from this file.`);
    sentence("4. Then ask Claude to create the purchase orders (or batches) from this file. Each one is shown to you before it is created.");
    line([]);

    if (buys.length > 0) {
        line(["Orders by vendor"], { font: { bold: true } });
        const head = line(["Vendor", "Lines", "Approved", "Est cost approved", "Earliest order by"], { font: { bold: true } });
        head.eachCell((cell) => { cell.fill = HEADER_FILL; });
        const col = (key: Column): string => `'To order'!$${letter(ORDER.findIndex((c) => c.key === key))}$2:$${letter(ORDER.findIndex((c) => c.key === key))}$${buys.length + 1}`;
        for (const vendor of [...new Set(buys.map((row) => String(row.Vendor ?? "")))]) {
            const mine = buys.filter((row) => String(row.Vendor ?? "") === vendor);
            const first = mine.map(urgency).sort()[0] ?? "";
            const r = summary.addRow([
                vendor || "(no primary vendor)",
                { formula: `COUNTIF(${col("Vendor")},A${summary.rowCount + 1})`, result: mine.length },
                { formula: `COUNTIFS(${col("Vendor")},A${summary.rowCount + 1},${col("Approve")},"Yes")`, result: 0 },
                { formula: `SUMIFS(${col("Est Cost")},${col("Vendor")},A${summary.rowCount + 1},${col("Approve")},"Yes")`, result: 0 },
                asDate(first) ?? "",
            ]);
            r.getCell(4).numFmt = "#,##0.00";
            r.getCell(5).numFmt = "d mmm yyyy";
            if (first < context.from) r.getCell(5).font = { color: LATE, bold: true };
            if (NO_VENDOR(vendor)) r.getCell(1).font = { color: LATE };
        }
        line([]);
    }
    if (context.notes.length > 0) {
        line(["Notes"], { font: { bold: true } });
        for (const note of context.notes) sentence(note);
    }
    return Buffer.from(await book.xlsx.writeBuffer());
}

/** A cell as the CSV reader would see it: text, with a date as yyyy-mm-dd and a formula as its result. */
function cellText(value: ExcelJS.CellValue): string {
    if (value === null || value === undefined) return "";
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === "object") {
        if ("result" in value) return cellText((value as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
        if ("richText" in value) return (value as ExcelJS.CellRichTextValue).richText.map((part) => part.text).join("");
        if ("text" in value) return String((value as ExcelJS.CellHyperlinkValue).text);
        return "";
    }
    return String(value);
}

/**
 * The rows of the tab a person approves one kind on (To order for BUY, To make for MAKE), keyed by
 * the worksheet's column names whatever the header says, with where each came from
 * ("To order row 7") for messages. The other tab is not read, so a problem there blocks nothing.
 */
export async function readWorkbook(data: Buffer, want: "BUY" | "MAKE" = "BUY"): Promise<{ rows: Array<Record<string, string>>; where: string[]; problems: string[] }> {
    const book = new ExcelJS.Workbook();
    try {
        await book.xlsx.load(data as unknown as ArrayBuffer);
    } catch {
        return { rows: [], where: [], problems: ["The file could not be opened as an Excel workbook (.xlsx). Save it from Excel or Google Sheets as .xlsx and try again."] };
    }
    const rows: Array<Record<string, string>> = [];
    const where: string[] = [];
    const problems: string[] = [];
    for (const spec of ACTION_SHEETS.filter((s) => s.type === want)) {
        const sheet = book.getWorksheet(spec.name);
        if (!sheet) { problems.push(`The workbook has no "${spec.name}" tab. It does not look like an MRP worksheet, or the tab was renamed.`); continue; }
        const byHeader = new Map(spec.columns.map((c) => [c.header.toLowerCase(), c.key] as const));
        const keys: Array<Column | undefined> = [];
        sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, n) => { keys[n] = byHeader.get(cellText(cell.value).trim().toLowerCase()); });
        for (let n = 2; n <= sheet.rowCount; n += 1) {
            // Every column either tab has, so the shared reader finds none missing (To make has no Vendor).
            const record: Record<string, string> = Object.fromEntries(ACTION_SHEETS.flatMap((s) => s.columns).map((c) => [c.key, ""]));
            let any = false;
            sheet.getRow(n).eachCell({ includeEmpty: false }, (cell, c) => {
                const key = keys[c];
                if (!key) return;
                record[key] = cellText(cell.value).trim();
                if (record[key]) any = true;
            });
            if (!any) continue;
            rows.push(record);
            where.push(`${spec.name} row ${n}`);
        }
    }
    return { rows, where, problems };
}
