/**
 * `koble setup`, `login`, `connect`, `doctor` and `update`: everything a person does once, so that
 * using the server afterwards needs nothing but a Claude app.
 *
 * The password is only ever typed at a hidden prompt (or piped in with --password-stdin). It is
 * never a flag, never printed, and never passes through a chat.
 */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { configure, setDiscoveredCompanies, type CompanyInfo } from "../config.js";
import { resetAuth, request } from "../ebms/client.js";
import { discoverCompanies } from "../ebms/companies.js";
import { EbmsError } from "../ebms/errors.js";
import { VERSION } from "../version.js";
import { APPS, appById, type App } from "./apps.js";
import { desktopLog, desktopRunning, readDesktopLog, type Launch } from "./hosts.js";
import { outputDir } from "../mrp/files.js";
import { accountFor, configDir, forgetPassword, loadPassword, readConfig, savePassword, writeConfig, type StoredConfig } from "./store.js";

export type Flags = Record<string, string | boolean>;

const REPO = "koblesystems/koble-mcp";
const say = (line = ""): void => void process.stdout.write(`${line}\n`);

/** The single-file build is the executable itself; from source it is node plus cli.js. */
export function isSingleFile(): boolean {
    try {
        return (createRequire(import.meta.url)("node:sea") as { isSea(): boolean }).isSea();
    } catch {
        return false;
    }
}

export function selfLaunch(): Launch {
    if (isSingleFile()) return { command: process.execPath, args: ["mcp"] };
    return { command: process.execPath, args: [fileURLToPath(new URL("../../cli.js", import.meta.url)), "mcp"] };
}

// ------------------------------------------------------------------ prompts

async function ask(question: string, fallback = ""): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `);
        return answer.trim() || fallback;
    } finally {
        rl.close();
    }
}

async function readLineFromPipe(): Promise<string> {
    let text = "";
    for await (const chunk of process.stdin) {
        text += String(chunk);
        if (text.includes("\n")) break;
    }
    return (text.split(/\r?\n/)[0] ?? "").trim();
}

/** Typed without echo. Needs a terminal: a password is never taken from a flag. */
async function askHidden(question: string): Promise<string> {
    const input = process.stdin;
    if (!input.isTTY) throw new Error("A password has to be typed in a terminal. Run `koble login` in a terminal window, or pipe it in with --password-stdin.");
    process.stdout.write(`${question}: `);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    return new Promise((resolve, reject) => {
        let value = "";
        const finish = (): void => {
            input.setRawMode(false);
            input.pause();
            input.off("data", onData);
            process.stdout.write("\n");
        };
        const onData = (chunk: string): void => {
            for (const ch of chunk) {
                if (ch === "\r" || ch === "\n") return (finish(), resolve(value));
                if (ch === "\u0003") return (finish(), reject(new Error("Cancelled.")));
                if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
                else value += ch;
            }
        };
        input.on("data", onData);
    });
}

// ------------------------------------------------------------------ EBMS checks

async function companiesFor(serial: string): Promise<CompanyInfo[]> {
    configure({ EBMS_SERIAL_NUMBER: serial });
    return discoverCompanies();
}

/** Signs in and makes one tiny read, so "saved" only ever means "works". */
async function signIn(serial: string, username: string, password: string, company: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    configure({ EBMS_SERIAL_NUMBER: serial, EBMS_USERNAME: username, EBMS_PASSWORD: password });
    resetAuth();
    try {
        setDiscoveredCompanies(await discoverCompanies());
        await request(company, "GET", "INVENTRY?$top=1&$select=ID");
        return { ok: true };
    } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        if (error instanceof EbmsError && error.kind === "credentials") return { ok: false, reason: `EBMS refused that username and password for ${company}.` };
        if (error instanceof EbmsError && error.kind === "signin") return { ok: false, reason: `Signing in to ${company} failed: ${why}` };
        return { ok: false, reason: why };
    }
}

const pickCompany = (companies: CompanyInfo[], wanted: string): CompanyInfo | undefined =>
    companies.find((c) => c.id.toLowerCase() === wanted.toLowerCase()) ?? companies.find((c) => c.name.toLowerCase() === wanted.toLowerCase());

const listCompanies = (companies: CompanyInfo[]): string => companies.map((c) => `${c.id} (${c.name}${c.version ? `, EBMS ${c.version}` : ""})`).join(", ");

// ------------------------------------------------------------------ commands

export async function setup(flags: Flags): Promise<number> {
    const existing = readConfig();
    const interactive = process.stdin.isTTY === true && flags["yes"] !== true;
    say(`koble ${VERSION} setup`);
    say();

    let serial = String(flags["serial"] ?? process.env["KOBLE_SERIAL"] ?? "");
    let companies: CompanyInfo[] = [];
    for (;;) {
        if (!serial) {
            if (!interactive) return fail("No serial number. Pass --serial or set KOBLE_SERIAL.");
            serial = await ask("EBMS serial number", existing?.serial ?? "");
        }
        try {
            companies = await companiesFor(serial);
            break;
        } catch (error) {
            say(`That serial number did not reach EBMS (${error instanceof Error ? error.message : String(error)}).`);
            if (!interactive) return 1;
            serial = "";
        }
    }
    say(`Companies on this serial: ${listCompanies(companies)}`);

    let sandbox = String(flags["sandbox"] ?? process.env["KOBLE_SANDBOX"] ?? existing?.sandbox ?? "");
    if (interactive && flags["sandbox"] === undefined) {
        say("");
        say("While you try this out, writes can be limited to one test company.");
        sandbox = await ask("Test company for writes (ID or name; 'none' to allow every company)", sandbox || "none");
    }
    let sandboxId: string | undefined;
    if (sandbox && sandbox.toLowerCase() !== "none") {
        const match = pickCompany(companies, sandbox);
        if (!match) return fail(`No company "${sandbox}" on this serial. Companies: ${listCompanies(companies)}.`);
        sandboxId = match.id;
    }

    let username = String(flags["username"] ?? process.env["KOBLE_USERNAME"] ?? "");
    if (!username) {
        if (!interactive) return fail("No username. Pass --username or set KOBLE_USERNAME.");
        username = await ask("EBMS username", existing?.username ?? "");
    }

    const config: StoredConfig = { serial, username, sandbox: sandboxId, companies: existing?.companies };
    const where = writeConfig(config);
    say(`Settings saved to ${where}.`);

    if (flags["skip-password"] === true) {
        say("");
        say("Next, type your EBMS password where only you can see it: open a terminal and run `koble login`.");
    } else {
        const code = await login({ ...flags, "from-setup": true });
        if (code !== 0) return code;
    }

    if (flags["no-connect"] !== true) {
        const found = APPS.filter((app) => app.installed());
        let picked = typeof flags["apps"] === "string" ? flags["apps"].split(",").map((s) => s.trim()) : found.map((app) => app.id);
        if (interactive && typeof flags["apps"] !== "string" && found.length > 0) {
            say("");
            say("Which AI apps should koble connect to?");
            APPS.forEach((app, i) => say(`  ${i + 1}. ${app.name}${app.installed() ? "" : "  (not found on this computer)"}`));
            const answer = await ask("Numbers separated by commas, or Enter for every app found", found.map((app) => String(APPS.indexOf(app) + 1)).join(","));
            picked = answer.split(",").map((n) => APPS[Number(n.trim()) - 1]?.id).filter((id): id is string => id !== undefined);
        }
        writeConfig({ ...(readConfig() ?? config), apps: picked });
        say("");
        await connect({ ...flags, apps: picked.join(",") });
    }
    say("");
    return doctor({ ...flags, brief: true });
}

export async function login(flags: Flags): Promise<number> {
    const config = readConfig();
    if (!config?.username) return fail("Run `koble setup` first: it needs the serial number and username before the password.");
    const companies = await companiesFor(config.serial).catch(() => [] as CompanyInfo[]);
    const company = config.sandbox ?? companies[0]?.id;
    if (!company) return fail("Could not list the companies on this serial, so the password cannot be checked. Try again when EBMS is reachable.");
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const password = flags["password-stdin"] === true ? await readLineFromPipe() : await askHidden(`EBMS password for ${config.username}`);
        if (!password) return fail("No password given.");
        const result = await signIn(config.serial, config.username, password, company);
        if (result.ok) {
            const where = savePassword(accountFor(config), password);
            say(`Signed in to ${company}. Password stored in ${where}.`);
            return 0;
        }
        say(result.reason);
        if (flags["password-stdin"] === true) return 1;
    }
    return fail("Three attempts failed. Check the username with `koble setup` and try `koble login` again.");
}

/** The apps to connect: --apps, else the ones chosen at setup, else every one installed here. */
function chosenApps(flags: Flags): App[] {
    const wanted = typeof flags["apps"] === "string" ? flags["apps"].split(",").map((s) => s.trim()).filter(Boolean) : readConfig()?.apps;
    if (wanted && wanted.length) return wanted.map((id) => appById(id)).filter((app): app is App => app !== undefined);
    return APPS.filter((app) => app.installed());
}

export async function connect(flags: Flags): Promise<number> {
    const launch = selfLaunch();
    const apps = chosenApps(flags);
    if (apps.length === 0) {
        say("No AI apps found to connect. Install Claude Desktop, Claude Code, Codex, Cursor, VS Code, Gemini CLI or Windsurf, then run koble connect.");
        return 0;
    }
    for (const app of apps) {
        if (!app.installed()) {
            say(`${app.name}: not installed here — skipped.`);
            continue;
        }
        if (app.id === "claude-desktop" && desktopRunning()) {
            // Claude Desktop writes its config file back from memory, so a change made while it runs can vanish.
            const where = process.platform === "win32" ? "right-click the Claude icon by the clock and choose Quit" : "Claude menu → Quit Claude";
            if (process.stdin.isTTY && flags["yes"] !== true) {
                for (let tries = 0; tries < 3 && desktopRunning(); tries += 1) await ask(`Claude Desktop is open. Quit it completely (${where}), then press Enter`);
                if (desktopRunning()) say("Claude Desktop is still running; connecting anyway. If koble does not appear in it, quit it and run `koble connect` again.");
            } else say(`Claude Desktop is open. Quit it completely (${where}) and run \`koble connect\` again, or it may undo this change.`);
        }
        for (const line of app.connect(launch)) say(`${app.name}: ${line}`);
    }
    say("");
    say("Restart each app to load koble: quit and reopen Claude Desktop and Cursor, start a new Claude Code or Codex session.");
    return 0;
}

interface Check {
    status: "ok" | "warn" | "fail" | "info";
    label: string;
    detail: string;
    fix?: string;
}

export async function doctor(flags: Flags): Promise<number> {
    const checks: Check[] = [];
    const add = (check: Check): void => void checks.push(check);
    add({ status: "info", label: "koble", detail: `${VERSION}, ${isSingleFile() ? process.execPath : "running from source"}` });

    const config = readConfig();
    if (!config) add({ status: "fail", label: "Settings", detail: "none saved", fix: "koble setup" });
    else {
        add({ status: "ok", label: "Settings", detail: `serial set, username ${config.username ?? "(none)"}` });
        const companies = await companiesFor(config.serial).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
        if (typeof companies === "string") add({ status: "fail", label: "EBMS", detail: `company list not reachable: ${companies}`, fix: "check the serial number and your internet connection" });
        else {
            add({ status: "ok", label: "EBMS", detail: listCompanies(companies) });
            const stored = config.username ? loadPassword(accountFor(config)) : null;
            if (!stored) add({ status: "fail", label: "Password", detail: "not stored", fix: "koble login" });
            else {
                add({ status: "ok", label: "Password", detail: `stored in ${stored.where}` });
                const company = config.sandbox ?? companies[0]?.id ?? "";
                const signed = await signIn(config.serial, config.username ?? "", stored.password, company);
                add(signed.ok ? { status: "ok", label: "Sign-in", detail: `works for ${company}` } : { status: "fail", label: "Sign-in", detail: signed.reason, fix: "koble login" });
            }
            add(config.sandbox ? { status: "ok", label: "Testing mode", detail: `writes go only to ${config.sandbox}` } : { status: "warn", label: "Testing mode", detail: "off: writes may go to every company", fix: "koble setup, and name a test company" });
        }
    }

    const self = selfLaunch();
    for (const app of chosenApps(flags)) {
        if (!app.installed()) {
            add({ status: "info", label: app.name, detail: "not installed" });
            continue;
        }
        const result = app.check(self);
        if (app.id === "claude-desktop" && result.status === "ok") {
            // Connected in its config; its own log says whether it actually started koble.
            const log = desktopLog();
            if (!log) add({ status: "warn", label: app.name, detail: "connected, but Claude Desktop has not started it yet", fix: "quit Claude Desktop completely and reopen it" });
            else {
                const seen = readDesktopLog(log.lines);
                add(seen.ok ? { status: "ok", label: app.name, detail: `connected; ${seen.detail}` } : { status: "fail", label: app.name, detail: `connected, but starting it failed: ${seen.detail}`, fix: `send the end of ${log.path}` });
            }
        } else add({ label: app.name, ...result });
    }
    const others = APPS.filter((app) => !chosenApps(flags).includes(app) && app.installed());
    if (others.length) add({ status: "info", label: "Not connected", detail: `${others.map((a) => a.name).join(", ")} (koble connect --apps to add them)` });

    if (flags["brief"] !== true) {
        const latest = await latestRelease(flags["pre"] === true).catch(() => null);
        if (latest && newer(latest.tag, VERSION)) add({ status: "warn", label: "Update", detail: `${latest.tag} is available`, fix: "koble update" });
    }

    if (flags["json"] === true) say(JSON.stringify({ version: VERSION, checks }, null, 2));
    else {
        const mark = { ok: "  ok ", warn: " warn", fail: " FIX ", info: "     " } as const;
        for (const c of checks) say(`${mark[c.status]}  ${c.label.padEnd(18)} ${c.detail}${c.fix ? `  ->  ${c.fix}` : ""}`);
    }
    return checks.some((c) => c.status === "fail") ? 1 : 0;
}

// ------------------------------------------------------------------ update

export function assetName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
    const os = platform === "win32" ? "windows" : platform;
    return `koble-${os}-${arch}${platform === "win32" ? ".exe" : ""}`;
}

/** "0.2.0" is newer than "0.1.0"; a release is newer than its own release candidates. */
export function newer(candidate: string, current: string): boolean {
    const parse = (v: string) => {
        const [core = "", pre] = v.replace(/^v/, "").split("-", 2);
        return { nums: core.split(".").map((n) => Number(n) || 0), pre: pre ?? null };
    };
    const a = parse(candidate);
    const b = parse(current);
    for (let i = 0; i < 3; i += 1) if ((a.nums[i] ?? 0) !== (b.nums[i] ?? 0)) return (a.nums[i] ?? 0) > (b.nums[i] ?? 0);
    if (a.pre === b.pre) return false;
    if (a.pre === null) return true;
    if (b.pre === null) return false;
    return a.pre.localeCompare(b.pre, undefined, { numeric: true }) > 0;
}

async function latestRelease(includePre: boolean): Promise<{ tag: string; assets: Array<{ name: string; url: string }> } | null> {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const releases = (await response.json()) as Array<{ tag_name: string; draft: boolean; prerelease: boolean; assets: Array<{ name: string; browser_download_url: string }> }>;
    const pick = releases.find((r) => !r.draft && (includePre || !r.prerelease));
    return pick ? { tag: pick.tag_name, assets: pick.assets.map((a) => ({ name: a.name, url: a.browser_download_url })) } : null;
}

export async function update(flags: Flags): Promise<number> {
    if (!isSingleFile()) return fail("This koble runs from source. Update it with `git pull` and `npm run build`.");
    const includePre = flags["pre"] === true || VERSION.includes("-");
    const latest = await latestRelease(includePre);
    if (!latest) return fail("No release found.");
    if (!newer(latest.tag, VERSION)) {
        say(`koble ${VERSION} is up to date.`);
        return 0;
    }
    const name = assetName();
    const asset = latest.assets.find((a) => a.name === name);
    const sums = latest.assets.find((a) => a.name === "checksums.txt");
    if (!asset || !sums) return fail(`Release ${latest.tag} has no ${name} or no checksums.txt.`);
    say(`Downloading koble ${latest.tag}…`);
    const [binary, checksums] = await Promise.all([fetch(asset.url).then((r) => r.arrayBuffer()), fetch(sums.url).then((r) => r.text())]);
    const expected = checksums.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).find((parts) => parts[1]?.replace(/^\*/, "") === name)?.[0];
    const actual = createHash("sha256").update(Buffer.from(binary)).digest("hex");
    if (!expected || expected !== actual) return fail("The download's checksum does not match checksums.txt. Nothing was changed.");
    const target = process.execPath;
    const fresh = `${target}.new`;
    writeFileSync(fresh, Buffer.from(binary));
    if (process.platform !== "win32") chmodSync(fresh, 0o755);
    if (process.platform === "win32") {
        // A running .exe can be renamed but not overwritten.
        const old = `${target}.old`;
        if (existsSync(old)) rmSync(old, { force: true });
        renameSync(target, old);
    }
    renameSync(fresh, target);
    say(`Updated to ${latest.tag}. Restart Claude Desktop (and Claude Code sessions) to use it.`);
    return 0;
}

// ------------------------------------------------------------------ uninstall

/** Takes koble's folder off the user's PATH on Windows, the one change the installer made outside its own files. */
function removeFromWindowsPath(dir: string): boolean {
    const script = "$d = [Console]::In.ReadLine().TrimEnd('\\'); $p = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($null -eq $p) { exit 0 }; $kept = ($p -split ';' | Where-Object { $_ -and ($_.TrimEnd('\\') -ne $d) }) -join ';'; if ($kept -ne $p) { [Environment]::SetEnvironmentVariable('Path', $kept, 'User'); 'changed' }";
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { input: `${dir}\n`, encoding: "utf8", windowsHide: true, timeout: 30_000 });
    return r.stdout.includes("changed");
}

/**
 * Deletes this program. On macOS and Linux a running program can delete its own file. On Windows it
 * cannot, so a hidden cmd waits a moment for koble to exit and then deletes it (and the folder,
 * if that leaves it empty).
 */
function removeSelf(): string {
    const exe = process.execPath;
    if (!isSingleFile() || !/^koble(\.exe)?$/i.test(basename(exe))) return "";
    if (process.platform !== "win32") {
        rmSync(exe, { force: true });
        return exe;
    }
    const dir = dirname(exe);
    const command = `ping -n 3 127.0.0.1 >nul & del /f /q "${exe}" "${exe}.old" "${exe}.new" & rmdir "${dir}"`;
    spawn("cmd.exe", ["/d", "/c", command], { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true }).unref();
    return exe;
}

export async function uninstall(flags: Flags): Promise<number> {
    const config = readConfig();
    const credential = config?.username ? loadPassword(accountFor(config)) : null;
    const apps = APPS.filter((app) => app.installed()).map((app) => ({ app, parts: app.footprint() })).filter((x) => x.parts.length > 0);
    const program = isSingleFile() ? process.execPath : null;

    const plan: string[] = [];
    for (const { app, parts } of apps) plan.push(`${app.name}: ${parts.join("; ")}`);
    if (credential) plan.push(`your EBMS password, from ${credential.where}`);
    if (existsSync(configDir())) plan.push(`koble's settings: ${configDir()}`);
    if (program) plan.push(`the koble program: ${program}${process.platform === "win32" ? ", and its folder on your PATH" : ""}`);
    else plan.push("(this koble runs from source: delete the folder yourself when you are done)");

    say("koble uninstall will remove:");
    for (const line of plan) say(`  - ${line}`);
    say("");
    say(`It keeps your MRP worksheets (${outputDir()}) and the config backups it made (files ending .koble-backup-…).`);
    say("");
    if (flags["yes"] !== true) {
        if (!process.stdin.isTTY) return fail("Nothing was removed. Run `koble uninstall --yes` to remove it all without being asked.");
        const answer = await ask("Remove all of this? Type yes to continue", "no");
        if (!/^y(es)?$/i.test(answer)) {
            say("Nothing was removed.");
            return 0;
        }
    }

    if (apps.some(({ app }) => app.id === "claude-desktop") && desktopRunning()) {
        const where = process.platform === "win32" ? "right-click the Claude icon by the clock and choose Quit" : "Claude menu → Quit Claude";
        if (process.stdin.isTTY && flags["yes"] !== true) {
            for (let tries = 0; tries < 3 && desktopRunning(); tries += 1) await ask(`Claude Desktop is open and could write koble back. Quit it completely (${where}), then press Enter`);
        } else say(`Claude Desktop is open; if koble-mcp is still listed in it afterwards, quit it (${where}) and run \`koble uninstall\` again.`);
    }

    for (const { app } of apps) for (const line of app.disconnect()) say(`${app.name}: ${line}`);
    if (config?.username) {
        forgetPassword(accountFor(config));
        if (credential) say(`Password: removed from ${credential.where}.`);
    }
    if (existsSync(configDir())) {
        rmSync(configDir(), { recursive: true, force: true });
        say(`Settings: removed ${configDir()}.`);
    }
    if (program && process.platform === "win32" && removeFromWindowsPath(dirname(program))) say("PATH: removed koble's folder.");
    const removed = removeSelf();
    if (removed) say(`Program: ${process.platform === "win32" ? "removing" : "removed"} ${removed}.`);
    say("");
    say("koble is uninstalled. Restart the AI apps so they stop looking for it.");
    return 0;
}

export function version(): number {
    say(`koble ${VERSION}`);
    return 0;
}

export function help(): number {
    say(`koble ${VERSION} — EBMS for Claude

  koble setup     Serial number, test company, username, password, and which AI apps to connect
  koble login     Enter or change the EBMS password (typed hidden, stored in the system's credential store)
  koble connect   Connect the AI apps again (--apps claude-desktop,claude-code,codex,cursor,vscode,gemini,windsurf)
  koble doctor    Check every part and say how to fix what is broken   (--json for a machine-readable report)
  koble update    Download and install the latest release              (--pre to include release candidates)
  koble uninstall Remove koble from every app, its settings, password and program (asks first; --yes to skip)
  koble mcp       Run the MCP server (what Claude starts; not for typing by hand)
  koble version

setup flags: --serial, --username, --sandbox <company|none>, --apps <ids>, --skip-password, --password-stdin, --no-connect, --yes
Docs: https://github.com/${REPO}`);
    return 0;
}

function fail(message: string): number {
    process.stderr.write(`${message}\n`);
    return 1;
}

/** Reads a small text file if it exists — used by the tests to check what setup wrote. */
export const readIfExists = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);
