// Builds dist/koble.plugin: the EBMS skills as a plugin to upload to a Claude account (Settings →
// Customize → Plugins), so they are `/` commands in Claude Desktop's chat as well as Claude Code.
// A .plugin file is a zip of the plugin folder, with .claude-plugin/plugin.json at its root.
// Usage: node scripts/build-plugin.mjs   (needs the `zip` command)
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const stage = join(dist, "plugin-stage");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, ".claude-plugin"), { recursive: true });

// Only the EBMS procedures: koble-setup runs commands on the computer, which a chat cannot do.
const skills = readdirSync(join(root, "skills")).filter((name) => name.startsWith("ebms-")).sort();
for (const skill of skills) cpSync(join(root, "skills", skill), join(stage, "skills", skill), { recursive: true });

writeFileSync(
    join(stage, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(
        {
            name: "koble",
            version,
            description: "EBMS (Koble Systems ERP) procedures for sales orders, purchase orders, receiving, products, tasks and MRP. They need the koble program running on this computer: https://github.com/koblesystems/koble-mcp",
            author: { name: "Koble Systems", url: "https://koblesystems.com" },
            homepage: "https://github.com/koblesystems/koble-mcp",
            license: "MIT",
            keywords: ["ebms", "koble", "erp", "mrp"],
        },
        null,
        2,
    )}\n`,
);
writeFileSync(
    join(stage, "README.md"),
    `# Koble\n\nThe EBMS procedures from [koble-mcp](https://github.com/koblesystems/koble-mcp) ${version}, as \`/\` commands:\n\n${skills.map((s) => `- \`/${s}\``).join("\n")}\n\nThey do their work through the koble-mcp tools, which the \`koble\` program provides on your computer. Install it first (see the link above); without it these skills can explain things but cannot reach EBMS.\n`,
);

const out = join(dist, "koble.plugin");
rmSync(out, { force: true });
execFileSync("zip", ["-r", "-q", "-X", out, ".", "-x", "*.DS_Store"], { cwd: stage, stdio: "inherit" });
console.log(`built dist/koble.plugin — ${skills.length} skills, version ${version}`);
