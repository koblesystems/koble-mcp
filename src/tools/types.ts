/** Shared shapes for tool registration, so every tool returns and fails the same way. */
import type { z } from "zod/v4";
import { EbmsError } from "../ebms/errors.js";

export interface McpToolResult {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
    [key: string]: unknown;
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
    description: string;
    inputSchema: S;
}

export type ToolRegistrar = <S extends z.ZodType>(name: string, definition: ToolDefinition<S>, handler: (args: z.infer<S>) => Promise<McpToolResult>) => void;

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
    return { content: [{ type: "text", text: JSON.stringify({ error: { message }, refused: true, ...extra }, null, 2) }], isError: true };
}
