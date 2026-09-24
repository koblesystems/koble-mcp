/**
 * `koble` — the command people install. `koble setup` once; after that Claude starts `koble mcp`.
 */
import { connect, doctor, help, login, setup, uninstall, update, version, type Flags } from "./src/cli/commands.js";
import { storedEnv } from "./src/cli/store.js";
import { configure } from "./src/config.js";
import { startServer } from "./src/server.js";

function parseFlags(args: string[]): Flags {
    const flags: Flags = {};
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i] ?? "";
        if (!arg.startsWith("--")) continue;
        const [key = "", inline] = arg.slice(2).split("=", 2);
        const next = args[i + 1];
        if (inline !== undefined) flags[key] = inline;
        else if (["serial", "username", "sandbox", "apps"].includes(key) && next !== undefined && !next.startsWith("--")) {
            flags[key] = next;
            i += 1;
        } else flags[key] = true;
    }
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
        case "connect":
            return connect(flags);
        case "doctor":
            return doctor(flags);
        case "update":
            return update(flags);
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
