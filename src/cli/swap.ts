/**
 * Puts a downloaded koble in place of the running one. On Windows a running .exe can be renamed but
 * not overwritten or deleted, and Claude Desktop keeps `koble mcp` running from whatever file it
 * started, so an old copy may still be in use when the next update comes. None of that may stop an
 * update, or leave the folder without koble.exe.
 */
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface SwapFs {
    exists(path: string): boolean;
    readdir(dir: string): string[];
    rename(from: string, to: string): void;
    rm(path: string): void;
}

const nodeFs: SwapFs = {
    exists: existsSync,
    readdir: (dir) => readdirSync(dir),
    rename: renameSync,
    rm: (path) => rmSync(path, { force: true }),
};

/** Deletes target.old and target.old-*, skipping any that are still running. */
export function clearOld(target: string, fs: SwapFs = nodeFs): void {
    const prefix = `${basename(target)}.old`.toLowerCase();
    let names: string[];
    try {
        names = fs.readdir(dirname(target));
    } catch {
        return;
    }
    for (const name of names) {
        if (!name.toLowerCase().startsWith(prefix)) continue;
        try {
            fs.rm(join(dirname(target), name));
        } catch {
            // still in use: the next update or doctor tries again
        }
    }
}

/** target.old-<time>, with a counter if that is taken. */
function unused(base: string, fs: SwapFs): string {
    const stamp = `${base}-${Date.now()}`;
    for (let i = 0; ; i += 1) if (!fs.exists(i ? `${stamp}-${i}` : stamp)) return i ? `${stamp}-${i}` : stamp;
}

/** Moves `fresh` to `target`. Returns where the old copy went on Windows, else null. */
export function swapInto(target: string, fresh: string, platform: NodeJS.Platform = process.platform, fs: SwapFs = nodeFs): string | null {
    if (platform !== "win32") {
        fs.rename(fresh, target);
        return null;
    }
    clearOld(target, fs);
    let old = `${target}.old`;
    if (fs.exists(old)) {
        // Still running (Claude Desktop's koble mcp from the last update): move it aside, or leave it and use another name.
        const aside = unused(old, fs);
        try {
            fs.rename(old, aside);
        } catch {
            old = aside;
        }
    }
    fs.rename(target, old);
    try {
        fs.rename(fresh, target);
    } catch (error) {
        fs.rename(old, target);
        throw error;
    }
    return old;
}
