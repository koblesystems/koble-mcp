/**
 * Where `koble setup` keeps what it learns: settings in a small JSON file in the user's config
 * folder, the password in the system's credential store. `koble mcp` turns them back into the
 * EBMS_* settings the server reads, so nobody edits a file and no password sits in a host's config.
 *
 * Secrets are stored base64-encoded ("b64:…") on every platform, so what comes back out of any
 * store is plain ASCII: macOS prints a non-ASCII password back as hex otherwise.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SERVICE = "koble-mcp";

export function configDir(): string {
    const override = process.env["KOBLE_CONFIG_DIR"];
    if (override) return override;
    if (process.platform === "win32") return join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "koble");
    return join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "koble");
}

export interface StoredConfig {
    serial: string;
    username?: string | undefined;
    /** Comma-separated company IDs to limit the server to; unset means every company the serial reaches. */
    companies?: string | undefined;
    /** While testing: the only company writes may go to. */
    sandbox?: string | undefined;
    /** The AI apps chosen at setup (ids from apps.ts); unset means every one installed. */
    apps?: string[] | undefined;
}

const configPath = (): string => join(configDir(), "config.json");

/** Written whole to a temporary file, then renamed over the old one, readable by the user only. */
function writePrivate(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
}

export function readConfig(): StoredConfig | null {
    try {
        const value = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<StoredConfig>;
        return typeof value.serial === "string" && value.serial ? (value as StoredConfig) : null;
    } catch {
        return null;
    }
}

export function writeConfig(config: StoredConfig): string {
    writePrivate(configPath(), `${JSON.stringify(config, null, 2)}\n`);
    return configPath();
}

export const accountFor = (config: Pick<StoredConfig, "serial" | "username">): string => `${config.serial}:${config.username ?? ""}`;

const encode = (secret: string): string => `b64:${Buffer.from(secret, "utf8").toString("base64")}`;
const decode = (stored: string): string => (stored.startsWith("b64:") ? Buffer.from(stored.slice(4), "base64").toString("utf8") : stored);

interface Backend {
    /** How the doctor and setup name it to the user. */
    label: string;
    get(account: string): string | null;
    set(account: string, value: string): void;
    remove(account: string): void;
}

const run = (command: string, args: string[], input?: string) =>
    spawnSync(command, args, { input, encoding: "utf8", windowsHide: true, timeout: 30_000 });

const macKeychain: Backend = {
    label: "macOS Keychain",
    get(account) {
        const r = run("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"]);
        return r.status === 0 ? r.stdout.trim() : null;
    },
    set(account, value) {
        // Through `security -i` on stdin, with the value hex-encoded, so it never appears on a command line.
        if (/["\\\n\r]/.test(account)) throw new Error("the account name has characters the Keychain command line cannot carry");
        const hex = Buffer.from(value, "utf8").toString("hex");
        const r = run("security", ["-i"], `add-generic-password -U -s ${SERVICE} -a "${account}" -X ${hex}\n`);
        if (r.status !== 0 || macKeychain.get(account) !== value) throw new Error(`the Keychain did not keep it (${(r.stderr || "").trim() || "no detail"})`);
    },
    remove(account) {
        run("security", ["delete-generic-password", "-s", SERVICE, "-a", account]);
    },
};

/** Windows Credential Manager through advapi32, from PowerShell. The script travels as -EncodedCommand; the data on stdin. */
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class KobleCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWrite(ref CREDENTIAL c, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredDelete(string target, int type, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static void Write(string target, string secret) {
    byte[] b = Encoding.Unicode.GetBytes(secret);
    CREDENTIAL c = new CREDENTIAL(); c.Type = 1; c.TargetName = target; c.UserName = "koble"; c.Persist = 2;
    c.CredentialBlobSize = b.Length; c.CredentialBlob = Marshal.AllocHGlobal(b.Length);
    try { Marshal.Copy(b, 0, c.CredentialBlob, b.Length); if (!CredWrite(ref c, 0)) throw new Exception("CredWrite failed: " + Marshal.GetLastWin32Error()); }
    finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static string Read(string target) {
    IntPtr p; if (!CredRead(target, 1, 0, out p)) return null;
    try { CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); byte[] b = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, b, 0, b.Length); return Encoding.Unicode.GetString(b); }
    finally { CredFree(p); }
  }
  public static void Delete(string target) { CredDelete(target, 1, 0); }
}
"@
$op = [Console]::In.ReadLine(); $target = [Console]::In.ReadLine()
if ($op -eq 'set') { [KobleCred]::Write($target, [Console]::In.ReadLine()); 'ok' }
elseif ($op -eq 'get') { $v = [KobleCred]::Read($target); if ($null -eq $v) { '<none>' } else { $v } }
else { [KobleCred]::Delete($target); 'ok' }
`;

function powershell(op: string, account: string, value = ""): string | null {
    const encoded = Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64");
    const r = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], `${op}\n${SERVICE}:${account}\n${value}\n`);
    if (r.status !== 0) throw new Error((r.stderr || "PowerShell failed").trim().split("\n")[0]);
    return r.stdout.trim();
}

const windowsCredentials: Backend = {
    label: "Windows Credential Manager",
    get(account) {
        const out = powershell("get", account);
        return out && out !== "<none>" ? out : null;
    },
    set(account, value) {
        powershell("set", account, value);
        if (windowsCredentials.get(account) !== value) throw new Error("Credential Manager did not keep it");
    },
    remove(account) {
        powershell("delete", account);
    },
};

const secretService: Backend = {
    label: "the Secret Service keyring",
    get(account) {
        const r = run("secret-tool", ["lookup", "service", SERVICE, "account", account]);
        return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    },
    set(account, value) {
        const r = run("secret-tool", ["store", `--label=${SERVICE}`, "service", SERVICE, "account", account], value);
        if (r.status !== 0 || secretService.get(account) !== value) throw new Error((r.stderr || "secret-tool failed").trim());
    },
    remove(account) {
        run("secret-tool", ["clear", "service", SERVICE, "account", account]);
    },
};

/** Last resort: a file in the config folder that only this user can read. */
const privateFile: Backend = {
    label: "a file only you can read",
    get(account) {
        try {
            const all = JSON.parse(readFileSync(join(configDir(), "credentials.json"), "utf8")) as Record<string, string>;
            return all[account] ?? null;
        } catch {
            return null;
        }
    },
    set(account, value) {
        const path = join(configDir(), "credentials.json");
        let all: Record<string, string> = {};
        try {
            all = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
        } catch {
            // no file yet
        }
        all[account] = value;
        writePrivate(path, `${JSON.stringify(all, null, 2)}\n`);
    },
    remove(account) {
        const path = join(configDir(), "credentials.json");
        if (!existsSync(path)) return;
        const all = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
        delete all[account];
        writePrivate(path, `${JSON.stringify(all, null, 2)}\n`);
    },
};

/** The system store first, then the file. KOBLE_CREDENTIAL_STORE=file forces the file (tests, CI, headless Linux). */
function backends(): Backend[] {
    if (process.env["KOBLE_CREDENTIAL_STORE"] === "file") return [privateFile];
    const system = process.platform === "darwin" ? macKeychain : process.platform === "win32" ? windowsCredentials : secretService;
    return [system, privateFile];
}

/** Stores the password, and says where it went. */
export function savePassword(account: string, password: string): string {
    const problems: string[] = [];
    for (const backend of backends()) {
        try {
            backend.set(account, encode(password));
            for (const other of backends()) if (other !== backend) try { other.remove(account); } catch { /* not there */ }
            return backend.label + (problems.length ? ` (${problems.join("; ")})` : "");
        } catch (error) {
            problems.push(`${backend.label}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    throw new Error(`The password could not be stored anywhere: ${problems.join("; ")}`);
}

export function loadPassword(account: string): { password: string; where: string } | null {
    for (const backend of backends()) {
        try {
            const value = backend.get(account);
            if (value) return { password: decode(value), where: backend.label };
        } catch {
            // try the next one
        }
    }
    return null;
}

export function forgetPassword(account: string): void {
    for (const backend of backends()) try { backend.remove(account); } catch { /* not there */ }
}

/**
 * The EBMS_* settings the server reads, filled from what setup stored — only where the environment
 * does not already set them, so an explicit configuration always wins.
 */
export function storedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
    const merged: Record<string, string | undefined> = { ...env };
    if (env["EBMS_SERIAL_NUMBER"]) return merged;
    const config = readConfig();
    if (!config) return merged;
    merged["EBMS_SERIAL_NUMBER"] = config.serial;
    if (config.username && !env["EBMS_USERNAME"]) merged["EBMS_USERNAME"] = config.username;
    if (config.companies && !env["EBMS_COMPANIES"]) merged["EBMS_COMPANIES"] = config.companies;
    if (config.sandbox && !env["EBMS_SANDBOX"]) merged["EBMS_SANDBOX"] = config.sandbox;
    if (config.username && !env["EBMS_PASSWORD"]) {
        const found = loadPassword(accountFor(config));
        if (found) merged["EBMS_PASSWORD"] = found.password;
    }
    return merged;
}
