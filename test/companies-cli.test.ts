import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { companiesCommand, login } from "../src/cli/commands.js";
import { enabledCompanies, loadPassword, loginAccount, loginFor, readConfig, savePassword, storedEnv, writeConfig } from "../src/cli/store.js";
import { configure, connectionFor, setDiscoveredCompanies } from "../src/config.js";

// Settings and passwords go to a scratch folder and a private file, never the real keychain.
process.env["KOBLE_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "koble-companies-"));
process.env["KOBLE_CREDENTIAL_STORE"] = "file";
const SERIAL = "000000000000000";

// The serial reaches three companies.
globalThis.fetch = (async (url: string | URL) => {
    if (String(url).includes("ebmscompanylist")) {
        return new Response(JSON.stringify([{ Id: "SBX", Name: "Sample Coffee Co" }, { Id: "LIVE", Name: "Acme Hardware" }, { Id: "ROV", Name: "Rova Bicycles" }]), { status: 200 });
    }
    return new Response("{}", { status: 404 });
}) as typeof fetch;

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
    writeConfig({ serial: SERIAL, username: "old" });
    savePassword(`${SERIAL}:old`, "old-pass");
    assert.equal(enabledCompanies(readConfig()!), null, "nothing chosen: every company");
    assert.deepEqual(loginFor(readConfig()!, "LIVE"), { username: "old", account: `${SERIAL}:old` });
    const env = storedEnv({});
    assert.deepEqual([env["EBMS_USERNAME"], env["EBMS_PASSWORD"], env["EBMS_COMPANIES"]], ["old", "old-pass", undefined]);
});

test("companies: add enables without a password until `koble login`; remove disables and forgets the password", async () => {
    writeConfig({ serial: SERIAL, companies: "SBX,LIVE", sandbox: "SBX", logins: { SBX: { username: "deke" }, LIVE: { username: "buyer" } } });
    savePassword(loginAccount(SERIAL, "LIVE", "buyer"), "live-pass");
    // Not a terminal here, so add only enables and says how to sign in.
    assert.equal(await quiet(() => companiesCommand({ _: "add rova bicycles" })), 1, "a name with a space is two words");
    assert.equal(await quiet(() => companiesCommand({ _: "add ROV" })), 0);
    assert.deepEqual(enabledCompanies(readConfig()!), ["SBX", "LIVE", "ROV"]);
    assert.equal(readConfig()?.logins?.["ROV"], undefined, "no login until the user types the password");

    assert.equal(await quiet(() => companiesCommand({ _: "remove LIVE" })), 0);
    assert.deepEqual(enabledCompanies(readConfig()!), ["SBX", "ROV"]);
    assert.equal(readConfig()?.logins?.["LIVE"], undefined);
    assert.equal(loadPassword(loginAccount(SERIAL, "LIVE", "buyer")), null, "its password is gone from the store");

    assert.equal(await quiet(() => companiesCommand({ _: "remove SBX" })), 1, "the test company cannot be removed");
    assert.equal(await quiet(() => companiesCommand({ _: "remove NOPE" })), 1, "an unknown company is refused");
    assert.deepEqual(enabledCompanies(readConfig()!), ["SBX", "ROV"], "refusals change nothing");
});

test("login refuses a company that is not enabled, and --password-stdin needs exactly one company", async () => {
    writeConfig({ serial: SERIAL, companies: "SBX,ROV", sandbox: "SBX" });
    assert.equal(await quiet(() => login({ _: "LIVE" })), 1);
    assert.equal(await quiet(() => login({ "password-stdin": true })), 1);
    assert.equal(readConfig()?.logins, undefined, "nothing was stored");
});
