/**
 * Every row checked against the entity's fields, before anything is read from EBMS: blanks
 * where a value is needed, cells that are not the field's type, values longer than EBMS keeps,
 * IDs a spreadsheet turned into numbers, keys that appear twice, and the per-entity checks.
 * Problems are kept per row and grouped by kind, so a person reads "9 IDs are over 24
 * characters", not nine messages.
 */
import type { SourceRow } from "./source.js";
import type { EntityMeta } from "./metadata.js";
import type { Mapping } from "./mapping.js";
import { coerce, keyFields } from "./mapping.js";
import type { EntityRule } from "./rules.js";
import { squash } from "./rules.js";

export type IssueKind =
    | "required"
    | "one-of"
    | "type"
    | "too-long"
    | "scientific"
    | "duplicate"
    | "missing"
    | "ambiguous"
    | "larger-zero"
    | "self-component"
    | "quantity"
    | "folder-cycle"
    | "write-failed";

export interface Issue {
    row: number;
    kind: IssueKind;
    field: string;
    /** The cell as written, for messages. */
    value: string;
    /** One line for this row's Problem cell. */
    text: string;
    /** For a missing reference: what it should have been ("folder"). */
    noun?: string;
}

export interface CheckedRow {
    row: number;
    source: SourceRow;
    /** Field -> value as EBMS takes it, in file order then defaults. */
    values: Record<string, string | number | boolean>;
    /** The key fields' values joined, upper-cased, for matching; "" when the key is blank. */
    key: string;
}

export interface Validation {
    rows: CheckedRow[];
    issues: Issue[];
    blank: number;
    notes: string[];
}

const SCIENTIFIC = /^\d+(\.\d+)?E\+\d+$/i;

export const keyOf = (fields: readonly string[], values: Record<string, unknown>): string =>
    fields.map((f) => String(values[f] ?? "").trim().toUpperCase()).every((v) => v === "") ? "" : fields.map((f) => String(values[f] ?? "").trim().toUpperCase()).join(" / ");

export function validateRows(rows: readonly SourceRow[], rule: EntityRule, meta: EntityMeta, mapping: Mapping, defaults: Readonly<Record<string, unknown>> = {}): Validation {
    const issues: Issue[] = [];
    const notes = new Set<string>();
    const checked: CheckedRow[] = [];
    const keys = keyFields(rule, meta);
    const defaultFields = new Map(Object.entries(defaults).map(([f, v]) => [[...meta.fields.keys()].find((n) => squash(n) === squash(f)) ?? f, v] as const));
    const required = new Set([
        ...[...meta.fields.values()].filter((f) => f.required && !f.readOnly && !f.virtual && !f.defaulted).map((f) => f.name),
        ...rule.required,
        ...(rule.keyOptional ? [] : keys),
    ].filter((f) => !(rule.optional ?? []).includes(f) && !(rule.neverSend ?? []).includes(f) && meta.fields.has(f)));
    // A folder may be named rather than numbered; the name is checked when it is looked up.
    // So may a folder's parent; and a field that is never sent (a folder's old number) has no length to keep.
    const named = new Set([...rule.lookups.filter((l) => l.byName).map((l) => l.field), ...(rule.folder ? ["PARENT_ID"] : []), ...(rule.neverSend ?? [])]);
    let blank = 0;
    const firstSeen = new Map<string, number>();

    for (const source of rows) {
        if (source.blank) { blank += 1; continue; }
        const values: Record<string, string | number | boolean> = {};
        const add = (issue: Omit<Issue, "row">): void => { issues.push({ row: source.row, ...issue }); };
        const fill = (field: string, text: string): void => {
            const info = meta.fields.get(field);
            if (!info) return;
            const coerced = coerce(text, info, rule.enums[field]);
            if (!coerced.ok) { add({ kind: "type", field, value: text, text: `${field}: ${coerced.why}` }); return; }
            if (coerced.unlisted) notes.add(`${field} "${text}" is not a value seen in EBMS before (${rule.enums[field]?.values.map((v) => v.value).join(", ")}); it is sent as written and the read-back will show what EBMS stored.`);
            if (info.kind === "enum" && !rule.enums[field]) notes.add(`${field} values are sent as written: EBMS does not publish the list of values it accepts.`);
            values[field] = coerced.value;
        };
        for (const column of mapping.columns) {
            const text = source.cells[column.header] ?? "";
            if (text !== "") fill(column.field, text);
        }
        for (const [field, value] of defaultFields) {
            const has = values[field] !== undefined || issues.some((i) => i.row === source.row && i.field === field);
            if (!has && value !== undefined && value !== null && String(value).trim() !== "") fill(field, String(value).trim());
        }
        for (const field of required) {
            if (values[field] === undefined && !issues.some((i) => i.row === source.row && i.field === field)) add({ kind: "required", field, value: "", text: `${field} is blank` });
        }
        if (rule.oneOf && !rule.oneOf.some((f) => values[f] !== undefined && String(values[f]).trim() !== "")) {
            add({ kind: "one-of", field: rule.oneOf.join("/"), value: "", text: `no name: ${rule.oneOf.join(" and ")} are both blank` });
        }
        for (const [field, value] of Object.entries(values)) {
            const info = meta.fields.get(field);
            if (typeof value === "string" && info && info.maxLength > 0 && value.length > info.maxLength && !named.has(field)) {
                add({ kind: "too-long", field, value, text: `${field} "${value}" is ${value.length} characters; EBMS keeps ${info.maxLength}` });
            }
            if (keys.includes(field) && typeof value === "string" && SCIENTIFIC.test(value)) {
                add({ kind: "scientific", field, value, text: `${field} "${value}" looks like a number a spreadsheet rewrote; type the real ID` });
            }
        }
        // Per-entity checks.
        if (rule.entity === "INVENUNT" && values["MULTIPLY"] === "Larger" && (values["MULTIPLIER"] === 0 || values["MULTIPLIER"] === undefined)) {
            add({ kind: "larger-zero", field: "MULTIPLIER", value: String(values["MULTIPLIER"] ?? ""), text: "a Larger unit needs how many main units it holds (MULTIPLIER), not 0" });
        }
        if (rule.entity === "INVENDET") {
            if (values["ID"] !== undefined && String(values["ID"]).toUpperCase() === String(values["COMP_ID"] ?? "").toUpperCase()) add({ kind: "self-component", field: "COMP_ID", value: String(values["COMP_ID"]), text: "the component is the product itself" });
            if (typeof values["QUAN"] === "number" && values["QUAN"] <= 0) add({ kind: "quantity", field: "QUAN", value: String(values["QUAN"]), text: `quantity ${values["QUAN"]} is not more than 0` });
        }

        const key = keyOf(keys, values);
        if (key !== "") {
            const first = firstSeen.get(key);
            if (first !== undefined) add({ kind: "duplicate", field: keys.join("/"), value: key, text: `${keys.join(" / ")} ${key} is also on row ${first}; this copy is ignored` });
            else firstSeen.set(key, source.row);
        }
        if (!issues.some((i) => i.row === source.row)) checked.push({ row: source.row, source, values, key });
    }
    return { rows: checked, issues, blank, notes: [...notes] };
}

export interface ProblemGroup {
    kind: IssueKind;
    field: string;
    message: string;
    count: number;
    /** "Row 9", …: the first twenty. The exceptions file has all of them. */
    rows: string[];
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
const examples = (values: readonly string[]): string => {
    const distinct = [...new Set(values.filter(Boolean))];
    return distinct.slice(0, 5).map((v) => `"${v}"`).join(", ") + (distinct.length > 5 ? ` and ${distinct.length - 5} more` : "");
};

/** Problems grouped by kind and field, largest group first. */
export function groupIssues(issues: readonly Issue[], context: { company: string; maxLength: (field: string) => number }): ProblemGroup[] {
    const groups = new Map<string, Issue[]>();
    for (const issue of issues) {
        const id = `${issue.kind}|${issue.field}`;
        groups.set(id, [...(groups.get(id) ?? []), issue]);
    }
    const out: ProblemGroup[] = [];
    for (const list of groups.values()) {
        const first = list[0] as Issue;
        const rows = [...new Set(list.map((i) => i.row))];
        const n = rows.length;
        const values = list.map((i) => i.value);
        const r = plural(n, "row", "rows");
        const message = ((): string => {
            switch (first.kind) {
                case "required": return `${n} ${r} ${plural(n, "leaves", "leave")} ${first.field} blank`;
                case "one-of": return `${n} ${r} ${plural(n, "has", "have")} no name (${first.field.split("/").join(" and ")} both blank)`;
                case "type": return `${n} ${r} ${plural(n, "has", "have")} a ${first.field} EBMS cannot read: ${examples(values)}`;
                case "too-long": return `${n} ${first.field} ${plural(n, "value is", "values are")} over ${context.maxLength(first.field)} characters; EBMS would cut ${plural(n, "it", "them")} silently`;
                case "scientific": return `${n} ${first.field} ${plural(n, "value looks", "values look")} like a spreadsheet turned ${plural(n, "it", "them")} into a number (${examples(values)}); format the column as text and type the real IDs`;
                case "duplicate": return `${n} ${first.field} ${plural(n, "value appears", "values appear")} twice in the file; the second copy is ignored`;
                case "missing": return first.noun === "unit of that product" ? `${n} ${r} ${plural(n, "names", "name")} a unit the product does not have: ${examples(values)}` : `${n} ${r} ${plural(n, "names", "name")} a ${first.noun ?? first.field} that is not in ${context.company}: ${examples(values)}`;
                case "ambiguous": return `${n} ${r} ${plural(n, "names", "name")} a ${first.noun ?? first.field} that matches more than one in ${context.company}: ${examples(values)}; use its number`;
                case "larger-zero": return `${n} Larger ${plural(n, "unit has", "units have")} a multiplier of 0`;
                case "self-component": return `${n} bill-of-materials ${plural(n, "line lists", "lines list")} the product as its own component`;
                case "quantity": return `${n} bill-of-materials ${plural(n, "line has", "lines have")} a quantity of 0 or less`;
                case "folder-cycle": return `${n} ${plural(n, "folder is its", "folders are their")} own ancestor through PARENT_ID`;
                case "write-failed": return `${n} ${r} could not be written to EBMS last time`;
            }
        })();
        out.push({ kind: first.kind, field: first.field, message, count: n, rows: rows.slice(0, 20).map((row) => `Row ${row}`) });
    }
    return out.sort((a, b) => b.count - a.count);
}
