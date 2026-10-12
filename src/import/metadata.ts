/**
 * An entity's fields as EBMS describes them, read once per import from EntityMetaData. This is
 * what the import validates against, so it follows the install rather than a copy of it.
 */
import { request } from "../ebms/client.js";
import { validatePath } from "../guards.js";

export type FieldKind = "string" | "integer" | "decimal" | "boolean" | "date" | "enum" | "other";

export interface FieldInfo {
    name: string;
    label: string;
    /** EBMS's type name: String, Decimal, … or an enum's name (Multiply, PayFrequency). */
    type: string;
    kind: FieldKind;
    maxLength: number;
    required: boolean;
    /** EBMS fills it in when it is not sent (a date that defaults to today), whatever "required" says. */
    defaulted: boolean;
    readOnly: boolean;
    virtual: boolean;
}

export interface EntityMeta {
    entity: string;
    naturalKey: string | null;
    hasExternalId: boolean;
    /** Plain fields only: no references, collections or files. Keyed by name as EBMS spells it. */
    fields: Map<string, FieldInfo>;
}

interface RawProperty {
    Name?: string;
    Label?: string;
    Type?: string;
    DataType?: string;
    TypeClassification?: number;
    IsCollection?: boolean;
    MaxLength?: number;
    IsRequired?: boolean;
    ReadOnly?: boolean;
    IsVirtual?: boolean;
}

const KINDS: Record<string, FieldKind> = {
    String: "string",
    Int16: "integer",
    Int32: "integer",
    Int64: "integer",
    Byte: "integer",
    Decimal: "decimal",
    Double: "decimal",
    Single: "decimal",
    Boolean: "boolean",
    DateTime: "date",
    DateTimeOffset: "date",
    Date: "date",
};
/** Types that are values but not ones a spreadsheet cell can carry. */
const NOT_FROM_A_CELL = new Set(["BlobInfo", "TimeSpan", "Guid", "Binary"]);

/** The metadata response, reduced to what an import needs. Exported for tests. */
export function parseMetadata(entity: string, body: unknown): EntityMeta {
    const record = (body ?? {}) as { NaturalKey?: string | null; Properties?: RawProperty[] };
    if (!Array.isArray(record.Properties)) throw new Error(`EBMS returned no field list for ${entity}.`);
    const fields = new Map<string, FieldInfo>();
    for (const p of record.Properties) {
        if (!p.Name || p.IsCollection || p.TypeClassification === 1) continue;
        const type = p.Type ?? "";
        if (NOT_FROM_A_CELL.has(type)) continue;
        fields.set(p.Name, {
            name: p.Name,
            label: p.Label ?? "",
            type,
            kind: KINDS[type] ?? (type && p.TypeClassification === 0 ? "enum" : "other"),
            maxLength: p.MaxLength ?? 0,
            required: p.IsRequired === true,
            defaulted: /Default/i.test(p.DataType ?? ""),
            readOnly: p.ReadOnly === true,
            virtual: p.IsVirtual === true,
        });
    }
    return { entity, naturalKey: record.NaturalKey?.trim() || null, hasExternalId: fields.has("EXTERNALID"), fields };
}

export async function readMetadata(company: string, entity: string): Promise<EntityMeta> {
    const query = new URLSearchParams({
        $select: "EntityName,NaturalKey",
        $expand: "Properties($select=Name,Label,Type,DataType,TypeClassification,IsCollection,MaxLength,IsRequired,ReadOnly,IsVirtual)",
    });
    const result = await request(company, "GET", `${validatePath(`EntityMetaData('${entity}')`)}?${query.toString()}`);
    return parseMetadata(entity, result.body);
}

/** Fields a file may write: not read-only, not computed. */
export const writable = (field: FieldInfo | undefined): field is FieldInfo => field !== undefined && !field.readOnly && !field.virtual;
