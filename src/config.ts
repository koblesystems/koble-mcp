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
    /** Comma-separated company IDs this server may write to. Default: sbx, the demo dataset. */
    EBMS_WRITE_COMPANIES: z.string().optional(),
    /** Bound actions ebms_command refuses, comma-separated. */
    EBMS_DENIED_COMMANDS: z.string().optional(),
    /** JSON-lines request log. Method, path, company, status and duration only. */
    EBMS_LOG_FILE: z.string().optional(),
});

export const DEFAULT_WRITE_COMPANIES = ["sbx"];
export const DEFAULT_DENIED_COMMANDS = ["Send", "RecordPayment", "PrintReport", "Sign"];

export interface Settings {
    serial: string;
    companies: string[];
    writeCompanies: string[];
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
    const companies = splitList(values.EBMS_COMPANIES ?? values.EBMS_COMPANY_ID).map(normalizeCompany);
    if (companies.length === 0) throw new Error("koble-mcp: EBMS_COMPANIES is empty; name at least one company ID.");
    const writeCompanies = (values.EBMS_WRITE_COMPANIES === undefined ? DEFAULT_WRITE_COMPANIES : splitList(values.EBMS_WRITE_COMPANIES)).map(normalizeCompany);
    settings = {
        serial: values.EBMS_SERIAL_NUMBER,
        companies,
        writeCompanies: writeCompanies.filter((company) => companies.includes(company)),
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
    return loadSettings().writeCompanies.includes(normalizeCompany(company));
}

/** Every write path calls this before building a request. */
export function assertWriteCompany(company: string): void {
    if (!isWriteCompany(company)) {
        const { writeCompanies } = loadSettings();
        throw new Error(
            `Refusing to write: company "${company}" is not in the write allowlist [${writeCompanies.join(", ")}]. ` +
                "Reads still work. Add it to EBMS_WRITE_COMPANIES only if it is a sandbox.",
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
