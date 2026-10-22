/**
 * ebms_get, ebms_write, ebms_command: the whole tool surface.
 *
 * Each one resolves the company, applies the guards, sends one request, and returns what
 * EBMS said. No procedure lives here: chunking, resuming, diffing, confirming and reading
 * back are the skills' job. What the server refuses on its own:
 *   - any write or command to a company that is not configured (or, in testing, not the sandbox)
 *   - any body carrying PROCESS, at any depth
 *   - a POST of a document, customer, vendor, product or worker whose EXTERNALID already exists (a duplicate order is the
 *     costly mistake, and this is the one check a model under time pressure skips), or while a
 *     create with that EXTERNALID is still in flight or came back uncertain and has not been read back
 *   - a POST of a vendor without an ID (a folder with no ID method would save a blank one)
 *   - any bound action not on the allow-list (EBMS_ALLOWED_COMMANDS)
 *   - paths that are not a plain entity path; keys are validated and percent-encoded
 */
import { z } from "zod/v4";
import { assertWriteCompany, availableCompanies, isWriteCompany, loadSettings, resolveCompany, setDiscoveredCompanies, setDiscoveryError } from "../config.js";
import { odataString, request } from "../ebms/client.js";
import { discoverCompanies } from "../ebms/companies.js";
import { readBefore, verifyDelete, verifyWrite, type Before, type ReadBack } from "../verify-run.js";
import type { Verification } from "../verify.js";
import { DOCUMENT_ENTITIES, encodeKey, entityOf, externalIdOf, findProcessKeys, isAllowedCommand, keyNamed, validateName, validatePath } from "../guards.js";
import { EbmsError } from "../ebms/errors.js";
import type { ToolRegistrar } from "./types.js";
import { errorResult, jsonResult } from "./types.js";

const companyField = (required: boolean) => {
    const base = z.string().describe(
        required
            ? "Company, by ID or name as ebms_companies lists them. Required on every write."
            : "Company, by ID or name as ebms_companies lists them. May be omitted only when one company is available.",
    );
    return required ? base.min(1) : base.optional();
};

function buildQuery(options: { select?: string | undefined; filter?: string | undefined; expand?: string | undefined; orderby?: string | undefined; top?: number | undefined; skip?: number | undefined; count?: boolean | undefined }): string {
    const params = new URLSearchParams();
    if (options.filter) params.set("$filter", options.filter);
    if (options.select) params.set("$select", options.select);
    if (options.expand) params.set("$expand", options.expand);
    if (options.orderby) params.set("$orderby", options.orderby);
    if (options.top !== undefined) params.set("$top", String(options.top));
    if (options.skip !== undefined) params.set("$skip", String(options.skip));
    if (options.count) params.set("$count", "true");
    const query = params.toString();
    return query.length > 0 ? `?${query}` : "";
}

/** Rows ebms_get shows when no top was asked for; beyond this, ebms_export is the way. */
export const GET_ROW_CAP = 200;
/** About 40k tokens: the most rows one ebms_get puts into the conversation, whatever top says. */
export const GET_BYTE_CAP = 150_000;

/** The rows that fit: at most GET_ROW_CAP when no top was given, and never more than GET_BYTE_CAP of JSON. */
export function capRows(rows: unknown[], noTop: boolean): unknown[] {
    const limit = noTop ? Math.min(rows.length, GET_ROW_CAP) : rows.length;
    let bytes = 0;
    for (let i = 0; i < limit; i += 1) {
        bytes += JSON.stringify(rows[i] ?? null).length + 1;
        if (bytes > GET_BYTE_CAP) return rows.slice(0, Math.max(1, i));
    }
    return limit === rows.length ? rows : rows.slice(0, limit);
}

/** The request must be the right shape for its verb, and must not carry PROCESS anywhere. */
function checkShape(method: "POST" | "PATCH" | "DELETE", path: string, body: unknown): void {
    const keyed = path.includes("(");
    if (method === "DELETE" && body !== undefined) throw new Error("DELETE takes no body.");
    if (method !== "DELETE" && body === undefined) throw new Error(`${method} needs a body.`);
    if (method !== "POST" && !keyed) throw new Error(`${method} needs a keyed path, e.g. ARINV('<AUTOID>').`);
    if (method === "POST" && keyed) throw new Error("POST goes to the entity set, e.g. ARINV, not a keyed path. Bound actions use ebms_command.");
    const processKeys = findProcessKeys(body);
    if (processKeys.length > 0) throw new Error(`Refused: the body carries PROCESS at ${processKeys.join(", ")}. Posting or unposting a document is done by a person in EBMS, not through this server.`);
    // Keys are matched in any case, and two spellings of one are refused, before anything relies on them.
    keyNamed(body, "EXTERNALID");
    const idKey = keyNamed(body, "ID");
    // A vendor folder without an ID method tries to save a vendor whose ID is blank, which no lookup by ID finds.
    const id = idKey === undefined ? undefined : (body as Record<string, unknown>)[idKey];
    if (method === "POST" && entityOf(path).toUpperCase() === "APVENDOR" && (typeof id !== "string" || id.trim() === "")) {
        throw new Error("Refused: a new vendor needs an ID: a non-blank string of at most 10 characters. EBMS generates one only when the vendor folder has a default ID method, which the API cannot show; without one it tries to save a vendor with a blank ID.");
    }
}

/**
 * Creates by EXTERNALID that are in flight, and those whose outcome came back unknown. The
 * duplicate check reads before it writes, so two parallel creates would both read "none", and a
 * create that timed out may still land after a resend's check. Both cases are refused here.
 */
interface Unsure { company: string; entity: string; externalId: string; at: number }
const creating = new Set<string>();
const unsure = new Map<string, Unsure>();
const UNSURE_HOLD_MS = 10 * 60 * 1000;
/** EBMS ends a request at about 2 minutes, so a read this long after an unknown create sees whatever landed. */
const SETTLE_MS = 150_000;
const createKey = (company: string, entity: string, externalId: string): string => JSON.stringify([company, entity, externalId].map((part) => part.toUpperCase()));

/**
 * A read by EXTERNALID settles an unknown create: it is there (and the duplicate check will now
 * find it), or a read of exactly that EXTERNALID came back empty once EBMS had time to finish.
 */
function settleUnsure(company: string, entity: string, filter: string, rows: unknown[], complete: boolean): void {
    for (const [key, held] of unsure) {
        if (Date.now() - held.at >= UNSURE_HOLD_MS) unsure.delete(key);
        if (held.company.toUpperCase() !== company.toUpperCase() || held.entity.toUpperCase() !== entity.toUpperCase()) continue;
        const exact = filter.replace(/\s+/g, " ").trim().toUpperCase() === `EXTERNALID EQ ${odataString(held.externalId)}`.toUpperCase();
        const found = rows.some((row) => String((row as Record<string, unknown> | null)?.["EXTERNALID"] ?? "").toUpperCase() === held.externalId.toUpperCase());
        if (found || (exact && (rows.length > 0 || (complete && Date.now() - held.at > SETTLE_MS)))) unsure.delete(key);
    }
}

/** Documents already carrying the EXTERNALID a create would use. A second one is the costly mistake. */
async function findExisting(company: string, entity: string, body: unknown): Promise<unknown[]> {
    const externalId = externalIdOf(body);
    if (externalId === undefined || !DOCUMENT_ENTITIES.includes(entity.toUpperCase())) return [];
    const found = await request(company, "GET", `${entity}${buildQuery({ filter: `EXTERNALID eq ${odataString(externalId)}`, select: "AUTOID,EXTERNALID", top: 2 })}`);
    return (found.body as { value?: unknown[] } | null)?.value ?? [];
}

async function verifyAfter(company: string, method: "POST" | "PATCH" | "DELETE", entity: string, path: string, body: unknown, created: Record<string, unknown>, before: Before | null, readBack: ReadBack | undefined): Promise<Verification> {
    if (method === "DELETE") return verifyDelete(company, path);
    if (method === "PATCH") return verifyWrite(company, path, body, before, readBack);
    if (typeof created["AUTOID"] !== "string") throw new Error("EBMS returned no AUTOID for the new record, so it could not be read back.");
    return verifyWrite(company, `${entity}(${odataString(created["AUTOID"])})`, body, null, readBack);
}

export function registerProxyTools(register: ToolRegistrar): void {
    register(
        "ebms_companies",
        {
            description: [
                "List the companies (datasets) this server can reach on its EBMS serial number, with name, ID, version and whether writes are allowed.",
                "Needs no credentials.",
                "Call it when the user names a company you haven't seen, or before the first write of a session, so the company is confirmed by name.",
                "Nothing marks a company as live or a test copy; ask if unsure.",
            ].join(" "),
            inputSchema: z.object({}),
        },
        async () => {
            try {
                try {
                    setDiscoveredCompanies(await discoverCompanies());
                } catch (error) {
                    setDiscoveryError(error instanceof Error ? error.message : String(error));
                }
                const { sandbox, configured } = loadSettings();
                const companies = availableCompanies().map((info) => ({ ...info, writable: isWriteCompany(info.id) }));
                return jsonResult({
                    companies,
                    note: [
                        configured ? `EBMS_COMPANIES limits this server to: ${configured.join(", ")}.` : "Every company the serial reaches is available.",
                        sandbox ? `Testing mode: writes go only to ${sandbox}.` : "Every available company may be written to; name it on every write.",
                    ].join(" "),
                });
            } catch (error) {
                return errorResult(error);
            }
        },
    );

    register(
        "ebms_get",
        {
            description: [
                "Read from EBMS OData: a collection (path 'ARINV') or one record (path \"ARINV('<AUTOID>')\").",
                "Always pass select — an unselected read returns every field, many computed, and large ones hit the 2-minute limit.",
                "For a collection, count is on by default and the result says whether rows were truncated.",
                `For more than a few hundred rows use ebms_export instead: without top only ${GET_ROW_CAP} rows are shown, and never more than about ${GET_BYTE_CAP / 1000} KB.`,
                "Query syntax and the install's quirks are in the ebms-api skill.",
            ].join(" "),
            inputSchema: z.object({
                company: companyField(false),
                path: z.string().min(1).describe("Required. Entity path only, e.g. ARINV, ARINV('7XQPR42LM8W91000'), EntityMetaData('ARINV'), $metadata. No query string."),
                select: z.string().optional().describe("$select, comma-separated. Include one inside expand too: Details($select=AUTOID,INVEN)."),
                filter: z.string().optional().describe("$filter, unencoded."),
                expand: z.string().optional(),
                orderby: z.string().optional(),
                top: z.number().int().min(1).max(1000).optional(),
                skip: z.number().int().min(0).optional(),
                count: z.boolean().optional().describe("Ask for @odata.count. Default true for collections."),
            }),
        },
        async (args) => {
            try {
                const company = resolveCompany(args.company);
                const path = validatePath(args.path);
                const isCollection = !path.includes("(") && path !== "$metadata";
                const warnings: string[] = [];
                if (!args.select && path !== "$metadata" && !path.startsWith("EntityMetaData")) warnings.push("No select was given: EBMS returns every field, which is slow and large. Select the fields you need.");
                const query = buildQuery({ ...args, count: args.count ?? isCollection });
                const result = await request(company, "GET", `${path}${query}`);
                const body = result.body as { value?: unknown[]; "@odata.count"?: number } | null;
                if (isCollection && body && Array.isArray(body.value)) {
                    const total = typeof body["@odata.count"] === "number" ? body["@odata.count"] : null;
                    const short = total !== null && (args.skip ?? 0) + body.value.length < total;
                    if (args.filter && unsure.size > 0) settleUnsure(company, entityOf(args.path), args.filter, body.value, !short && (args.skip ?? 0) === 0);
                    const rows = capRows(body.value, args.top === undefined);
                    const clipped = rows.length < body.value.length;
                    const truncated = clipped || short;
                    if (clipped) warnings.push(`EBMS returned ${body.value.length} rows; only the first ${rows.length} are shown, to keep the conversation from filling up. Do not page through the rest with skip: use ebms_export with the same path, select and filter, which writes them all to a file and returns a summary, then analyse the file with a script.`);
                    return jsonResult({ company, rows, returned: rows.length, ...(clipped ? { received: body.value.length } : {}), total, truncated, warnings: [...warnings, ...result.warnings], ms: result.ms });
                }
                return jsonResult({ company, record: result.body, warnings: [...warnings, ...result.warnings], ms: result.ms });
            } catch (error) {
                return errorResult(error);
            }
        },
    );

    register(
        "ebms_write",
        {
            description: [
                "Write to EBMS: POST creates a record (documents take their lines nested as Details), PATCH updates one by quoted AUTOID (lines via a Details@delta array), DELETE removes one.",
                "Refused for a company that is not configured (or not the sandbox, while testing), and refused if the body carries PROCESS anywhere, a POST's EXTERNALID already exists (orders, POs, batches, tasks, customers, vendors, products, workers), or a vendor (APVENDOR) POST has no ID.",
                "A 2xx is not proof — EBMS silently ignores unknown @ids and unwritable fields — so the server reads back the fields you sent and returns a verification: ok, mismatches (sent vs stored), problems (a row that never appeared or was not removed), notes (rows EBMS added itself) and the stored rows.",
                "Treat ok:false as a partly failed write and tell the user.",
                "If the result says uncertain, read back before resending — a resent create or add duplicates; a create resent by EXTERNALID is refused until a read finds it or confirms it is absent.",
            ].join(" "),
            inputSchema: z.object({
                company: companyField(true),
                method: z.enum(["POST", "PATCH", "DELETE"]),
                path: z.string().min(1).describe("Required. ARINV for a POST; ARINV('<AUTOID>') for PATCH or DELETE."),
                body: z.record(z.string(), z.unknown()).optional().describe("JSON body for POST and PATCH. Omit for DELETE."),
                verify: z.boolean().optional().describe("Default true: after the write the server reads back exactly the fields you sent and reports each mismatch. Set false only for a write whose result you will read yourself."),
                readBack: z
                    .object({
                        record: z.string().optional().describe("Extra top-level fields to return with the verification, e.g. INVOICE,TOTAL_S_SO,TOTAL_SO."),
                        lines: z.string().optional().describe("Extra fields to return for every row the write touched or created, e.g. UNIT_MEAS,UNIT_VIS,SO_AMOUNT — the values EBMS computed."),
                        children: z.string().optional().describe("A child navigation to read under every new row, e.g. Materials, so rows EBMS adds by itself (an assembly kit's default components) are reported in notes."),
                    })
                    .optional(),
            }),
        },
        async (args) => {
            let sent = false;
            let pending: { key: string; company: string; entity: string; externalId: string } | null = null;
            try {
                const company = resolveCompany(args.company);
                assertWriteCompany(company);
                const path = validatePath(args.path);
                const entity = entityOf(args.path);
                checkShape(args.method, path, args.body);
                const verify = args.verify ?? true;

                const externalId = args.method === "POST" && DOCUMENT_ENTITIES.includes(entity.toUpperCase()) ? externalIdOf(args.body) : undefined;
                if (externalId !== undefined) {
                    const wanted = createKey(company, entity, externalId);
                    if (creating.has(wanted)) {
                        return jsonResult({ company, refused: true, uncertain: false, reason: `Another create of ${entity} with EXTERNALID ${externalId} is still in progress. Nothing was sent. Wait for it, then read the record back instead of creating another.` });
                    }
                    const held = unsure.get(wanted);
                    if (held && Date.now() - held.at < UNSURE_HOLD_MS) {
                        return jsonResult({ company, refused: true, uncertain: false, reason: `An earlier create of ${entity} with EXTERNALID ${externalId} came back with an unknown outcome. Nothing was sent. Read back first: ebms_get ${entity} with filter EXTERNALID eq ${odataString(externalId)}. If it is there, continue from it. If it is not, EBMS may still be finishing the first request: read again a few minutes after the failure, and send the create again only once that read is empty.` });
                    }
                    unsure.delete(wanted);
                    creating.add(wanted);
                    pending = { key: wanted, company, entity, externalId };
                }

                // Everything up to here, and the two reads below, happen BEFORE the write: if one fails, nothing was sent.
                let before: Before | null = null;
                try {
                    const existing = args.method === "POST" ? await findExisting(company, entity, args.body) : [];
                    if (existing.length > 0) {
                        return jsonResult({ company, refused: true, uncertain: false, reason: `An ${entity} record with EXTERNALID ${externalIdOf(args.body)} already exists. Nothing was sent. Read it and continue from it instead of creating another.`, existing });
                    }
                    if (verify && args.method === "PATCH") before = await readBefore(company, path, args.body);
                } catch (error) {
                    const why = error instanceof Error ? error.message : String(error);
                    return jsonResult({ company, method: args.method, path, refused: true, uncertain: false, reason: `A check before the write failed (${why}), so the write was NOT sent. Nothing changed in EBMS. It is safe to try again.` });
                }

                sent = true;
                const result = await request(company, args.method, path, args.body);
                const created = (result.body ?? {}) as Record<string, unknown>;
                const identity = Object.fromEntries(["AUTOID", "INVOICE", "ID"].filter((key) => created[key] !== undefined).map((key) => [key, created[key]]));
                const base = { company, method: args.method, path, status: result.status, ...(Object.keys(identity).length > 0 ? { record: identity } : {}), warnings: result.warnings, ms: result.ms };
                if (!verify) return jsonResult({ ...base, verification: "skipped", next: "Read the record back and compare each field you sent." });

                const verifyStarted = Date.now();
                try {
                    const verification = await verifyAfter(company, args.method, entity, path, args.body, created, before, args.readBack);
                    return jsonResult({
                        ...base,
                        verification,
                        verifyMs: Date.now() - verifyStarted,
                        next: verification.ok
                            ? "Every field sent was stored as sent. Report EBMS's values from verification.rows, not the ones you sent."
                            : "EBMS accepted the request but did not store everything as sent. Show the user the mismatches and problems; do not resend an add.",
                    });
                } catch (error) {
                    // The write succeeded; only looking at it afterwards failed.
                    return jsonResult({ ...base, verification: null, verificationError: error instanceof Error ? error.message : String(error), next: "The write itself returned the status above; only the read-back failed. Read the record before doing anything else, and do not resend the write." });
                }
            } catch (error) {
                // A create whose outcome is unknown may still land: hold its EXTERNALID until it is read back.
                const uncertain = error instanceof EbmsError ? error.uncertain : sent;
                if (pending !== null && sent && uncertain) unsure.set(pending.key, { company: pending.company, entity: pending.entity, externalId: pending.externalId, at: Date.now() });
                return errorResult(error, { company: args.company, method: args.method, path: args.path, ...(sent && !(error instanceof EbmsError) ? { afterSend: true } : {}) });
            } finally {
                if (pending !== null) creating.delete(pending.key);
            }
        },
    );

    register(
        "ebms_command",
        {
            description: [
                "Run a bound action on one record: POST /ENTITY('<AUTOID>')/Model.Entities.<Command>.",
                "Omit body for a command with no dialog (MarkAllAsShipped, RecalculateAllPrices) — EBMS rejects even {}.",
                "Pass the dialog's fields for one that has a dialog (ChangeCustomer).",
                "Refused for a company that is not configured (or not the sandbox, while testing), and for any action that is not on the server's short allow-list — nothing that posts, processes, pays or sends.",
                "Commands return little; read the record back afterwards.",
            ].join(" "),
            inputSchema: z.object({
                company: companyField(true),
                entity: z.string().min(1).describe("Required. The entity, e.g. ARINV"),
                key: z.string().min(1).describe("Required. AUTOID of the record."),
                command: z.string().min(1).describe("Required. The action name, e.g. MarkAllAsShipped, RecalculateAllPrices, ChangeCustomer"),
                body: z.record(z.string(), z.unknown()).optional().describe("Dialog fields, only for commands that have a dialog."),
            }),
        },
        async (args) => {
            let sent = false;
            try {
                const company = resolveCompany(args.company);
                assertWriteCompany(company);
                const entity = validateName(args.entity, "Entity");
                const command = validateName(args.command, "Command");
                if (!isAllowedCommand(command, loadSettings().allowedCommands)) {
                    throw new Error(`Refused: ${command} is not one of the actions this server runs (${loadSettings().allowedCommands.join(", ")}). Anything that posts, processes, pays or sends is done by a person in EBMS.`);
                }
                const processKeys = findProcessKeys(args.body);
                if (processKeys.length > 0) throw new Error(`Refused: the body carries PROCESS at ${processKeys.join(", ")}.`);
                const path = `${entity}(${encodeKey(args.key)})/Model.Entities.${command}`;
                sent = true;
                const result = await request(company, "POST", path, args.body);
                return jsonResult({ company, command, path, status: result.status, response: result.body, warnings: result.warnings, ms: result.ms, next: "Read the record back to see what changed." });
            } catch (error) {
                return errorResult(error, { company: args.company, entity: args.entity, command: args.command, ...(sent && !(error instanceof EbmsError) ? { afterSend: true } : {}) });
            }
        },
    );
}
