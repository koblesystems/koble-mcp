/**
 * The hard guards: pure functions, no network, all unit-tested. They refuse what a model
 * must never be able to do by accident — or on the say-so of text it read somewhere.
 *
 * Paths are PARSED and REBUILT, never passed through: the entity name and each key value are
 * validated and then percent-encoded, so nothing a caller supplies can add a path segment, a
 * query or a fragment. The client checks the finished URL again as a second line of defence.
 */

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const isControl = (ch: string): boolean => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127;

export function validateName(value: string, what: string): string {
    const clean = value.trim();
    if (!NAME_RE.test(clean)) throw new Error(`${what} "${value}" is not a plain identifier.`);
    return clean;
}

/** A key value as the caller means it (quotes un-doubled): no path, query or escape syntax, no control characters. */
function validateKeyValue(value: string, what = "Key"): string {
    if (value.length === 0 || value.length > 200) throw new Error(`${what} must be 1 to 200 characters.`);
    const bad = [...value].some((ch) => ch === "/" || ch === "\\" || ch === "?" || ch === "%" || isControl(ch));
    if (bad || value.includes("..")) {
        throw new Error(`${what} "${value}" contains characters that are not allowed in a record key: slash, backslash, question mark, percent, two dots, or a control character.`);
    }
    return value;
}

/** A quoted key for a URL path: quotes doubled for OData, everything else percent-encoded (so # stays data). */
export function encodeKey(value: string): string {
    const encoded = validateKeyValue(value)
        .split("'")
        .map((part) => encodeURIComponent(part))
        .join("''");
    return `'${encoded}'`;
}

const notEntityPath = (path: string): Error =>
    new Error(`Path "${path}" is not an entity path. Use ENTITY or ENTITY('key'); put query options in their own fields, and use ebms_command for bound actions.`);

export interface ParsedPath {
    entity: string;
    /** Encoded and safe to append to the company's OData root. */
    encoded: string;
    keyed: boolean;
}

/** Reads one OData string literal starting at `start` (which must be a quote). */
function readLiteral(text: string, start: number): { value: string; end: number } | null {
    if (text[start] !== "'") return null;
    let value = "";
    for (let i = start + 1; i < text.length; i += 1) {
        if (text[i] === "'") {
            if (text[i + 1] === "'") {
                value += "'";
                i += 1;
                continue;
            }
            return { value, end: i + 1 };
        }
        value += text[i];
    }
    return null;
}

/** ENTITY, ENTITY('key'), ENTITY(FIELD='v',FIELD2='v'), or $metadata. Nothing else. */
function parsePath(path: string): ParsedPath {
    const clean = path.trim().replace(/^\/+/, "");
    if (clean === "$metadata") return { entity: "$metadata", encoded: "$metadata", keyed: false };
    const open = clean.indexOf("(");
    const entity = open < 0 ? clean : clean.slice(0, open);
    if (!NAME_RE.test(entity)) throw notEntityPath(path);
    if (open < 0) return { entity, encoded: entity, keyed: false };
    if (!clean.endsWith(")")) throw notEntityPath(path);
    const inside = clean.slice(open + 1, -1);

    const single = readLiteral(inside, 0);
    if (single && single.end === inside.length) return { entity, encoded: `${entity}(${encodeKey(single.value)})`, keyed: true };

    const parts: string[] = [];
    let at = 0;
    while (at < inside.length) {
        const eq = inside.indexOf("=", at);
        if (eq < 0) throw notEntityPath(path);
        const field = inside.slice(at, eq);
        if (!NAME_RE.test(field)) throw notEntityPath(path);
        const literal = readLiteral(inside, eq + 1);
        if (!literal) throw notEntityPath(path);
        parts.push(`${field}=${encodeKey(literal.value)}`);
        at = literal.end;
        if (at < inside.length) {
            if (inside[at] !== ",") throw notEntityPath(path);
            at += 1;
        }
    }
    if (parts.length === 0) throw notEntityPath(path);
    return { entity, encoded: `${entity}(${parts.join(",")})`, keyed: true };
}

/** The encoded path, or an error if it is anything but an entity path. */
export function validatePath(path: string): string {
    return parsePath(path).encoded;
}

export function entityOf(path: string): string {
    return parsePath(path).entity;
}

/**
 * Every key path in a body whose name is PROCESS, at any depth. Posting a document is a
 * person's decision, made outside this server, so the key is refused wherever it appears.
 */
export function findProcessKeys(body: unknown, at = "$"): string[] {
    if (Array.isArray(body)) return body.flatMap((item, index) => findProcessKeys(item, `${at}[${index}]`));
    if (!body || typeof body !== "object") return [];
    return Object.entries(body as Record<string, unknown>).flatMap(([key, value]) => {
        const here = `${at}.${key}`;
        const own = key.replace(/^[@#]/, "").toUpperCase() === "PROCESS" ? [here] : [];
        return [...own, ...findProcessKeys(value, here)];
    });
}

/**
 * Bound actions are allowed by name, not refused by name: EBMS has many that post, process,
 * pay or send (ProcessScanner, Post, Unpost, RecordPayment, Send and more) and a list of
 * those can never be complete. Only the actions the skills actually use are let through.
 */
export function isAllowedCommand(command: string, allowed: readonly string[]): boolean {
    const wanted = command.trim().toLowerCase();
    return allowed.some((name) => name.trim().toLowerCase() === wanted);
}

/** The top-level EXTERNALID a create carries, if any. */
export function externalIdOf(body: unknown): string | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    const value = (body as Record<string, unknown>)["EXTERNALID"];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Entities that carry an EXTERNALID and where a duplicate create is the costly mistake. */
export const DOCUMENT_ENTITIES = ["ARINV", "APINV", "INMFG", "TASK"];
