import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexCommandLine, installClaudeSkills, upsertCodexServer } from "../src/cli/apps.js";
import { mergeServerEntry, readServerEntry } from "../src/cli/hosts.js";

const launch = { command: "C:\\Users\\A B\\koble.exe", args: ["mcp"] };
const scratch = (): string => mkdtempSync(join(tmpdir(), "koble-apps-"));

test("Codex: the koble table is added or replaced; every other line is kept", () => {
    const before = ['model = "gpt-5"', "", "[mcp_servers.other]", 'command = "x"', "", "[mcp_servers.koble-mcp]", "command = 'old'", 'args = ["mcp"]', "", "[mcp_servers.koble-mcp.env]", 'EBMS_PASSWORD = "secret"', "", "[profiles.work]", 'model = "o4"', ""].join("\n");
    const after = upsertCodexServer(before, launch);
    assert.ok(after.includes('model = "gpt-5"') && after.includes("[mcp_servers.other]") && after.includes("[profiles.work]"), "other settings kept");
    assert.ok(!after.includes("secret") && !after.includes("'old'"), "the old table and its env sub-table are gone");
    assert.equal(codexCommandLine(after), "command = 'C:\\Users\\A B\\koble.exe'", "a Windows path as a TOML literal string, backslashes as they are");
    assert.equal(upsertCodexServer(after, launch), after, "running it again changes nothing");
    assert.equal(codexCommandLine('model = "x"\n'), null);
    assert.match(upsertCodexServer("", launch), /^\[mcp_servers\.koble-mcp\]\ncommand = /);
});

test("VS Code keeps its servers under `servers`, with a type", () => {
    const path = join(scratch(), "mcp.json");
    writeFileSync(path, JSON.stringify({ servers: { github: { type: "http", url: "https://x" } }, inputs: [] }));
    const entry = { type: "stdio", command: launch.command, args: launch.args };
    assert.equal(mergeServerEntry(path, "servers", entry, "VS Code").status, "added");
    const saved = JSON.parse(readFileSync(path, "utf8")) as { servers: Record<string, unknown>; inputs: unknown[] };
    assert.deepEqual(Object.keys(saved.servers), ["github", "koble-mcp"]);
    assert.deepEqual(readServerEntry(path, "servers"), entry);
});

test("skills: copied with a marker; a person's own skill of the same name is never touched; stale ones removed", () => {
    const dir = scratch();
    mkdirSync(join(dir, "ebms-tasks"), { recursive: true });
    writeFileSync(join(dir, "ebms-tasks", "SKILL.md"), "my own version");
    mkdirSync(join(dir, "ebms-retired"), { recursive: true });
    writeFileSync(join(dir, "ebms-retired", ".koble-skill"), "installed by an older koble");
    const files = new Map([
        ["ebms-api/SKILL.md", "---\nname: ebms-api\n---\napi"],
        ["ebms-api/references/odata-quirks.md", "quirks"],
        ["ebms-tasks/SKILL.md", "---\nname: ebms-tasks\n---\ntasks"],
        ["koble-setup/SKILL.md", "---\nname: koble-setup\n---\nsetup"],
        ["notes/README.md", "not a skill we ship"],
    ]);
    const lines = installClaudeSkills(dir, files);
    assert.equal(readFileSync(join(dir, "ebms-api", "references", "odata-quirks.md"), "utf8"), "quirks");
    assert.ok(existsSync(join(dir, "ebms-api", ".koble-skill")));
    assert.equal(readFileSync(join(dir, "ebms-tasks", "SKILL.md"), "utf8"), "my own version");
    assert.ok(existsSync(join(dir, "koble-setup", "SKILL.md")));
    assert.ok(!existsSync(join(dir, "notes")) && !existsSync(join(dir, "ebms-retired")));
    assert.match(lines.join(" "), /2 skills installed.*left your own ebms-tasks skill alone/);
});

test("uninstall: the koble entry comes out of a JSON config, everything else stays, a backup is kept", async () => {
    const { removeServerEntry } = await import("../src/cli/hosts.js");
    const dir = scratch();
    const path = join(dir, "claude_desktop_config.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { "koble-mcp": { command: "k", args: ["mcp"] }, koble: { command: "/old/koble", args: ["mcp"] }, other: { command: "o" } }, preferences: { theme: "dark" } }));
    const r = removeServerEntry(path, "mcpServers", "Claude Desktop");
    assert.equal(r.status, "removed");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { mcpServers: { other: { command: "o" } }, preferences: { theme: "dark" } });
    assert.equal(removeServerEntry(path, "mcpServers", "Claude Desktop").status, "absent", "a second run finds nothing to do");
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ // not JSON");
    assert.equal(removeServerEntry(broken, "mcpServers", "Cursor").status, "invalid");
    assert.equal(readFileSync(broken, "utf8"), "{ // not JSON", "left exactly as it was");
});

test("uninstall: Codex keeps every other setting; only koble's skill folders are removed", async () => {
    const { stripCodexServer, removeClaudeSkills } = await import("../src/cli/apps.js");
    const text = upsertCodexServer('model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n', launch);
    assert.equal(stripCodexServer(text).join("\n"), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"');
    const dir = scratch();
    installClaudeSkills(dir, new Map([["ebms-api/SKILL.md", "api"], ["ebms-mrp/SKILL.md", "mrp"]]));
    mkdirSync(join(dir, "my-own-skill"), { recursive: true });
    writeFileSync(join(dir, "my-own-skill", "SKILL.md"), "mine");
    assert.deepEqual(removeClaudeSkills(dir).sort(), ["ebms-api", "ebms-mrp"]);
    assert.ok(existsSync(join(dir, "my-own-skill", "SKILL.md")) && !existsSync(join(dir, "ebms-api")));
});
