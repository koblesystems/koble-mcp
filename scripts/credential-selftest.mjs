// Stores, reads and deletes a throwaway secret in this machine's real credential store.
// CI runs it on Windows, where the Credential Manager path cannot be tried any other way.
import assert from "node:assert/strict";
import { forgetPassword, loadPassword, savePassword } from "../src/cli/store.js";

const account = `selftest-${process.pid}:ci`;
const secret = 'pä ss"w\\ord;$(x)';
const where = savePassword(account, secret);
console.log(`stored in: ${where}`);
if (process.platform === "win32") assert.equal(where, "Windows Credential Manager");
assert.equal(loadPassword(account)?.password, secret, "read back exactly");
forgetPassword(account);
assert.equal(loadPassword(account), null, "deleted");
console.log("credential store round trip: ok");
