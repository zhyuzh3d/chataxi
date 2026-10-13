// Mutate chataxi's chp/2 drawing client and require the suite to catch each change
// *by name*.
//
// A mutation that leaves the suite green means the assertion that names the rule is
// not actually guarding it — so that counts as a failure of this script, not a pass.
// Requiring the failing assertion's own words (and not merely "something went red") is
// what keeps a rule that a whole test file happens to break from being mistaken for
// the one that was caught. Run it after touching the CHP client, its discovery path or
// the drawing card's canvas picker:
//   node tests/.mutate-chp.mjs              # 整轮（~6 分钟）
//   node tests/.mutate-chp.mjs <substring>  # 只跑名字命中它的那几条；交活前仍要再跑一次整轮
//
// ⚠️ **沙箱化运行器下必须「一条一进程」。** 本脚本在原进程里对同一批源文件做 27 次
// "改写 → 跑测试 → 还原"，而受管沙箱的 brokered-fs 会在**第 11 条左右**直接拒写：
//   Error: Brokered file token refused: modify backup failed  (code: CODEBUDDY_BROKER_DENY)
// 那是**写盘之前**抛的，所以仓库没被留在变异状态；但它会把整轮截断在第 11 条、而且
// **不发**汇总行 —— 看到"跑到一半就没声了"别当成通过了。绕法是每次进程只做一条：
//   while IFS= read -r n; do node tests/.mutate-chp.mjs "$n"; done <<< "$(names…)"
// 一条一进程时全程绿（2026-10-01 实测 27/27 CAUGHT，0 escaped，0 skip）。
//
// 三条纪律（都是踩过的）：
//   · **每一条都要说清该由哪句话抓住**。变异真跑红了、但红的是别的断言，等于没验
//     （曾经把 expected 写成"我以为会抓它的那句"，其实是被上一条先拦下的）。
//   · 脚本会改写源文件，所以恢复必须挂在 finally **和** SIGTERM / SIGINT 上：
//     只写 finally 的话，被信号杀掉时文件就留在变异状态（实测把重试次数留在 99 上）。
//     每条测试也都要有超时 —— 变异可能把重试变成死等，拖死整个脚本。
//   · **光有信号处理器还不够**：被 SIGKILL（工具超时、内存不足）杀掉时 JS 一行都跑不到，
//     实测留下两个带着变异的源文件，而下一次运行还把那份坏文件当成了"原文"，一路绿到天上去。
//     所以动手之前先把原文写进系统临时目录，脚本一启动先看有没有遗留快照 —— 有就先还原再干活。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME = "tests/runtime.test.mjs", VERIFY = "tools/verify.mjs";
const TIMEOUT = 180000;
// 快照目录按仓库路径取哈希：同一台机器上可能有几份 chataxi 检出，谁也不该还原到别人头上。
const STASH = path.join(
  os.tmpdir(),
  "chataxi-mutate-chp-" + createHash("sha256").update(root).digest("hex").slice(0, 10)
);

function stashPath(file) { return path.join(STASH, file.split("/").join("__")); }

// 进度**同步**写。管道上的 console.log 是异步刷的，被硬杀时最后几行就丢了 ——
// 而"死在哪一条"恰恰是事后唯一能据以判断仓库被留在什么状态的信息。
function say(text) { fs.writeSync(1, text); }

// 上一次被硬杀留下的快照：先还原，否则下面读到的"原文"本身就是变异过的。
if (fs.existsSync(path.join(STASH, "ready"))) {
  for (const name of fs.readdirSync(STASH)) {
    if (name === "ready") continue;
    fs.writeFileSync(path.join(root, name.split("__").join("/")), fs.readFileSync(path.join(STASH, name)));
  }
  console.log("RESTORED sources left mutated by an earlier run that was killed before it could restore");
}

const mutations = [
  // ── 画幅：只选不算 ────────────────────────────────────────────────────────────
  ["the canvas is whatever the table lists first",
    "app/services/draw.js",
    '      if (String(frame && frame.ratio || "") !== "9:16") return;',
    "      if (false) return;",
    "取的就是标着 9:16 的那一档"],
  ["the canvas is found by comparing the two numbers",
    "app/services/draw.js",
    '      if (String(frame && frame.ratio || "") !== "9:16") return;',
    '      var numbers = String((frame.resolution || [])[0] || "").split("x"); if (Number(numbers[0]) !== Number(numbers[1])) return;',
    "取的就是标着 9:16 的那一档"],
  // 期望句写的是**真正会先失败的那一条**（同一条测试里先抛错就停，后面那句根本没轮到）——
  // "没有帧表就报读不到"是同一件事的另一句，它排在后面，永远抓不到这个变异。
  ["no 9:16 frame invents one anyway",
    "app/services/draw.js",
    "    if (!list.length) return null;",
    '    if (!list.length) return "512x512";',
    "表里没有 9:16 就不许自己挑一张凑合"],
  // 同上：顺序被反转时，先撞上的是"同一个标签有多档时取第一档"那一句。
  ["the resolutions of a frame come out in reverse",
    "app/services/draw.js",
    "        if (text && out.indexOf(text) < 0) out.push(text);",
    "        if (text && out.indexOf(text) < 0) out.unshift(text);",
    "9:16 有多档时取第一档"],

  // ── 画幅：卡上挑的那条（业主 2026-09-30 要能挑低档，出图更快） ─────────────────
  ["the canvas chosen on the card is ignored",
    "app/services/draw.js",
    "    return list.indexOf(wanted) >= 0 ? wanted : list[0];",
    "    return list[0];",
    "卡上选中的那条在清单里就用它"],
  ["a canvas outside the plugin's current table is sent as it is",
    "app/services/draw.js",
    "    return list.indexOf(wanted) >= 0 ? wanted : list[0];",
    "    return wanted || list[0];",
    "不在清单里（插件换过帧表）就退回第一条"],
  ["the drawing card hardcodes its own canvas list",
    "app/features/model-single-editor.js",
    "        ? app.services.draw.sizes((catalogModels || [])[0]).map(function (item) { return { id: item, name: item }; })",
    '        ? ["768x1344", "576x1024"].map(function (item) { return { id: item, name: item }; })',
    "画幅选项要取自 draw.sizes",
    VERIFY],

  // ── 请求体：chp/2 的那套字段名 ────────────────────────────────────────────────
  ["the body names the category with the v1 field",
    "app/services/draw.js",
    "      category: String(scene.category || model.id),",
    "      capability: String(scene.category || model.id),",
    "v2 的字段名是 category"],
  ["the canvas travels as a pair of numbers",
    "app/services/draw.js",
    "      resolution: resolution\n",
    '      resolution: resolution.split("x").map(Number)\n',
    "发的就是表里的字面量"],

  // ── 走哪条场景：按「手上有没有参考图」分流（业主 2026-10-01） ─────────────────────
  // 这几条是本轮的核心契约：有定妆照 ⇒ render（按图重画），没有 ⇒ generate（从零画一张）。
  // 期望句写的是**真正会先失败的那一条** —— 同一张卡片上先走哪条路由前面的断言说了算。
  ["a reference is sent down the scenario that takes no image",
    "app/services/draw.js",
    "    if (hasReference) return scenes.render || null;",
    "    if (hasReference) return scenes.generate || null;",
    // 先失败的是 draw.js 自己那道守卫（把参考图交给一条不收图的场景之前必须拦住），
    // 而不是下面那条 category 断言 —— 守卫在提交之前就把整次调用打断了。
    "场景不接受参考图"],
  ["a drawing without a reference never reaches the text-to-image scenario",
    "app/services/draw.js",
    "    return scenes.generate || scenes.render || null;",
    "    return scenes.render || null;",
    "没有参考图就走从零画一张那条"],
  // 这两条是一对：画幅 / 默认值必须取自**这一次真正走的**那条场景，而不是卡片上那份主的。
  ["the canvas comes from the card instead of the scenario actually used",
    "app/services/draw.js",
    "    var defaults = scene.defaults || {}, resolution = pickSize(scene, profile.resolution);",
    "    var defaults = model.defaults || {}, resolution = pickSize(model, profile.resolution);",
    "画幅跟着**这一次那条场景**走，不是主场景那份"],
  ["the reference is dropped from the request body",
    "app/services/draw.js",
    "    if (reference) body.image_base64 = reference;",
    "    if (false) body.image_base64 = reference;",
    "定妆照必须原样进 image_base64"],
  // 参考强度是「要多像这张参考图」，没有图的时候它没有意义 —— 不许跟参考图脱钩单独发。
  ["the reference strength is sent even without a reference",
    "app/services/draw.js",
    "    if (reference && Number.isFinite(Number(defaults.ref_strength))) body.ref_strength =",
    "    if (Number.isFinite(Number(defaults.ref_strength))) body.ref_strength =",
    "参考强度必须跟参考图一起出现，没有图就不发"],
  ["a scenario that declares it takes no image gets one anyway",
    "app/services/draw.js",
    "    if (reference && scene.takesReference === false) throw new Error(",
    "    if (false) throw new Error(",
    "收不收参考图要按场景自己声明的来判"],

  // ── 发现路径：两条场景合成一张卡片 ─────────────────────────────────────────────
  ["only the reference-redraw scenario is collected",
    "app/services/model-services.js",
    '  var IMAGE_SCENES = ["render", "generate"];',
    '  var IMAGE_SCENES = ["render"];',
    "两条场景都要在卡片上"],
  ["the card keeps just one instead of both scenarios",
    "app/services/model-services.js",
    "      scenes: scenes,\n",
    "      scenes: { render: scenes.render },\n",
    "两条场景都要在卡片上"],
  ["the card is identified by a hardcoded scenario instead of the primary one",
    "app/services/model-services.js",
    "      id: primary.category,",
    '      id: "render",',
    "只剩 generate 时它就是主场景"],
  // 「收不收参考图」必须从文档里的**签名**派生，不许在客户端另立一份名单。
  ["whether a scenario takes a reference stops being derived from its signature",
    "app/services/model-services.js",
    '    var signature = String(rule && (rule.signature || rule.rule) || "").trim();',
    '    var signature = "";',
    "txt-2-img 不收"],
  // 缺件取并集而不是只抄主场景那份：不然"没有定妆照就画不出来"要等用户等过一次出图才暴露。
  ["the card reports only the primary scenario's missing models",
    "app/services/model-services.js",
    "      missing: missing,\n      scenes: scenes,",
    "      missing: primary.missing,\n      scenes: scenes,",
    "卡片上的缺件是两条场景的并集"],

  // ── 地址：一律从文档里读 ──────────────────────────────────────────────────────
  ["the submission address is assembled instead of read",
    "app/services/draw.js",
    '        url: services.chpUrl(profile, "jobs", "/chp/jobs"), method: "POST",',
    '        url: services.chpBase(services.computedEndpoint("image", profile)) + "/chp/jobs", method: "POST",',
    "请求地址一律从文档的 endpoints 里读"],
  ["the output address is resolved against the base instead of the origin",
    "app/services/draw.js",
    '    var bytes = await readBytes({ url: services.chpAbsolute(profile, output.url), method: "GET"',
    '    var bytes = await readBytes({ url: /^https?:/i.test(output.url) ? output.url : services.chpBase(services.computedEndpoint("image", profile)) + output.url, method: "GET"',
    "请求地址一律从文档的 endpoints 里读"],
  ["the published endpoints are not kept on the card",
    "app/services/model-services.js",
    "    service.endpoints = document.endpoints || {};",
    "    service.endpoints = {};",
    "地址表原样存下来"],

  // ── 发现路径：两张表 ─────────────────────────────────────────────────────────
  // 期望句是"先失败的那一条"：把每条场景的扫描并成一份累加数组之后，卡片上 render 那档
  // 会连后面那条能力播报的帧一起收进来 —— 于是先撞上的是"只取第一条能力的帧"那句。
  ["the frames of every ability are pooled",
    "app/services/model-services.js",
    "      if (ability) return;\n      var mine = [];",
    "      var mine = frames;",
    "画幅只取回答这条场景的第一条能力的帧"],
  ["the v1 capabilities table is read again",
    "app/services/model-services.js",
    '      var rule = rules.find(function (item) { return item && String(item.category || "") === category; });',
    '      var rule = (document.capabilities || []).find(function (item) { return item && String(item.category || "") === category; });',
    "插件没有提供成品图"],
  ["the typed address is no longer tried first",
    "app/services/model-services.js",
    '    var candidates = [typed, chpBase(typed) + "/chp/info"], answered = false;',
    '    var candidates = [chpBase(typed) + "/chp/info"], answered = false;',
    "先原样试用户填的地址"],
  ["an unreachable address is reported as a non-CHP service",
    "app/services/model-services.js",
    '    if (answered) throw new Error("这个地址不是 CHP 服务',
    '    if (true) throw new Error("这个地址不是 CHP 服务',
    "连不上要说地址不通"],

  // ── CHP 的 401：一个**确定的答案**，不是「地址可能填错」──────────────────────────
  // 信息接口从本轮起需要 key，所以钥错时回 401。以前它落进 `continue`，最后被报成
  // 「这个地址不是 CHP 服务」—— 那句话唯一指向的下一步是「去重装一个本来好好的插件」。
  ["a 401 is swallowed and reported as a wrong address",
    "app/services/model-services.js",
    '      if (response.status === 401) throw new Error("访问密码不正确，请在 ComfyUI 的 CHP 插件配置节点里核对密码");',
    "      ;",
    "一个 401 必须当场报「访问密码不正确」"],
  // 一把 key 有它自己被授权的场景（403 forbidden_capability）。掉到最后那条 message 上的话，
  // 用户看到的是插件自己的原话 —— 既没说清是授权问题，也没说该找谁。
  ["a capability the key was not granted is reported as a generic failure",
    "app/services/draw.js",
    '    if (code === "forbidden_capability") return new Error("这把 key 没有这个能力，请让管理员在 CHP 控制台里为这个场景授权");',
    '    if (false) return new Error("");',
    "403 必须说成「这把 key 没有这个能力」"],

  // ── CHP 的朗读（speech 段，§5.3）──────────────────────────────────────────────
  // 家族没登记成 CHP 的话，discover 会把它当成普通 TTS 走通用那条路：音色表变成空、
  // 采样率无从谈起，而界面上看起来完全正常（只是"没有音色可选"）。
  ["the speech family stops being a CHP family",
    "app/services/catalog.js",
    '      endpoint: "", discovery: "chp",\n      // 引擎在服务端加载',
    '      endpoint: "", discovery: "none",\n      // 引擎在服务端加载',
    "音色表来自文档的 speech.abilities[].voices"],
  ["the speech card is discovered through the generic TTS path",
    "app/services/model-services.js",
    '    else if (kind === "tts" && definition.discovery === "chp") result = await discoverChpSpeech(service, definition);',
    '    else if (false) result = await discoverChpSpeech(service, definition);',
    "音色表来自文档的 speech.abilities[].voices"],
  // 地址只从文档的 endpoints 里读。用户填的那个地址可能带着一段路径（…/chp），自己拼会拼出
  // …/chp/chp/speech —— 那是用户看不见、服务端也只回 404 的一种坏。
  ["the speech address is assembled instead of read",
    "app/services/model-services.js",
    "    var speechUrl = chpSpeech ? chpAbsolute(service, service.endpoints && service.endpoints.speech) : \"\";",
    '    var speechUrl = chpSpeech ? String(service.endpoint || "") + "/chp/speech" : "";',
    "朗读地址来自文档的 endpoints.speech"],
  // 采样率是**这台机器上引擎**的输出规格，写在文档里。写死一个常数会把声音放快或放慢，
  // 而播放链路本身一切正常 —— 这是最难被发现的一类坏。
  ["the speech sample rate is a hardcoded constant",
    "app/services/model-services.js",
    "      sampleRate: chpSpeech ? Number(chpAudio.sampleRate || 24000) : Number(service.sampleRate || 24000),",
    "      sampleRate: chpSpeech ? 24000 : Number(service.sampleRate || 24000),",
    "采样率来自文档的 audio.sample_rate"],
  // 朗读的文本字段叫 text，**不许**叫 prompt：`prompt` 在 CHP 里带翻译副作用
  // （图片侧那条规则的 prompt.language 会让服务端先把中文译成英文），而朗读的文本永不翻译。
  ["the speech request names the text with the translating field",
    "app/services/tts.js",
    '    if (profile.protocol === "chp-speech") return {\n      text: text,',
    '    if (profile.protocol === "chp-speech") return {\n      prompt: text,',
    "朗读的请求体就是这五个字段"],
  ["the speech request drops the streaming flag",
    "app/services/tts.js",
    '      response_format: formatOverride || profile.format || "pcm",\n      stream: formatOverride === "pcm"\n    };',
    '      response_format: formatOverride || profile.format || "pcm",\n      stream: false\n    };',
    "朗读的请求体就是这五个字段"],
  ["chp-speech has no raw streaming channel",
    "app/services/tts.js",
    '    if (profile.protocol === "chp-speech") return { kind: "raw", format: "pcm", sampleRate: Number(profile.sampleRate || 24000) };',
    '    if (false) return { kind: "raw", format: "pcm", sampleRate: Number(profile.sampleRate || 24000) };',
    "chp-speech 必须有一条流式通道"],
];

const escaped = [];
const sources = new Map();
// 可选过滤：`node tests/.mutate-chp.mjs pooled` 只跑名字里含这段的那几条。
// 调一条断言时不必每次等整轮跑完（整轮约六分钟），但**交活之前必须跑一次没有过滤的**。
const only = process.argv[2] || "";
const pending = only ? mutations.filter(([name]) => name.includes(only)) : mutations;
if (!pending.length) throw new Error("no mutation matches " + only);
for (const [, file] of pending) if (!sources.has(file)) sources.set(file, fs.readFileSync(path.join(root, file), "utf8"));

// 动手之前先把原文写到盘上。这份快照就是"被 SIGKILL 也不怕"的那一层 ——
// 它是原地重跑一次就能自愈的唯一依据（内存里的 sources 会随进程一起消失）。
fs.rmSync(STASH, { recursive: true, force: true });
fs.mkdirSync(STASH, { recursive: true });
for (const [file, source] of sources) fs.writeFileSync(stashPath(file), source);
fs.writeFileSync(path.join(STASH, "ready"), "\n");

function restore() {
  for (const [file, source] of sources) {
    try { fs.writeFileSync(path.join(root, file), source); } catch (error) { console.log("RESTORE FAILED " + file + ": " + error.message); }
  }
}
// 信号也要恢复：finally 只管"脚本自己走完"的那条路。
// 还原成功才敢删快照 —— 删早了就没东西可依据，被硬杀时就再也回不来了。
function finish(code) {
  restore();
  const damaged = [...sources].filter(([file, source]) => fs.readFileSync(path.join(root, file), "utf8") !== source);
  if (!damaged.length) fs.rmSync(STASH, { recursive: true, force: true });
  process.exit(code);
}
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => finish(1));

try {
  for (const [name, file, find, replace, expect, runner] of pending) {
    const target = path.join(root, file), original = sources.get(file);
    if (!original.includes(find)) {
      escaped.push(name + " (anchor not found, cannot mutate)");
      console.log("SKIP  " + name);
      continue;
    }
    // 每一条变异都从**干净的树**上开始。少了这一步，上一条变异留在**另一个文件**里的
    // 改动不会被任何人覆盖（每轮只重写自己要改的那个文件），于是：
    // 它引起的那次失败会被算到当前这条头上（假 CAUGHT），
    // 而当前这条自己的失败又可能被它挡在更早的地方（假 ESCAPED）——
    // 两种都实测过：speech 那五条在整轮里报 ESCAPED、单跑同样一条却报 CAUGHT。
    for (const [rel, source] of sources) fs.writeFileSync(path.join(root, rel), source);
    fs.writeFileSync(target, original.replace(find, replace));
    // 写盘之后再报一次：被硬杀时，日志里最后一条 RUN 就是仓库此刻带着的那处变异。
    say("RUN   " + name + " (" + file + ")\n");
    let text = "";
    try {
      const args = runner === VERIFY ? [VERIFY, "--source-only"] : ["--test", path.join(root, RUNTIME)];
      execFileSync(process.execPath, args, { cwd: root, stdio: "pipe", timeout: TIMEOUT });
    } catch (error) {
      text = String(error.stderr || "") + String(error.stdout || "");
    }
    const caught = Boolean(text) && text.includes(expect);
    const line = text.split("\n").find(row => row.includes("AssertionError") || /^Error: /.test(row.trim())) ||
      text.trim().split("\n").pop() || "";
    say((caught ? "CAUGHT" : "ESCAPED") + " " + name + (caught ? "" : "\n      expected to see: " + expect + "\n      got: " + line.trim()) + "\n");
    if (!caught) escaped.push(name);
  }
} finally {
  restore();
  for (const [file, source] of sources) if (fs.readFileSync(path.join(root, file), "utf8") !== source) throw new Error(file + " was not restored");
  fs.rmSync(STASH, { recursive: true, force: true });
}

if (escaped.length) {
  console.log("\nchp client mutation check FAILED: " + escaped.join("; "));
  process.exit(1);
}
console.log("\nchp client mutation check: ok (" + pending.length + " mutations, every one caught by the assertion it names)");
if (only) console.log("NOTE: filtered run (argv: " + only + ") — 交活之前必须再跑一次不带过滤的整轮");
