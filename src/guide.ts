/**
 * The skills, served by the server itself, so an MCP host that cannot install skills (Claude
 * Desktop keeps them in the user's account, uploaded by hand) still gets every procedure.
 *
 * The files are loaded once, into memory, from the `skills/` folder beside the server — or, in the
 * single-file build, from the assets embedded in it. A request is looked up by exact name in that
 * map, so no path a model sends ever reaches the filesystem.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillInfo {
    /** The skill's folder, which is also its name. */
    name: string;
    description: string;
    /** Other files in the skill, relative to the skills folder: `ebms-api/references/odata-quirks.md`. */
    files: string[];
}

export interface Guide {
    skills: SkillInfo[];
    read(path: string): string | undefined;
}

/** `skills/` in the single-file build: an index asset lists the files, each stored under its path. */
function fromEmbedded(): Map<string, string> | null {
    try {
        const sea = createRequire(import.meta.url)("node:sea") as { isSea(): boolean; getAsset(key: string, encoding: string): string };
        if (!sea.isSea()) return null;
        const index = JSON.parse(sea.getAsset("skills/index.json", "utf8")) as string[];
        return new Map(index.map((path) => [path, sea.getAsset(`skills/${path}`, "utf8")]));
    } catch {
        return null;
    }
}

function fromFolder(root: string): Map<string, string> {
    const files = new Map<string, string>();
    const walk = (dir: string): void => {
        for (const name of readdirSync(dir).sort()) {
            const full = join(dir, name);
            if (statSync(full).isDirectory()) walk(full);
            else if (name.endsWith(".md")) files.set(relative(root, full).split(sep).join("/"), readFileSync(full, "utf8"));
        }
    };
    walk(root);
    return files;
}

/** The front matter's name and description, which is all a skill says about when to use it. */
function frontMatter(text: string): { name: string; description: string } | null {
    const block = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, "\n"))?.[1];
    if (!block) return null;
    const field = (key: string): string => new RegExp(`^${key}:\\s*(.*)$`, "m").exec(block)?.[1]?.trim() ?? "";
    const name = field("name");
    return name ? { name, description: field("description") } : null;
}

export function loadGuide(files: Map<string, string> = fromEmbedded() ?? fromFolder(fileURLToPath(new URL("../skills/", import.meta.url)))): Guide {
    const skills: SkillInfo[] = [];
    for (const [path, text] of files) {
        const [folder, file] = path.split("/");
        if (file !== "SKILL.md" || path.split("/").length !== 2 || !folder) continue;
        const meta = frontMatter(text);
        if (!meta || meta.name !== folder) continue;
        const others = [...files.keys()].filter((other) => other.startsWith(`${folder}/`) && other !== path);
        skills.push({ name: folder, description: meta.description, files: others });
    }
    skills.sort((a, b) => a.name.localeCompare(b.name));
    return { skills, read: (path) => files.get(path) };
}

/** One line per skill for the server's instructions: the part of the description before "Use …". */
export function skillSummary(guide: Guide): string {
    return guide.skills
        .map((skill) => {
            const what = skill.description.split(/\.\s+Use\b/)[0] ?? skill.description;
            return `${skill.name}: ${what.length > 170 ? `${what.slice(0, 167)}…` : what}`;
        })
        .join("; ");
}
