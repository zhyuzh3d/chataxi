#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "templates", "char");
const assetRoot = path.join(root, "app", "assets", "role-templates");
const catalogPath = path.join(root, "app", "data", "role-templates.js");

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(sourceRoot, name), "utf8"));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function imageSize(file) {
  const value = execFileSync("magick", ["identify", "-format", "%w %h", file], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
  return { width: value[0], height: value[1] };
}

const groups = [
  { key: "boys", category: "male", categoryLabel: "男", primary: "boys.json.new", fallback: "boys.json" },
  { key: "girls", category: "female", categoryLabel: "女", primary: "girls.json.new", fallback: "girls.json" },
  { key: "others", category: "other", categoryLabel: "其他", primary: "others.json" }
];

fs.mkdirSync(assetRoot, { recursive: true });
const byGroup = {};
const expectedAssets = new Set(["template-mosaic.webp"]);

for (const group of groups) {
  const primary = readJson(group.primary), fallback = group.fallback ? readJson(group.fallback) : null;
  assert.equal(primary.schemaVersion, 2, `${group.primary} must use schema 2`);
  if (fallback) assert.equal(fallback.schemaVersion, 1, `${group.fallback} must use schema 1`);
  const primaryItems = primary[group.key], fallbackItems = fallback && fallback[group.key];
  assert.equal(primaryItems.length, 9, `${group.primary} must contain nine templates`);
  if (fallbackItems) assert.equal(fallbackItems.length, primaryItems.length, `${group.fallback} must align with schema 2`);
  const spriteName = primary.sprite.image, spritePath = path.join(sourceRoot, spriteName);
  assert.ok(fs.existsSync(spritePath), `missing sprite ${spriteName}`);
  assert.equal(sha256(spritePath), primary.sprite.sha256, `${spriteName} differs from schema 2`);
  if (fallback) assert.equal(sha256(spritePath), fallback.sprite.sha256, `${spriteName} differs from schema 1`);
  assert.deepEqual(imageSize(spritePath), { width: primary.sprite.width, height: primary.sprite.height }, `${spriteName} dimensions differ`);
  byGroup[group.category] = primaryItems.map((item, index) => {
    const supplement = fallbackItems && fallbackItems[index], avatar = item["头像图片裁切数据"];
    if (supplement) {
      const fallbackAvatar = supplement.avatar;
      assert.deepEqual([avatar.sprite, avatar.row, avatar.column, avatar.x, avatar.y, avatar.width, avatar.height], [fallbackAvatar.sprite, fallbackAvatar.row, fallbackAvatar.column, fallbackAvatar.x, fallbackAvatar.y, fallbackAvatar.width, fallbackAvatar.height], `${group.key}[${index}] schema positions differ`);
    }
    const id = String(item.id || supplement && supplement.id || "").trim(), name = String(item["角色名称"] || "").trim(), systemPrompt = String(item["角色介绍"] || "").trim();
    const age = supplement ? Number(supplement["角色"] && supplement["角色"]["年龄"]) : null;
    const profession = String(item["角色类型"] || supplement && supplement["角色"] && supplement["角色"]["职业"] || "").trim();
    assert.match(id, /^[a-z0-9-]+$/, `${group.key}[${index}] lacks a stable id`);
    assert.ok(name && systemPrompt && profession, `${id} has incomplete gallery data`);
    if (group.category !== "other") assert.ok(age >= 18 && age <= 120, `${id} has an invalid adult age`);
    else assert.equal(age, null, `${id} must not fabricate an age for a non-human template`);
    assert.ok(systemPrompt.includes(name), `${id} prompt must identify the schema 2 name`);
    assert.equal(avatar.width, 418); assert.equal(avatar.height, 418);
    const assetName = `${id}.webp`, assetPath = path.join(assetRoot, assetName);
    expectedAssets.add(assetName);
    execFileSync("cwebp", ["-quiet", "-q", "84", "-crop", String(avatar.x), String(avatar.y), String(avatar.width), String(avatar.height), "-resize", "320", "320", spritePath, "-o", assetPath]);
    return { id, name, profession, age, category: group.category, categoryLabel: group.categoryLabel, systemPrompt, avatar: `./app/assets/role-templates/${assetName}` };
  });
}

const items = [...byGroup.male, ...byGroup.female, ...byGroup.other];
assert.equal(new Set(items.map(item => item.id)).size, 27, "template ids must be unique");
assert.equal(new Set(items.map(item => item.name)).size, 27, "template names must be unique");

const mixedPeople = [];
for (let index = 0; mixedPeople.length < 9; index += 1) mixedPeople.push(byGroup.female[index], byGroup.male[index]);
const mosaicItems = mixedPeople.slice(0, 9).map(item => path.join(root, item.avatar.replace(/^\.\//, "")));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chataxi-role-templates-"));
try {
  const rows = [0, 1, 2].map(row => {
    const output = path.join(temporaryRoot, `row-${row}.png`);
    execFileSync("magick", [...mosaicItems.slice(row * 3, row * 3 + 3), "+append", output]);
    return output;
  });
  execFileSync("magick", [...rows, "-append", "-resize", "192x192", "-quality", "82", path.join(assetRoot, "template-mosaic.webp")]);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

for (const name of fs.readdirSync(assetRoot)) {
  if (name.endsWith(".webp") && !expectedAssets.has(name)) fs.unlinkSync(path.join(assetRoot, name));
}

const payload = { schemaVersion: 1, sourceSchemaVersion: 2, count: items.length, items };
const source = `(function (app) {\n  "use strict";\n  app.data = app.data || {};\n  app.data.roleTemplates = ${JSON.stringify(payload, null, 2)};\n})(window.chataxi);\n`;
fs.writeFileSync(catalogPath, source, "utf8");
process.stdout.write(`synced ${items.length} role templates and ${expectedAssets.size} image assets\n`);
