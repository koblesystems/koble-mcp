// Updates a running koble.exe three times in a row while every old copy keeps running, as Claude
// Desktop's `koble mcp` does, with the swap `koble update` uses. CI runs it on Windows, where a
// running .exe can be renamed but not deleted; a real release download is not needed for that.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearOld, swapInto } from "../src/cli/swap.js";

const built = join(import.meta.dirname, "..", "dist", "koble-windows-x64.exe");
const dir = mkdtempSync(join(tmpdir(), "koble-update-"));
const exe = join(dir, "koble.exe");
const env = { ...process.env, KOBLE_CONFIG_DIR: join(dir, "settings"), KOBLE_CREDENTIAL_STORE: "file", EBMS_SERIAL_NUMBER: "000000000000000", EBMS_USERNAME: "ci", EBMS_PASSWORD: "ci" };
mkdirSync(env.KOBLE_CONFIG_DIR);
const olds = () => readdirSync(dir).filter((name) => name.startsWith("koble.exe.old")).sort();

const running = [];
const start = async () => {
    const child = spawn(exe, ["mcp"], { env, stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let err = "";
    child.stderr.on("data", (chunk) => (err += chunk));
    running.push(child);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal(child.exitCode, null, `koble mcp exited: ${err}`);
};

try {
    copyFileSync(built, exe);
    await start();
    for (const round of [1, 2, 3]) {
        copyFileSync(built, `${exe}.new`);
        const old = swapInto(exe, `${exe}.new`);
        console.log(`update ${round}: the old copy is now ${old}; old copies: ${olds().join(", ")}`);
        assert.ok(existsSync(exe), "koble.exe is in place");
        assert.ok(!existsSync(`${exe}.new`), "koble.exe.new was moved in");
        if (round === 1) assert.throws(() => rmSync(`${exe}.old`), { code: "EPERM" }, "a running koble.exe.old cannot be deleted");
        const v = spawnSync(exe, ["version"], { env, encoding: "utf8" });
        assert.equal(v.status, 0, `koble version: ${v.stderr}`);
        await start(); // Claude Desktop restarts onto the new koble.exe; the old one keeps running too
    }
    assert.equal(olds().length, 3, "every running old copy was kept");
    clearOld(exe);
    assert.equal(olds().length, 3, "clearOld leaves running copies alone");
    for (const child of running) child.kill();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    clearOld(exe);
    assert.deepEqual(olds(), [], "clearOld removes stopped copies");
    console.log("update with old copies still running: ok");
} finally {
    for (const child of running) child.kill();
}
