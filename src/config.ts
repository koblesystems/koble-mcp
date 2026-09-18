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
    /** Comma-separated company IDs this server may read. */
    EBMS_COMPANIES: z.string().optional(),
    /** The single-company form ebms-mcp used; still honoured. */
    EBMS_COMPANY_ID: z.string().optional(),
    /**
     * Optional, for testing: when set, writes go only to this one company. Readable by
     * implication, so it need not be repeated in EBMS_COMPANIES. Leave it unset in real use,
     * where every listed company may be written to.
     */
    EBMS_SANDBOX: z.string().optional(),
    /** Bound actions ebms_command refuses, comma-separated. */
    EBMS_DENIED_COMMANDS: z.string().optional(),
    /** JSON-lines request log. Method, path, company, status and duration only. */
    EBMS_LOG_FILE: z.string().optional(),
});

export const DEFAULT_DENIED_COMMANDS = ["Send", "RecordPayment", "PrintReport", "Sign"];

export interface Settings {
    serial: string;
    /** Every listed company may be read and written. */
    companies: string[];
    /** When set, the only company writes may go to. */
    sandbox: string | null;
    deniedCommands: string[];
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

const splitList = (value: string | undefined): string[] =>
    (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

/** Company IDs compare case-insensitively; EBMS itself reports them upper-case. */
export const normalizeCompany = (company: string): string => company.trim().toUpperCase();

/** Points the module at a different environment. Tests use it; the server never calls it. */
export function configure(newEnv: Env): void {
    env = newEnv;
    settings = null;
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
    const companies = sandbox !== null && !listed.includes(sandbox) ? [...listed, sandbox] : listed;
    if (companies.length === 0) throw new Error("koble-mcp: no companies configured. Set EBMS_COMPANIES to the company IDs this server may use.");
    settings = {
        serial: values.EBMS_SERIAL_NUMBER,
        companies,
        sandbox,
        deniedCommands: values.EBMS_DENIED_COMMANDS === undefined ? DEFAULT_DENIED_COMMANDS : splitList(values.EBMS_DENIED_COMMANDS),
        logFile: values.EBMS_LOG_FILE,
    };
    return settings;
}

/**
 * Turns an optional company argument into a configured company ID. With one company
 * configured it may be omitted; with several it must be named, so a call never lands on a
 * company by accident.
 */
export function resolveCompany(company: string | undefined): string {
    const { companies } = loadSettings();
    if (company === undefined || company.trim() === "") {
        const [only] = companies;
        if (companies.length === 1 && only) return only;
        throw new Error(`Name the company. This server is configured for: ${companies.join(", ")}.`);
    }
    const wanted = normalizeCompany(company);
    if (!companies.includes(wanted)) {
        throw new Error(`Company "${company}" is not configured on this server (configured: ${companies.join(", ")}).`);
    }
    return wanted;
}

export function isWriteCompany(company: string): boolean {
    const { companies, sandbox } = loadSettings();
    const wanted = normalizeCompany(company);
    return sandbox === null ? companies.includes(wanted) : sandbox === wanted;
}

/** Every write path calls this before building a request. */
export function assertWriteCompany(company: string): void {
    if (!isWriteCompany(company)) {
        const { companies, sandbox } = loadSettings();
        throw new Error(
            sandbox !== null
                ? `Refusing to write: EBMS_SANDBOX restricts writes to ${sandbox}, and this call names "${company}". Reads still work.`
                : `Refusing to write: company "${company}" is not configured on this server (configured: ${companies.join(", ")}).`,
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
