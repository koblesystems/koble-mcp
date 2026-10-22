/** Metadata shaped as EntityMetaData returns it, for the import tests. */
import { parseMetadata, type EntityMeta } from "../src/import/metadata.js";

type P = { Name: string; Label?: string; Type?: string; DataType?: string; MaxLength?: number; IsRequired?: boolean; ReadOnly?: boolean; IsVirtual?: boolean; TypeClassification?: number; IsCollection?: boolean };
const p = (Name: string, Type = "String", extra: Partial<P> = {}): P => ({ Name, Label: Name, Type, TypeClassification: 0, IsCollection: false, MaxLength: 0, IsRequired: false, ReadOnly: false, IsVirtual: false, ...extra });

export const RAW: Record<string, { NaturalKey: string | null; Properties: P[] }> = {
    INVENTRY: {
        NaturalKey: "ID",
        Properties: [
            p("ID", "String", { Label: "Product", MaxLength: 24, IsRequired: true }),
            p("DESCR_1", "String", { Label: "Description", MaxLength: 80 }),
            p("TREE_ID", "String", { Label: "Category ID", MaxLength: 5 }),
            p("TREE_ID_Reference", "INVENTRE", { TypeClassification: 1, IsRequired: true }),
            p("C_TYPE", "Int32", { Label: "Classification" }),
            p("COST", "Decimal", { Label: "Cost" }),
            p("BASE", "Decimal", { Label: "Base price" }),
            p("PRI_VENDOR", "String", { Label: "Primary vendor", MaxLength: 10 }),
            p("INACTIVE", "Boolean", { Label: "Inactive" }),
            p("E_DATE", "DateTime", { Label: "Expiration" }),
            p("FOLDERNAME", "String", { Label: "Folder name", ReadOnly: true }),
            p("DATE", "DateTime", { IsRequired: true, ReadOnly: true }),
            p("LAST_CHK_D", "DateTime", { IsRequired: true, DataType: "DateDefaultedToday" } as Partial<P>),
            p("Title", "String", { ReadOnly: true, IsVirtual: true }),
            p("EXTERNALID", "String", { Label: "External ID", MaxLength: 50 }),
            p("AUTOID", "String", { ReadOnly: true, MaxLength: 16 }),
            p("INVENUNTs", "INVENUNT", { TypeClassification: 1, IsCollection: true }),
            p("VOBJECT1", "BlobInfo"),
        ],
    },
    INVENUNT: {
        NaturalKey: null,
        Properties: [
            p("ID", "String", { Label: "Product ID", MaxLength: 24, ReadOnly: true }),
            p("UNIT", "String", { Label: "Unit", MaxLength: 10 }),
            p("MULTIPLIER", "Decimal", { Label: "Quantity relative to main unit" }),
            p("MULTIPLY", "Multiply", { Label: "Size relative to main unit" }),
        ],
    },
    INVENDOR: {
        NaturalKey: null,
        Properties: [p("ID", "String", { MaxLength: 24, ReadOnly: true }), p("VENDOR_ID", "String", { MaxLength: 10 }), p("PART_NO", "String", { MaxLength: 30 }), p("UNIT_MEAS", "String", { MaxLength: 10 }), p("COST", "Decimal")],
    },
    INVENDET: {
        NaturalKey: null,
        Properties: [p("ID", "String", { MaxLength: 24, ReadOnly: true }), p("COMP_ID", "String", { MaxLength: 24 }), p("QUAN", "Decimal")],
    },
    INVENTRE: {
        NaturalKey: "TREE_ID",
        Properties: [p("TREE_ID", "String", { MaxLength: 5, IsRequired: true }), p("PARENT_ID", "String", { MaxLength: 5 }), p("TREE_DESCR", "String", { MaxLength: 35 })],
    },
    ARTAX: {
        NaturalKey: "ID",
        Properties: [p("ID", "String", { MaxLength: 10, IsRequired: true }), p("RATE", "Decimal"), p("LEVEL", "TaxLevel"), p("EFF_DATE", "DateTime")],
    },
    ARCUST: {
        NaturalKey: "ID",
        Properties: [p("ID", "String", { MaxLength: 10 }), p("TREE_ID", "String", { MaxLength: 5 }), p("F_NAME", "String", { MaxLength: 30 }), p("L_NAME", "String", { MaxLength: 40, Label: "Last name" }), p("ZIP", "String", { MaxLength: 10 }), p("EXTERNALID", "String", { MaxLength: 50 })],
    },
    PYEMP: {
        NaturalKey: "ID",
        Properties: [p("ID", "String", { MaxLength: 10, IsRequired: true, ReadOnly: true }), p("TREE_ID", "String", { MaxLength: 5 }), p("L_NAME", "String", { MaxLength: 40 }), p("DEF_PAY", "DefaultPay"), p("PAY_TYPE", "PayFrequency"), p("HIRE_DATE", "DateTime", { IsRequired: true })],
    },
    INPRICE: {
        NaturalKey: "LEVEL",
        Properties: [p("LEVEL", "String", { MaxLength: 15, ReadOnly: true }), p("ROUND", "Boolean")],
    },
    GLDEPT: {
        NaturalKey: "DEPT_ID",
        Properties: [p("DEPT_ID", "String", { MaxLength: 6, IsRequired: true }), p("DESCR", "String", { MaxLength: 30 })],
    },
};

export const meta = (entity: string): EntityMeta => parseMetadata(entity, RAW[entity]);
