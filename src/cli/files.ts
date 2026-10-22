/**
 * Writing the files koble owns or edits: koble's own settings, and the config files of the AI apps
 * it connects. Every write goes to a temporary file that is renamed over the old one, so a crash
 * never leaves half a file.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Backups kept per file; older ones are deleted when a new one is made. */
const BACKUPS = 3;

/**
 * Writes `text` to `path` whole. The file keeps its mode (an app's config often holds other servers'
 * API keys, and may be 0600), or takes `mode` when given. With `backup`, the old file is copied
 * aside first and the path of the copy returned.
 */
export function atomicWrite(path: string, text: string, options: { backup?: boolean; mode?: number } = {}): string | null {
    const exists = existsSync(path);
    // Windows has no permission bits to keep; copying its read-only flag would only break the rename.
    const mode = options.mode ?? (exists && process.platform !== "win32" ? statSync(path).mode & 0o777 : undefined);
    mkdirSync(dirname(path), { recursive: true, ...(options.mode !== undefined ? { mode: 0o700 } : {}) });
    let backup: string | null = null;
    if (options.backup && exists) {
        backup = `${path}.koble-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        copyFileSync(path, backup);
        pruneBackups(path);
    }
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, text, mode === undefined ? {} : { mode });
    if (mode !== undefined && process.platform !== "win32") chmodSync(temp, mode);
    renameSync(temp, path);
    return backup;
}

/** Deletes all but the newest few backups of one file. The timestamps sort as text. */
function pruneBackups(path: string): void {
    const prefix = `${basename(path)}.koble-backup-`;
    const old = readdirSync(dirname(path)).filter((name) => name.startsWith(prefix)).sort().slice(0, -BACKUPS);
    for (const name of old) rmSync(join(dirname(path), name), { force: true });
}

/** A JSON config file as an object ({} when missing or empty), or why it is not one. A UTF-8 BOM is allowed. */
export function readJsonConfig(path: string): Record<string, unknown> | Error {
    if (!existsSync(path)) return {};
    try {
        const text = readFileSync(path, "utf8").replace(/^﻿/, "");
        const parsed = text.trim() ? (JSON.parse(text) as unknown) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("it is not a JSON object");
        return parsed as Record<string, unknown>;
    } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
    }
}
