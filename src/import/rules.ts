/**
 * What import_from_csv knows about each entity beyond what EBMS's own metadata says: the key a
 * row is matched on, how it is written (a POST of its own, or a row PATCHed onto its product),
 * the body order EBMS needs, fields our procedures require that the metadata does not, which
 * fields point at other records, the values of enums the metadata names but does not list, and
 * the headers people use for each field. Pure data; nothing here decides what to write.
 *
 * tier: "verified" — created and read back on a live EBMS; "drafted" — the shape is known from
 * metadata and the skills but a live create has not been checked; "discover" — metadata only.
 */

export type Tier = "verified" | "drafted" | "discover";

export interface EnumSpec {
    /** Accepted values, each with the spellings a file may use. `value` is what is sent. */
    values: ReadonlyArray<{ value: string | number; labels: readonly string[] }>;
    /** True when the list is what was seen on one install, not every value EBMS has: anything else is sent as written, with a note. */
    open?: boolean;
}

export interface LookupSpec {
    field: string;
    /** The entity the value must exist in, and its key there. */
    entity: string;
    key: string;
    /** Also accept the record's name, e.g. a folder's TREE_DESCR, and send its key instead. */
    byName?: string;
    /** "the folder", "the vendor": how messages name what is missing. */
    noun: string;
    /** For a product's units: the value must be one of that product's units, not any record. */
    perProduct?: boolean;
}

export interface EntityRule {
    entity: string;
    /** "products", "customers": for messages. */
    plural: string;
    tier: Tier;
    /** "post": one POST per row. "child": rows PATCHed onto their product as a collection. */
    route: "post" | "child";
    /** The fields that identify a row in the file and in EBMS. Empty when EBMS assigns the key. */
    key: readonly string[];
    /** The key may be left blank and EBMS assigns one (a customer folder with an ID method). */
    keyOptional?: boolean;
    /** Fields written first, in this order; then the file's fields in file order; EXTERNALID last. */
    order: readonly string[];
    /** Required by our procedures even where EBMS's metadata does not mark them. */
    required: readonly string[];
    /** Marked required in the metadata but EBMS fills them (or the skills treat them as optional). */
    optional?: readonly string[];
    /** At least one of these must have a value. */
    oneOf?: readonly string[];
    lookups: readonly LookupSpec[];
    enums: Readonly<Record<string, EnumSpec>>;
    /** Header (lowercased, spaces and punctuation collapsed) -> field, for this entity only. */
    aliases: Readonly<Record<string, string>>;
    /** The field that names a row for people. */
    label: readonly string[];
    readBack?: { record?: string; lines?: string };
    /** For "child": the collection on INVENTRY that carries these rows. */
    collection?: string;
    /** A folder set: matched by name under its parent; EBMS numbers new folders itself. */
    folder?: boolean;
    /** In the file to match or link rows, never sent: EBMS refuses them (a folder's own TREE_ID). */
    neverSend?: readonly string[];
    /** Read-only in the metadata, but EBMS takes them on a create (verified): the product ID of a bill-of-materials line. */
    sendsReadOnly?: readonly string[];
    /** Set when EBMS refuses every create of this entity through the API: the file is reviewed, nothing is drafted. */
    cannotCreate?: string;
    /** Read with the result so the person can see what to expect. */
    note?: string;
}

/** INVENTRY.C_TYPE. The numbers are what EBMS stores; labels as the products skill names them. */
const C_TYPE: EnumSpec = {
    values: [
        { value: 0, labels: ["Service Item", "Service"] },
        { value: 1, labels: ["No Count"] },
        { value: 2, labels: ["Track Count"] },
        { value: 3, labels: ["Serialized Item", "Serialized"] },
        { value: 4, labels: [] },
        { value: 5, labels: [] },
        { value: 6, labels: ["Percentage Price"] },
        { value: 7, labels: ["Non-inventory Serialized"] },
        { value: 8, labels: ["Rental Code", "Rental"] },
        { value: 9, labels: ["Lots-Avg Cost", "Lots Avg Cost"] },
        { value: 10, labels: ["Percentage Discount"] },
        { value: 11, labels: ["Lots-Tracked Cost", "Lots Tracked Cost"] },
    ],
};

const MULTIPLY: EnumSpec = { values: [{ value: "Larger", labels: ["Larger", "L"] }, { value: "Smaller", labels: ["Smaller", "S"] }] };

/** Seen on COF (EBMS 1.8.184); the full lists are not published through the API. */
const DEF_PAY: EnumSpec = { open: true, values: [{ value: "Salary", labels: ["Salary", "Salaried"] }, { value: "Hourly", labels: ["Hourly"] }] };
const PAY_TYPE: EnumSpec = { open: true, values: [{ value: "Weekly", labels: ["Weekly"] }, { value: "Monthly", labels: ["Monthly"] }] };
const PAY_METHOD: EnumSpec = { open: true, values: [{ value: "Check", labels: ["Check", "Cheque"] }] };

/** ARTAX on COF (EBMS 1.8.184): TaxLevel, TaxRateType and TaxPaymentFrequency, as far as seen. */
const TAX_LEVEL: EnumSpec = { open: true, values: [{ value: "State", labels: ["State"] }, { value: "County", labels: ["County"] }, { value: "City", labels: ["City"] }] };
const RATE_TYPE: EnumSpec = { open: true, values: [{ value: "Percentage", labels: ["Percentage", "Percent", "%"] }] };
const PMNT_FREQ: EnumSpec = { open: true, values: [{ value: "Monthly", labels: ["Monthly"] }] };

const folderRule = (entity: string, plural: string, tier: Tier): EntityRule => ({
    entity,
    plural,
    tier,
    route: "post",
    key: ["PARENT_ID", "TREE_DESCR"],
    order: ["PARENT_ID", "TREE_DESCR"],
    required: ["TREE_DESCR", "PARENT_ID"],
    neverSend: ["TREE_ID"],
    lookups: [],
    enums: {},
    aliases: { folder: "TREE_ID", folderid: "TREE_ID", folderno: "TREE_ID", foldernumber: "TREE_ID", name: "TREE_DESCR", foldername: "TREE_DESCR", description: "TREE_DESCR", parent: "PARENT_ID", parentfolder: "PARENT_ID", parentid: "PARENT_ID" },
    label: ["TREE_DESCR"],
    folder: true,
    note: "EBMS numbers each new folder itself; a folder whose parent is another row of this file is drafted on the run after that parent is created. Each new folder gets a ($) defaults row with the install's defaults (on COF: tax group Taxable, purchase account 60000-000, no markup): check them in EBMS before records go in.",
});

/** A configuration set: validated from metadata only, its key read from EntityMetaData. */
const configRule = (entity: string, plural: string, label: string[], aliases: Record<string, string> = {}, verified = false): EntityRule => ({
    entity,
    plural,
    tier: verified ? "verified" : "discover",
    route: "post",
    key: [],
    order: [],
    required: [],
    lookups: [],
    enums: {},
    aliases,
    label,
    ...(verified ? {} : { note: "Not yet verified on a live EBMS: check the first record in EBMS before writing the rest." }),
});

const TREE_LABEL = { folder: "TREE_ID", folderid: "TREE_ID", category: "TREE_ID", categoryid: "TREE_ID" };

export const RULES: Readonly<Record<string, EntityRule>> = {
    // Customer (ARCUSTRE) and vendor (APVENTRE) folders cannot be created through the API on 1.8.184:
    // EBMS requires a PARENT_ID their API entity does not expose. They are set up in EBMS.
    INVENTRE: folderRule("INVENTRE", "product folders", "verified"),
    PYEMPTRE: folderRule("PYEMPTRE", "worker folders", "verified"),
    PYWORKTRE: folderRule("PYWORKTRE", "work code folders", "verified"),
    INVENTRY: {
        entity: "INVENTRY",
        plural: "products",
        tier: "verified",
        route: "post",
        key: ["ID"],
        order: ["ID", "DESCR_1", "TREE_ID", "C_TYPE"],
        required: ["TREE_ID", "C_TYPE"],
        lookups: [
            { field: "TREE_ID", entity: "INVENTRE", key: "TREE_ID", byName: "TREE_DESCR", noun: "folder" },
            { field: "PRI_VENDOR", entity: "APVENDOR", key: "ID", noun: "vendor" },
            { field: "TAX_GROUP", entity: "ARTAXGROUP", key: "TAX_GROUP", noun: "tax group" },
        ],
        enums: { C_TYPE },
        aliases: { ...TREE_LABEL, partnumber: "ID", partno: "ID", sku: "ID", item: "ID", itemnumber: "ID", product: "ID", productid: "ID", name: "DESCR_1", description: "DESCR_1", classification: "C_TYPE", type: "C_TYPE", cost: "COST", price: "BASE", baseprice: "BASE", vendor: "PRI_VENDOR", primaryvendor: "PRI_VENDOR", taxgroup: "TAX_GROUP", upc: "UPC", min: "MIN_INVEN", max: "MAX_INVEN" },
        label: ["DESCR_1"],
        readBack: { record: "FOLDERNAME,MARKUP,TAX_GROUP,PUR_ACC,EACH_UNIT,DEF_UNIT" },
    },
    INVENUNT: {
        entity: "INVENUNT",
        plural: "units",
        tier: "verified",
        route: "child",
        collection: "INVENUNTs",
        key: ["ID", "UNIT"],
        order: ["UNIT", "MULTIPLY", "MULTIPLIER"],
        required: ["ID", "UNIT", "MULTIPLY", "MULTIPLIER"],
        lookups: [{ field: "ID", entity: "INVENTRY", key: "ID", noun: "product" }],
        enums: { MULTIPLY },
        aliases: { product: "ID", productid: "ID", item: "ID", partnumber: "ID", sku: "ID", unit: "UNIT", uom: "UNIT", unitofmeasure: "UNIT", multiplier: "MULTIPLIER", quantity: "MULTIPLIER", qty: "MULTIPLIER", size: "MULTIPLY", largerorsmaller: "MULTIPLY", multiply: "MULTIPLY" },
        label: ["UNIT"],
    },
    INVENDOR: {
        entity: "INVENDOR",
        plural: "vendor records",
        tier: "verified",
        route: "child",
        collection: "INVENDORs",
        key: ["ID", "VENDOR_ID"],
        order: ["VENDOR_ID", "PART_NO", "UNIT_MEAS", "COST"],
        required: ["ID", "VENDOR_ID"],
        lookups: [
            { field: "ID", entity: "INVENTRY", key: "ID", noun: "product" },
            { field: "VENDOR_ID", entity: "APVENDOR", key: "ID", noun: "vendor" },
            { field: "UNIT_MEAS", entity: "INVENUNT", key: "UNIT", noun: "unit", perProduct: true },
        ],
        enums: {},
        aliases: { product: "ID", productid: "ID", item: "ID", sku: "ID", vendor: "VENDOR_ID", vendorid: "VENDOR_ID", partnumber: "PART_NO", vendorpartnumber: "PART_NO", vendorpartno: "PART_NO", partno: "PART_NO", unit: "UNIT_MEAS", purchaseunit: "UNIT_MEAS", cost: "COST", leaddays: "LEAD_DAYS", leadtime: "LEAD_DAYS" },
        label: ["VENDOR_ID"],
    },
    INVENDET: {
        entity: "INVENDET",
        plural: "bill-of-materials lines",
        tier: "verified",
        // INVENTRY's INVENDETs is a paged collection that refuses additions, so each line is its own POST.
        route: "post",
        key: ["ID", "COMP_ID"],
        sendsReadOnly: ["ID"],
        order: ["ID", "COMP_ID", "QUAN"],
        required: ["ID", "COMP_ID", "QUAN"],
        lookups: [
            { field: "ID", entity: "INVENTRY", key: "ID", noun: "product" },
            { field: "COMP_ID", entity: "INVENTRY", key: "ID", noun: "component product" },
        ],
        enums: {},
        aliases: { product: "ID", parent: "ID", assembly: "ID", finishedgood: "ID", component: "COMP_ID", componentid: "COMP_ID", part: "COMP_ID", quantity: "QUAN", qty: "QUAN", qtyper: "QUAN", quantityper: "QUAN" },
        label: ["COMP_ID"],
        readBack: { record: "CATEGORY" },
    },
    ARCUST: {
        entity: "ARCUST",
        plural: "customers",
        tier: "verified",
        route: "post",
        key: ["ID"],
        keyOptional: true,
        optional: ["ID"],
        order: ["TREE_ID", "ID", "F_NAME", "L_NAME"],
        required: ["TREE_ID"],
        oneOf: ["L_NAME", "F_NAME"],
        lookups: [
            { field: "TREE_ID", entity: "ARCUSTRE", key: "TREE_ID", byName: "TREE_DESCR", noun: "folder" },
            { field: "IN_LEVEL", entity: "INPRICE", key: "LEVEL", noun: "price level" },
            { field: "SALESMAN", entity: "ARSALESP", key: "ID", noun: "salesperson" },
        ],
        enums: {},
        aliases: { ...TREE_LABEL, customer: "ID", customerid: "ID", customernumber: "ID", account: "ID", name: "L_NAME", company: "L_NAME", companyname: "L_NAME", lastname: "L_NAME", firstname: "F_NAME", address: "ADDRESS1", street: "ADDRESS1", city: "CITY", state: "STATE", zip: "ZIP", zipcode: "ZIP", postalcode: "ZIP", phone: "PHONE", email: "EMAIL", pricelevel: "IN_LEVEL", salesperson: "SALESMAN", salesrep: "SALESMAN" },
        label: ["L_NAME", "F_NAME"],
    },
    APVENDOR: {
        entity: "APVENDOR",
        plural: "vendors",
        tier: "verified",
        route: "post",
        key: ["ID"],
        order: ["TREE_ID", "ID", "F_NAME", "L_NAME"],
        required: ["TREE_ID", "ID"],
        oneOf: ["L_NAME", "F_NAME"],
        lookups: [
            { field: "TREE_ID", entity: "APVENTRE", key: "TREE_ID", byName: "TREE_DESCR", noun: "folder" },
            { field: "GL_CODE", entity: "GLEDGER", key: "ACCOUNT", noun: "GL account" },
        ],
        enums: {},
        aliases: { ...TREE_LABEL, vendor: "ID", vendorid: "ID", vendornumber: "ID", supplier: "ID", name: "L_NAME", company: "L_NAME", companyname: "L_NAME", vendorname: "L_NAME", address: "ADDRESS1", street: "ADDRESS1", city: "CITY", state: "STATE", zip: "ZIP", zipcode: "ZIP", phone: "PHONE", email: "EMAIL", account: "ACCOUNT", glaccount: "GL_CODE" },
        label: ["L_NAME", "F_NAME"],
    },
    PYEMP: {
        entity: "PYEMP",
        plural: "workers",
        tier: "discover",
        route: "post",
        key: ["ID"],
        keyOptional: true,
        optional: ["ID"],
        order: ["TREE_ID", "ID", "F_NAME", "L_NAME"],
        required: ["TREE_ID", "DEF_PAY", "PAY_TYPE", "HIRE_DATE"],
        oneOf: ["L_NAME", "F_NAME"],
        lookups: [{ field: "TREE_ID", entity: "PYEMPTRE", key: "TREE_ID", byName: "TREE_DESCR", noun: "folder" }],
        enums: { DEF_PAY, PAY_TYPE, PAY_METHOD },
        aliases: { ...TREE_LABEL, employee: "ID", employeeid: "ID", worker: "ID", workerid: "ID", firstname: "F_NAME", lastname: "L_NAME", hiredate: "HIRE_DATE", hired: "HIRE_DATE", startdate: "HIRE_DATE", pay: "DEF_PAY", defaultpay: "DEF_PAY", paytype: "DEF_PAY", frequency: "PAY_TYPE", payfrequency: "PAY_TYPE", payperiod: "PAY_TYPE", paymethod: "PAY_METHOD", email: "EMAIL", phone: "PHONE" },
        label: ["L_NAME", "F_NAME"],
        cannotCreate: "EBMS 1.8.184 refuses every worker create through the API (\"Invalid constructor parameter\", tried on COF 2026-10-12 with and without an ID, folder and pay fields). The file is checked so it can be keyed in EBMS, but nothing is drafted.",
    },
    ARTAX: {
        entity: "ARTAX",
        plural: "tax rates",
        tier: "verified",
        route: "post",
        key: ["ID"],
        order: ["ID", "DESCR", "RATE", "LEVEL"],
        required: ["ID", "RATE", "COUNTRY"],
        lookups: [
            { field: "TAX_AGENCY", entity: "APVENDOR", key: "ID", noun: "tax agency vendor" },
            { field: "LIAB_GL", entity: "GLEDGER", key: "ACCOUNT", noun: "liability account" },
        ],
        enums: { LEVEL: TAX_LEVEL, RATE_TYPE, PMNT_FREQ },
        aliases: { description: "DESCR", name: "DESCR", rate: "RATE", level: "LEVEL", country: "COUNTRY", state: "STATE", county: "COUNTY", city: "CITY", zip: "ZIP", fips: "FIPS_CODE", fipscode: "FIPS_CODE", agency: "TAX_AGENCY", taxagency: "TAX_AGENCY", liabilityaccount: "LIAB_GL", liabilitygl: "LIAB_GL", effectivedate: "EFF_DATE", effective: "EFF_DATE" },
        label: ["DESCR"],
        note: "A rate made through the API is stored as sent and is matched to orders by geography, but on COF (2026-10-12) a new County rate taxed $0 on an order its own state rate taxed: open each new rate in EBMS, set what it taxes, and check one order before relying on it.",
    },
    ARTAXGROUP: configRule("ARTAXGROUP", "tax groups", ["TAX_GROUP"], { taxgroup: "TAX_GROUP", name: "TAX_GROUP" }),
    PYWORK: {
        ...configRule("PYWORK", "work codes", ["DESCR"], { workcode: "ID", code: "ID", description: "DESCR", name: "DESCR", folder: "TREE_ID", folderid: "TREE_ID" }, true),
        key: ["ID"],
        order: ["ID", "DESCR", "TREE_ID"],
        lookups: [{ field: "TREE_ID", entity: "PYWORKTRE", key: "TREE_ID", byName: "TREE_DESCR", noun: "folder" }],
    },
    INWH: configRule("INWH", "warehouses", ["DESCR"], { warehouse: "WAREHOUSE", warehouseid: "WAREHOUSE", description: "DESCR", name: "DESCR" }),
    ARSALESP: {
        ...configRule("ARSALESP", "salespeople", ["ID"], { salesperson: "ID", salespersonid: "ID", name: "ID", commissionaccount: "COM_GL", commissiongl: "COM_GL", address: "ADDRESS1", city: "CITY", state: "STATE", zip: "ZIP" }, true),
        key: ["ID"],
        // EBMS refuses a salesperson without one: "There must be a valid Commission G/L Account".
        required: ["COM_GL"],
        lookups: [{ field: "COM_GL", entity: "GLEDGER", key: "ACCOUNT", noun: "GL account" }],
    },
    INPRICE: configRule("INPRICE", "price levels", ["DESCR"], { pricelevel: "LEVEL", level: "LEVEL", description: "DESCR", name: "DESCR" }),
    APTERM: configRule("APTERM", "terms", ["DESCR"], { terms: "ID", termsid: "ID", description: "DESCR", name: "DESCR" }),
    GLEDGER: configRule("GLEDGER", "GL accounts", ["DESCR"], { account: "ACCOUNT", accountnumber: "ACCOUNT", glaccount: "ACCOUNT", description: "DESCR", name: "DESCR" }),
    GLDEPT: configRule("GLDEPT", "departments", ["DESCR"], { department: "DEPT_ID", dept: "DEPT_ID", description: "DESCR", name: "DESCR" }),
};

export const ENTITIES = Object.keys(RULES) as [string, ...string[]];

/** Headers people use whatever the entity. */
export const GLOBAL_ALIASES: Readonly<Record<string, string>> = { externalid: "EXTERNALID", inactive: "INACTIVE" };

/** A header or field name reduced for matching: lowercase, letters and digits only. */
export const squash = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

