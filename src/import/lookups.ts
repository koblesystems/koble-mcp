/**
 * What EBMS already holds that an import depends on: records with the same key (skipped, not
 * created again), records an earlier run of this import created (found by EXTERNALID), and the
 * folders, vendors, products and units the rows point at. Reads only.
 */
import { odataString } from "../ebms/client.js";
import { EbmsError } from "../ebms/errors.js";
import { readAll, readByIds } from "../mrp/snapshot.js";
import type { EntityMeta } from "./metadata.js";
import { keyFields } from "./mapping.js";
import type { EntityRule, LookupSpec } from "./rules.js";
import type { CheckedRow, Issue } from "./validate.js";
import { keyOf } from "./validate.js";

type Row = Record<string, unknown>;
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const upper = (value: unknown): string => text(value).toUpperCase();
/**
 * Rows whose field is one of `ids`, ignoring case. EBMS compares `eq` case-sensitively (on COF
 * `ID eq 'padep'` finds nothing while `PADEP` exists) and `tolower(ID) eq …` fails outright, but
 * `toupper(ID) eq …` works, so keys are matched upper-cased.
 */
const readByIdsAnyCase = (company: string, entity: string, field: string, ids: readonly string[], select: string): Promise<Row[]> =>
    readByIds(company, entity, `toupper(${field})`, ids.map((id) => id.toUpperCase()), select);

/** A folder row EBMS keeps for a folder's defaults, e.g. ID "($)   26"; never a real record. */
const isDefaultsRow = (value: unknown): boolean => text(value).startsWith("($)");

/** The EXTERNALID prefix every record of one import carries. */
export const importPrefix = (importId: string): string => `claude-import-${importId}-`;
/** The row an import's EXTERNALID was made for, or null. */
function rowOfExternalId(externalId: string, importId: string): number | null {
    if (!externalId.startsWith(importPrefix(importId))) return null;
    const match = /-r(\d+)$/.exec(externalId);
    return match ? Number(match[1]) : null;
}

export interface Resolved {
    folder?: string;
    vendor?: string;
}

export interface Lookups {
    /** Rows whose key is already in EBMS, with what is there. */
    existing: Map<number, Row>;
    /** Rows an earlier run of this import created (by EXTERNALID). */
    created: Map<number, Row>;
    issues: Issue[];
    resolved: Map<number, Resolved>;
    /** Values to send instead of what the row says, e.g. a folder's name replaced by its number. */
    replace: Map<number, Record<string, string>>;
    /** Folder rows whose parent is another row of this import that is not in EBMS yet: drafted on the next run. */
    waiting: Set<number>;
    /** Product ID (upper case) -> AUTOID, for PATCHing child rows onto it. */
    products: Map<string, string>;
    /** Rows with no key of their own (a customer EBMS numbers) whose name, and ZIP where given, match a record already there. */
    likely?: Map<number, Row>;
    notes: string[];
}

/** A read that may fail because this install does not expose the entity or field: reported, not fatal. */
async function tryRead<T>(what: string, notes: string[], read: () => Promise<T>, fallback: T): Promise<T> {
    try {
        return await read();
    } catch (error) {
        if (error instanceof EbmsError && error.status >= 400 && error.status < 500) {
            notes.push(`${what} could not be checked (${error.detail ?? error.message}); those values were not checked against EBMS.`);
            return fallback;
        }
        throw error;
    }
}

/** Records whose EXTERNALID starts with this import's prefix: one read, or exact reads of every row's EXTERNALID where startswith is not supported. */
async function createdByThisImport(company: string, entity: string, importId: string, rows: readonly CheckedRow[], externalIdFor: (row: number) => string, select: string): Promise<Row[]> {
    try {
        return await readAll(company, entity, { $filter: `startswith(EXTERNALID,${odataString(importPrefix(importId))})`, $select: select });
    } catch (error) {
        if (!(error instanceof EbmsError && error.status === 400)) throw error;
        return readByIds(company, entity, "EXTERNALID", rows.map((r) => externalIdFor(r.row)), select);
    }
}

export async function lookUp(company: string, rule: EntityRule, meta: EntityMeta, rows: readonly CheckedRow[], options: { importId: string; externalIdFor: (row: number) => string }): Promise<Lookups> {
    const out: Lookups = { existing: new Map(), created: new Map(), issues: [], resolved: new Map(), replace: new Map(), waiting: new Set(), products: new Map(), notes: [] };
    const keys = keyFields(rule, meta);

    // 1. What this import already created, and what is already there by key or by the file's own EXTERNALID.
    if (rule.route === "post" && rule.folder) await lookUpFolders(company, rule, rows, out);
    else if (rule.route === "post") {
        const keyField = keys[0] as string;
        const labels = rule.label.filter((f) => meta.fields.has(f));
        const select = [...new Set(["AUTOID", ...keys, ...labels, ...(meta.hasExternalId ? ["EXTERNALID"] : [])])].join(",");
        if (meta.hasExternalId) {
            const claim = (r: CheckedRow, record: Row): void => {
                // A marker on a different record means the file changed since that run (a row deleted
                // or moved, or another file under the same name). Never skip a row on the marker alone.
                if (sameRecord(r, record, keys, labels)) { out.created.set(r.row, record); return; }
                const there = keyOf(keys, record) || labels.map((f) => text(record[f])).filter(Boolean).join(" ");
                out.issues.push({ row: r.row, kind: "id-taken", field: "EXTERNALID", value: text(record["EXTERNALID"]), text: `an earlier run of this import created ${there || "a different record"} for row ${r.row}; this row is ${r.key || labels.map((f) => text(r.values[f])).filter(Boolean).join(" ")}` });
            };
            const byRow = new Map(rows.map((r) => [r.row, r]));
            for (const record of await createdByThisImport(company, rule.entity, options.importId, rows, options.externalIdFor, select)) {
                const row = rowOfExternalId(text(record["EXTERNALID"]), options.importId);
                // Only rows of this file: an exceptions file holds a few rows of a bigger import.
                const r = row === null ? undefined : byRow.get(row);
                if (r && typeof r.values["EXTERNALID"] !== "string") claim(r, record);
            }
            const ownIds = rows.filter((r) => typeof r.values["EXTERNALID"] === "string").map((r) => String(r.values["EXTERNALID"]));
            if (ownIds.length > 0) {
                const found = new Map((await readByIds(company, rule.entity, "EXTERNALID", ownIds, select)).map((record) => [upper(record["EXTERNALID"]), record]));
                for (const r of rows) {
                    const record = found.get(upper(r.values["EXTERNALID"]));
                    if (record) claim(r, record);
                }
            }
        }
        const taken = new Set(out.issues.map((i) => i.row));
        const open = rows.filter((r) => r.key !== "" && !out.created.has(r.row) && !taken.has(r.row));
        // A two-part key (a bill-of-materials line: product and component) is read by its first part.
        const there = await readByIdsAnyCase(company, rule.entity, keyField, open.map((r) => String(r.values[keyField])), select);
        const byKey = new Map(there.filter((record) => !isDefaultsRow(record[keyField])).map((record) => [keyOf(keys, record), record]));
        for (const r of open) if (byKey.has(r.key)) out.existing.set(r.row, byKey.get(r.key) as Row);
        if (rule.keyOptional) await likelyMatches(company, rule, meta, rows.filter((r) => r.key === "" && !out.created.has(r.row) && !taken.has(r.row)), out);
    }

    // 2. Products a child row hangs on, and the rows each already has.
    const flagged = new Set(out.issues.map((i) => i.row));
    const pending = rows.filter((r) => !out.created.has(r.row) && !out.existing.has(r.row) && !flagged.has(r.row));
    // Every product the rows name (a bill of materials' product and its components), read once.
    const productSpecs = rule.lookups.filter((l) => l.entity === "INVENTRY" && l.key === "ID" && !l.byName && !l.perProduct);
    const productIds = (of: readonly CheckedRow[]): string[] => [...new Set(productSpecs.flatMap((l) => of.map((r) => text(r.values[l.field]).toUpperCase())).filter(Boolean))];
    let products: Row[] | null = null;
    if (rule.route === "child") {
        products = await readByIdsAnyCase(company, "INVENTRY", "ID", productIds(pending), "AUTOID,ID");
        // A product without an AUTOID could only be PATCHed at INVENTRY(''): treat it as missing.
        for (const record of products) if (text(record["AUTOID"])) out.products.set(upper(record["ID"]), text(record["AUTOID"]));
        const second = keys[1] as string;
        const children = await readByIdsAnyCase(company, rule.entity, "ID", [...new Set(pending.map((r) => text(r.values["ID"])))], `ID,${second}`);
        const have = new Set(children.map((record) => `${upper(record["ID"])} / ${upper(record[second])}`));
        for (const r of pending) if (have.has(r.key)) out.existing.set(r.row, { ID: r.values["ID"], [second]: r.values[second] });
    }

    // 3. Every other record the rows point at.
    const live = pending.filter((r) => !out.existing.has(r.row));
    if (products === null && productSpecs.length > 1) products = await tryRead<Row[] | null>("Products", out.notes, () => readByIdsAnyCase(company, "INVENTRY", "ID", productIds(live), "ID"), null);
    for (const spec of rule.lookups) {
        if (!meta.fields.has(spec.field) && !(rule.route === "child" && spec.field === "ID")) continue;
        const wanted = live.filter((r) => text(r.values[spec.field]) !== "");
        if (wanted.length === 0) continue;
        if (spec.field === "ID" && rule.route === "child") {
            for (const r of wanted) if (!out.products.has(upper(r.values["ID"]))) missing(out, r, spec);
            continue;
        }
        if (spec.perProduct) {
            await checkUnits(company, wanted, spec, out);
            continue;
        }
        const records = products !== null && spec.entity === "INVENTRY" && spec.key === "ID" ? products : await tryRead<Row[] | null>(`${spec.field} (against ${spec.entity})`, out.notes, async () =>
            spec.key === "TREE_ID" || spec.byName
                ? (await readAll(company, spec.entity, { $select: [spec.key, ...(spec.byName ? [spec.byName] : [])].join(",") })).filter((record) => !isDefaultsRow(record[spec.key]))
                : readByIdsAnyCase(company, spec.entity, spec.key, wanted.map((r) => text(r.values[spec.field])), spec.entity === "APVENDOR" ? "ID,L_NAME,F_NAME" : spec.key), null);
        if (records === null) continue;
        const byKey = new Map(records.map((record) => [upper(record[spec.key]), record]));
        for (const r of wanted) {
            const value = text(r.values[spec.field]);
            let record = byKey.get(value.toUpperCase());
            if (!record && spec.byName) {
                const named = records.filter((candidate) => upper(candidate[spec.byName as string]) === value.toUpperCase());
                if (named.length > 1) {
                    out.issues.push({ row: r.row, kind: "ambiguous", field: spec.field, value, noun: spec.noun, text: `${spec.field} "${value}" matches ${named.length} ${spec.noun}s: ${named.map((n) => text(n[spec.key])).join(", ")}` });
                    continue;
                }
                record = named[0];
                if (record) out.replace.set(r.row, { ...(out.replace.get(r.row) ?? {}), [spec.field]: text(record[spec.key]) });
            }
            if (!record) {
                missing(out, r, spec);
                continue;
            }
            const resolved = out.resolved.get(r.row) ?? {};
            if (spec.noun === "folder") resolved.folder = `${text(record[spec.key])} ${text(record[spec.byName ?? ""])}`.trim();
            if (spec.entity === "APVENDOR") resolved.vendor = `${text(record["ID"])} ${text(record["F_NAME"])} ${text(record["L_NAME"])}`.replace(/\s+/g, " ").trim();
            out.resolved.set(r.row, resolved);
        }
    }
    return out;
}

/** EBMS's padded form of a folder number: right-aligned in five characters, as it stores and matches them. */
const padFolder = (value: string): string => value.trim().padStart(5, " ");

/**
 * Folders. EBMS numbers a new folder itself (sending TREE_ID is refused) and finds a parent only by
 * its padded number, so a row is matched to EBMS by its name under its parent, and its parent is
 * named by EBMS number, by the name of a folder in EBMS, or by another row of the file (its
 * Folder column, which is only the old system's number, or its name). A row whose parent is
 * another row not yet in EBMS waits for the next run, when that parent exists and has a number.
 */
async function lookUpFolders(company: string, rule: EntityRule, rows: readonly CheckedRow[], out: Lookups): Promise<void> {
    const folders = (await readAll(company, rule.entity, { $select: "AUTOID,TREE_ID,PARENT_ID,TREE_DESCR" })).filter((f) => !isDefaultsRow(f["TREE_ID"]));
    const byNumber = new Map(folders.map((f) => [text(f["TREE_ID"]), f]));
    const nameUnder = (parent: string, name: string): Row | undefined => folders.find((f) => text(f["PARENT_ID"]) === parent && upper(f["TREE_DESCR"]) === name.toUpperCase());
    const localOf = (r: CheckedRow): string[] => [text(r.values["TREE_ID"]).toUpperCase(), text(r.values["TREE_DESCR"]).toUpperCase()].filter(Boolean);
    /** Other rows of the file a row's parent reference names (by their Folder or their Name). */
    const inFileParents = (r: CheckedRow): CheckedRow[] => {
        const ref = text(r.values["PARENT_ID"]).toUpperCase();
        return rows.filter((other) => other !== r && localOf(other).includes(ref));
    };
    // A row's EBMS number once it exists, found by its name under its resolved parent.
    const numberOf = new Map<number, string | null>();
    const resolving = new Set<number>();
    const resolve = (r: CheckedRow): string | null => {
        if (numberOf.has(r.row)) return numberOf.get(r.row) ?? null;
        if (resolving.has(r.row)) return null;
        resolving.add(r.row);
        const parent = parentOf(r);
        const found = parent ? nameUnder(parent, text(r.values["TREE_DESCR"])) : undefined;
        resolving.delete(r.row);
        const number = found ? text(found["TREE_ID"]) : null;
        numberOf.set(r.row, number);
        return number;
    };
    const parentOf = (r: CheckedRow): string | null => {
        const ref = text(r.values["PARENT_ID"]);
        const inFile = inFileParents(r);
        if (inFile.length > 1) return null;
        if (inFile[0]) return resolve(inFile[0]);
        if (byNumber.has(ref)) return ref;
        const named = folders.filter((f) => upper(f["TREE_DESCR"]) === ref.toUpperCase());
        return named.length === 1 ? text((named[0] as Row)["TREE_ID"]) : null;
    };
    // The same folder named twice (its parent by number on one row, by name on another) would be created twice.
    const drafted = new Map<string, number>();
    for (const r of rows) {
        const ref = text(r.values["PARENT_ID"]);
        const candidates = inFileParents(r);
        if (candidates.length > 1) {
            out.issues.push({ row: r.row, kind: "ambiguous", field: "PARENT_ID", value: ref, noun: "parent folder", text: `PARENT_ID "${ref}" matches ${candidates.length} rows of this file (rows ${candidates.map((c) => c.row).join(", ")}); use the parent's Folder number` });
            continue;
        }
        const inFile = candidates[0];
        const parent = parentOf(r);
        if (parent === null && !inFile) {
            const named = folders.filter((f) => upper(f["TREE_DESCR"]) === ref.toUpperCase());
            if (named.length > 1) out.issues.push({ row: r.row, kind: "ambiguous", field: "PARENT_ID", value: ref, noun: "parent folder", text: `PARENT_ID "${ref}" matches ${named.length} folders: ${named.map((n) => text(n["TREE_ID"])).join(", ")}; use its number` });
            else out.issues.push({ row: r.row, kind: "missing", field: "PARENT_ID", value: ref, noun: "parent folder", text: `PARENT_ID "${ref}" is not a folder in EBMS or in this file` });
            continue;
        }
        if (parent === null) {
            // Follow the rows' own parent links: one that comes back to this row is a loop, never resolved.
            let at: CheckedRow | undefined = inFile;
            for (let step = 0; at && step <= rows.length; step += 1) {
                if (at === r) break;
                const next = text(at.values["PARENT_ID"]).toUpperCase();
                at = rows.find((other) => other !== at && localOf(other).includes(next));
            }
            if (at === r) out.issues.push({ row: r.row, kind: "folder-cycle", field: "PARENT_ID", value: ref, text: `PARENT_ID "${ref}" leads back to this folder` });
            else out.waiting.add(r.row);
            continue;
        }
        const existing = nameUnder(parent, text(r.values["TREE_DESCR"]));
        if (existing) { out.existing.set(r.row, existing); continue; }
        const identity = `${parent} / ${upper(r.values["TREE_DESCR"])}`;
        const first = drafted.get(identity);
        if (first !== undefined) {
            out.issues.push({ row: r.row, kind: "duplicate", field: "PARENT_ID/TREE_DESCR", value: identity, text: `the same folder (${text(r.values["TREE_DESCR"])} under ${parent}) is also on row ${first}; this copy is ignored` });
            continue;
        }
        drafted.set(identity, r.row);
        out.replace.set(r.row, { PARENT_ID: padFolder(parent) });
        const parentRow = byNumber.get(parent);
        out.resolved.set(r.row, { folder: `under ${parent}${parentRow ? ` ${text(parentRow["TREE_DESCR"])}` : ""}` });
    }
}

/** Whether a record an earlier run created is the one this row describes: same key, or for a row without one (a customer EBMS numbered) the same name. */
function sameRecord(r: CheckedRow, record: Row, keys: readonly string[], labels: readonly string[]): boolean {
    if (r.key !== "") return keyOf(keys, record) === r.key;
    const named = labels.filter((f) => text(r.values[f]) !== "");
    return named.length > 0 && named.every((f) => upper(record[f]) === upper(r.values[f]));
}

/**
 * Rows without a key match nothing by key, so a customer list pasted again would be drafted
 * again. Same name (and same ZIP, where the row has one) as a record already there is reported,
 * not skipped: two customers can share a name.
 */
async function likelyMatches(company: string, rule: EntityRule, meta: EntityMeta, rows: readonly CheckedRow[], out: Lookups): Promise<void> {
    const name = rule.label.find((f) => meta.fields.has(f));
    if (!name || rows.length === 0) return;
    const zip = meta.fields.has("ZIP") ? "ZIP" : null;
    const wanted = rows.filter((r) => text(r.values[name]) !== "");
    const select = [...new Set(["ID", ...rule.label.filter((f) => meta.fields.has(f)), ...(zip ? [zip] : [])])].join(",");
    const there = await tryRead<Row[]>(`${rule.plural} with the same name`, out.notes, () => readByIdsAnyCase(company, rule.entity, name, wanted.map((r) => text(r.values[name])), select), []);
    const zipOf = (value: unknown): string => text(value).replace(/\s/g, "").slice(0, 5).toUpperCase();
    for (const r of wanted) {
        const match = there.find((record) => rule.label.every((f) => !meta.fields.has(f) || text(r.values[f]) === "" || upper(record[f]) === upper(r.values[f]))
            && (!zip || text(r.values[zip]) === "" || zipOf(record[zip]) === zipOf(r.values[zip])));
        if (match) (out.likely ??= new Map()).set(r.row, match);
    }
}

function missing(out: Lookups, r: CheckedRow, spec: LookupSpec): void {
    const value = text(r.values[spec.field]);
    out.issues.push({ row: r.row, kind: "missing", field: spec.field, value, noun: spec.noun, text: `${spec.field} "${value}": no such ${spec.noun} in EBMS` });
}

/** A vendor record's unit must be one of that product's units. */
async function checkUnits(company: string, rows: readonly CheckedRow[], spec: LookupSpec, out: Lookups): Promise<void> {
    const units = await readByIdsAnyCase(company, "INVENUNT", "ID", [...new Set(rows.map((r) => text(r.values["ID"])))], "ID,UNIT");
    const have = new Set(units.map((u) => `${upper(u["ID"])} / ${upper(u["UNIT"])}`));
    for (const r of rows) {
        if (have.has(`${upper(r.values["ID"])} / ${upper(r.values[spec.field])}`)) continue;
        out.issues.push({ row: r.row, kind: "missing", field: spec.field, value: text(r.values[spec.field]), noun: "unit of that product", text: `${spec.field} "${text(r.values[spec.field])}" is not one of ${text(r.values["ID"])}'s units` });
    }
}
