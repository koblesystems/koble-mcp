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
import { loadSettings } from "./src/config.js";
import { registerProxyTools } from "./src/tools/proxy-tools.js";
import type { McpToolResult, ToolDefinition } from "./src/tools/types.js";

function describeSetup(): string {
    try {
        const { companies, sandbox, deniedCommands } = loadSettings();
        return [
            `Companies: ${companies.join(", ")}.`,
            sandbox ? `Testing mode: writes go only to ${sandbox}.` : "Every listed company may be read and written; name the company on every write.",
            companies.length > 1 ? "Name the company on every call." : "",
            `Denied commands: ${deniedCommands.join(", ")}.`,
        ]
            .filter(Boolean)
            .join(" ");
    } catch (error) {
        return `Not configured: ${error instanceof Error ? error.message : String(error)}`;
    }
}

const server = new McpServer(
    { name: "koble-mcp", version: "0.1.0" },
    {
        instructions:
            "Thin proxy over EBMS OData. Use the ebms-api skill for syntax and quirks and the task skills for procedure. " +
            "PROCESS is never accepted; a POST whose EXTERNALID already exists is refused; a 2xx is not proof a write applied — read back. " +
            describeSetup(),
    },
);

function register<S extends z.ZodType>(name: string, definition: ToolDefinition<S>, handler: (args: z.infer<S>) => Promise<McpToolResult>): void {
    server.registerTool(name, definition as never, handler as never);
}

registerProxyTools(register);

async function main(): Promise<void> {
    await server.connect(new StdioServerTransport());
    console.error(`koble-mcp ready. ${describeSetup()}`);
}

void main();
