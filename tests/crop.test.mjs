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

test("Haminn avatar picker passes its object URL directly to the cropper and defers cleanup", async () => {
  let deletedId = "";
  window.chataxi.platform = { haminn: { available: () => true, api: () => ({ files: {
    pickImage: async () => ({ cancelled: false, logicalFileId: "picked-avatar", url: "https://local.haminn/files/picked-avatar", name: "portrait.jpg", mime: "image/jpeg" }),
    delete: async ({ logicalFileId }) => { deletedId = logicalFileId; return { deleted: true }; }
  } }) } };
  const picked = await window.chataxi.components.pickLocalImage();
  assert.equal(picked.url, "https://local.haminn/files/picked-avatar");
  assert.equal(picked.type, "image/jpeg");
  assert.equal(picked.name, "portrait.jpg");
  assert.equal(deletedId, "", "the source must remain available while the cropper decodes it");
  await picked.release();
  assert.equal(deletedId, "picked-avatar");
  await picked.release();
  assert.equal(deletedId, "picked-avatar", "cleanup must be idempotent");
});

test("cropper releases a managed Haminn file when image decoding fails", async () => {
  let releases = 0;
  context.Image = class { set src(_) { this.onerror(); } };
  await assert.rejects(window.chataxi.components.cropAvatar({
    url: "/__haminn/files/broken-avatar", type: "image/jpeg", size: 128,
    release: async () => { releases += 1; }
  }, async () => {}), /头像图片无法读取/);
  assert.equal(releases, 1);
});

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
