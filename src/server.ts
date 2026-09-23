/**
 * The MCP server: tools, prompts and the skills guide, over stdio. Started by `koble mcp` or by
 * `node index.js`. stdout belongs to JSON-RPC, so log with console.error only.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { z } from "zod/v4";
import { describeCompanies, loadSettings, setDiscoveredCompanies, setDiscoveryError } from "./config.js";
import { discoverCompanies } from "./ebms/companies.js";
import { loadGuide, skillSummary } from "./guide.js";
import { registerPrompts } from "./prompts.js";
import { registerGuideTools } from "./tools/guide-tools.js";
import { registerMrpTools } from "./tools/mrp-tools.js";
import { registerProxyTools } from "./tools/proxy-tools.js";
import { registerWorksheetTools } from "./tools/worksheet-tools.js";
import type { McpToolResult, ToolDefinition } from "./tools/types.js";
import { VERSION } from "./version.js";

function describeSetup(): string {
    try {
        const { sandbox, allowedCommands } = loadSettings();
        const companies = describeCompanies();
        return [
            companies ? `Companies: ${companies}.` : "No companies known yet; call ebms_companies.",
            sandbox ? `Testing mode: writes go only to ${sandbox}.` : "Every available company may be read and written; name the company (ID or name) on every write.",
            companies.includes(",") ? "Name the company on every call." : "",
            `Actions ebms_command will run: ${allowedCommands.join(", ")}.`,
        ]
            .filter(Boolean)
            .join(" ");
    } catch (error) {
        return `Not configured: ${error instanceof Error ? error.message : String(error)}`;
    }
}

/** Runs the MCP server over stdio until the host closes it. */
export async function startServer(): Promise<void> {
    try {
        setDiscoveredCompanies(await discoverCompanies());
    } catch (error) {
        setDiscoveryError(error instanceof Error ? error.message : String(error));
        console.error(`koble-mcp: could not list companies for this serial (${error instanceof Error ? error.message : String(error)}); using EBMS_COMPANIES if set.`);
    }

    const guide = loadGuide();
    const server = new McpServer(
        { name: "koble-mcp", version: VERSION },
        {
            instructions:
                "Thin proxy over EBMS OData, plus read-only planning tools. " +
                "The procedures live in skills. If the matching skill is not already loaded in this app, call ebms_guide with its name before any task beyond a single read, and follow it. " +
                `Skills: ${skillSummary(guide)}. ` +
                "PROCESS is never accepted, and ebms_command runs only a short allow-list of actions; a POST whose EXTERNALID already exists is refused; a 2xx is not proof a write applied — read back. " +
                describeSetup(),
        },
    );

    const register = <S extends z.ZodType>(name: string, definition: ToolDefinition<S>, handler: (args: z.infer<S>) => Promise<McpToolResult>): void => {
        server.registerTool(name, definition as never, handler as never);
    };
    registerProxyTools(register);
    registerMrpTools(register);
    registerWorksheetTools(register);
    registerGuideTools(register, guide);
    registerPrompts((name, config, callback) => server.registerPrompt(name, config as never, callback as never));

    await server.connect(new StdioServerTransport());
    console.error(`koble-mcp ${VERSION} ready. ${describeSetup()}`);
}
