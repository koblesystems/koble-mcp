/**
 * The writes an import would make, one per row (or one per product for units, vendor records
 * and bills of materials), in the order they must be made. This shapes; it decides nothing:
 *
 *   - Body keys go in the order EBMS needs (TREE_ID first for customers, vendors and workers,
 *     or the create fails), then the file's columns in file order, then EXTERNALID.
 *   - A folder is drafted only once its parent exists in EBMS (lookups decide which wait), so
 *     a file of nested folders takes one run per level.
 *   - Child rows are grouped by product, in order of first appearance, at most 50 to a PATCH,
 *     so one product's rows are one write a person can read.
 *   - The window (rowsFrom, rowsTo, maxDrafts) only bounds what is returned; the order is the
 *     same whatever the window.
 */
import type { EntityMeta } from "./metadata.js";
import type { Lookups, Resolved } from "./lookups.js";
import { importPrefix } from "./lookups.js";
import type { EntityRule } from "./rules.js";
import type { CheckedRow, Issue } from "./validate.js";

export const CHILD_ROWS_PER_PATCH = 50;

export interface WriteEnvelope {
    tool: "ebms_write";
    method: "POST" | "PATCH";
    path: string;
    body: Record<string, unknown>;
    readBack?: { record?: string; lines?: string };
}

export interface Draft {
    row: number;
    /** Every row a child PATCH carries. */
    rows?: number[];
    key: string;
    label: string;
    externalId?: string;
    unverified?: true;
    resolved: Resolved;
    write: WriteEnvelope;
}

export interface DraftSet {
    drafts: Draft[];
    /** Rows that could be drafted, in write order. */
    ready: number;
    issues: Issue[];
    nextRowsFrom: number | null;
    notes: string[];
}

/** The EXTERNALID a row's create carries: <= 50 characters, and found again by the import's prefix. */
export function externalIdFor(importId: string, date: string, row: number): string {
    return `${importPrefix(importId)}${date}-r${row}`;
}

function bodyOf(rule: EntityRule, row: CheckedRow, replace: Record<string, string> | undefined, externalId: string | undefined, leaveOut: readonly string[] = []): Record<string, unknown> {
    const values: Record<string, unknown> = { ...row.values, ...(replace ?? {}) };
    // A record's folder goes unpadded; EBMS pads it. (A folder's parent arrives already padded from the lookups: EBMS will not pad that one.)
    if (typeof values["TREE_ID"] === "string") values["TREE_ID"] = values["TREE_ID"].trim();
    const body: Record<string, unknown> = {};
    for (const field of rule.order) if (values[field] !== undefined && !leaveOut.includes(field)) body[field] = values[field];
    for (const [field, value] of Object.entries(values)) if (!(field in body) && field !== "EXTERNALID" && !leaveOut.includes(field)) body[field] = value;
    const own = values["EXTERNALID"];
    if (typeof own === "string") body["EXTERNALID"] = own;
    else if (externalId) body["EXTERNALID"] = externalId;
    return body;
}

const labelOf = (rule: EntityRule, row: CheckedRow): string =>
    rule.label.map((field) => String(row.values[field] ?? "").trim()).filter(Boolean).join(" ") || row.key;

export interface DraftOptions {
    company: string;
    importId: string;
    date: string;
    rowsFrom?: number | undefined;
    rowsTo?: number | undefined;
    maxDrafts: number;
}

/** Drafts for the rows that are valid, not in EBMS and not created by an earlier run. */
export function buildDrafts(rule: EntityRule, meta: EntityMeta, rows: readonly CheckedRow[], lookups: Lookups, options: DraftOptions): DraftSet {
    const notes: string[] = [];
    const unverified = rule.tier !== "verified" ? ({ unverified: true } as const) : {};
    const inWindow = (row: number): boolean => row >= (options.rowsFrom ?? 0) && row <= (options.rowsTo ?? Number.MAX_SAFE_INTEGER);

    if (rule.route === "child") {
        const groups = new Map<string, CheckedRow[]>();
        for (const row of rows) {
            const product = String(row.values["ID"] ?? "").trim().toUpperCase();
            groups.set(product, [...(groups.get(product) ?? []), row]);
        }
        const all: Draft[] = [];
        for (const [product, members] of groups) {
            const autoId = lookups.products.get(product) as string;
            for (let i = 0; i < members.length; i += CHILD_ROWS_PER_PATCH) {
                const chunk = members.slice(i, i + CHILD_ROWS_PER_PATCH);
                const first = chunk[0] as CheckedRow;
                all.push({
                    row: first.row,
                    rows: chunk.map((r) => r.row),
                    key: String(first.values["ID"]),
                    label: `${chunk.length} ${chunk.length === 1 ? rule.plural.replace(/s$/, "") : rule.plural} for ${String(first.values["ID"])}`,
                    ...unverified,
                    resolved: {},
                    write: { tool: "ebms_write", method: "PATCH", path: `INVENTRY('${autoId}')`, body: { [rule.collection as string]: chunk.map((r) => bodyOf(rule, r, lookups.replace.get(r.row), undefined, ["ID"])) } },
                });
            }
        }
        return windowed(all, inWindow, options.maxDrafts, notes, rows.length);
    }

    const all: Draft[] = [...rows].sort((a, b) => a.row - b.row).map((row) => {
        const externalId = meta.hasExternalId && typeof row.values["EXTERNALID"] !== "string" ? externalIdFor(options.importId, options.date, row.row) : undefined;
        const body = bodyOf(rule, row, lookups.replace.get(row.row), externalId, rule.neverSend);
        return {
            row: row.row,
            key: row.key,
            label: labelOf(rule, row),
            ...(typeof body["EXTERNALID"] === "string" ? { externalId: body["EXTERNALID"] } : {}),
            ...unverified,
            resolved: lookups.resolved.get(row.row) ?? {},
            write: { tool: "ebms_write", method: "POST", path: rule.entity, body, ...(rule.readBack ? { readBack: rule.readBack } : {}) },
        };
    });
    return windowed(all, inWindow, options.maxDrafts, notes, all.length);
}

function windowed(all: Draft[], inWindow: (row: number) => boolean, maxDrafts: number, notes: string[], ready: number): DraftSet {
    const candidates = all.filter((d) => inWindow(d.row));
    const drafts = candidates.slice(0, maxDrafts);
    const rest = candidates.slice(maxDrafts);
    let nextRowsFrom: number | null = null;
    if (rest.length > 0) nextRowsFrom = Math.min(...rest.map((d) => d.row));
    return { drafts, ready, issues: [], nextRowsFrom, notes };
}
