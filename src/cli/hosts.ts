/**
 * Connecting the server to the Claude apps on this computer.
 *
 * Claude Desktop reads one strict JSON file: a stray comment switches off every local server. So
 * the file is parsed before anything is changed, left alone if it does not parse, backed up, and
 * written whole. Claude Code is connected through its own `claude` command.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

export const SERVER_NAME = "koble-mcp";
export const MARKETPLACE = "koblesystems/koble-mcp";
export const PLUGIN = "koble-mcp@koblesystems";

export interface Launch {
    command: string;
    args: string[];
}

/**
 * Where Claude Desktop keeps its config on Windows. The packaged (Microsoft Store style) build reads
 * the copy in its own package folder, LocalCache\Roaming\Claude, and ignores %APPDATA%\Claude once
 * that copy exists — seen on a Windows VM, where "Edit config" opened the package folder's file.
 * So both are written, the package folder's first.
 */
export function windowsDesktopPaths(roaming: string, localAppData: string, packages: string[]): string[] {
    const packaged = packages.filter((name) => /^Claude_/i.test(name)).map((name) => join(localAppData, "Packages", name, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
    return [...packaged, join(roaming, "Claude", "claude_desktop_config.json")];
}

/** Every config file the installed Claude Desktop may read: the ones whose app folder exists. */
export function desktopConfigPaths(): string[] {
    if (process.platform === "darwin") {
        const path = join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
        return existsSync(dirname(path)) ? [path] : [];
    }
    if (process.platform === "win32") {
        const roaming = process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
        const local = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
        let packages: string[] = [];
        try {
            packages = readdirSync(join(local, "Packages"));
        } catch {
            // no packaged apps
        }
        return windowsDesktopPaths(roaming, local, packages).filter((path) => {
            // The package folder counts whether or not it has a config yet; %APPDATA%\Claude only if it exists.
            const packaged = path.includes(`${sep}Packages${sep}`);
            return packaged ? existsSync(path.slice(0, path.indexOf(`${sep}LocalCache${sep}`))) : existsSync(dirname(path));
        });
    }
    const path = join(homedir(), ".config", "Claude", "claude_desktop_config.json");
    return existsSync(dirname(path)) ? [path] : [];
}

/** The file Claude Desktop reads first, for messages: the package folder's on the packaged build. */
export function findDesktopConfig(): string | null {
    return desktopConfigPaths()[0] ?? null;
}

export type MergeResult =
    | { status: "added" | "updated" | "unchanged"; path: string; backup: string | null; replaced: string[] }
    | { status: "not-installed" }
    | { status: "invalid"; path: string; reason: string };
export type DesktopResult = MergeResult;

/** Entries that are an older koble-mcp: by name, or by what they run. */
function isOurs(name: string, entry: unknown): boolean {
    if (name === SERVER_NAME || name === "koble") return true;
    const e = entry as { command?: unknown; args?: unknown } | null;
    const words = [e?.command, ...(Array.isArray(e?.args) ? e.args : [])].map(String).join(" ");
    return /koble-mcp[\\/](index|cli)\.js|[\\/]koble(\.exe)?$/.test(words);
}

/**
 * Puts koble-mcp into a JSON config's server list (`mcpServers` for most apps, `servers` for VS
 * Code). The file is parsed first and left untouched if it does not parse; otherwise backed up,
 * older koble entries replaced, everything else kept, and written whole.
 */
export function mergeServerEntry(path: string, key: string, entry: Record<string, unknown>, app: string): MergeResult {
    let config: Record<string, unknown> = {};
    if (existsSync(path)) {
        const text = readFileSync(path, "utf8");
        try {
            const parsed = text.trim() ? (JSON.parse(text.replace(/^﻿/, "")) as unknown) : {};
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("it is not a JSON object");
            config = parsed as Record<string, unknown>;
        } catch (error) {
            return { status: "invalid", path, reason: `${app}'s config is not plain JSON (${error instanceof Error ? error.message : String(error)}). Nothing was changed. Fix the file, or move it aside, and run koble connect again.` };
        }
    }
    const servers = (config[key] && typeof config[key] === "object" ? config[key] : {}) as Record<string, unknown>;
    const replaced = Object.keys(servers).filter((name) => name !== SERVER_NAME && isOurs(name, servers[name]));
    const current = servers[SERVER_NAME];
    if (replaced.length === 0 && JSON.stringify(current) === JSON.stringify(entry)) return { status: "unchanged", path, backup: null, replaced };

    for (const name of replaced) delete servers[name];
    servers[SERVER_NAME] = entry;
    config[key] = servers;

    let backup: string | null = null;
    if (existsSync(path)) {
        backup = `${path}.koble-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        copyFileSync(path, backup);
    }
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`);
    renameSync(temp, path);
    return { status: current === undefined && replaced.length === 0 ? "added" : "updated", path, backup, replaced };
}

export type RemoveResult = { status: "removed"; path: string; backup: string } | { status: "absent" } | { status: "invalid"; path: string; reason: string };

/** Takes koble-mcp (and any older koble entry) out of a JSON config; backs the file up first. */
export function removeServerEntry(path: string, key: string, app: string): RemoveResult {
    if (!existsSync(path)) return { status: "absent" };
    let config: Record<string, unknown>;
    try {
        const text = readFileSync(path, "utf8").replace(/^﻿/, "");
        const parsed = text.trim() ? (JSON.parse(text) as unknown) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("it is not a JSON object");
        config = parsed as Record<string, unknown>;
    } catch (error) {
        return { status: "invalid", path, reason: `${app}'s config is not plain JSON (${error instanceof Error ? error.message : String(error)}); it was left alone. Remove the koble-mcp entry by hand.` };
    }
    const servers = config[key];
    if (!servers || typeof servers !== "object") return { status: "absent" };
    const ours = Object.keys(servers).filter((name) => isOurs(name, (servers as Record<string, unknown>)[name]));
    if (ours.length === 0) return { status: "absent" };
    for (const name of ours) delete (servers as Record<string, unknown>)[name];
    const backup = `${path}.koble-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(path, backup);
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`);
    renameSync(temp, path);
    return { status: "removed", path, backup };
}

/** What a JSON config has as koble-mcp: the entry, or why not. */
export function readServerEntry(path: string, key: string): Record<string, unknown> | "missing" | "invalid" {
    if (!existsSync(path)) return "missing";
    try {
        const entry = ((JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as Record<string, Record<string, unknown> | undefined>)[key] ?? {})[SERVER_NAME];
        return (entry as Record<string, unknown> | undefined) ?? "missing";
    } catch {
        return "invalid";
    }
}

export function connectDesktop(launch: Launch, path = findDesktopConfig()): DesktopResult {
    if (!path) return { status: "not-installed" };
    return mergeServerEntry(path, "mcpServers", { command: launch.command, args: launch.args }, "Claude Desktop");
}

/**
 * Whether Claude Desktop is running. It keeps its settings in the same config file and writes the
 * file back from memory, so an edit made while it runs can be silently undone.
 */
export function desktopRunning(): boolean {
    try {
        if (process.platform === "darwin") return /\/Claude\.app\/Contents\/MacOS\/Claude$/m.test(spawnSync("ps", ["-axo", "comm"], { encoding: "utf8" }).stdout ?? "");
        if (process.platform === "win32") {
            // claude.exe is also Claude Code's name, so only count the Desktop app by where it lives.
            const script = "Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -match 'WindowsApps|AnthropicClaude' } | Measure-Object | Select-Object -ExpandProperty Count";
            const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
            return Number(r.stdout.trim()) > 0;
        }
    } catch {
        // cannot tell
    }
    return false;
}

/** Claude Desktop's own log of starting koble-mcp: it exists only once Desktop has tried. */
export function desktopLog(): { path: string; lines: string[] } | null {
    const dirs = process.platform === "darwin" ? [join(homedir(), "Library", "Logs", "Claude")] : desktopConfigPaths().map((config) => join(dirname(config), "logs"));
    for (const dir of dirs) {
        const path = join(dir, `mcp-server-${SERVER_NAME}.log`);
        if (existsSync(path)) return { path, lines: readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).slice(-200) };
    }
    return null;
}

/** What the log says about the most recent start: ready, or the last error. */
export function readDesktopLog(lines: string[]): { ok: boolean; detail: string } {
    let last: { ok: boolean; detail: string } | null = null;
    for (const line of lines) {
        if (/koble-mcp .*ready/.test(line)) last = { ok: true, detail: "Claude Desktop started it" };
        else if (/\b(error|failed|exited|disconnected|ENOENT|not recognized)\b/i.test(line) && !/Message from (client|server)/.test(line)) last = { ok: false, detail: line.replace(/^\S+\s+\[[^\]]*\]\s*(\[\w+\]\s*)?/, "").slice(0, 200) };
    }
    return last ?? { ok: true, detail: "Claude Desktop has a log for it, with no errors" };
}

/** What Claude Desktop is configured to run for koble-mcp, for the doctor. */
export function desktopEntry(path = findDesktopConfig()): Launch | "missing" | "invalid" | "not-installed" {
    if (!path) return "not-installed";
    if (!existsSync(path)) return "missing";
    try {
        const entry = ((JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, Launch> }).mcpServers ?? {})[SERVER_NAME];
        return entry ?? "missing";
    } catch {
        return "invalid";
    }
}

/** The first file with this exact name under a folder, looking at most `depth` levels down. */
function findFile(dir: string, name: string, depth: number): string | null {
    let entries: string[] = [];
    try {
        entries = readdirSync(dir);
    } catch {
        return null;
    }
    if (entries.includes(name) && existsSync(join(dir, name)) && !statSync(join(dir, name)).isDirectory()) return join(dir, name);
    if (depth <= 0) return null;
    for (const entry of entries) {
        const full = join(dir, entry);
        try {
            if (statSync(full).isDirectory()) {
                const found = findFile(full, name, depth - 1);
                if (found) return found;
            }
        } catch {
            // unreadable
        }
    }
    return null;
}

/** Newest first: "2.1.280" before "2.1.275" before "2.1.9". */
const byVersionDesc = (a: string, b: string): number => b.localeCompare(a, undefined, { numeric: true });

/**
 * The copy of Claude Code that Claude Desktop bundles for its Code tab, for people who have Desktop
 * but never installed the `claude` command. It reads and writes the same user settings as the
 * command, so registering koble through it connects the Code tab.
 */
export function bundledClaudeCode(): string | null {
    const roots = process.platform === "darwin" ? [join(homedir(), "Library", "Application Support", "Claude")] : desktopConfigPaths().map(dirname);
    for (const root of roots) {
        const base = join(root, "claude-code");
        let versions: string[] = [];
        try {
            versions = readdirSync(base).sort(byVersionDesc);
        } catch {
            continue;
        }
        for (const version of versions) {
            const candidates =
                process.platform === "darwin"
                    ? [join(base, version, "claude.app", "Contents", "MacOS", "claude"), join(base, version, "claude")]
                    : process.platform === "win32"
                      ? [join(base, version, "claude.exe"), join(base, version, "claude", "claude.exe"), join(base, version, "bin", "claude.exe")]
                      : [join(base, version, "claude")];
            const found = candidates.find((path) => existsSync(path)) ?? findFile(join(base, version), process.platform === "win32" ? "claude.exe" : "claude", 4);
            if (found) return found;
        }
    }
    return null;
}

type ClaudeRunner = { command: string; label: string } | null;
let runner: ClaudeRunner | undefined;

/** How Claude Code is reached here: the `claude` command, or Desktop's bundled copy, or not at all. */
export function claudeCodeRunner(): ClaudeRunner {
    if (runner !== undefined) return runner;
    const onPath = spawnSync("claude", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
    if (!onPath.error && onPath.status === 0) return (runner = { command: "claude", label: "Claude Code" });
    if (process.platform === "win32") {
        const viaShell = spawnSync("claude --version", { encoding: "utf8", windowsHide: true, timeout: 60_000, shell: true });
        if (!viaShell.error && viaShell.status === 0) return (runner = { command: "claude", label: "Claude Code" });
    }
    const bundled = bundledClaudeCode();
    return (runner = bundled ? { command: bundled, label: "Claude Code (Claude Desktop's Code tab)" } : null);
}

/**
 * Runs Claude Code's own command. A full path or `claude.exe` runs directly; `claude.cmd` (an npm
 * install on Windows) needs a shell, and then every argument is quoted for cmd.
 */
function claude(args: string[]): { status: number | null; out: string } {
    const found = claudeCodeRunner();
    if (!found) return { status: null, out: "Claude Code is not installed." };
    const direct = spawnSync(found.command, args, { encoding: "utf8", windowsHide: true, timeout: 120_000 });
    if (!(direct.error && process.platform === "win32" && found.command === "claude")) return { status: direct.error ? null : direct.status, out: `${direct.stdout ?? ""}${direct.stderr ?? ""}` };
    const quoted = ["claude", ...args].map((a) => (/^[\w@.:\\/-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)).join(" ");
    const viaShell = spawnSync(quoted, { encoding: "utf8", windowsHide: true, timeout: 120_000, shell: true });
    return { status: viaShell.error ? null : viaShell.status, out: `${viaShell.stdout ?? ""}${viaShell.stderr ?? ""}` };
}

export function claudeCodeInstalled(): boolean {
    return claudeCodeRunner() !== null;
}

export function claudeCodeHasPlugin(): boolean {
    const r = claude(["plugin", "list"]);
    return r.status === 0 && r.out.includes(SERVER_NAME);
}

/** Takes koble out of Claude Code: the user-level server, and the plugin and its marketplace if they were added. */
export function disconnectClaudeCode(): string[] {
    if (!claudeCodeRunner()) return [];
    const lines: string[] = [];
    if (claude(["mcp", "remove", SERVER_NAME, "--scope", "user"]).status === 0) lines.push("removed the koble-mcp server.");
    if (claudeCodeHasPlugin()) {
        const r = claude(["plugin", "uninstall", PLUGIN]);
        lines.push(r.status === 0 ? "removed the koble-mcp plugin." : `removing the koble-mcp plugin failed: ${r.out.trim().split("\n")[0]}`);
    }
    const markets = claude(["plugin", "marketplace", "list"]);
    if (markets.status === 0 && /\bkoblesystems\b/.test(markets.out)) {
        const r = claude(["plugin", "marketplace", "remove", "koblesystems"]);
        lines.push(r.status === 0 ? "removed the koblesystems plugin marketplace." : `removing the koblesystems marketplace failed: ${r.out.trim().split("\n")[0]}`);
    }
    return lines;
}

/** Whether Claude Code has koble registered at all, without starting it. */
export function claudeCodeHasServer(): boolean {
    const r = claude(["mcp", "list"]);
    return r.status === 0 && new RegExp(`^${SERVER_NAME}:`, "m").test(r.out);
}

export interface ClaudeCodeServer {
    command: string;
    args: string[];
    /** Claude Code's own health check: it starts the server and reports whether it connected. */
    connected: boolean;
    issue: string | null;
}

/** What Claude Code has registered as koble-mcp, from `claude mcp get`, or null if nothing. */
export function claudeCodeServer(): ClaudeCodeServer | null {
    const r = claude(["mcp", "get", SERVER_NAME]);
    if (r.status !== 0 || !/Command:/.test(r.out)) return null;
    const field = (name: string): string => new RegExp(`^\\s*${name}:[ \\t]*(.*)$`, "m").exec(r.out)?.[1]?.trim() ?? "";
    const status = field("Status");
    return { command: field("Command"), args: field("Args").split(/\s+/).filter(Boolean), connected: /connected/i.test(status) && !/fail/i.test(status), issue: field("Issue") || (/fail/i.test(status) ? status : null) };
}

/**
 * Registers this koble with Claude Code by its full path, for every project (user scope), so it
 * starts whatever PATH the terminal or editor had. The skills are copied separately (apps.ts);
 * a plugin someone installed themselves is only kept up to date.
 */
export function connectClaudeCode(launch: Launch): { ok: boolean; lines: string[] } {
    if (!claudeCodeInstalled()) return { ok: false, lines: ["not installed here — skipped."] };
    const lines: string[] = [];
    claude(["mcp", "remove", SERVER_NAME, "--scope", "user"]);
    const add = claude(["mcp", "add", "--scope", "user", SERVER_NAME, "--", launch.command, ...launch.args]);
    if (add.status !== 0) return { ok: false, lines: [`registering the server failed: ${add.out.trim().split("\n")[0]}`] };
    lines.push("server registered for all projects.");

    if (claudeCodeHasPlugin()) {
        // People who installed the plugin themselves keep it current; everyone else gets the skills copied (apps.ts).
        claude(["plugin", "marketplace", "update", "koblesystems"]);
        const up = claude(["plugin", "update", PLUGIN]);
        if (up.status !== 0) lines.push(`updating the koble-mcp plugin failed: ${up.out.trim().split("\n")[0]}`);
    }

    const check = claudeCodeServer();
    if (check?.connected) lines.push("Claude Code started koble-mcp and it connected.");
    else if (check) lines.push(`Claude Code could not start it: ${check.issue ?? "no detail"}`);
    return { ok: check?.connected === true, lines };
}
