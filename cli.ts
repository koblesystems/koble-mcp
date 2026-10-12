/**
 * `koble` — the command people install. `koble setup` once; after that Claude starts `koble mcp`.
 */
import { companiesCommand, connect, doctor, help, login, plugin, setup, uninstall, update, version, type Flags } from "./src/cli/commands.js";
import { storedEnv } from "./src/cli/store.js";
import { configure } from "./src/config.js";
import { startServer } from "./src/server.js";

/** --name value, --name=value and --switch; words that are not flags are kept, space-separated, in "_". */
export function parseFlags(args: string[]): Flags {
    const flags: Flags = {};
    const words: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i] ?? "";
        if (!arg.startsWith("--")) {
            if (arg.trim()) words.push(arg.trim());
            continue;
        }
        const [key = "", inline] = arg.slice(2).split("=", 2);
        const next = args[i + 1];
        if (inline !== undefined) flags[key] = inline;
        else if (["serial", "username", "sandbox", "apps", "companies"].includes(key) && next !== undefined && !next.startsWith("--")) {
            flags[key] = next;
            i += 1;
        } else flags[key] = true;
    }
    if (words.length) flags["_"] = words.join(" ");
    return flags;
}

async function main(): Promise<number> {
    const [command = "help", ...rest] = process.argv.slice(2);
    const flags = parseFlags(rest);
    switch (command) {
        case "mcp":
            configure(storedEnv());
            await startServer();
            return -1; // keep running until the host closes stdin
        case "setup":
            return setup(flags);
        case "login":
            return login(flags);
        case "companies":
            return companiesCommand(flags);
        case "connect":
            return connect(flags);
        case "doctor":
            return doctor(flags);
        case "update":
            return update(flags);
        case "plugin":
            return plugin(flags);
        case "uninstall":
            return uninstall(flags);
        case "version":
        case "--version":
        case "-v":
            return version();
        default:
            return help();
    }
}

main().then(
    (code) => {
        if (code >= 0) process.exit(code);
    },
    (error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    },
);
