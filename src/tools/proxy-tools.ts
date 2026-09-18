/**
 * ebms_get, ebms_write, ebms_command: the whole tool surface.
 *
 * Each one resolves the company, applies the guards, sends one request, and returns what
 * EBMS said. No procedure lives here: chunking, resuming, diffing, confirming and reading
 * back are the skills' job. What the server refuses on its own:
 *   - any write or command to a company that is not configured (or, in testing, not the sandbox)
 *   - any body carrying PROCESS, at any depth
 *   - a POST of a document whose EXTERNALID already exists (a duplicate order is the
 *     costly mistake, and this is the one check a model under time pressure skips)
 *   - a denied command (Send, RecordPayment, ... — see EBMS_DENIED_COMMANDS)
 *   - paths that are not a plain entity path
 */
import { z } from "zod/v4";
import { assertWriteCompany, availableCompanies, isWriteCompany, loadSettings, resolveCompany, setDiscoveredCompanies, setDiscoveryError } from "../config.js";
import { odataString, request } from "../ebms/client.js";
import { discoverCompanies } from "../ebms/companies.js";
import { DOCUMENT_ENTITIES, entityOf, externalIdOf, findProcessKeys, isDeniedCommand, validateName, validatePath } from "../guards.js";
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

export function buildQuery(options: { select?: string | undefined; filter?: string | undefined; expand?: string | undefined; orderby?: string | undefined; top?: number | undefined; skip?: number | undefined; count?: boolean | undefined }): string {
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

export function registerProxyTools(register: ToolRegistrar): void {
    register(
        "ebms_companies",
        {
            description:
                "List the companies (datasets) this server can reach on its EBMS serial number, with name, ID, version and whether writes are allowed. Needs no credentials. Call it when the user names a company you haven't seen, or before the first write of a session, so the company is confirmed by name. Nothing marks a company as live or a test copy; ask if unsure.",
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
            description:
                "Read from EBMS OData: a collection (path 'ARINV') or one record (path \"ARINV('<AUTOID>')\"). Always pass select — an unselected read returns every field, many computed, and large ones hit the 2-minute limit. For a collection, count is on by default and the result says whether rows were truncated. Query syntax and the install's quirks are in the ebms-api skill.",
            inputSchema: z.object({
                company: companyField(false),
                path: z.string().min(1).describe("Entity path only, e.g. ARINV, ARINV('7XQPR42LM8W91000'), EntityMetaData('ARINV'), $metadata. No query string."),
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
                    const truncated = total !== null && (args.skip ?? 0) + body.value.length < total;
                    return jsonResult({ company, rows: body.value, returned: body.value.length, total, truncated, warnings: [...warnings, ...result.warnings], ms: result.ms });
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
            description:
                "Write to EBMS: POST creates a record (documents take their lines nested as Details), PATCH updates one by quoted AUTOID (lines via a Details@delta array), DELETE removes one. Refused for a company that is not configured (or not the sandbox, while testing), and refused if the body carries PROCESS anywhere or a POST's EXTERNALID already exists. A 2xx is not proof: EBMS silently ignores unknown @ids and unwritable fields, so read the record back afterwards. If the result says uncertain, read back before resending — a resent create or add duplicates.",
            inputSchema: z.object({
                company: companyField(true),
                method: z.enum(["POST", "PATCH", "DELETE"]),
                path: z.string().min(1).describe("ARINV for a POST; ARINV('<AUTOID>') for PATCH or DELETE."),
                body: z.record(z.string(), z.unknown()).optional().describe("JSON body for POST and PATCH. Omit for DELETE."),
            }),
        },
        async (args) => {
            try {
                const company = resolveCompany(args.company);
                assertWriteCompany(company);
                const path = validatePath(args.path);
                if (args.method === "DELETE" && args.body !== undefined) throw new Error("DELETE takes no body.");
                if (args.method !== "DELETE" && args.body === undefined) throw new Error(`${args.method} needs a body.`);
                if (args.method === "DELETE" && !path.includes("(")) throw new Error("DELETE needs a keyed path, e.g. ARINV('<AUTOID>').");
                if (args.method === "PATCH" && !path.includes("(")) throw new Error("PATCH needs a keyed path, e.g. ARINV('<AUTOID>').");
                if (args.method === "POST" && path.includes("(")) throw new Error("POST goes to the entity set, e.g. ARINV, not a keyed path. Bound actions use ebms_command.");
                const processKeys = findProcessKeys(args.body);
                if (processKeys.length > 0) {
                    throw new Error(`Refused: the body carries PROCESS at ${processKeys.join(", ")}. Posting or unposting a document is done by a person in EBMS, not through this server.`);
                }
                const externalId = args.method === "POST" ? externalIdOf(args.body) : undefined;
                const entity = entityOf(path);
                if (externalId !== undefined && DOCUMENT_ENTITIES.includes(entity)) {
                    const check = await request(company, "GET", `${entity}${buildQuery({ filter: `EXTERNALID eq ${odataString(externalId)}`, select: "AUTOID,INVOICE,EXTERNALID", top: 2 })}`);
                    const existing = (check.body as { value?: unknown[] } | null)?.value ?? [];
                    if (existing.length > 0) {
                        return jsonResult({
                            company,
                            refused: true,
                            reason: `An ${entity} record with EXTERNALID ${externalId} already exists. Nothing was sent. Read it and continue from it instead of creating another.`,
                            existing,
                        });
                    }
                }
                const result = await request(company, args.method, path, args.body);
                return jsonResult({ company, method: args.method, path, status: result.status, record: result.body, warnings: result.warnings, ms: result.ms, next: "Read the record back and compare each field you sent." });
            } catch (error) {
                return errorResult(error, { company: args.company, method: args.method, path: args.path });
            }
        },
    );

    register(
        "ebms_command",
        {
            description:
                "Run a bound action on one record: POST /ENTITY('<AUTOID>')/Model.Entities.<Command>. Omit body for a command with no dialog (MarkAllAsShipped, RecalculateAllPrices) — EBMS rejects even {}. Pass the dialog's fields for one that has a dialog (ChangeCustomer). Refused for a company that is not configured (or not the sandbox, while testing) and for denied commands (Send, RecordPayment by default). Commands return little; read the record back afterwards.",
            inputSchema: z.object({
                company: companyField(true),
                entity: z.string().min(1).describe("e.g. ARINV"),
                key: z.string().min(1).describe("AUTOID of the record."),
                command: z.string().min(1).describe("e.g. MarkAllAsShipped, RecalculateAllPrices, ChangeCustomer"),
                body: z.record(z.string(), z.unknown()).optional().describe("Dialog fields, only for commands that have a dialog."),
            }),
        },
        async (args) => {
            try {
                const company = resolveCompany(args.company);
                assertWriteCompany(company);
                const entity = validateName(args.entity, "Entity");
                const command = validateName(args.command, "Command");
                if (isDeniedCommand(command, loadSettings().deniedCommands)) {
                    throw new Error(`Refused: ${command} is on this server's denied-command list (${loadSettings().deniedCommands.join(", ")}). Do it in EBMS.`);
                }
                const processKeys = findProcessKeys(args.body);
                if (processKeys.length > 0) throw new Error(`Refused: the body carries PROCESS at ${processKeys.join(", ")}.`);
                const path = `${entity}(${odataString(args.key)})/Model.Entities.${command}`;
                const result = await request(company, "POST", path, args.body);
                return jsonResult({ company, command, path, status: result.status, response: result.body, warnings: result.warnings, ms: result.ms, next: "Read the record back to see what changed." });
            } catch (error) {
                return errorResult(error, { company: args.company, entity: args.entity, command: args.command });
            }
        },
    );
}
