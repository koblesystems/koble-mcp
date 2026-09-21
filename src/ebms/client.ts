/**
 * The one HTTP client for EBMS OData, one token per company.
 *
 * Owns the token dance (proactive refresh, one retry on a 401), the Basic-auth fallback
 * for an install without /Token, the 150 s timeout, and the Messages[] envelope. Network
 * failures and timeouts come out as EbmsError with `uncertain` set, so callers can tell
 * "EBMS said no" from "nobody knows". Credentials never appear in an error or a result.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { connectionFor, loadSettings, type Connection } from "../config.js";
import { EbmsError, errorFromBody, warningsFromBody } from "./errors.js";

const TOKEN_LIFETIME_MS = 9 * 60 * 1000; // EBMS tokens last ~10 minutes.

/**
 * EBMS cuts requests off at about 2 minutes. This sits above that so it never ends a real
 * request early; it only stops a dropped connection from hanging a tool forever.
 */
export const REQUEST_TIMEOUT_MS = 150_000;

interface TokenState {
    accessToken: string;
    refreshToken: string | undefined;
    obtainedAt: number;
}

interface CompanyAuth {
    token: TokenState | null;
    /** Set only when the install has no /Token endpoint (404/405), never on a transient failure. */
    basic: boolean;
}

const auth = new Map<string, CompanyAuth>();
const authFor = (company: string): CompanyAuth => {
    let state = auth.get(company);
    if (!state) {
        state = { token: null, basic: false };
        auth.set(company, state);
    }
    return state;
};

/** Forgets every token. Tests use it. */
export function resetAuth(): void {
    auth.clear();
}

/** Escapes a value for an OData string literal: single quotes are doubled. */
export function odataString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

async function readBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.length === 0) return null;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return { raw: text };
    }
}

async function tokenRequest(url: string, payload: unknown): Promise<Response> {
    try {
        return await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(30_000),
        });
    } catch (error) {
        throw wrapFetchError(error, "POST /Token");
    }
}

async function login(conn: Connection, state: CompanyAuth): Promise<TokenState | null> {
    const response = await tokenRequest(`${conn.baseUrl}/Token`, { Username: conn.username, Password: conn.password });
    const body = (await readBody(response)) as { AccessToken?: string; RefreshToken?: string } | null;
    if (response.ok && body?.AccessToken) {
        return { accessToken: body.AccessToken, refreshToken: body.RefreshToken, obtainedAt: Date.now() };
    }
    if (response.status === 404 || response.status === 405) {
        // No token endpoint on this install: use Basic from here on, for this company.
        state.basic = true;
        return null;
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
        throw errorFromBody(body, response.status) ?? new EbmsError(`EBMS rejected the configured credentials for ${conn.company}`, response.status, { kind: "credentials" });
    }
    // Anything else is transient. Fail this request; the next one logs in again.
    throw errorFromBody(body, response.status) ?? new EbmsError(`/Token failed for ${conn.company}`, response.status);
}

async function refresh(conn: Connection, state: CompanyAuth, current: TokenState): Promise<TokenState | null> {
    if (!current.refreshToken) return login(conn, state);
    const response = await tokenRequest(`${conn.baseUrl}/RefreshToken`, { RefreshToken: current.refreshToken });
    const body = (await readBody(response)) as { AccessToken?: string; RefreshToken?: string } | null;
    if (!response.ok || !body?.AccessToken) return login(conn, state);
    return { accessToken: body.AccessToken, refreshToken: body.RefreshToken ?? current.refreshToken, obtainedAt: Date.now() };
}

async function authHeader(conn: Connection, forceRenew: boolean): Promise<string> {
    const state = authFor(conn.company);
    const basic = (): string => "Basic " + Buffer.from(`${conn.username}:${conn.password}`).toString("base64");
    if (state.basic) return basic();
    const stale = state.token !== null && Date.now() - state.token.obtainedAt > TOKEN_LIFETIME_MS;
    if (state.token === null) state.token = await login(conn, state);
    else if (forceRenew || stale) state.token = await refresh(conn, state, state.token);
    if (state.token === null) return basic();
    return `Bearer ${state.token.accessToken}`;
}

function wrapFetchError(error: unknown, what: string): EbmsError {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    if (name === "TimeoutError" || name === "AbortError") {
        return new EbmsError(`${what} timed out after ${REQUEST_TIMEOUT_MS / 1000} s; EBMS may still be processing it`, 0, { kind: "timeout" });
    }
    return new EbmsError(`${what} failed before a response arrived (${message})`, 0, { kind: "network" });
}

/**
 * The last line of defence for the company boundary: whatever path was built, the finished
 * URL must still be inside this company's OData root, with no fragment. `new URL` resolves
 * dot segments the same way fetch does, so a path that climbs out is caught here.
 */
export function safeUrl(baseUrl: string, path: string): string {
    const root = new URL(`${baseUrl}/`);
    const url = new URL(`${baseUrl}/${path}`);
    const inside = url.origin === root.origin && url.pathname.startsWith(root.pathname) && url.pathname.length > root.pathname.length;
    const rest = url.pathname.slice(root.pathname.length);
    if (!inside || rest.includes("//") || rest.includes("\\") || url.hash !== "" || url.username !== "" || url.password !== "") {
        throw new EbmsError("Refused: the request would leave this company's OData root. Nothing was sent.", 0, { kind: "refused" });
    }
    return url.toString();
}

export interface RequestResult {
    status: number;
    body: unknown;
    /** Non-error messages EBMS attached to a successful response. */
    warnings: string[];
    ms: number;
}

async function log(entry: Record<string, unknown>): Promise<void> {
    const file = loadSettings().logFile;
    if (!file) return;
    try {
        await mkdir(dirname(file), { recursive: true });
        await appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
    } catch {
        // The log is advisory; a failed write must never fail a request.
    }
}

/**
 * Sends one request. `path` is relative to the company's OData root and already
 * query-encoded. Throws EbmsError on any failure, with `uncertain` set when the outcome
 * is unknown.
 */
export async function request(company: string, method: string, path: string, body?: unknown): Promise<RequestResult> {
    const conn = connectionFor(company);
    const started = Date.now();
    const attempt = async (isRetry: boolean): Promise<Response> => {
        let authorization: string;
        try {
            authorization = await authHeader(conn, isRetry);
        } catch (error) {
            if (error instanceof EbmsError && error.kind === "credentials") throw error;
            const why = error instanceof Error ? error.message : String(error);
            throw new EbmsError(`Could not sign in to EBMS (${why}). The request was not sent.`, error instanceof EbmsError ? error.status : 0, { kind: "signin" });
        }
        const headers: Record<string, string> = { Authorization: authorization, Accept: "application/json" };
        if (body !== undefined) headers["Content-Type"] = "application/json";
        const init: RequestInit = { method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
        if (body !== undefined) init.body = JSON.stringify(body);
        try {
            return await fetch(safeUrl(conn.baseUrl, path), init);
        } catch (error) {
            if (error instanceof EbmsError) throw error;
            throw wrapFetchError(error, `${method} ${path.split("?")[0]}`);
        }
    };
    /** A response whose body breaks off is as unknown as one that never arrived. */
    const bodyOf = async (response: Response): Promise<unknown> => {
        try {
            return await readBody(response);
        } catch (error) {
            throw wrapFetchError(error, `${method} ${path.split("?")[0]} (reading the response)`);
        }
    };

    try {
        let response = await attempt(false);
        if (response.status === 401 && !authFor(conn.company).basic) {
            authFor(conn.company).token = null;
            response = await attempt(true);
        }
        const parsed = await bodyOf(response);
        if (!response.ok) {
            const error = errorFromBody(parsed, response.status);
            if (error) throw error;
            const text = typeof parsed === "object" && parsed !== null ? JSON.stringify(parsed) : String(parsed);
            throw new EbmsError(`${method} ${path.split("?")[0]} failed`, response.status, { detail: text.slice(0, 500) });
        }
        // A 2xx carrying an error message: EBMS may or may not have saved, so it is not a refusal.
        const embedded = errorFromBody(parsed, response.status);
        if (embedded) throw new EbmsError(embedded.message, response.status, { kind: "embedded", detail: embedded.detail, solution: embedded.solution });
        const result = { status: response.status, body: parsed, warnings: warningsFromBody(parsed, response.status), ms: Date.now() - started };
        await log({ company: conn.company, method, path: path.split("?")[0], status: response.status, ms: result.ms });
        return result;
    } catch (error) {
        const status = error instanceof EbmsError ? error.status : -1;
        const kind = error instanceof EbmsError ? error.kind : "exception";
        await log({ company: conn.company, method, path: path.split("?")[0], status, kind, ms: Date.now() - started });
        throw error;
    }
}
