/**
 * Which column is which field, and what a cell means as that field's type. A column is matched
 * by, in order: the caller's mapping, the field's own name, a header people use for it on this
 * entity, one they use on any entity, and the field's label in EBMS. Matching ignores case,
 * spaces and punctuation. Nothing is guessed beyond that: an unmatched column is reported.
 */
import { parseDate } from "../mrp/csv.js";
import type { EntityMeta, FieldInfo } from "./metadata.js";
import { writable } from "./metadata.js";
import type { EntityRule, EnumSpec } from "./rules.js";
import { GLOBAL_ALIASES, squash } from "./rules.js";

export type MatchedBy = "your mapping" | "field name" | "alias" | "EBMS label";

export interface MappedColumn {
    header: string;
    field: string;
    by: MatchedBy;
}

export interface Mapping {
    columns: MappedColumn[];
    /** Field -> header. */
    byField: Map<string, string>;
    unmapped: string[];
    notes: string[];
    fatal: string[];
}

/** The key fields a row is matched on: the rule's, else the entity's natural key. */
export function keyFields(rule: EntityRule, meta: EntityMeta): string[] {
    if (rule.key.length > 0) return [...rule.key];
    return meta.naturalKey ? [meta.naturalKey] : [];
}

/** Fields a file may fill: writable ones, plus the key fields (a child row's product ID is read-only on the child but names the product). */
function fillable(rule: EntityRule, meta: EntityMeta, name: string): FieldInfo | undefined {
    const field = meta.fields.get(name);
    if (writable(field)) return field;
    if (field && keyFields(rule, meta).includes(name)) return field;
    return undefined;
}

export function resolveMapping(headers: readonly string[], rule: EntityRule, meta: EntityMeta, explicit: Readonly<Record<string, string>> = {}, defaults: Readonly<Record<string, unknown>> = {}): Mapping {
    const fatal: string[] = [];
    const notes: string[] = [];
    const byName = new Map([...meta.fields.keys()].map((name) => [squash(name), name] as const));
    const byLabel = new Map<string, string | null>();
    for (const field of meta.fields.values()) {
        if (!field.label) continue;
        const key = squash(field.label);
        byLabel.set(key, byLabel.has(key) ? null : field.name);
    }
    const explicitByHeader = new Map(Object.entries(explicit).map(([header, field]) => [header.trim().toLowerCase(), field.trim()] as const));
    for (const header of explicitByHeader.keys()) {
        if (!headers.some((h) => h.toLowerCase() === header)) fatal.push(`The mapping names a column "${header}" that is not in the file. Its columns: ${headers.map((h) => `"${h}"`).join(", ")}.`);
    }

    const columns: MappedColumn[] = [];
    const unmapped: string[] = [];
    for (const header of headers) {
        const wanted = explicitByHeader.get(header.toLowerCase());
        if (wanted !== undefined) {
            if (wanted === "") { unmapped.push(header); continue; }
            const name = byName.get(squash(wanted));
            const field = name ? meta.fields.get(name) : undefined;
            if (!name || !field) { fatal.push(`The mapping sends "${header}" to ${wanted}, which is not a field of ${meta.entity}.`); continue; }
            if (!fillable(rule, meta, name)) { fatal.push(`The mapping sends "${header}" to ${name}, which EBMS ${field.virtual ? "computes" : "does not let you write"}.`); continue; }
            columns.push({ header, field: name, by: "your mapping" });
            continue;
        }
        const squashed = squash(header);
        const candidates: Array<[string | null | undefined, MatchedBy]> = [
            [byName.get(squashed), "field name"],
            [rule.aliases[squashed], "alias"],
            [GLOBAL_ALIASES[squashed], "alias"],
            [byLabel.get(squashed), "EBMS label"],
        ];
        const hit = candidates.find(([name]) => typeof name === "string" && meta.fields.has(name));
        if (!hit) { unmapped.push(header); continue; }
        const name = hit[0] as string;
        if (!fillable(rule, meta, name)) {
            notes.push(`"${header}" matches ${name}, which EBMS ${meta.fields.get(name)?.virtual ? "computes" : "does not let you write"}; the column is left out.`);
            continue;
        }
        columns.push({ header, field: name, by: hit[1] });
    }

    const byField = new Map<string, string>();
    for (const column of columns) {
        const other = byField.get(column.field);
        if (other !== undefined) fatal.push(`Two columns, "${other}" and "${column.header}", both map to ${column.field}. Pass a mapping that sends one of them to "" (left out).`);
        else byField.set(column.field, column.header);
    }
    for (const field of Object.keys(defaults)) {
        if (!byName.has(squash(field)) || !fillable(rule, meta, byName.get(squash(field)) as string)) fatal.push(`defaults names ${field}, which is not a field of ${meta.entity} you can write.`);
    }
    const keys = keyFields(rule, meta);
    const keyRequired = !rule.keyOptional && rule.route === "post";
    for (const key of keys) {
        const childKey = rule.route === "child";
        if ((keyRequired || childKey) && !byField.has(key) && !Object.keys(defaults).some((f) => squash(f) === squash(key))) {
            fatal.push(`No column holds ${key}${meta.fields.get(key)?.label ? ` (${meta.fields.get(key)?.label})` : ""}, which identifies each ${rule.entity} row. Columns: ${headers.map((h) => `"${h}"`).join(", ")}. Pass a mapping that names it.`);
        }
    }
    // A key EBMS will not take from the API means the record cannot be created through it at all (INWH, INPRICE on 1.8.184).
    const lockedKey = rule.route === "post" && !rule.keyOptional ? keys.find((key) => meta.fields.get(key)?.readOnly && !(rule.sendsReadOnly ?? []).includes(key)) : undefined;
    if (lockedKey) fatal.push(`EBMS does not let the API set ${lockedKey}, the key of ${meta.entity}, so these records cannot be created here. Set them up in EBMS.`);
    if (keys.length === 0) fatal.push(`EBMS publishes no key for ${meta.entity}, so rows cannot be matched to what already exists. Set these up in EBMS.`);
    return { columns, byField, unmapped, notes, fatal };
}

export type Coerced = { ok: true; value: string | number | boolean; unlisted?: true } | { ok: false; why: string };

/**
 * A number as people type one: $1,250.00, -3, (3.00), 6%, 0.5. Thousands commas must be in
 * the right places; anything a locale could read two ways (1.250,00) is refused.
 */
export function parseNumber(text: string): number | null {
    let clean = text.trim().replace(/\s+/g, "");
    let negative = false;
    if (/^\(.*\)$/.test(clean)) { negative = true; clean = clean.slice(1, -1); }
    if (clean.startsWith("-")) { negative = !negative; clean = clean.slice(1); }
    else if (clean.startsWith("+")) clean = clean.slice(1);
    clean = clean.replace(/^\$/, "");
    if (clean.startsWith("-")) { negative = !negative; clean = clean.slice(1); }
    clean = clean.replace(/%$/, "");
    let value: number;
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(clean)) value = Number(clean.replace(/,/g, ""));
    else if (/^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(clean)) value = Number(clean);
    else return null;
    return negative ? -value : value;
}

const YES = /^(y|yes|true|t|x|1|on)$/i;
const NO = /^(n|no|false|f|0|off)$/i;

function matchEnum(text: string, spec: EnumSpec): Coerced {
    const wanted = squash(text);
    for (const option of spec.values) {
        if (squash(String(option.value)) === wanted || option.labels.some((label) => squash(label) === wanted)) return { ok: true, value: option.value };
    }
    if (spec.open) return { ok: true, value: text.trim(), unlisted: true };
    const shown = spec.values.map((o) => (o.labels[0] && o.labels[0] !== String(o.value) ? `${o.value} ${o.labels[0]}` : String(o.value)));
    return { ok: false, why: `"${text}" is not one of: ${shown.join(", ")}` };
}

/** A cell as the value EBMS takes for this field. Blank cells never get here. */
export function coerce(text: string, field: FieldInfo, spec?: EnumSpec): Coerced {
    if (spec) return matchEnum(text, spec);
    switch (field.kind) {
        case "integer":
        case "decimal": {
            const value = parseNumber(text);
            if (value === null) return { ok: false, why: `"${text}" is not a number` };
            if (field.kind === "integer" && !Number.isInteger(value)) return { ok: false, why: `"${text}" is not a whole number` };
            return { ok: true, value };
        }
        case "boolean":
            if (YES.test(text.trim())) return { ok: true, value: true };
            if (NO.test(text.trim())) return { ok: true, value: false };
            return { ok: false, why: `"${text}" is not yes or no` };
        case "date": {
            const iso = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(text.trim()) ? text.trim().slice(0, 10) : parseDate(text);
            // A date that does not survive a round trip does not exist: 2026-02-30 would become 2 March.
            const real = iso !== null && !Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) && new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso;
            if (iso === null || !real) return { ok: false, why: `"${text}" is not a date (use 2026-10-12 or 10/12/2026)` };
            return { ok: true, value: iso };
        }
        default:
            return { ok: true, value: text };
    }
}
