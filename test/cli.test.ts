import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetName, newer } from "../src/cli/commands.js";
import { connectDesktop, readDesktopLog, SERVER_NAME } from "../src/cli/hosts.js";
import { accountFor, loadPassword, readConfig, savePassword, storedEnv, writeConfig } from "../src/cli/store.js";

const launch = { command: "/opt/koble/koble", args: ["mcp"] };
const scratch = (): string => mkdtempSync(join(tmpdir(), "koble-test-"));

test("Desktop: a missing config is created with just our entry", () => {
    const path = join(scratch(), "Claude", "claude_desktop_config.json");
    const r = connectDesktop(launch, path);
    assert.equal(r.status, "added");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { mcpServers: { [SERVER_NAME]: launch } });
});

test("Desktop: an older koble entry is replaced, everything else kept, and a backup taken", () => {
    const dir = scratch();
    const path = join(dir, "claude_desktop_config.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { "koble-mcp": { command: "node", args: ["/x/koble-mcp/index.js"], env: { EBMS_PASSWORD: "secret" } }, koble: { command: "/y/koble", args: ["mcp"] }, other: { command: "o" } }, theme: "dark" }));
    const r = connectDesktop(launch, path);
    assert.equal(r.status, "updated");
    const after = JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, unknown>; theme: string };
    assert.deepEqual(after.mcpServers, { "koble-mcp": launch, other: { command: "o" } });
    assert.equal(after.theme, "dark");
    assert.ok(!readFileSync(path, "utf8").includes("secret"), "the plaintext password is gone");
    assert.equal(readdirSync(dir).filter((f) => f.includes("koble-backup")).length, 1);
    assert.equal(connectDesktop(launch, path).status, "unchanged", "running it twice changes nothing");
});

test("Desktop: a config that does not parse is left exactly as it was", () => {
    const path = join(scratch(), "claude_desktop_config.json");
    const broken = '{ "mcpServers": { // a comment breaks it\n } }';
    writeFileSync(path, broken);
    const r = connectDesktop(launch, path);
    assert.equal(r.status, "invalid");
    assert.equal(readFileSync(path, "utf8"), broken);
});

test("stored settings fill the environment only where it is silent, and the password file is private", () => {
    const dir = scratch();
    process.env["KOBLE_CONFIG_DIR"] = dir;
    process.env["KOBLE_CREDENTIAL_STORE"] = "file";
    try {
        writeConfig({ serial: "000000000000000", username: "u", sandbox: "SBX" });
        const where = savePassword(accountFor({ serial: "000000000000000", username: "u" }), "pä ss\"word");
        assert.equal(where, "a file only you can read");
        assert.equal(loadPassword(accountFor({ serial: "000000000000000", username: "u" }))?.password, "pä ss\"word", "non-ASCII and quotes survive");
        if (process.platform !== "win32") assert.equal(statSync(join(dir, "credentials.json")).mode & 0o777, 0o600);
        assert.equal(readConfig()?.sandbox, "SBX");
        const env = storedEnv({});
        assert.deepEqual([env["EBMS_SERIAL_NUMBER"], env["EBMS_USERNAME"], env["EBMS_PASSWORD"], env["EBMS_SANDBOX"]], ["000000000000000", "u", "pä ss\"word", "SBX"]);
        assert.equal(storedEnv({ EBMS_SERIAL_NUMBER: "1" })["EBMS_PASSWORD"], undefined, "an explicit configuration wins outright");
        assert.equal(storedEnv({ EBMS_SANDBOX: "LIVE" })["EBMS_SANDBOX"], "LIVE");
    } finally {
        delete process.env["KOBLE_CONFIG_DIR"];
        delete process.env["KOBLE_CREDENTIAL_STORE"];
    }
});

test("release names and version order", () => {
    assert.equal(assetName("win32", "x64"), "koble-windows-x64.exe");
    assert.equal(assetName("darwin", "arm64"), "koble-darwin-arm64");
    assert.equal(newer("v0.2.0", "0.1.0"), true);
    assert.equal(newer("v0.1.0", "0.1.0"), false);
    assert.equal(newer("v0.1.0", "0.1.0-rc.2"), true, "a release beats its candidates");
    assert.equal(newer("v0.1.0-rc.10", "0.1.0-rc.9"), true);
    assert.equal(newer("v0.1.0-rc.1", "0.1.0"), false);
});

test("Desktop's log: the most recent start decides, ready or the last error", () => {
    const ok = readDesktopLog(["2026-09-24T11:10:51Z [koble-mcp] [info] Initializing server...", "koble-mcp 0.1.0 ready. Companies: SBX."]);
    assert.equal(ok.ok, true);
    const failed = readDesktopLog(["koble-mcp 0.1.0 ready.", "2026-09-24T12:00:00Z [koble-mcp] [error] spawn C:\\x\\koble.exe ENOENT"]);
    assert.equal(failed.ok, false);
    assert.match(failed.detail, /ENOENT/);
    assert.equal(readDesktopLog(["2026-09-24T12:00:00Z [koble-mcp] [info] Message from client: method=\"tools/list\" error-free"]).ok, true, "protocol traffic is not an error");
});
