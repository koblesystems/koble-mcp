// Builds `koble` as one executable for the platform it runs on: the whole program bundled into
// one script, the skills embedded as assets, injected into a copy of the Node that runs this.
// Release builds run it once per platform in CI. Usage: node scripts/build-single.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const os = process.platform === "win32" ? "windows" : process.platform;
const name = `koble-${os}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1. One CommonJS script. import.meta.url does not exist in CommonJS, so it becomes this file's URL.
await build({
    entryPoints: [join(root, "cli.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: join(dist, "koble.cjs"),
    define: { "import.meta.url": "__kobleImportMetaUrl" },
    banner: { js: 'const __kobleImportMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
    logLevel: "warning",
});

// 2. The skills, as assets: an index plus one asset per file.
const skillsDir = join(root, "skills");
const files = [];
const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(md|py)$/.test(entry)) files.push(relative(skillsDir, full).split(sep).join("/"));
    }
};
walk(skillsDir);
writeFileSync(join(dist, "skills-index.json"), JSON.stringify(files));
const assets = { "skills/index.json": join(dist, "skills-index.json") };
for (const file of files) assets[`skills/${file}`] = join(skillsDir, ...file.split("/"));

// 3. The blob, then a copy of node with the blob injected.
writeFileSync(join(dist, "sea-config.json"), JSON.stringify({ main: join(dist, "koble.cjs"), output: join(dist, "sea-prep.blob"), disableExperimentalSEAWarning: true, useCodeCache: false, assets }, null, 2));
execFileSync(process.execPath, ["--experimental-sea-config", join(dist, "sea-config.json")], { stdio: "inherit" });

const out = join(dist, name);
copyFileSync(process.execPath, out);
if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", out]);
if (process.platform === "win32") {
    // node.exe is signed by the Node project; injecting breaks that signature, so remove it (Node's own advice).
    const kits = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
    const signtool = (() => { try { return readdirSync(kits).filter((v) => v.startsWith("10.")).sort().reverse().map((v) => join(kits, v, "x64", "signtool.exe")).find((p) => { try { return statSync(p).isFile(); } catch { return false; } }); } catch { return undefined; } })();
    if (signtool) execFileSync(signtool, ["remove", "/s", out], { stdio: "inherit" });
    else console.warn("signtool not found; the Windows build keeps a broken signature");
}
const postject = join(root, "node_modules", "postject", "dist", "cli.js");
const args = [postject, out, "NODE_SEA_BLOB", join(dist, "sea-prep.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
if (process.platform === "darwin") args.push("--macho-segment-name", "NODE_SEA");
execFileSync(process.execPath, args, { stdio: "inherit" });
if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", out]);

// 4. It must at least run and report the right version.
const reported = execFileSync(out, ["version"], { encoding: "utf8" }).trim();
if (reported !== `koble ${version}`) throw new Error(`built ${name} reports "${reported}", expected "koble ${version}"`);
console.log(`built dist/${name} (${(statSync(out).size / 1e6).toFixed(0)} MB) — ${reported}, ${files.length} skill files embedded`);
