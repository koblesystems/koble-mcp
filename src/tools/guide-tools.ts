import { z } from "zod/v4";
import type { Guide } from "../guide.js";
import { errorResult, jsonResult, type ToolRegistrar } from "./types.js";

export function registerGuideTools(register: ToolRegistrar, guide: Guide): void {
    register(
        "ebms_guide",
        {
            description: [
                "The procedures for working with EBMS through this server: how to build and change sales orders and purchase orders, receive stock, manage products and tasks, and run MRP.",
                "Call it before any task beyond a single read, unless the matching skill is already loaded in this app.",
                "With no arguments it lists the skills; with skill it returns that skill; with file it returns one of the skill's reference files.",
                "Read-only.",
            ].join(" "),
            inputSchema: z.object({
                skill: z.string().optional().describe("A skill name from the list, e.g. ebms-purchase-orders."),
                file: z.string().optional().describe("A file a skill refers to, as listed, e.g. ebms-purchase-orders/references/receive.md."),
            }),
        },
        async (args) => {
            try {
                const how = "Where a skill says to load another skill, call ebms_guide with skill set to its name. Where it says to open references/x.md, call ebms_guide with file set to '<skill>/references/x.md'.";
                if (args.file !== undefined) {
                    const text = guide.read(args.file);
                    if (text === undefined) throw new Error(`No file ${args.file}. Files are listed by ebms_guide with the skill's name.`);
                    return { content: [{ type: "text", text }] };
                }
                if (args.skill !== undefined) {
                    const skill = guide.skills.find((s) => s.name === args.skill);
                    if (!skill) throw new Error(`No skill ${args.skill}. Skills: ${guide.skills.map((s) => s.name).join(", ")}.`);
                    const text = guide.read(`${skill.name}/SKILL.md`) ?? "";
                    const files = skill.files.length > 0 ? `\n\n---\nFiles in this skill: ${skill.files.join(", ")}.` : "";
                    return { content: [{ type: "text", text: `${how}\n\n${text}${files}` }] };
                }
                return jsonResult({ skills: guide.skills.map(({ name, description }) => ({ name, description })), next: `Call ebms_guide with skill set to the one that matches the request. ${how}` });
            } catch (error) {
                return errorResult(error);
            }
        },
    );
}
