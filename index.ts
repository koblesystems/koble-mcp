/**
 * koble-mcp — a thin MCP server over the EBMS (Koble) OData API.
 *
 * It owns authentication, the list of companies it may use and a few hard guards. Everything else —
 * which entity, which fields, chunking, resuming, diffing, confirming — lives in skills.
 * Transport is stdio, so stdout belongs to JSON-RPC: log with console.error only.
 */

import { startServer } from "./src/server.js";

void startServer();
