/**
 * EBMS reports failures in the response body as a Messages[] envelope, sometimes under a
 * 2xx status. This module normalises that, and keeps warnings apart from errors: a 2xx
 * whose messages are all warnings is a success that the caller should still hear about.
 */
export interface EbmsMessage {
    Id?: string;
    Severity?: string;
    TextBriefDescription?: string;
    BriefDescription?: string;
    TextSolution?: string;
    TextDetail?: string;
    Detail?: string;
}

export type ErrorKind = "network" | "timeout" | "http" | "credentials" | "embedded" | "refused" | "signin";

export class EbmsError extends Error {
    readonly status: number;
    readonly kind: ErrorKind;
    readonly detail: string | undefined;
    readonly solution: string | undefined;

    constructor(message: string, status: number, options: { kind?: ErrorKind | undefined; detail?: string | undefined; solution?: string | undefined } = {}) {
        super(message);
        this.name = "EbmsError";
        this.status = status;
        this.kind = options.kind ?? "http";
        this.detail = options.detail;
        this.solution = options.solution;
    }

    /**
     * True when the request's fate is unknown: a timeout, a dropped connection, or a
     * gateway/server error. A write that failed this way may still have been applied, so
     * the only safe next step is to read the record back — never to resend it.
     */
    get uncertain(): boolean {
        // Signing in happens before the request itself, so a failure there means nothing was sent.
        if (this.kind === "refused" || this.kind === "credentials" || this.kind === "signin") return false;
        return this.kind === "network" || this.kind === "timeout" || this.kind === "embedded" || this.status === 408 || this.status >= 500;
    }

    override toString(): string {
        const parts = [`EBMS ${this.status}: ${this.message}`];
        if (this.detail) parts.push(this.detail);
        if (this.solution) parts.push(this.solution);
        return parts.join(" — ");
    }
}

export function messagesFromBody(body: unknown): EbmsMessage[] {
    if (!body || typeof body !== "object") return [];
    const messages = (body as { Messages?: unknown }).Messages;
    // EBMS's envelope is trusted no further than its shape: anything that is not an object is dropped.
    return Array.isArray(messages) ? (messages.filter((m) => m !== null && typeof m === "object") as EbmsMessage[]) : [];
}

const text = (m: EbmsMessage): string => m.TextBriefDescription ?? m.BriefDescription ?? "EBMS message";
const isErrorSeverity = (m: EbmsMessage, status: number): boolean => {
    const severity = typeof m.Severity === "string" ? m.Severity.toLowerCase() : undefined;
    // On a failure status every message is part of the failure. On a success, only a
    // message that says it is an error counts as one.
    if (status >= 400) return true;
    return severity === "error" || severity === "fatal";
};

/** An EbmsError when the body's messages amount to a failure, else null. */
export function errorFromBody(body: unknown, status: number): EbmsError | null {
    const messages = messagesFromBody(body);
    const errors = messages.filter((m) => isErrorSeverity(m, status));
    const [first] = errors;
    if (!first) return null;
    return new EbmsError(errors.map(text).join("; "), status, { detail: first.TextDetail ?? first.Detail, solution: first.TextSolution });
}

/** Messages in a body that are not errors, as text. */
export function warningsFromBody(body: unknown, status: number): string[] {
    return messagesFromBody(body)
        .filter((m) => !isErrorSeverity(m, status))
        .map((m) => `${m.Severity ?? "Message"}: ${text(m)}`);
}
