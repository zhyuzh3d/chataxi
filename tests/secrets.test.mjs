import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const window = { chataxi: {}, crypto: globalThis.crypto, URL, Blob, Uint8Array, setTimeout, clearTimeout, btoa, atob };
const context = vm.createContext({ window, URL, Blob, Uint8Array, FileReader: class {}, btoa, atob, setTimeout, clearTimeout });
for (const relative of ["app/core/namespace.js", "app/core/utils.js"]) vm.runInContext(fs.readFileSync(path.join(root, relative), "utf8"), context, { filename: relative });
const utils = window.chataxi.utils;

test("saved credentials keep useful ends while masking the middle", () => {
  assert.equal(utils.maskSecret("xai-demoCredentialOmega"), "xai-••••••mega");
  assert.equal(utils.maskSecret("Bearer demoHeaderAlphaOmega"), "Bearer demo••••••mega");
  assert.equal(utils.maskSecret("tiny"), "t••y");
  assert.equal(utils.maskSecret(""), "");
});

test("every saved custom header value is masked but remains available to explicit copy logic", () => {
  const entries = utils.maskedHeaderEntries(JSON.stringify({ Authorization: "Bearer demoHeaderAlphaOmega", "X-Client": "chataxi" }));
  assert.deepEqual(Array.from(entries, item => item.name), ["Authorization", "X-Client"]);
  assert.equal(entries[0].maskedValue, "Bearer demo••••••mega");
  assert.equal(entries[0].value, "Bearer demoHeaderAlphaOmega");
  assert.equal(entries[1].maskedValue, "ch••••••xi");
  assert.equal(utils.maskedHeaderEntries("not json").length, 0);
});
