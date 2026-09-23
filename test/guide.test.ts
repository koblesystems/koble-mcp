import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGuide, skillSummary } from "../src/guide.js";
import { registerGuideTools } from "../src/tools/guide-tools.js";
import type { McpToolResult } from "../src/tools/types.js";

const guide = loadGuide();
const tools: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {};
registerGuideTools((name, definition, handler) => { tools[name] = (args) => handler(definition.inputSchema.parse(args) as never); }, guide);
const call = async (args: Record<string, unknown>) => { const r = await tools["ebms_guide"]!(args); return { text: (r.content[0] as { text: string }).text, isError: r.isError === true }; };

test("every skill folder is served, by the name in its front matter", () => {
    const names = guide.skills.map((s) => s.name);
    for (const name of ["ebms-api", "ebms-sales-orders", "ebms-purchase-orders", "ebms-products", "ebms-tasks", "ebms-mrp", "ebms-mrp-purchase-orders", "ebms-mrp-batches"]) assert.ok(names.includes(name), name);
    assert.ok(guide.skills.every((s) => s.description.length > 50), "every skill has a description");
    assert.ok(!names.includes("koble-setup"), "the installer skill is for Claude Code, not served to every host");
    assert.match(skillSummary(guide), /ebms-tasks: Create and manage/);
});

test("every references/… file a skill mentions exists, so the guide never sends Claude to a dead end", () => {
    for (const skill of guide.skills) {
        const texts = [guide.read(`${skill.name}/SKILL.md`) ?? "", ...skill.files.map((f) => guide.read(f) ?? "")];
        for (const text of texts) {
            for (const [, ref] of text.matchAll(/`(references\/[A-Za-z0-9_./-]+\.md)`/g)) {
                const inThisSkill = `${skill.name}/${ref}`;
                const inApi = `ebms-api/${ref}`;
                assert.ok(guide.read(inThisSkill) !== undefined || guide.read(inApi) !== undefined, `${skill.name} mentions ${ref}`);
            }
        }
    }
});

test("the tool lists, returns a skill with its files, and returns one file", async () => {
    const list = JSON.parse((await call({})).text) as { skills: Array<{ name: string }> };
    assert.equal(list.skills.length, guide.skills.length);
    const skill = await call({ skill: "ebms-purchase-orders" });
    assert.match(skill.text, /# EBMS purchase orders/);
    assert.match(skill.text, /ebms-purchase-orders\/references\/receive\.md/);
    const file = await call({ file: "ebms-purchase-orders/references/receive.md" });
    assert.match(file.text, /# Record what arrived/);
});

test("only files that were loaded can be read: no path reaches the disk", async () => {
    for (const file of ["../package.json", "ebms-api/../../package.json", "/etc/passwd", "ebms-api/SKILL", "..\\index.ts"]) {
        const r = await call({ file });
        assert.equal(r.isError, true, file);
    }
    assert.equal((await call({ skill: "nope" })).isError, true);
});
