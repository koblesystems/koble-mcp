/**
 * koble-mcp — a thin MCP server over the EBMS (Koble) OData API.
 *
 * It owns authentication, the list of companies it may use and a few hard guards. Everything else —
 * which entity, which fields, chunking, resuming, diffing, confirming — lives in skills.
 * Transport is stdio, so stdout belongs to JSON-RPC: log with console.error only.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { z } from "zod/v4";
import { describeCompanies, loadSettings, setDiscoveredCompanies, setDiscoveryError } from "./src/config.js";
import { discoverCompanies } from "./src/ebms/companies.js";
import { registerMrpTools } from "./src/tools/mrp-tools.js";
import { registerProxyTools } from "./src/tools/proxy-tools.js";
import type { McpToolResult, ToolDefinition } from "./src/tools/types.js";

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

try {
    setDiscoveredCompanies(await discoverCompanies());
} catch (error) {
    setDiscoveryError(error instanceof Error ? error.message : String(error));
    console.error(`koble-mcp: could not list companies for this serial (${error instanceof Error ? error.message : String(error)}); using EBMS_COMPANIES if set.`);
}

const server = new McpServer(
    { name: "koble-mcp", version: "0.1.0" },
    {
        instructions:
            "Thin proxy over EBMS OData, plus read-only planning tools. Follow the ebms-mrp and ebms-mrp-purchase-orders skills when they are installed. " +
            "PROCESS is never accepted, and ebms_command runs only a short allow-list of actions; a POST whose EXTERNALID already exists is refused; a 2xx is not proof a write applied — read back. " +
            describeSetup(),
    },
);

function register<S extends z.ZodType>(name: string, definition: ToolDefinition<S>, handler: (args: z.infer<S>) => Promise<McpToolResult>): void {
    server.registerTool(name, definition as never, handler as never);
}

registerProxyTools(register);
registerMrpTools(register);

async function main(): Promise<void> {
    await server.connect(new StdioServerTransport());
    console.error(`koble-mcp ready. ${describeSetup()}`);
}

void main();
