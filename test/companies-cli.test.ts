import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { companiesCommand, login, setPasswordInput, setup } from "../src/cli/commands.js";
import { accountFor, enabledCompanies, loadPassword, loginAccount, loginFor, readConfig, savePassword, storedEnv, writeConfig } from "../src/cli/store.js";
import { resetAuth } from "../src/ebms/client.js";
import { configure, connectionFor, setDiscoveredCompanies } from "../src/config.js";

// Settings and passwords go to a scratch folder and a private file, never the real keychain;
// a new folder for every test, so no test sees another's passwords.
process.env["KOBLE_CREDENTIAL_STORE"] = "file";
const fresh = (): void => { process.env["KOBLE_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "koble-companies-")); };
const SERIAL = "000000000000000";

// The serial reaches three companies; each accepts one username and password of its own.
const PASSWORDS: Record<string, [string, string]> = { SBX: ["deke", "sbx-pass"], LIVE: ["buyer", "live-pass"], ROV: ["deke", "rov-pass"] };
const signIns: string[] = [];
const passwordsSent: string[] = [];
const requests: string[] = [];
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    requests.push(u);
    if (u.includes("ebmscompanylist")) {
        return new Response(JSON.stringify([{ Id: "SBX", Name: "Sample Coffee Co" }, { Id: "LIVE", Name: "Acme Hardware" }, { Id: "ROV", Name: "Rova Bicycles" }]), { status: 200 });
    }
    const company = /MyEbms\/([^/]+)\//.exec(u)?.[1] ?? "";
    if (u.endsWith("/Token")) {
        const { Username, Password } = JSON.parse(String(init?.body)) as { Username: string; Password: string };
        signIns.push(`${company}:${Username}`);
        passwordsSent.push(Password);
        const ok = PASSWORDS[company]?.[0] === Username && PASSWORDS[company]?.[1] === Password;
        return ok ? new Response(JSON.stringify({ AccessToken: "t" }), { status: 200 }) : new Response(JSON.stringify({ Messages: [{ TextBriefDescription: "Invalid user name or password" }] }), { status: 401 });
    }
    return new Response(JSON.stringify({ value: [] }), { status: 200 });
}) as typeof fetch;
const piped = (...lines: string[]) => { setPasswordInput((async function* () { yield lines.join("\n") + "\n"; })()); resetAuth(); };

const quiet = async <T>(work: () => Promise<T>): Promise<T> => {
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
        return await work();
    } finally {
        process.stdout.write = write;
    }
};

test("each company keeps its own login, and the server gets per-company credentials", () => {
    fresh();
    writeConfig({ serial: SERIAL, companies: "SBX,LIVE", sandbox: "SBX", logins: { SBX: { username: "deke" }, LIVE: { username: "buyer" } } });
    savePassword(loginAccount(SERIAL, "SBX", "deke"), "sbx-pass");
    savePassword(loginAccount(SERIAL, "LIVE", "buyer"), "live-pass");
    const env = storedEnv({});
    assert.equal(env["EBMS_COMPANIES"], "SBX,LIVE");
    assert.deepEqual([env["EBMS_SBX_USERNAME"], env["EBMS_SBX_PASSWORD"], env["EBMS_LIVE_USERNAME"], env["EBMS_LIVE_PASSWORD"]], ["deke", "sbx-pass", "buyer", "live-pass"]);
    assert.equal(env["EBMS_USERNAME"], undefined, "no shared login on a new install");
    // What the server makes of it: each company signs in with its own.
    configure(env);
    setDiscoveredCompanies([{ id: "SBX", name: "Sample Coffee Co", version: "" }, { id: "LIVE", name: "Acme Hardware", version: "" }]);
    assert.equal(connectionFor("LIVE").username, "buyer");
    assert.equal(connectionFor("SBX").password, "sbx-pass");
    assert.throws(() => connectionFor("ROV"), /not available/, "a company that was not enabled does not exist for the agent");
});

test("an older install with one shared login keeps working", () => {
    fresh();
    writeConfig({ serial: SERIAL, username: "old" });
    savePassword(`${SERIAL}:old`, "old-pass");
    assert.equal(enabledCompanies(readConfig()!), null, "nothing chosen: every company");
    assert.deepEqual(loginFor(readConfig()!, "LIVE"), { username: "old", account: `${SERIAL}:old` });
    const env = storedEnv({});
    assert.deepEqual([env["EBMS_USERNAME"], env["EBMS_PASSWORD"], env["EBMS_COMPANIES"]], ["old", "old-pass", undefined]);
});

test("companies: add enables without a password until `koble login`; remove disables and forgets the password", async () => {
    fresh();
    writeConfig({ serial: SERIAL, companies: "SBX,LIVE", sandbox: "SBX", logins: { SBX: { username: "deke" }, LIVE: { username: "buyer" } } });
    savePassword(loginAccount(SERIAL, "LIVE", "buyer"), "live-pass");
    // Not a terminal here, so add only enables and says how to sign in.
    assert.equal(await quiet(() => companiesCommand({ _: "add\nRova Bicycles" })), 0, "a quoted name with a space is one company");
    assert.deepEqual(enabledCompanies(readConfig()!), ["SBX", "LIVE", "ROV"]);
    assert.equal(readConfig()?.logins?.["ROV"], undefined, "no login until the user types the password");

    assert.equal(await quiet(() => companiesCommand({ _: "remove\nLIVE" })), 0);
    assert.deepEqual(enabledCompanies(readConfig()!), ["SBX", "ROV"]);
    assert.equal(readConfig()?.logins?.["LIVE"], undefined);
    assert.equal(loadPassword(loginAccount(SERIAL, "LIVE", "buyer")), null, "its password is gone from the store");

    assert.equal(await quiet(() => companiesCommand({ _: "remove\nSBX" })), 1, "the test company cannot be removed");
    assert.equal(await quiet(() => companiesCommand({ _: "remove\nNOPE" })), 1, "an unknown company is refused");
    assert.deepEqual(enabledCompanies(readConfig()!), ["SBX", "ROV"], "refusals change nothing");
});

test("login refuses a company that is not enabled", async () => {
    fresh();
    writeConfig({ serial: SERIAL, companies: "SBX,ROV", sandbox: "SBX" });
    assert.equal(await quiet(() => login({ _: "LIVE" })), 1);
    assert.equal(readConfig()?.logins, undefined, "nothing was stored");
});

test("login with piped passwords: one line per company, the saved username, each stored under its company", async () => {
    fresh();
    writeConfig({ serial: SERIAL, companies: "SBX,ROV", sandbox: "SBX", logins: { SBX: { username: "deke" }, ROV: { username: "deke" } } });
    piped("sbx-pass", "rov-pass");
    signIns.length = 0;
    assert.equal(await quiet(() => login({ "password-stdin": true })), 0);
    assert.deepEqual(signIns, ["SBX:deke", "ROV:deke"], "no username prompt: the saved one is used");
    assert.equal(loadPassword(loginAccount(SERIAL, "ROV", "deke"))?.password, "rov-pass");
    piped("wrong");
    assert.equal(await quiet(() => login({ _: "SBX", "password-stdin": true })), 1);
    assert.equal(loadPassword(loginAccount(SERIAL, "SBX", "deke"))?.password, "sbx-pass", "a failed sign-in keeps the stored password");
});

test("an upgraded install keeps every company working until each has a password of its own", async () => {
    fresh();
    // Before: one shared login for everything.
    writeConfig({ serial: SERIAL, username: "deke" });
    savePassword(accountFor({ serial: SERIAL, username: "deke" }), "sbx-pass");
    // The skill's upgrade: companies named, usernames saved, passwords left to the user.
    assert.equal(await quiet(() => setup({ serial: SERIAL, companies: "SBX,ROV", sandbox: "SBX", username: "deke", "skip-password": true, "no-connect": true, yes: true, brief: true })) >= 0, true);
    assert.deepEqual(enabledCompanies(readConfig()!), ["SBX", "ROV"]);
    piped("rov-pass");
    assert.equal(await quiet(() => login({ _: "ROV", "password-stdin": true })), 0);
    // ROV has its own now; SBX still runs on the shared login, which must not have been retired.
    assert.equal(readConfig()?.username, "deke");
    let env = storedEnv({});
    assert.deepEqual([env["EBMS_ROV_PASSWORD"], env["EBMS_SBX_PASSWORD"], env["EBMS_PASSWORD"]], ["rov-pass", undefined, "sbx-pass"]);
    configure(env);
    setDiscoveredCompanies([{ id: "SBX", name: "", version: "" }, { id: "ROV", name: "", version: "" }]);
    assert.equal(connectionFor("SBX").password, "sbx-pass");
    // Once SBX has its own too, the shared login is forgotten.
    piped("sbx-pass");
    assert.equal(await quiet(() => login({ _: "SBX", "password-stdin": true })), 0);
    assert.equal(readConfig()?.username, undefined);
    assert.equal(loadPassword(accountFor({ serial: SERIAL, username: "deke" })), null);
    env = storedEnv({});
    assert.deepEqual([env["EBMS_SBX_PASSWORD"], env["EBMS_ROV_PASSWORD"]], ["sbx-pass", "rov-pass"]);
});

test("a first setup without a terminal must name its companies", async () => {
    fresh();
    writeConfig({ serial: "999999999999999" });
    assert.equal(await quiet(() => setup({ serial: SERIAL, sandbox: "none", "skip-password": true, "no-connect": true, yes: true })), 1);
});

test("setup refuses a serial number that would move the host, before any request is made", async () => {
    fresh();
    requests.length = 0;
    for (const serial of ["evil.example/x?", "evil.example#", "user@evil.example", "a.b"]) {
        assert.equal(await quiet(() => setup({ serial, companies: "SBX", sandbox: "none", "skip-password": true, "no-connect": true, yes: true })), 1, serial);
        assert.equal(await quiet(() => companiesCommand({ serial })), 1, serial);
    }
    assert.deepEqual(requests, [], "nothing was sent anywhere");
    assert.equal(readConfig(), null, "nothing was saved");
});

test("a piped password keeps its spaces; only the line ending goes", async () => {
    fresh();
    writeConfig({ serial: SERIAL, companies: "SBX", sandbox: "SBX", logins: { SBX: { username: "deke" } } });
    setPasswordInput((async function* () { yield "  spaced pass \r\n"; })());
    resetAuth();
    passwordsSent.length = 0;
    await quiet(() => login({ "password-stdin": true }));
    assert.deepEqual(passwordsSent, ["  spaced pass "]);
});
