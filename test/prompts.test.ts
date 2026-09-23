import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGuide } from "../src/guide.js";
import { PROMPTS, promptText, registerPrompts } from "../src/prompts.js";
import { readFileSync } from "node:fs";
import { VERSION } from "../src/version.js";

test("every prompt names a skill the server actually serves", () => {
    const skills = new Set(loadGuide().skills.map((s) => s.name));
    for (const p of PROMPTS) assert.ok(skills.has(p.skill), `${p.name} -> ${p.skill}`);
    assert.equal(new Set(PROMPTS.map((p) => p.name)).size, PROMPTS.length, "names are unique");
});

test("filled-in arguments are passed on; blank ones are left for the skill to ask", () => {
    const mrp = PROMPTS.find((p) => p.name === "mrp-plan")!;
    const full = promptText(mrp, { days: "60", scope: "Bike Parts Co only", company: "SBX" });
    assert.match(full, /Run MRP\. Time frame: 60\. Scope: Bike Parts Co only\. Company: SBX\./);
    assert.match(full, /ebms_guide tool with skill "ebms-mrp"/);
    assert.match(promptText(mrp, { days: " " }), /^Run MRP\.\n/);
});

test("registration hands the host an optional string argument per field", () => {
    const seen: Array<{ name: string; keys: string[]; text: string }> = [];
    registerPrompts((name, config, callback) => {
        const parsed = config.argsSchema.parse({}) as Record<string, string | undefined>;
        seen.push({ name, keys: Object.keys(config.argsSchema.shape), text: callback(parsed).messages[0]!.content.text });
    });
    assert.equal(seen.length, PROMPTS.length);
    assert.deepEqual(seen.find((s) => s.name === "mrp-plan")?.keys, ["days", "scope", "company"]);
});

test("the version the server reports is the package version", () => {
    assert.equal(VERSION, (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version);
});
