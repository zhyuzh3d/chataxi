import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const window = { chataxi: {}, crypto: globalThis.crypto, setTimeout, clearTimeout };
const context = vm.createContext({ window, console, URL, Blob, Uint8Array, Uint32Array, btoa, atob, setTimeout, clearTimeout });
for (const relative of ["app/core/namespace.js", "app/core/utils.js", "app/components/ui.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, relative), "utf8"), context, { filename: relative });
}
const geometry = window.chataxi.components.cropGeometry;

test("avatar crop always covers the square and stays inside landscape images", () => {
  const value = geometry(1600, 900, 320, 0.2, 99999, -99999);
  assert.equal(value.zoom, 1);
  assert.ok(value.renderedWidth >= 320 && value.renderedHeight >= 320);
  assert.ok(value.sourceX >= 0 && value.sourceY >= 0);
  assert.ok(value.sourceX + value.sourceSize <= 1600);
  assert.ok(value.sourceY + value.sourceSize <= 900);
  assert.equal(value.sourceSize, 900);
});

test("avatar crop clamps zoom and offsets for portrait images", () => {
  const value = geometry(720, 1280, 360, 99, -99999, 99999);
  assert.equal(value.zoom, 4);
  assert.ok(value.renderedWidth >= 360 && value.renderedHeight >= 360);
  assert.ok(value.sourceX >= 0 && value.sourceY >= 0);
  assert.ok(value.sourceX + value.sourceSize <= 720);
  assert.ok(value.sourceY + value.sourceSize <= 1280);
  assert.equal(value.sourceSize, 180);
});
