/**
 * Settings and per-company connections, read from the environment.
 *
 * Credentials never leave this module except into the EBMS client, and never enter a tool
 * result. Loading is lazy so the guards are testable without a real serial number.
 */
import { z } from "zod/v4";

const envSchema = z.object({
    EBMS_SERIAL_NUMBER: z.string().min(1),
    EBMS_USERNAME: z.string().min(1).optional(),
    EBMS_PASSWORD: z.string().min(1).optional(),
    /**
     * Comma-separated company IDs this server may use. Optional: left unset, every company
     * the serial number reaches is available (discovered from the company-list endpoint).
     */
    EBMS_COMPANIES: z.string().optional(),
    /** The single-company form ebms-mcp used; still honoured. */
    EBMS_COMPANY_ID: z.string().optional(),
    /**
     * Optional, for testing: when set, writes go only to this one company. Readable by
     * implication, so it need not be repeated in EBMS_COMPANIES. Leave it unset in real use,
     * where every listed company may be written to.
     */
    EBMS_SANDBOX: z.string().optional(),
    /** Bound actions ebms_command will run, comma-separated. Anything else is refused. */
    EBMS_ALLOWED_COMMANDS: z.string().optional(),
    /** JSON-lines request log. Method, path, company, status and duration only. */
    EBMS_LOG_FILE: z.string().optional(),
});

/** The bound actions the skills use. None of them posts, pays or sends anything. */
export const DEFAULT_ALLOWED_COMMANDS = ["MarkAllAsShipped", "RecalculateAllPrices", "CalculateFreight", "ChangeCustomer"];

export interface CompanyInfo {
    id: string;
    name: string;
    version: string | null;
}

export interface Settings {
    serial: string;
    /** Company IDs named in the environment, or null to use whatever the serial reaches. */
    configured: string[] | null;
    /** When set, the only company writes may go to. */
    sandbox: string | null;
    allowedCommands: string[];
    logFile: string | undefined;
}

export interface Connection {
    company: string;
    baseUrl: string;
    username: string;
    password: string;
}

type Env = Record<string, string | undefined>;

let env: Env = process.env;
let settings: Settings | null = null;
let discovered: CompanyInfo[] = [];
let discoveryError: string | null = null;

const splitList = (value: string | undefined): string[] =>
    (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

/** Company IDs compare case-insensitively; EBMS itself reports them upper-case. */
export const normalizeCompany = (company: string): string => company.trim().toUpperCase();

/** A company ID becomes a segment of the URL, so it may only be letters, digits, underscore and hyphen. */
export const isCompanyId = (company: string): boolean => /^[A-Za-z0-9_-]{1,40}$/.test(company.trim());

/** Points the module at a different environment. Tests use it; the server never calls it. */
export function configure(newEnv: Env): void {
    env = newEnv;
    settings = null;
    discovered = [];
    discoveryError = null;
}

/** Records what the company-list endpoint reported for this serial. */
export function setDiscoveredCompanies(list: CompanyInfo[]): void {
    // An ID from the discovery endpoint is used in a URL too; one that is not a plain ID is dropped.
    discovered = list.filter((info) => isCompanyId(info.id));
    discoveryError = null;
}

export function setDiscoveryError(message: string): void {
    discoveryError = message;
}

export function discoveredCompanies(): CompanyInfo[] {
    return discovered;
}

export function loadSettings(): Settings {
    if (settings) return settings;
    const parsed = envSchema.safeParse(env);
    if (!parsed.success) {
        const missing = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
        throw new Error(`koble-mcp: missing or invalid environment variables: ${missing}`);
    }
    const values = parsed.data;
    const listed = splitList(values.EBMS_COMPANIES ?? values.EBMS_COMPANY_ID).map(normalizeCompany);
    const sandbox = values.EBMS_SANDBOX?.trim() ? normalizeCompany(values.EBMS_SANDBOX) : null;
    if (sandbox !== null && sandbox.includes(",")) throw new Error("koble-mcp: EBMS_SANDBOX names one company, the only one writes may go to while testing.");
    const bad = [...listed, ...(sandbox === null ? [] : [sandbox])].filter((id) => !isCompanyId(id));
    if (bad.length > 0) throw new Error(`koble-mcp: not a company ID: ${bad.map((id) => JSON.stringify(id)).join(", ")}. IDs are letters, digits, underscore and hyphen only.`);
    settings = {
        serial: values.EBMS_SERIAL_NUMBER,
        configured: listed.length > 0 ? listed : null,
        sandbox,
        allowedCommands: values.EBMS_ALLOWED_COMMANDS === undefined ? DEFAULT_ALLOWED_COMMANDS : splitList(values.EBMS_ALLOWED_COMMANDS),
        logFile: values.EBMS_LOG_FILE,
    };
    return settings;
}

/**
 * The companies this server may use: the configured IDs if any were named, otherwise
 * everything discovered for the serial; plus the sandbox, which is always available. Names
 * and versions come from discovery when it ran.
 */
export function availableCompanies(): CompanyInfo[] {
    const { configured, sandbox } = loadSettings();
    const known = new Map(discovered.map((info) => [info.id, info]));
    const ids = configured ?? discovered.map((info) => info.id);
    const withSandbox = sandbox !== null && !ids.includes(sandbox) ? [...ids, sandbox] : ids;
    return withSandbox.map((id) => known.get(id) ?? { id, name: "", version: null });
}

const describe = (info: CompanyInfo): string => (info.name ? `${info.id} (${info.name})` : info.id);
export const describeCompanies = (): string => availableCompanies().map(describe).join(", ");

/**
 * Turns a company argument — an ID or a name, either case — into a company ID. With one
 * company available it may be omitted; with several it must be named, so a call never lands
 * on a company by accident.
 */
export function resolveCompany(company: string | undefined): string {
    const available = availableCompanies();
    if (available.length === 0) {
        throw new Error(
            `No companies are known${discoveryError ? ` (discovery failed: ${discoveryError})` : ""}. Set EBMS_COMPANIES, or call ebms_companies to retry discovery.`,
        );
    }
    if (company === undefined || company.trim() === "") {
        const [only] = available;
        if (available.length === 1 && only) return only.id;
        throw new Error(`Name the company. Available: ${describeCompanies()}.`);
    }
    const wanted = company.trim().toLowerCase();
    const byName = available.filter((info) => info.name.toLowerCase() === wanted);
    // A live company and its test copy often share a name: a name is only accepted when it is unique.
    if (byName.length > 1 && !available.some((info) => info.id.toLowerCase() === wanted)) {
        throw new Error(`"${company}" is the name of ${byName.length} companies (${byName.map((info) => info.id).join(", ")}). Use the company ID.`);
    }
    const match = available.find((info) => info.id.toLowerCase() === wanted) ?? byName[0];
    if (!match) throw new Error(`Company "${company}" is not available on this server. Available: ${describeCompanies()}. Call ebms_companies to see what the serial reaches.`);
    return match.id;
}

export function isWriteCompany(company: string): boolean {
    const { sandbox } = loadSettings();
    const wanted = normalizeCompany(company);
    return sandbox === null ? availableCompanies().some((info) => info.id === wanted) : sandbox === wanted;
}

/** Every write path calls this before building a request. */
export function assertWriteCompany(company: string): void {
    if (!isWriteCompany(company)) {
        const { sandbox } = loadSettings();
        throw new Error(
            sandbox !== null
                ? `Refusing to write: EBMS_SANDBOX restricts writes to ${sandbox}, and this call names "${company}". Reads still work.`
                : `Refusing to write: company "${company}" is not available on this server (available: ${describeCompanies()}).`,
        );
    }
}

/** The connection for one company. Per-company credentials override the defaults. */
export function connectionFor(company: string): Connection {
    const { serial } = loadSettings();
    const id = resolveCompany(company);
    const key = id.replace(/[^A-Z0-9]/g, "_");
    const username = env[`EBMS_${key}_USERNAME`] ?? env["EBMS_USERNAME"];
    const password = env[`EBMS_${key}_PASSWORD`] ?? env["EBMS_PASSWORD"];
    if (!username || !password) {
        throw new Error(`koble-mcp: no credentials for company ${id}. Set EBMS_USERNAME/EBMS_PASSWORD or EBMS_${key}_USERNAME/EBMS_${key}_PASSWORD.`);
    }
    return { company: id, baseUrl: `https://${serial}.koblesystems.dev/MyEbms/${id}/OData`, username, password };
}

/** The unauthenticated company-list endpoint for this serial. */
export function companyListUrl(): string {
    return `https://${loadSettings().serial}.koblesystems.dev/ebmscompanylist/myebms/companies`;
}
