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
 * Every failure comes back in one shape, and `uncertain` is the field to read before retrying a
 * write: true means the request had gone to EBMS and the outcome is not known, so read the record
 * back first. `afterSend` marks a fault inside this server once the request was already out.
 */
export function errorResult(error: unknown, context: Record<string, unknown> = {}): McpToolResult {
    const { afterSend, ...where } = context;
    const isWrite = where["method"] !== undefined || where["command"] !== undefined;
    const ebms = error instanceof EbmsError ? error : null;
    const uncertain = ebms ? ebms.uncertain : afterSend === true;
    const advice = uncertain
        ? isWrite
            ? "The outcome is unknown. Read the record back before sending this again; a resent create or add duplicates."
            : "The read did not complete; it is safe to try again."
        : ebms
          ? isWrite
              ? "EBMS refused this request; nothing was saved."
              : "EBMS refused this request."
          : "This server refused the request; nothing was sent to EBMS.";
    const detail = ebms
        ? { status: ebms.status, kind: ebms.kind, message: ebms.message, detail: ebms.detail, solution: ebms.solution }
        : { message: error instanceof Error ? error.message : String(error) };
    const body = { error: detail, ...(ebms || uncertain ? {} : { refused: true }), uncertain, advice, ...where };
    return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], isError: true };
}
