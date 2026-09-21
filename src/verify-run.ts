/**
 * The reads around a write that make verification possible: which rows existed before, and
 * what is stored after. Kept apart from verify.ts so the comparison stays pure.
 *
 * Reads are as narrow as the write: only the fields that were sent (plus any the caller asks
 * to see), and nested children only for the parent rows the write touched — an unfiltered
 * nested expand costs EBMS tens of seconds on a large document.
 */
import { odataString, request } from "./ebms/client.js";
import { EbmsError } from "./ebms/errors.js";
import { checkRecord, checkRows, childrenOf, emptyVerification, fieldsOf, finish, shapeOf, type BodyShape, type Json, type Verification } from "./verify.js";

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PARENTS_PER_READ = 20;

export interface ReadBack {
    /** Extra top-level fields to return, e.g. "INVOICE,TOTAL_S_SO". */
    record?: string | undefined;
    /** Extra fields to return on every row the write touched, e.g. "UNIT_MEAS,UNIT_VIS,SO_AMOUNT". */
    lines?: string | undefined;
    /**
     * A child navigation to read under every NEW row, e.g. "Materials", so rows EBMS adds by
     * itself (an assembly kit's default components) are reported.
     */
    children?: string | undefined;
}

const clean = (names: readonly string[]): string[] => [...new Set(names.map((name) => name.trim()).filter((name) => FIELD_RE.test(name)))];
const split = (value: string | undefined): string[] => clean((value ?? "").split(","));
const query = (select: string[], expand: string[]): string => {
    const params = new URLSearchParams();
    params.set("$select", clean(["AUTOID", ...select]).join(","));
    if (expand.length > 0) params.set("$expand", expand.join(","));
    return `?${params.toString()}`;
};
const rowsOf = (record: Json | null, nav: string): Json[] => (Array.isArray(record?.[nav]) ? (record[nav] as Json[]) : []);
const idFilter = (ids: readonly string[]): string => ids.map((id) => `AUTOID eq ${odataString(id)}`).join(" or ");
const allEntries = (shape: BodyShape, nav: string): Json[] => [...(shape.deltas[nav] ?? []), ...(shape.creates[nav] ?? [])];
const navsOf = (shape: BodyShape): string[] => [...new Set([...Object.keys(shape.deltas), ...Object.keys(shape.creates)])].filter((nav) => FIELD_RE.test(nav));
const hasAdds = (entries: readonly Json[]): boolean => entries.some((entry) => typeof entry["@id"] !== "string" && typeof entry["#id"] !== "string");

export interface Before {
    rows: Record<string, Set<string>>;
    /** Child row IDs per `nav/parentId/childNav`. */
    children: Record<string, Set<string>>;
}

/** What existed before a PATCH, read only where the body adds rows. */
export async function readBefore(company: string, path: string, body: unknown): Promise<Before> {
    const shape = shapeOf(body);
    const before: Before = { rows: {}, children: {} };
    // A plain `Nav: [...]` array on a PATCH adds rows too, so the rows that were already there
    // must be known or an old row could be mistaken for the new one.
    const navsWithAdds = navsOf(shape).filter((nav) => shape.creates[nav] !== undefined || hasAdds(shape.deltas[nav] ?? []));
    if (navsWithAdds.length > 0) {
        const record = (await request(company, "GET", `${path}${query([], navsWithAdds.map((nav) => `${nav}($select=AUTOID)`))}`)).body as Json | null;
        for (const nav of navsWithAdds) before.rows[nav] = new Set(rowsOf(record, nav).map((row) => String(row["AUTOID"] ?? "")));
    }
    for (const nav of Object.keys(shape.deltas).filter((name) => FIELD_RE.test(name))) {
        const parents = new Map<string, string[]>();
        for (const entry of shape.deltas[nav] ?? []) {
            const id = typeof entry["@id"] === "string" ? entry["@id"] : undefined;
            if (id === undefined) continue;
            const kids = childrenOf(entry);
            const childNavs = navsOf(kids).filter((childNav) => hasAdds(allEntries(kids, childNav)));
            if (childNavs.length > 0) parents.set(id, childNavs);
        }
        const ids = [...parents.keys()];
        for (let i = 0; i < ids.length; i += PARENTS_PER_READ) {
            const batch = ids.slice(i, i + PARENTS_PER_READ);
            const childNavs = [...new Set(batch.flatMap((id) => parents.get(id) ?? []))];
            const expand = `${nav}($select=AUTOID;$filter=${idFilter(batch)};$expand=${childNavs.map((childNav) => `${childNav}($select=AUTOID)`).join(",")})`;
            const record = (await request(company, "GET", `${path}${query([], [expand])}`)).body as Json | null;
            for (const row of rowsOf(record, nav)) {
                for (const childNav of childNavs) before.children[`${nav}/${String(row["AUTOID"])}/${childNav}`] = new Set(rowsOf(row, childNav).map((child) => String(child["AUTOID"] ?? "")));
            }
        }
    }
    return before;
}

/**
 * Reads the record back and compares it with what was sent. `before` is null for a create,
 * where every row is new.
 */
export async function verifyWrite(company: string, path: string, body: unknown, before: Before | null, readBack: ReadBack = {}): Promise<Verification> {
    const out = emptyVerification();
    const shape = shapeOf(body);
    const navs = navsOf(shape);
    const extraLines = split(readBack.lines);

    const expand = navs.map((nav) => `${nav}($select=${clean(["AUTOID", ...fieldsOf(allEntries(shape, nav)), ...extraLines]).join(",")})`);
    const record = (await request(company, "GET", `${path}${query([...Object.keys(shape.scalars), ...split(readBack.record)], expand)}`)).body as Json | null;
    if (!record) {
        out.problems.push("The record could not be read back.");
        return finish(out);
    }
    checkRecord(shape.scalars, record, out);
    const { AUTOID: _a, "@odata.context": _c, ...top } = record;
    const topScalars = Object.fromEntries(Object.entries(top).filter(([key]) => !navs.includes(key)));
    if (Object.keys(topScalars).length > 0) out.rows.push({ where: "record", stored: topScalars });

    for (const nav of navs) {
        const entries = allEntries(shape, nav);
        const isCreate = before === null;
        const matched = checkRows("", nav, entries, rowsOf(record, nav), isCreate ? null : (before?.rows[nav] ?? new Set(rowsOf(record, nav).map((row) => String(row["AUTOID"])))), out);

        // Nested children, read only for the parents this write touched.
        const parents: Array<{ entry: Json; index: number; id: string; kids: BodyShape; isNew: boolean }> = [];
        const alwaysChild = readBack.children !== undefined && FIELD_RE.test(readBack.children.trim()) ? readBack.children.trim() : null;
        entries.forEach((entry, index) => {
            const kids = childrenOf(entry);
            const row = matched[index];
            const isNew = typeof entry["@id"] !== "string";
            if (alwaysChild !== null && isNew && kids.deltas[alwaysChild] === undefined && kids.creates[alwaysChild] === undefined) kids.creates[alwaysChild] = [];
            if (navsOf(kids).length > 0 && row) parents.push({ entry, index, id: String(row["AUTOID"]), kids, isNew });
        });
        for (let i = 0; i < parents.length; i += PARENTS_PER_READ) {
            const batch = parents.slice(i, i + PARENTS_PER_READ);
            const childNavs = [...new Set(batch.flatMap((parent) => navsOf(parent.kids)))];
            const childExpand = childNavs.map((childNav) => `${childNav}($select=${clean(["AUTOID", ...batch.flatMap((parent) => fieldsOf(allEntries(parent.kids, childNav))), ...extraLines]).join(",")})`);
            const nested = (await request(company, "GET", `${path}${query([], [`${nav}($select=AUTOID;$filter=${idFilter(batch.map((parent) => parent.id))};$expand=${childExpand.join(",")})`])}`)).body as Json | null;
            const byParent = new Map(rowsOf(nested, nav).map((row) => [String(row["AUTOID"]), row]));
            for (const parent of batch) {
                const parentRow = byParent.get(parent.id);
                for (const childNav of navsOf(parent.kids)) {
                    const known = parent.isNew ? null : (before?.children[`${nav}/${parent.id}/${childNav}`] ?? new Set<string>());
                    checkRows(`${nav}[${parent.index + 1}] › `, childNav, allEntries(parent.kids, childNav), parentRow ? rowsOf(parentRow, childNav) : [], known, out);
                }
            }
        }
    }
    return finish(out);
}

/** A DELETE is verified by the record no longer being readable. */
export async function verifyDelete(company: string, path: string): Promise<Verification> {
    const out = emptyVerification();
    out.checked = 1;
    try {
        await request(company, "GET", `${path}?%24select=AUTOID`);
        out.problems.push("The record is still there after the DELETE.");
    } catch (error) {
        // Only "not found" proves it is gone. EBMS says that as a 404, or a 400/422 "Key not found".
        const status = error instanceof EbmsError ? error.status : -1;
        const gone = status === 404 || ((status === 400 || status === 422) && /key not found|not found/i.test(error instanceof EbmsError ? `${error.message} ${error.detail ?? ""}` : ""));
        if (!gone) out.problems.push(`Could not confirm the record is gone: the read-back failed (${error instanceof Error ? error.message : String(error)}). Read it again before assuming the DELETE worked.`);
    }
    return finish(out);
}
