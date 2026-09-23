/**
 * Read-back verification for ebms_write: did EBMS store what was sent?
 *
 * EBMS answers 200 to writes it only partly applies — an unknown @id is ignored, an
 * unwritable field is dropped, a quantity can come back as 0 — so the server re-reads
 * exactly the fields that were sent and compares them, with the arithmetic done here rather
 * than by a model. It is generic: it knows OData's shapes (scalars, `Nav@delta` arrays,
 * nested `Nav` arrays on a create) and nothing about any particular entity.
 */

export type Json = Record<string, unknown>;

export interface Mismatch {
    where: string;
    field: string;
    sent: unknown;
    stored: unknown;
}

export interface Verification {
    /** True only when every field sent was found stored as sent and nothing was missing. */
    ok: boolean;
    checked: number;
    mismatches: Mismatch[];
    /** Things that are not a field mismatch: a row that never appeared, rows EBMS added itself. */
    problems: string[];
    notes: string[];
    /** The stored values of every row the write touched or created. */
    rows: Array<{ where: string; stored: Json }>;
}

const TOLERANCE = 0.005;

const isPlainObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isScalar = (value: unknown): boolean => value === null || ["string", "number", "boolean"].includes(typeof value);
const isControlKey = (key: string): boolean => key.startsWith("@") || key.startsWith("#") || key.includes("@odata");

/** Numbers within half a cent, strings ignoring padding and line-ending style, null the same as empty. */
export function sameValue(sent: unknown, stored: unknown): boolean {
    // A value that was sent and came back as nothing is never "close enough": that is the
    // zeroed-quantity failure this check exists to catch, however small the number.
    if (typeof sent === "number" && typeof stored === "number") return sent !== 0 && stored === 0 ? false : Math.abs(sent - stored) < TOLERANCE;
    if (typeof sent === "number" && typeof stored === "string" && stored.trim() !== "" && !Number.isNaN(Number(stored))) return Math.abs(sent - Number(stored)) < TOLERANCE;
    if (typeof sent === "boolean" || typeof stored === "boolean") return sent === stored;
    const text = (value: unknown): string => (value === null || value === undefined ? "" : String(value).replace(/\r\n/g, "\n").trim());
    // A date sent as a day and stored as midnight of that day is the same date. EBMS documents
    // MM/DD/YYYY for input and stores ISO, so both spellings of a day are compared as a day.
    const dayOf = (value: string): string | null => {
        if (/^\d{4}-\d{2}-\d{2}(T00:00:00(\.0+)?(Z|[+-]00:00)?)?$/.test(value)) return value.slice(0, 10);
        const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
        return us ? `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}` : null;
    };
    const a = text(sent);
    const b = text(stored);
    if (dayOf(a) !== null && dayOf(a) === dayOf(b)) return true;
    return a === b;
}

export interface BodyShape {
    scalars: Json;
    /** `Nav@delta` arrays: entries with `@id` modify or remove, entries without add. */
    deltas: Record<string, Json[]>;
    /** Plain `Nav` arrays, as on a create: every entry is a new row. */
    creates: Record<string, Json[]>;
}

export function shapeOf(body: unknown): BodyShape {
    const shape: BodyShape = { scalars: {}, deltas: {}, creates: {} };
    if (!isPlainObject(body)) return shape;
    for (const [key, value] of Object.entries(body)) {
        if (key.endsWith("@delta") && Array.isArray(value)) shape.deltas[key.slice(0, -"@delta".length)] = value.filter(isPlainObject);
        else if (Array.isArray(value) && value.every(isPlainObject)) shape.creates[key] = value;
        else if (!isControlKey(key) && isScalar(value)) shape.scalars[key] = value;
    }
    return shape;
}

const idOf = (entry: Json): string | undefined => {
    const id = entry["@id"] ?? entry["#id"];
    return typeof id === "string" ? id : undefined;
};
const isRemoval = (entry: Json): boolean => entry["@removed"] === true || entry["#removed"] === true;

/** Scalar field names used anywhere in a set of entries — what the read-back must select. */
export function fieldsOf(entries: readonly Json[]): string[] {
    const names = new Set<string>();
    for (const entry of entries) for (const [key, value] of Object.entries(entry)) if (!isControlKey(key) && isScalar(value)) names.add(key);
    return [...names];
}

/** Child navigations an entry carries, either as a nested delta or a nested create array. */
export function childrenOf(entry: Json): BodyShape {
    const { deltas, creates } = shapeOf(entry);
    return { scalars: {}, deltas, creates };
}

function compareScalars(where: string, sent: Json, stored: Json | undefined, out: Verification): void {
    for (const [field, value] of Object.entries(sent)) {
        if (isControlKey(field) || !isScalar(value)) continue;
        out.checked += 1;
        const actual = stored?.[field];
        if (stored === undefined || !sameValue(value, actual)) out.mismatches.push({ where, field, sent: value, stored: stored === undefined ? "(row not found)" : actual });
    }
}

const label = (nav: string, entry: Json, index: number): string => {
    const name = [entry["INVEN"], entry["ID"], entry["DESCR"]].find((v) => typeof v === "string" && v.trim().length > 0);
    return `${nav}[${index + 1}]${typeof name === "string" ? ` ${name.trim().slice(0, 30)}` : ""}`;
};

/**
 * Checks one navigation's entries against the rows read back.
 * `before` is the set of row AUTOIDs that existed before the write; null means every row is
 * new (a create). Returns the stored row matched to each entry, so nested children can be
 * checked against the right parent.
 */
export function checkRows(where: string, nav: string, entries: readonly Json[], stored: readonly Json[], before: ReadonlySet<string> | null, out: Verification): Array<Json | undefined> {
    const byId = new Map(stored.map((row) => [String(row["AUTOID"] ?? ""), row]));
    const fresh = before === null ? [...stored] : stored.filter((row) => !before.has(String(row["AUTOID"] ?? "")));
    const adds = entries.filter((entry) => idOf(entry) === undefined);
    const claimed = new Set<Json>();
    const matched: Array<Json | undefined> = [];

    const takeFresh = (entry: Json): Json | undefined => {
        // EBMS appends in request order, so the first unclaimed new row is the candidate; prefer
        // one whose text fields agree, which keeps the match right when EBMS adds rows of its own.
        const texts = Object.entries(entry).filter(([key, value]) => !isControlKey(key) && typeof value === "string" && value.trim() !== "");
        const agrees = (row: Json): boolean => texts.every(([key, value]) => sameValue(value, row[key]));
        const pick = fresh.find((row) => !claimed.has(row) && agrees(row)) ?? fresh.find((row) => !claimed.has(row));
        if (pick) claimed.add(pick);
        return pick;
    };

    entries.forEach((entry, index) => {
        const at = `${where}${label(nav, entry, index)}`;
        const id = idOf(entry);
        if (id !== undefined && isRemoval(entry)) {
            out.checked += 1;
            if (byId.has(id)) out.problems.push(`${at}: row ${id} was to be removed but is still there.`);
            matched.push(undefined);
            return;
        }
        const row = id !== undefined ? byId.get(id) : takeFresh(entry);
        if (!row) {
            out.problems.push(id !== undefined ? `${at}: no row with @id ${id} — EBMS ignores an unknown @id without an error.` : `${at}: no new row appeared for this entry.`);
            compareScalars(at, entry, undefined, out);
            matched.push(undefined);
            return;
        }
        compareScalars(at, entry, row, out);
        out.rows.push({ where: at, stored: row });
        matched.push(row);
    });

    const unclaimed = fresh.filter((row) => !claimed.has(row));
    if ((adds.length > 0 || entries.length === 0) && unclaimed.length > 0) {
        out.notes.push(`${where}${nav}: EBMS added ${unclaimed.length} row(s) that were not in the request (${unclaimed.map((row) => String(row["INVEN"] ?? row["DESCR"] ?? row["AUTOID"] ?? "?").trim()).join(", ")}).`);
    }
    return matched;
}

export const emptyVerification = (): Verification => ({ ok: false, checked: 0, mismatches: [], problems: [], notes: [], rows: [] });

export function finish(out: Verification): Verification {
    out.ok = out.mismatches.length === 0 && out.problems.length === 0;
    return out;
}

/** Top-level scalars, compared against the record read back. */
export function checkRecord(sent: Json, stored: Json | undefined, out: Verification): void {
    compareScalars("record", sent, stored, out);
}
