/** Shared shapes for tool registration, so every tool returns and fails the same way. */
import type { z } from "zod/v4";
import { EbmsError } from "../ebms/errors.js";

export type ContentBlock =
    | { type: "text"; text: string }
    /** A file's contents travelling with the result, so the chat can show or offer it without anyone fetching it from disk. */
    | { type: "resource"; resource: { uri: string; mimeType: string; text: string } };

export interface McpToolResult {
    content: ContentBlock[];
    isError?: boolean;
    [key: string]: unknown;
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
    description: string;
    inputSchema: S;
}

export type ToolRegistrar = <S extends z.ZodType>(name: string, definition: ToolDefinition<S>, handler: (args: z.infer<S>) => Promise<McpToolResult>) => void;

/** A JSON result with a text file attached to it. */
export function jsonResultWithFile(value: unknown, file: { uri: string; mimeType: string; text: string }): McpToolResult {
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }, { type: "resource", resource: file }] };
}

export function jsonResult(value: unknown): McpToolResult {
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/**
 * Every failure comes back in one shape. `uncertain` is the field a skill must read before
 * retrying a write: true means "read the record back first".
 */
export function errorResult(error: unknown, extra: Record<string, unknown> = {}): McpToolResult {
    if (error instanceof EbmsError) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(
                        {
                            error: { status: error.status, kind: error.kind, message: error.message, detail: error.detail, solution: error.solution },
                            uncertain: error.uncertain,
                            advice: error.uncertain
                                ? extra["method"] === undefined && extra["command"] === undefined
                                    ? "The read did not complete; it is safe to try again."
                                    : "The outcome is unknown. Read the record back before sending this again; a resent create or add duplicates."
                                : extra["method"] === undefined && extra["command"] === undefined
                                  ? "EBMS refused this request."
                                  : "EBMS refused this request; nothing was saved.",
                            ...extra,
                        },
                        null,
                        2,
                    ),
                },
            ],
            isError: true,
        };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (extra["afterSend"] === true) {
        // Something failed in this server AFTER the request went to EBMS: the write may well have happened.
        const { afterSend: _afterSend, ...rest } = extra;
        return { content: [{ type: "text", text: JSON.stringify({ error: { message }, uncertain: true, advice: "The request was sent to EBMS and this server failed while handling the answer. The outcome is unknown: read the record back before sending this again; a resent create or add duplicates.", ...rest }, null, 2) }], isError: true };
    }
    // Otherwise it was raised by this server before a request went out.
    return { content: [{ type: "text", text: JSON.stringify({ error: { message }, refused: true, uncertain: false, advice: "This server refused the request; nothing was sent to EBMS.", ...extra }, null, 2) }], isError: true };
}
