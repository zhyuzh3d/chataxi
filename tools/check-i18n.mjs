#!/usr/bin/env node
// 审计用工具：扫描运行时源码里的中文界面文案，报告哪些还没有英文对照。
//
// 为什么需要它：英文界面走的是「渲染后逐节点翻译」，命中不到就原样保留中文，
// 不会报错，只会静默漏译。这个脚本在源码层面兜底检查。
//
// 判定单位为「渲染后可能成为文本节点/属性值的一段文字」：
//   1. 按 HTML 标签切分字符串字面量，取出标签之间的文字；
//   2. 单独取出 aria-label / title / placeholder / alt 的值；
//   3. 去掉字符串拼接的边界（' + expr + '），剩下的片段允许是
//      某条字典键或某条正则规则原文的子串 —— 这正是插值句的形态。
//
// 用法：
//   node tools/check-i18n.mjs           只报告
//   node tools/check-i18n.mjs --check   有未覆盖文案时退出码 1
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

// 生成产物与字典自身不需要审计：前者是双语数据，后者就是英文对照表。
const SKIP = new Set(["app/data/i18n-en.js", "app/data/role-templates.js"]);

// 不是界面固定文案、因此不需要英文对照的中文。
const CONTENT = [
  /^[\u4e00-\u9fff]$/,                                        // 单个汉字：分类标签另有 _En 字段
  /^(年|月|日|时|分|秒|字|条|个|岁|位|种|张|我|你|他|她|它)$/,
  /^[「」【】（）《》、，。；：！？·…—\s]+$/,
  /^\d/,
  /[<>"'={};]/,                                              // 提取时残留的标签/属性碎片
  /^(?:https?|ws|wss):/
];

// 长句几乎都直接交给模型（提示词、场景指令），不算界面文案。
// 界面上的说明文字远达不到这个长度，所以用长度做一次粗筛，交给人复核。
const PROMPT_LENGTH = 60;

// 这两个模块主要在拼装发给模型的提示词，其中的中文不会出现在 DOM 里，
// 因此归入复核区，不参与门禁。同文件里的报错文案已单独覆盖。
const PROMPT_FILES = new Set(["app/services/context.js", "app/services/llm.js", "app/services/draw-prompt.js"]);

const ATTRIBUTE = /(?:aria-label|title|placeholder|alt)="([^"]*)(?:"|$)/g;

// 拼装句里被字符串拼接隔开的位置用这个占位符标记，判定时再换成几种样例试一次。
const FILL = "\u0000";
const FILL_SAMPLES = ["5", "X", "一位角色", ""];
// 两个字面量之间只隔着 + 和表达式（无 , ;）时才认为属于同一句拼装。
const JOIN = /^[^;,]*\+[^;,]*$/;

function walk(dir, result = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, result);
    else if (entry.name.endsWith(".js")) result.push(full);
  }
  return result;
}

// 逐字符扫描 JS 源码，取出所有字符串字面量（含模板字符串）。
function literals(source) {
  const found = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index], next = source[index + 1];
    if (char === "/" && next === "/") { const end = source.indexOf("\n", index); if (end < 0) break; index = end; continue; }
    if (char === "/" && next === "*") { const end = source.indexOf("*/", index); if (end < 0) break; index = end + 2; continue; }
    if (char === '"' || char === "'" || char === "`") {
      let value = "", cursor = index + 1, closed = false;
      while (cursor < source.length) {
        const current = source[cursor];
        if (current === "\\") {
          const escaped = source[cursor + 1] || "";
          value += escaped === "n" || escaped === "t" ? " " : escaped;
          cursor += 2; continue;
        }
        if (current === char) { closed = true; cursor += 1; break; }
        if (current === "\n" && char !== "`") break;
        value += current; cursor += 1;
      }
      if (closed) found.push({ value, start: index, end: cursor });
      index = cursor; continue;
    }
    index += 1;
  }
  return found;
}

// app.i18n.pick(中文, 英文) 的两个分支都由代码显式给出，不需要再查字典。
// 找出所有 pick(...) 调用的字符区间，抽取字面量时跳过它们。
function pickRanges(source) {
  const ranges = [];
  for (const match of source.matchAll(/\bpick\(/g)) {
    let depth = 0, cursor = match.index + match[0].length - 1;
    for (; cursor < source.length; cursor += 1) {
      const char = source[cursor];
      if (char === '"' || char === "'" || char === "`") {
        let quote = char; cursor += 1;
        while (cursor < source.length && source[cursor] !== quote) cursor += source[cursor] === "\\" ? 2 : 1;
      } else if (char === "(") depth += 1;
      else if (char === ")") { depth -= 1; if (!depth) break; }
    }
    ranges.push([match.index, cursor + 1]);
  }
  return ranges;
}

function sourceFragments(source) {
  const ranges = pickRanges(source);
  return literals(source)
    .filter(literal => !ranges.some(([from, to]) => literal.start >= from && literal.start < to))
    .flatMap(literal => fragments(literal.value));
}

// 把一段源码字符串拆成「渲染后可能独立成节点」的片段。
function fragments(value) {
  const result = [];
  for (const match of value.matchAll(ATTRIBUTE)) {
    result.push(match[1]);
    value = value.slice(0, match.index) + " " + value.slice(match.index + match[0].length);
  }
  // 同一字面量内部不存在字符串拼接（拼接会拆成多个字面量），所以只按标签和换行切。
  for (const piece of value.replace(/<[^>]*>/g, "\n").split("\n")) result.push(piece);
  return result.map(piece => piece.trim()).filter(Boolean);
}

function loadDictionary() {
  const file = path.join(root, "app/data/i18n-en.js");
  const context = vm.createContext({ window: { chataxi: { data: {} } } });
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: "app/data/i18n-en.js" });
  const data = context.window.chataxi.data, table = data.i18nEn || {};
  const patterns = (data.i18nEnPatterns || []).map(entry => entry[0]);
  const text = fs.readFileSync(file, "utf8");
  const block = text.slice(text.indexOf("app.data.i18nEn = {"), text.indexOf("app.data.i18nEnPatterns"));
  const keys = [...block.matchAll(/^\s{4}"((?:[^"\\]|\\.)*)":/gm)].map(match => match[1].replace(/\\(.)/g, "$1"));
  // 插值句的静态骨架：去掉正则语法后剩下的普通文字。
  const skeletons = patterns.map(pattern => String(pattern.source || pattern).replace(/[\^$\\]/g, "").replace(/\([^)]*\)/g, "").replace(/\[[^\]]*\]/g, ""));
  return { table, patterns, keys, skeletons: skeletons.filter(entry => /[\u4e00-\u9fff]/.test(entry)) };
}

const hasChinese = value => /[\u4e00-\u9fff]/.test(value);

function audit() {
  const { table, patterns, keys, skeletons } = loadDictionary();
  const duplicates = [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];
  const ruleSources = patterns.map(pattern => String(pattern.source || pattern));
  const duplicateRules = [...new Set(ruleSources.filter((source, index) => ruleSources.indexOf(source) !== index))];
  // 精确命中或命中规则才算真覆盖。骨架（规则里去掉空位后剩下的文字）不参与判定：
  // 用 includes 判骨架会放过「自动」这类会独立成节点的短词条 —— 它既是主题选择器的选项，
  // 又是「自动选角前请…」长骨架的子串。骨架只作为人工复核线索。
  const covered = text => Object.prototype.hasOwnProperty.call(table, text)
    || patterns.some(pattern => pattern.test(text));
  // 只是某条字典键或规则骨架的一部分：多半是拼装句被拆出来的残片，也可能碰巧是漏译，交人工确认。
  const partial = text => keys.some(key => key !== text && key.includes(text))
    || skeletons.some(entry => entry.includes(text));
  const missing = [], review = [], partials = [];
  let scanned = 0;

  const targets = walk(path.join(root, "app")).map(file => path.relative(root, file)).sort()
    .filter(file => !SKIP.has(file)).concat(["index.html"]);
  for (const file of targets) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const candidates = file.endsWith(".html")
      ? [...source.matchAll(/>([^<>]+)</g)].map(match => match[1]).concat([...source.matchAll(ATTRIBUTE)].map(match => match[1]))
      : sourceFragments(source);
    for (const value of candidates) {
      if (!hasChinese(value)) continue;
      scanned += 1;
      const text = value.trim();
      if (!text || !hasChinese(text)) continue;
      // 拼装句的空位按几种样例各试一次，任意一种能被字典或规则接住就算覆盖。
      if ([text, ...FILL_SAMPLES.map(sample => text.split(FILL).join(sample))].some(covered)) continue;
      if (CONTENT.some(pattern => pattern.test(text))) continue;
      const display = text.split(FILL).join("…");
      const bucket = display.length > PROMPT_LENGTH || PROMPT_FILES.has(file)
        ? review
        : partial(text) ? partials : missing;
      bucket.push([file, display]);
    }
  }

  const group = entries => {
    const byFile = new Map();
    for (const [file, text] of entries) { if (!byFile.has(file)) byFile.set(file, new Set()); byFile.get(file).add(text); }
    return [...byFile.entries()].sort().map(([file, values]) => [file, [...values].sort()]);
  };
  const section = (title, entries, detail = true) => {
    const total = entries.reduce((sum, [, values]) => sum + values.length, 0);
    if (!total) return 0;
    process.stdout.write(`\n${title}: ${total}\n`);
    for (const [file, values] of entries) {
      process.stdout.write(`\n${file} (${values.length})\n`);
      if (detail) for (const text of values) process.stdout.write(`  - ${text}\n`);
    }
    return total;
  };

  process.stdout.write(`dictionary keys        : ${keys.length} (${new Set(keys).size} unique)\n`);
  process.stdout.write(`pattern rules          : ${patterns.length}\n`);
  process.stdout.write(`Chinese fragments seen : ${scanned}\n`);
  if (duplicates.length) process.stdout.write(`\nDUPLICATE dictionary keys (the later one silently wins):\n${duplicates.map(key => `  - ${key}`).join("\n")}\n`);
  if (duplicateRules.length) process.stdout.write(`\nDUPLICATE pattern rules (the first one wins, the rest are dead weight):\n${duplicateRules.map(source => `  - /${source}/`).join("\n")}\n`);

  const uncovered = group(missing), ambiguous = group(partials), longform = group(review);
  section("UNCOVERED UI fragments", uncovered);
  section("FRAGMENTS TO CONFIRM (substring of a key or rule skeleton — either a concatenation piece or a real miss)", ambiguous);
  section("LONG-FORM strings to review (prompt text)", longform, false);
  if (!uncovered.length && !ambiguous.length && !duplicates.length && !duplicateRules.length) process.stdout.write("\nEvery short Chinese UI fragment resolves to English.\n");
  return duplicates.length || duplicateRules.length || uncovered.length ? 1 : 0;
}

const status = audit();
process.exit(check ? status : 0);
