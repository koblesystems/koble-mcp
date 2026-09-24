/**
 * The AI apps koble can connect to, each able to say whether it is installed, connect koble, and
 * report whether it is connected. Claude Desktop and Claude Code live in hosts.ts; the rest are a
 * config file each, in the format that app documents.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { skillFiles } from "../guide.js";
import { VERSION } from "../version.js";
import { claudeCodeHasPlugin, claudeCodeHasServer, claudeCodeRunner, claudeCodeServer, connectClaudeCode, connectDesktop, desktopConfigPaths, desktopEntry, disconnectClaudeCode, mergeServerEntry, readServerEntry, removeServerEntry, SERVER_NAME, type Launch, type MergeResult, type RemoveResult } from "./hosts.js";

export interface AppStatus {
    status: "ok" | "warn" | "fail" | "info";
    detail: string;
    fix?: string;
}

export interface App {
    id: string;
    name: string;
    installed(): boolean;
    connect(launch: Launch): string[];
    check(launch: Launch): AppStatus;
    /** What koble put in this app, in words, for the uninstall plan; empty when there is nothing. */
    footprint(): string[];
    /** Takes all of it out again; says what happened. */
    disconnect(): string[];
}

const sameLaunch = (entry: Record<string, unknown>, launch: Launch): boolean => entry["command"] === launch.command && JSON.stringify(entry["args"]) === JSON.stringify(launch.args);

function describeRemove(result: RemoveResult, what: string): string[] {
    if (result.status === "removed") return [`removed ${what}. Backup: ${result.backup}`];
    if (result.status === "invalid") return [result.reason];
    return [];
}

function describeMerge(result: MergeResult): string {
    if (result.status === "invalid") return result.reason;
    if (result.status === "not-installed") return "not installed — skipped.";
    const verb = result.status === "unchanged" ? "already connected" : result.status === "added" ? "connected" : "updated";
    return `${verb}.${result.replaced.length ? ` Replaced the older entry ${result.replaced.join(", ")}.` : ""}${result.backup ? ` Backup: ${result.backup}` : ""}`;
}

/** An app whose MCP servers live in one JSON file, under `key`. */
function jsonApp(id: string, name: string, path: () => string, key: string, entry: (launch: Launch) => Record<string, unknown>, installed: () => boolean): App {
    return {
        id,
        name,
        installed,
        connect: (launch) => [describeMerge(mergeServerEntry(path(), key, entry(launch), name))],
        footprint: () => (typeof readServerEntry(path(), key) === "object" ? [`the koble-mcp entry in ${path()}`] : []),
        disconnect: () => describeRemove(removeServerEntry(path(), key, name), `the koble-mcp entry from ${path()}`),
        check: (launch) => {
            const found = readServerEntry(path(), key);
            if (found === "invalid") return { status: "fail", detail: `config is not plain JSON (${path()})`, fix: "fix or move the file, then koble connect" };
            if (found === "missing") return { status: "fail", detail: "not connected", fix: "koble connect" };
            const want = entry(launch);
            return JSON.stringify(found) === JSON.stringify(want) ? { status: "ok", detail: "connected to this koble" } : { status: "warn", detail: `runs ${String(found["command"])}`, fix: "koble connect, to point it at this koble" };
        },
    };
}

const home = homedir;
const userDir = (...parts: string[]): string =>
    process.platform === "win32" ? join(process.env["APPDATA"] ?? join(home(), "AppData", "Roaming"), ...parts) : process.platform === "darwin" ? join(home(), "Library", "Application Support", ...parts) : join(process.env["XDG_CONFIG_HOME"] ?? join(home(), ".config"), ...parts);
const onPath = (command: string): boolean => {
    const r = spawnSync(command, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 30_000, shell: process.platform === "win32" });
    return !r.error && r.status === 0;
};

// ------------------------------------------------------------------ Codex (TOML)

const codexHome = (): string => process.env["CODEX_HOME"] ?? join(home(), ".codex");

/** A TOML string for a path: a literal string unless the value itself has a single quote. */
const tomlString = (value: string): string => (value.includes("'") ? JSON.stringify(value) : `'${value}'`);

/**
 * Replaces the [mcp_servers.koble-mcp] table (and any sub-table of it) in Codex's config.toml and
 * leaves every other line exactly as it was.
 */
/** Codex's config.toml without koble's table and its sub-tables; every other line kept as it was. */
export function stripCodexServer(text: string): string[] {
    const header = /^\s*\[\s*mcp_servers\s*\.\s*(?:koble-mcp|"koble-mcp")\s*(?:\.[^\]]*)?\]\s*$/;
    const kept: string[] = [];
    let skipping = false;
    for (const line of text.split(/\r?\n/)) {
        if (/^\s*\[/.test(line)) skipping = header.test(line);
        if (!skipping) kept.push(line);
    }
    while (kept.length > 0 && kept[kept.length - 1]?.trim() === "") kept.pop();
    return kept;
}

export function upsertCodexServer(text: string, launch: Launch): string {
    const kept = stripCodexServer(text);
    const block = [`[mcp_servers.${SERVER_NAME}]`, `command = ${tomlString(launch.command)}`, `args = [${launch.args.map(tomlString).join(", ")}]`];
    return `${[...kept, ...(kept.length ? [""] : []), ...block].join("\n")}\n`;
}

/** The `command = …` line of Codex's koble-mcp table, or null when there is no such table. */
export function codexCommandLine(text: string): string | null {
    let inside = false;
    for (const line of text.split(/\r?\n/)) {
        if (/^\s*\[/.test(line)) inside = /^\s*\[\s*mcp_servers\s*\.\s*(?:koble-mcp|"koble-mcp")\s*\]\s*$/.test(line);
        else if (inside && /^\s*command\s*=/.test(line)) return line.trim();
    }
    return inside || text.includes(`[mcp_servers.${SERVER_NAME}]`) ? "" : null;
}

const codex: App = {
    id: "codex",
    name: "Codex (OpenAI)",
    installed: () => existsSync(codexHome()) || onPath("codex"),
    connect: (launch) => {
        const path = join(codexHome(), "config.toml");
        const before = existsSync(path) ? readFileSync(path, "utf8") : "";
        const after = upsertCodexServer(before, launch);
        if (after === before) return ["already connected."];
        mkdirSync(dirname(path), { recursive: true });
        let backup = "";
        if (existsSync(path)) {
            backup = `${path}.koble-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
            copyFileSync(path, backup);
        }
        writeFileSync(`${path}.tmp-${process.pid}`, after);
        renameSync(`${path}.tmp-${process.pid}`, path);
        return [`connected.${backup ? ` Backup: ${backup}` : ""}`];
    },
    footprint: () => {
        const path = join(codexHome(), "config.toml");
        return existsSync(path) && codexCommandLine(readFileSync(path, "utf8")) !== null ? [`the koble-mcp table in ${path}`] : [];
    },
    disconnect: () => {
        const path = join(codexHome(), "config.toml");
        if (!existsSync(path)) return [];
        const before = readFileSync(path, "utf8");
        if (codexCommandLine(before) === null) return [];
        const backup = `${path}.koble-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        copyFileSync(path, backup);
        const kept = stripCodexServer(before);
        writeFileSync(`${path}.tmp-${process.pid}`, kept.length ? `${kept.join("\n")}\n` : "");
        renameSync(`${path}.tmp-${process.pid}`, path);
        return [`removed the koble-mcp table from ${path}. Backup: ${backup}`];
    },
    check: (launch) => {
        const path = join(codexHome(), "config.toml");
        const text = existsSync(path) ? readFileSync(path, "utf8") : "";
        const line = codexCommandLine(text);
        if (line === null) return { status: "fail", detail: "not connected", fix: "koble connect" };
        return line === `command = ${tomlString(launch.command)}` ? { status: "ok", detail: "connected to this koble" } : { status: "warn", detail: "runs a different koble", fix: "koble connect" };
    },
};

// ------------------------------------------------------------------ Claude Code skills

const MARKER = ".koble-skill";

/** Claude Code's own skills folder, where each skill is also a `/` command: `/ebms-mrp`. */
export const claudeSkillsDir = (): string => join(process.env["CLAUDE_CONFIG_DIR"] ?? join(home(), ".claude"), "skills");

/**
 * Copies the skills built into this koble into Claude Code's skills folder. Only folders koble put
 * there (they carry a marker file) are replaced or removed; a skill of the same name the person
 * made themselves is left alone.
 */
export function installClaudeSkills(dir = claudeSkillsDir(), files = skillFiles()): string[] {
    const bySkill = new Map<string, Array<[string, string]>>();
    for (const [path, text] of files) {
        const [skill] = path.split("/");
        if (!skill || !(skill.startsWith("ebms-") || skill === "koble-setup")) continue;
        bySkill.set(skill, [...(bySkill.get(skill) ?? []), [path.slice(skill.length + 1), text]]);
    }
    const notes: string[] = [];
    let copied = 0;
    for (const [skill, entries] of bySkill) {
        const target = join(dir, skill);
        if (existsSync(target) && !existsSync(join(target, MARKER))) {
            notes.push(`left your own ${skill} skill alone.`);
            continue;
        }
        rmSync(target, { recursive: true, force: true });
        for (const [relative, text] of entries) {
            const file = join(target, ...relative.split("/"));
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, text);
        }
        writeFileSync(join(target, MARKER), `Installed by koble ${VERSION}. koble update replaces this folder; your own skills are never touched.\n`);
        copied += 1;
    }
    // Skills a newer koble no longer ships.
    try {
        for (const name of readdirSync(dir)) if (!bySkill.has(name) && existsSync(join(dir, name, MARKER))) rmSync(join(dir, name), { recursive: true, force: true });
    } catch {
        // no skills folder yet
    }
    return [`${copied} skills installed as / commands (e.g. /ebms-mrp).`, ...notes];
}

/** Removes only the skill folders koble put there (they carry its marker). */
export function removeClaudeSkills(dir = claudeSkillsDir()): string[] {
    let names: string[] = [];
    try {
        names = readdirSync(dir).filter((name) => existsSync(join(dir, name, MARKER)));
    } catch {
        return [];
    }
    for (const name of names) rmSync(join(dir, name), { recursive: true, force: true });
    return names;
}

const markedSkills = (dir = claudeSkillsDir()): string[] => {
    try {
        return readdirSync(dir).filter((name) => existsSync(join(dir, name, MARKER)));
    } catch {
        return [];
    }
};

export function claudeSkillsInstalled(dir = claudeSkillsDir()): string | null {
    const marker = join(dir, "ebms-api", MARKER);
    return existsSync(marker) ? readFileSync(marker, "utf8").trim() : null;
}

const claudeCode: App = {
    id: "claude-code",
    name: "Claude Code",
    installed: () => claudeCodeRunner() !== null,
    connect: (launch) => {
        const result = connectClaudeCode(launch);
        const lines = [...result.lines];
        if (claudeCodeHasPlugin()) lines.push("the koble-mcp plugin supplies the skills, so they were not copied again.");
        else lines.push(...installClaudeSkills());
        return lines;
    },
    footprint: () => {
        const parts: string[] = [];
        if (claudeCodeHasServer()) parts.push("the koble-mcp server");
        const skills = markedSkills();
        if (skills.length) parts.push(`${skills.length} skills koble installed (${skills.join(", ")})`);
        if (claudeCodeHasPlugin()) parts.push("the koble-mcp plugin and its marketplace");
        return parts;
    },
    disconnect: () => {
        const lines = disconnectClaudeCode();
        const removed = removeClaudeSkills();
        if (removed.length) lines.push(`removed ${removed.length} skills koble installed.`);
        return lines;
    },
    check: (launch) => {
        const server = claudeCodeServer();
        if (!server) return { status: "fail", detail: "koble-mcp is not registered", fix: "koble connect" };
        if ([server.command, ...server.args].join(" ") !== [launch.command, ...launch.args].join(" ")) return { status: "warn", detail: `runs ${[server.command, ...server.args].join(" ")}`, fix: "koble connect, to point it at this koble" };
        if (!server.connected) return { status: "fail", detail: `registered, but it does not start: ${server.issue ?? "no detail"}`, fix: "koble connect; if it persists, send this line" };
        const skills = claudeCodeHasPlugin() ? "skills from the plugin" : claudeSkillsInstalled() ? "skills installed" : "no skills (run koble connect)";
        return { status: "ok", detail: `connected to this koble; ${skills}${claudeCodeRunner()?.command !== "claude" ? " (via Claude Desktop's Code tab)" : ""}` };
    },
};

const claudeDesktop: App = {
    id: "claude-desktop",
    name: "Claude Desktop",
    installed: () => desktopConfigPaths().length > 0,
    connect: (launch) => {
        const paths = desktopConfigPaths();
        return paths.map((path) => `${paths.length > 1 ? `${path}: ` : ""}${describeMerge(connectDesktop(launch, path))}`);
    },
    footprint: () => desktopConfigPaths().filter((path) => typeof desktopEntry(path) === "object").map((path) => `the koble-mcp entry in ${path}`),
    disconnect: () => desktopConfigPaths().flatMap((path) => describeRemove(removeServerEntry(path, "mcpServers", "Claude Desktop"), `the koble-mcp entry from ${path}`)),
    check: (launch) => {
        const missing = desktopConfigPaths().filter((path) => {
            const e = desktopEntry(path);
            return typeof e !== "object" || !sameLaunch(e as unknown as Record<string, unknown>, launch);
        });
        return missing.length ? { status: "fail", detail: `not connected in ${missing.join(", ")}`, fix: "koble connect" } : { status: "ok", detail: "connected to this koble" };
    },
};

const stdio = (launch: Launch): Record<string, unknown> => ({ command: launch.command, args: launch.args });

export const APPS: App[] = [
    claudeDesktop,
    claudeCode,
    codex,
    jsonApp("cursor", "Cursor", () => join(home(), ".cursor", "mcp.json"), "mcpServers", stdio, () => existsSync(join(home(), ".cursor"))),
    jsonApp("vscode", "VS Code (Copilot)", () => userDir("Code", "User", "mcp.json"), "servers", (launch) => ({ type: "stdio", ...stdio(launch) }), () => existsSync(userDir("Code", "User"))),
    jsonApp("gemini", "Gemini CLI", () => join(home(), ".gemini", "settings.json"), "mcpServers", stdio, () => existsSync(join(home(), ".gemini"))),
    jsonApp("windsurf", "Windsurf", () => join(home(), ".codeium", "windsurf", "mcp_config.json"), "mcpServers", stdio, () => existsSync(join(home(), ".codeium", "windsurf"))),
];

export const appById = (id: string): App | undefined => APPS.find((app) => app.id === id);
