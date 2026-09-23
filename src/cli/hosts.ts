/**
 * Connecting the server to the Claude apps on this computer.
 *
 * Claude Desktop reads one strict JSON file: a stray comment switches off every local server. So
 * the file is parsed before anything is changed, left alone if it does not parse, backed up, and
 * written whole. Claude Code is connected through its own `claude` command.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SERVER_NAME = "koble-mcp";
export const MARKETPLACE = "koblesystems/koble-mcp";
export const PLUGIN = "koble-mcp@koblesystems";

export interface Launch {
    command: string;
    args: string[];
}

/** Candidate locations of Claude Desktop's config, most likely first. */
export function desktopConfigPaths(): string[] {
    if (process.platform === "darwin") return [join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")];
    if (process.platform === "win32") {
        const roaming = process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
        const local = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
        const paths = [join(roaming, "Claude", "claude_desktop_config.json")];
        // The Microsoft Store build keeps its AppData inside its package folder.
        try {
            const packages = join(local, "Packages");
            for (const name of spawnSync("cmd", ["/c", "dir", "/b", packages], { encoding: "utf8", windowsHide: true }).stdout.split(/\r?\n/)) {
                if (/^Claude_/i.test(name.trim())) paths.push(join(packages, name.trim(), "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
            }
        } catch {
            // no Store build
        }
        return paths;
    }
    return [join(homedir(), ".config", "Claude", "claude_desktop_config.json")];
}

/** The config file of the Claude Desktop that is installed, if any: the first whose folder exists. */
export function findDesktopConfig(): string | null {
    return desktopConfigPaths().find((path) => existsSync(path) || existsSync(dirname(path))) ?? null;
}

export type DesktopResult =
    | { status: "added" | "updated" | "unchanged"; path: string; backup: string | null; replaced: string[] }
    | { status: "not-installed" }
    | { status: "invalid"; path: string; reason: string };

/** Entries that are an older koble-mcp: by name, or by what they run. */
function isOurs(name: string, entry: unknown): boolean {
    if (name === SERVER_NAME || name === "koble") return true;
    const e = entry as { command?: unknown; args?: unknown } | null;
    const words = [e?.command, ...(Array.isArray(e?.args) ? e.args : [])].map(String).join(" ");
    return /koble-mcp[\\/](index|cli)\.js|[\\/]koble(\.exe)?$/.test(words);
}

export function connectDesktop(launch: Launch, path = findDesktopConfig()): DesktopResult {
    if (!path) return { status: "not-installed" };
    let config: Record<string, unknown> = {};
    if (existsSync(path)) {
        const text = readFileSync(path, "utf8");
        try {
            const parsed = text.trim() ? (JSON.parse(text) as unknown) : {};
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("it is not a JSON object");
            config = parsed as Record<string, unknown>;
        } catch (error) {
            return { status: "invalid", path, reason: `Claude Desktop's config is not valid JSON (${error instanceof Error ? error.message : String(error)}). Nothing was changed. Fix the file, or move it aside, and run koble connect again.` };
        }
    }
    const servers = (config["mcpServers"] && typeof config["mcpServers"] === "object" ? config["mcpServers"] : {}) as Record<string, unknown>;
    const wanted = { command: launch.command, args: launch.args };
    const replaced = Object.keys(servers).filter((name) => name !== SERVER_NAME && isOurs(name, servers[name]));
    const current = servers[SERVER_NAME];
    if (replaced.length === 0 && JSON.stringify(current) === JSON.stringify(wanted)) return { status: "unchanged", path, backup: null, replaced };

    for (const name of replaced) delete servers[name];
    servers[SERVER_NAME] = wanted;
    config["mcpServers"] = servers;

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

const claude = (args: string[]) => spawnSync("claude", args, { encoding: "utf8", windowsHide: true, timeout: 120_000, shell: process.platform === "win32" });

export function claudeCodeInstalled(): boolean {
    try {
        return claude(["--version"]).status === 0;
    } catch {
        return false;
    }
}

export function claudeCodeHasPlugin(): boolean {
    const r = claude(["plugin", "list"]);
    return r.status === 0 && r.stdout.includes(SERVER_NAME);
}

/** Adds the plugin marketplace and installs the plugin: the server, the skills and the setup skill in one. */
export function connectClaudeCode(): { ok: boolean; detail: string } {
    if (!claudeCodeInstalled()) return { ok: false, detail: "Claude Code is not installed." };
    if (claudeCodeHasPlugin()) return { ok: true, detail: "the koble-mcp plugin is already installed." };
    const add = claude(["plugin", "marketplace", "add", MARKETPLACE]);
    if (add.status !== 0 && !/already/i.test(`${add.stdout}${add.stderr}`)) return { ok: false, detail: `adding the marketplace failed: ${(add.stderr || add.stdout).trim().split("\n")[0]}` };
    const install = claude(["plugin", "install", PLUGIN]);
    if (install.status !== 0) return { ok: false, detail: `installing the plugin failed: ${(install.stderr || install.stdout).trim().split("\n")[0]}` };
    return { ok: true, detail: "installed the koble-mcp plugin (server and skills)." };
}
