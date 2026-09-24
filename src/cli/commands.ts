/**
 * `koble setup`, `login`, `connect`, `doctor` and `update`: everything a person does once, so that
 * using the server afterwards needs nothing but a Claude app.
 *
 * The password is only ever typed at a hidden prompt (or piped in with --password-stdin). It is
 * never a flag, never printed, and never passes through a chat.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { configure, setDiscoveredCompanies, type CompanyInfo } from "../config.js";
import { resetAuth, request } from "../ebms/client.js";
import { discoverCompanies } from "../ebms/companies.js";
import { EbmsError } from "../ebms/errors.js";
import { VERSION } from "../version.js";
import { claudeCodeHasPlugin, claudeCodeInstalled, claudeCodeServer, connectClaudeCode, connectDesktop, desktopEntry, desktopLog, desktopRunning, findDesktopConfig, readDesktopLog, type Launch } from "./hosts.js";
import { accountFor, loadPassword, readConfig, savePassword, writeConfig, type StoredConfig } from "./store.js";

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
        say("");
        await connect(flags);
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

export async function connect(flags: Flags): Promise<number> {
    const launch = selfLaunch();
    // Claude Desktop writes its config file back from memory, so a change made while it runs can vanish.
    if (findDesktopConfig() && desktopRunning()) {
        const where = process.platform === "win32" ? "right-click the Claude icon by the clock and choose Quit" : "Claude menu → Quit Claude";
        if (process.stdin.isTTY && flags["yes"] !== true) {
            for (let tries = 0; tries < 3 && desktopRunning(); tries += 1) await ask(`Claude Desktop is open. Quit it completely (${where}), then press Enter`);
            if (desktopRunning()) say("Claude Desktop is still running; connecting anyway. If koble does not appear in it, quit it and run `koble connect` again.");
        } else say(`Claude Desktop is open. Quit it completely (${where}) and run \`koble connect\` again, or it may undo this change.`);
    }
    const desktop = connectDesktop(launch);
    if (desktop.status === "not-installed") say("Claude Desktop: not installed here — skipped.");
    else if (desktop.status === "invalid") say(`Claude Desktop: ${desktop.reason}`);
    else {
        const verb = desktop.status === "unchanged" ? "already connected" : desktop.status === "added" ? "connected" : "updated";
        say(`Claude Desktop: ${verb}.${desktop.replaced.length ? ` Replaced the older entry ${desktop.replaced.join(", ")}.` : ""}${desktop.backup ? ` Backup of the old config: ${desktop.backup}` : ""}`);
        if (desktop.status !== "unchanged") say("  Quit and reopen Claude Desktop to load it.");
    }
    if (flags["no-claude-code"] === true) return 0;
    const code = connectClaudeCode(launch);
    for (const line of code.lines) say(`Claude Code: ${line}`);
    if (code.ok) say("  Start a new Claude Code session (or run /mcp) to load it.");
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

    const entry = desktopEntry();
    const self = selfLaunch();
    if (entry === "not-installed") add({ status: "info", label: "Claude Desktop", detail: "not installed" });
    else if (entry === "invalid") add({ status: "fail", label: "Claude Desktop", detail: `config is not valid JSON (${findDesktopConfig()})`, fix: "fix or move the file, then koble connect" });
    else if (entry === "missing") add({ status: "fail", label: "Claude Desktop", detail: "not connected", fix: "koble connect" });
    else if (entry.command === self.command && JSON.stringify(entry.args) === JSON.stringify(self.args)) {
        const log = desktopLog();
        if (!log) add({ status: "warn", label: "Claude Desktop", detail: "connected, but Claude Desktop has not started it yet", fix: "quit Claude Desktop completely and reopen it" });
        else {
            const seen = readDesktopLog(log.lines);
            add(seen.ok ? { status: "ok", label: "Claude Desktop", detail: `connected; ${seen.detail}` } : { status: "fail", label: "Claude Desktop", detail: `connected, but starting it failed: ${seen.detail}`, fix: `send the end of ${log.path}` });
        }
    }
    else add({ status: "warn", label: "Claude Desktop", detail: `runs ${[entry.command, ...(entry.args ?? [])].join(" ")}`, fix: "koble connect, to point it at this koble" });

    if (!claudeCodeInstalled()) add({ status: "info", label: "Claude Code", detail: "not installed" });
    else {
        const server = claudeCodeServer();
        // `claude mcp get` prints the arguments joined by spaces, so compare the whole command line.
        const runsSelf = server !== null && [server.command, ...server.args].join(" ") === [self.command, ...self.args].join(" ");
        if (!server) add({ status: "fail", label: "Claude Code", detail: "koble-mcp is not registered", fix: "koble connect" });
        else if (!runsSelf) add({ status: "warn", label: "Claude Code", detail: `runs ${[server.command, ...server.args].join(" ")}`, fix: "koble connect, to point it at this koble" });
        else if (!server.connected) add({ status: "fail", label: "Claude Code", detail: `registered, but it does not start: ${server.issue ?? "no detail"}`, fix: "koble connect; if it persists, send this line" });
        else add({ status: "ok", label: "Claude Code", detail: "connected to this koble" });
        if (!claudeCodeHasPlugin()) add({ status: "warn", label: "Skills plugin", detail: "not installed in Claude Code (the tools work; the skills come from the server's guide)", fix: "koble connect" });
    }

    if (flags["brief"] !== true) {
        const latest = await latestRelease(flags["pre"] === true).catch(() => null);
        if (latest && newer(latest.tag, VERSION)) add({ status: "warn", label: "Update", detail: `${latest.tag} is available`, fix: "koble update" });
    }

    if (flags["json"] === true) say(JSON.stringify({ version: VERSION, checks }, null, 2));
    else {
        const mark = { ok: "  ok ", warn: " warn", fail: " FIX ", info: "     " } as const;
        for (const c of checks) say(`${mark[c.status]}  ${c.label.padEnd(15)} ${c.detail}${c.fix ? `  ->  ${c.fix}` : ""}`);
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

export function version(): number {
    say(`koble ${VERSION}`);
    return 0;
}

export function help(): number {
    say(`koble ${VERSION} — EBMS for Claude

  koble setup     Serial number, test company, username and password; connects Claude Desktop and Claude Code
  koble login     Enter or change the EBMS password (typed hidden, stored in the system's credential store)
  koble connect   Connect Claude Desktop and Claude Code again
  koble doctor    Check every part and say how to fix what is broken   (--json for a machine-readable report)
  koble update    Download and install the latest release              (--pre to include release candidates)
  koble mcp       Run the MCP server (what Claude starts; not for typing by hand)
  koble version

setup flags: --serial, --username, --sandbox <company|none>, --skip-password, --password-stdin, --no-connect, --yes
Docs: https://github.com/${REPO}`);
    return 0;
}

function fail(message: string): number {
    process.stderr.write(`${message}\n`);
    return 1;
}

/** Reads a small text file if it exists — used by the tests to check what setup wrote. */
export const readIfExists = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);
