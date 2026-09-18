/**
 * The hard guards: pure functions, no network, all unit-tested. They refuse what a model
 * must never be able to do by accident, and nothing else.
 */

/** `ENTITY`, `ENTITY('key')`, `ENTITY(FIELD='v',FIELD2='v')`, or `$metadata`. Nothing else. */
const PATH_RE = /^(\$metadata|[A-Za-z][A-Za-z0-9_]*(\('(?:[^']|'')*'\)|\([A-Za-z0-9_]+='(?:[^']|'')*'(?:,[A-Za-z0-9_]+='(?:[^']|'')*')*\))?)$/;

/** Returns the path without a leading slash, or throws if it is anything but an entity path. */
export function validatePath(path: string): string {
    const clean = path.trim().replace(/^\/+/, "");
    if (!PATH_RE.test(clean)) {
        throw new Error(
            `Path "${path}" is not an entity path. Use ENTITY or ENTITY('key'); put query options in their own fields, and use ebms_command for bound actions.`,
        );
    }
    return clean;
}

export function entityOf(path: string): string {
    return validatePath(path).replace(/\(.*$/, "");
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
export function validateName(value: string, what: string): string {
    const clean = value.trim();
    if (!NAME_RE.test(clean)) throw new Error(`${what} "${value}" is not a plain identifier.`);
    return clean;
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

export function isDeniedCommand(command: string, denied: readonly string[]): boolean {
    const wanted = command.trim().toLowerCase();
    return denied.some((name) => name.trim().toLowerCase() === wanted);
}

/** The top-level EXTERNALID a create carries, if any. */
export function externalIdOf(body: unknown): string | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    const value = (body as Record<string, unknown>)["EXTERNALID"];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Entities that carry an EXTERNALID and where a duplicate create is the costly mistake. */
export const DOCUMENT_ENTITIES = ["ARINV", "APINV"];
