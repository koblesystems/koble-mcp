import { test } from "node:test";
import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import { clearOld, swapInto, type SwapFs } from "../src/cli/swap.js";

const dir = join("C:", "koble");
const exe = join(dir, "koble.exe");

/** A folder in memory, Windows style: a running file can be renamed, but not deleted or replaced. */
function folder(files: Record<string, string>, running: string[] = [], locked: string[] = []) {
    const content = new Map(Object.entries(files).map(([name, body]) => [join(dir, name), body]));
    const busy = new Set(running.map((name) => join(dir, name)));
    const stuck = new Set(locked.map((name) => join(dir, name)));
    const eperm = (op: string, path: string) => Object.assign(new Error(`EPERM: operation not permitted, ${op} '${path}'`), { code: "EPERM" });
    const fs: SwapFs = {
        exists: (path) => content.has(path),
        readdir: (d) => [...content.keys()].filter((p) => dirname(p) === d).map((p) => basename(p)),
        rename(from, to) {
            if (!content.has(from)) throw Object.assign(new Error(`ENOENT ${from}`), { code: "ENOENT" });
            if (stuck.has(from) || busy.has(to)) throw eperm("rename", from);
            content.set(to, content.get(from) ?? "");
            content.delete(from);
            if (busy.delete(from)) busy.add(to);
        },
        rm(path) {
            if (busy.has(path) || stuck.has(path)) throw eperm("unlink", path);
            content.delete(path);
        },
    };
    const names = () => Object.fromEntries([...content].map(([p, body]) => [basename(p), body]).sort());
    const put = (name: string, body: string) => void content.set(join(dir, name), body);
    const run = (name: string) => void busy.add(join(dir, name));
    return { fs, names, put, run, busy: () => [...busy].map((p) => basename(p)).sort() };
}

test("macOS and Linux: the new file simply replaces the old", () => {
    const f = folder({ "koble.exe": "rc13", "koble.exe.new": "rc15" });
    assert.equal(swapInto(exe, `${exe}.new`, "darwin", f.fs), null);
    assert.deepEqual(f.names(), { "koble.exe": "rc15" });
});

test("Windows, first update: the running koble.exe becomes koble.exe.old", () => {
    const f = folder({ "koble.exe": "rc13", "koble.exe.new": "rc14" }, ["koble.exe"]);
    swapInto(exe, `${exe}.new`, "win32", f.fs);
    assert.deepEqual(f.names(), { "koble.exe": "rc14", "koble.exe.old": "rc13" });
    assert.deepEqual(f.busy(), ["koble.exe.old"]);
});

test("Windows, second update while the first old copy still runs: it is moved aside, not deleted", () => {
    // rc.13 -> rc.15 with Claude Desktop open: its koble mcp runs from koble.exe.old, so deleting it is EPERM.
    const f = folder({ "koble.exe": "rc14", "koble.exe.old": "rc13", "koble.exe.new": "rc15" }, ["koble.exe", "koble.exe.old"]);
    swapInto(exe, `${exe}.new`, "win32", f.fs);
    const names = f.names();
    assert.equal(names["koble.exe"], "rc15");
    assert.equal(names["koble.exe.old"], "rc14");
    const aside = Object.keys(names).filter((n) => /^koble\.exe\.old-\d+$/.test(n));
    assert.equal(aside.length, 1);
    assert.equal(names[aside[0] ?? ""], "rc13");
    assert.equal(names["koble.exe.new"], undefined);
});

test("Windows, an old copy that cannot even be renamed: this update uses a new .old name", () => {
    const f = folder({ "koble.exe": "rc14", "koble.exe.old": "rc13", "koble.exe.new": "rc15" }, ["koble.exe"], ["koble.exe.old"]);
    const old = swapInto(exe, `${exe}.new`, "win32", f.fs);
    assert.match(basename(old ?? ""), /^koble\.exe\.old-\d+$/);
    const names = f.names();
    assert.equal(names["koble.exe"], "rc15");
    assert.equal(names["koble.exe.old"], "rc13");
    assert.equal(names[basename(old ?? "")], "rc14");
});

test("Windows, three updates in a row with every old copy still running", () => {
    const f = folder({ "koble.exe": "v1" }, ["koble.exe"]);
    for (const v of ["v2", "v3", "v4"]) {
        f.put("koble.exe.new", v);
        swapInto(exe, `${exe}.new`, "win32", f.fs);
        f.run("koble.exe"); // Claude Desktop restarts and runs the new one
    }
    const names = f.names();
    assert.equal(names["koble.exe"], "v4");
    assert.equal(names["koble.exe.old"], "v3");
    assert.deepEqual(Object.values(names).sort(), ["v1", "v2", "v3", "v4"]);
    assert.equal(f.busy().length, 4);
});

test("Windows: if the new file cannot be moved in, koble.exe is put back", () => {
    const f = folder({ "koble.exe": "rc14", "koble.exe.new": "rc15" }, ["koble.exe"], ["koble.exe.new"]);
    assert.throws(() => swapInto(exe, `${exe}.new`, "win32", f.fs), /EPERM/);
    assert.equal(f.names()["koble.exe"], "rc14");
});

test("clearOld removes old copies that have stopped and leaves running ones", () => {
    const f = folder({ "koble.exe": "v4", "koble.exe.old": "v3", "koble.exe.old-1": "v1", "koble.exe.old-2": "v2", "other.txt": "x" }, ["koble.exe", "koble.exe.old-2"]);
    clearOld(exe, f.fs);
    assert.deepEqual(f.names(), { "koble.exe": "v4", "koble.exe.old-2": "v2", "other.txt": "x" });
});

test("clearOld does nothing when the folder cannot be read", () => {
    const fs: SwapFs = { exists: () => false, readdir: () => { throw new Error("ENOENT"); }, rename: () => {}, rm: () => assert.fail("nothing to remove") };
    clearOld(exe, fs);
});
