import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// doctor and uninstall look at every AI app on the computer, so this file gives them a computer of
// their own: a scratch home, no programs on PATH, settings and passwords in a scratch folder.
const home = mkdtempSync(join(tmpdir(), "koble-home-"));
Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    PATH: join(home, "bin"),
    KOBLE_CREDENTIAL_STORE: "file",
});
const { doctor, uninstall } = await import("../src/cli/commands.js");
const { APPS } = await import("../src/cli/apps.js");
const { desktopConfigPaths, mergeServerEntry, removeServerEntry } = await import("../src/cli/hosts.js");
const { loginAccount, savePassword, writeConfig } = await import("../src/cli/store.js");

const SERIAL = "000000000000000";
const listings: string[] = [];
globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("ebmscompanylist")) {
        listings.push(u);
        return new Response(JSON.stringify([{ Id: "SBX", Name: "Sample" }, { Id: "ROV", Name: "Rova" }]), { status: 200 });
    }
    if (u.endsWith("/Token")) return new Response(JSON.stringify({ AccessToken: "t" }), { status: 200 });
    return new Response(JSON.stringify({ value: [] }), { status: 200 });
}) as typeof fetch;

const quiet = async <T>(work: () => Promise<T>): Promise<T> => {
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
        return await work();
    } finally {
        process.stdout.write = write;
    }
};

test("the scratch computer really is one", () => {
    assert.equal(homedir(), home);
    assert.deepEqual(APPS.filter((app) => app.installed()).map((app) => app.id), []);
});

test("doctor lists the companies once, not once per company it signs in to", async () => {
    process.env["KOBLE_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "koble-doctor-"));
    writeConfig({ serial: SERIAL, companies: "SBX,ROV", sandbox: "SBX", logins: { SBX: { username: "u" }, ROV: { username: "u" } } });
    savePassword(loginAccount(SERIAL, "SBX", "u"), "p");
    savePassword(loginAccount(SERIAL, "ROV", "u"), "p");
    listings.length = 0;
    assert.equal(await quiet(() => doctor({ brief: true })), 0);
    assert.equal(listings.length, 1);
});

test("Claude Desktop: a config saved with a BOM reads as connected, in doctor as in connect", () => {
    const dir = process.platform === "darwin" ? join(home, "Library", "Application Support", "Claude") : process.platform === "win32" ? join(home, "AppData", "Roaming", "Claude") : join(home, ".config", "Claude");
    mkdirSync(dir, { recursive: true });
    const desktop = APPS.find((app) => app.id === "claude-desktop")!;
    const launch = { command: "/opt/koble", args: ["mcp"] };
    const [path] = desktopConfigPaths();
    assert.ok(path);
    writeFileSync(path, `﻿${JSON.stringify({ mcpServers: { "koble-mcp": launch } })}`);
    assert.deepEqual(desktop.connect(launch), ["already connected."]);
    assert.equal(desktop.check(launch).status, "ok");
    assert.equal(desktop.footprint().length, 1);
});

test("config rewrites keep the file's mode, and only the newest three backups", () => {
    const dir = mkdtempSync(join(tmpdir(), "koble-mode-"));
    const path = join(dir, "mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: "o", env: { API_KEY: "secret" } } } }), { mode: 0o600 });
    for (let i = 0; i < 5; i += 1) {
        mergeServerEntry(path, "mcpServers", { command: `/opt/koble-${i}`, args: ["mcp"] }, "Cursor");
        assert.equal(removeServerEntry(path, "mcpServers", "Cursor").status, "removed");
    }
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readdirSync(dir).filter((name) => name.includes(".koble-backup-")).length, 3);
    assert.ok(readFileSync(path, "utf8").includes("secret"), "the other server is kept");
});

test("uninstall removes koble's own files but never a folder that holds anything else", async () => {
    const dir = mkdtempSync(join(tmpdir(), "koble-shared-"));
    process.env["KOBLE_CONFIG_DIR"] = dir;
    writeConfig({ serial: SERIAL, companies: "SBX", logins: { SBX: { username: "u" } } });
    savePassword(loginAccount(SERIAL, "SBX", "u"), "p");
    writeFileSync(join(dir, "notes.txt"), "not koble's");
    assert.equal(await quiet(() => uninstall({ yes: true })), 0);
    assert.deepEqual(readdirSync(dir), ["notes.txt"]);

    const own = mkdtempSync(join(tmpdir(), "koble-own-"));
    process.env["KOBLE_CONFIG_DIR"] = own;
    writeConfig({ serial: SERIAL, companies: "SBX" });
    assert.equal(await quiet(() => uninstall({ yes: true })), 0);
    assert.equal(existsSync(own), false, "koble's own folder goes once it is empty");
});
