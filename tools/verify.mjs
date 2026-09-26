#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const hermit = JSON.parse(fs.readFileSync(path.join(root, "hermit.json"), "utf8"));

assert.equal(hermit.schema, 2);
assert.equal(hermit.happId, "life.airen.chataxi", "chataxi ships under the shared life.airen namespace");
assert.equal(hermit.entry, "index.html");
assert.equal(hermit.routing, "hash");
assert.equal(hermit.icon, "app/assets/icon.webp");
assert.deepEqual(hermit.display, { orientation: "portrait", keyboard: "resize" }, "chataxi must stay portrait while the host keeps focused fields above the keyboard");
assert.match(html, /interactive-widget=resizes-content/, "the page viewport must expose the keyboard-reduced content area");
assert.match(hermit.liveUrl, /^http:\/\/192\.168\.124\.161:4180\/$/, "the package needs a reachable live runtime target");
const iconPath = path.join(root, hermit.icon);
assert.ok(fs.statSync(iconPath).isFile(), "manifest icon must exist");
const iconBytes = fs.readFileSync(iconPath);
assert.equal(iconBytes.subarray(0, 4).toString("ascii"), "RIFF", "manifest icon must be a WebP RIFF file");
assert.equal(iconBytes.subarray(8, 12).toString("ascii"), "WEBP", "manifest icon must use the WebP codec");
assert.ok(iconBytes.length <= 160 * 1024, "manifest icon should remain reasonably compressed");
const namespace = fs.readFileSync(path.join(root, "app/core/namespace.js"), "utf8");
assert.equal(namespace.match(/chataxi.version = "([^\"]+)"/)[1], hermit.version.name, "runtime version differs from manifest");
const ttsSource = fs.readFileSync(path.join(root, "app/services/tts.js"), "utf8");
assert.doesNotMatch(ttsSource, /use_pvc_as_ivc/, "deprecated ElevenLabs PVC fallback must never be inferred or sent");
assert.match(ttsSource, /AudioContext[\s\S]*pointerdown[\s\S]*touchstart/, "inline TTS playback needs a user-gesture-unlocked Web Audio path");
assert.match(ttsSource, /response\.body[\s\S]*getReader[\s\S]*pushPcm/, "third-party TTS must consume response audio before the response completes");
assert.match(ttsSource, /text-to-speech\/[\s\S]*stream-input/, "Eleven non-v3 text streaming must use the TTS WebSocket");
assert.match(ttsSource, /text-to-dialogue\/stream-input/, "Eleven v3 text streaming must use the dialogue WebSocket");
assert.match(ttsSource, /languages\.indexOf\(profile\.language\)/, "system TTS must filter saved languages through the current engine catalog");
assert.match(ttsSource, /voices\.some\(function \(voice\)/, "system TTS must filter saved voices through the current engine catalog");
// 朗读音效（用户 2026-09-26: "统一的房间混响" + "隐约的环境声" + "确保声音连续不间断不破坏"）。
// 这里断言的是结构而不是参数, 因为"连续"正是由结构保证的:
//   全进程只有一份总线、所有出声点汇进它的 input ⇒ 流式 PCM 被切成几十段逐段喂进去,
//   与整段喂进去等价（ConvolverNode 是线性时不变节点）, 段间不会多出接缝。
// 一旦有人再往 destination 直连一条新路径, 那条路就会绕过混响, 混响也就不再"统一"。
assert.match(ttsSource, /function ensureBus\(\)[\s\S]*shared\.convolver\.buffer = buildImpulse/, "the shared bus must own one impulse response");
assert.match(ttsSource, /shared\.input\.connect\(shared\.dry\)[\s\S]*shared\.input\.connect\(shared\.convolver\)/, "dry and wet must split off one shared input");
assert.match(ttsSource, /ctx\.createDynamicsCompressor\(\)/, "the bus needs a limiter: wet plus dry raises the peak and would clip — clipping is the real way to break the sound");
assert.match(ttsSource, /shared\.master\.connect\(ctx\.destination\)/, "only the bus may reach the destination");
assert.doesNotMatch(ttsSource, /audioGain\.connect\(audioContext\.destination\)/, "no playback path may bypass the shared bus by connecting straight to the destination");
assert.match(ttsSource, /owner\.audioGain\.connect\(outputTarget\(\)\)/, "streaming PCM must enter the shared bus");
assert.match(ttsSource, /gain\.connect\(outputTarget\(\)\)/, "decoded clips must enter the shared bus too");
assert.match(ttsSource, /ensureBus\(\); playbackUnlocked = true/, "the bus must exist the moment the context unlocks, not on the first spoken word");
assert.match(ttsSource, /function startAmbience[\s\S]*Math\.random\(\)/, "the ambience must be re-rolled on every playback so it never sounds like a loop");
assert.match(ttsSource, /function stopAmbience[\s\S]*setTargetAtTime\(0/, "the ambience has to fade out instead of cutting");
assert.match(ttsSource, /bus\.ambience\.gain\.setTargetAtTime\(muted \? 0 : ambienceLevel/, "muting must also silence the standalone ambience source, or 'muted' still leaks sound");
assert.match(ttsSource, /for \(var c = 0; c < fade; c \+= 1\)/, "the ambience loop point needs a crossfade, otherwise every loop clicks");
// Android 系统朗读拿不到混响, 那就不该单独留一个环境声在响 —— 设置页写的"混响和环境声对 Android
// 系统朗读无效"必须是事实, 不能只写进说明文字。
assert.match(ttsSource, /var systemVoice = resolved\.profile\.type === "system"[\s\S]{0,240}applyAudioFx\(resolved\.settings, !systemVoice\)[\s\S]{0,90}if \(systemVoice\) stopAmbience\(\); else startAmbience\(\)/, "system speech must not leave the ambience running without the voice it belongs to");
assert.match(ttsSource, /function applyAudioFx\(settings, reverbEnabled\)/, "the reverb switch must be overridable per playback");
// 房间大小（用户 2026-09-26: "像是大厅。。。我希望是那种小房间里面的混响效果"）。
// 判据不是"听起来小", 而是三个可量的量: 尾巴更短、衰减更陡、早期反射挤在 1~23ms。
// 大厅那组是 1.8s / decay 3.0 / 反射 9~52ms —— 一旦有人把这三个数改回去, 混响就会重新变成大厅。
assert.match(ttsSource, /REVERB_SECONDS = 0\.6/, "the reverb tail must stay small-room short (0.6s), not hall long");
assert.match(ttsSource, /REVERB_DECAY = 5\.0/, "a steeper decay keeps the tail from reading as a big hall");
assert.match(ttsSource, /\[\[0\.0009, -0\.22\], \[0\.0026, 0\.58\][\s\S]{0,170}\[0\.0231, 0\.22\]\]/, "the early reflections must all arrive inside ~1~23ms or the room sounds huge");
// "麦克风贴耳"（用户 2026-09-26: "我希望营造那种麦克风贴耳的声音、真实感氛围"）。
// 贴耳的判据是**融合区内必须有反射**: 5ms 以内的反射不会被听成回声, 只会和直达声融成一个音色,
// 而近距离拾音时桌面、手、头部的反射必定就在这一档到达。只留 2.6ms 以后那几条就只剩"小房间",
// 没有"话筒在嘴边"。这一条同时锁住极性交错 —— 两条同相早期反射会顶出一个突出的梳状峰。
assert.match(ttsSource, /\[\[0\.0009, -0\.22\], \[0\.0026, 0\.58\], \[0\.0034, -0\.34\]/, "close-mic intimacy needs reflections inside the 5ms fusion zone, alternating in polarity");
assert.match(ttsSource, /shared\.dryTone\.frequency\.value = 3400/, "the dry path needs a presence lift: that band is where near-field speech gets its intimacy");
assert.match(ttsSource, /shared\.dry\.connect\(shared\.dryTone\); shared\.dryTone\.connect\(shared\.limiter\)/, "the presence filter must sit in the dry path only — pushing it into the wet path would brighten the room instead of the voice");
// 湿声低切只切真正的隆隆声（100Hz 以下）。这里**曾经是 240Hz**, 理由是"近讲时房间声本来就薄";
// 真机听感却是"混响几乎没有了"—— 把尾巴的低中频一起拿掉之后, 剩下的高频尾音被干声自己的 presence
// 盖住, 混响就不再可闻。所以这一条现在锁的是**上限**: 不许再抬回 200Hz 以上。
assert.match(ttsSource, /shared\.tone\.frequency\.value = 120/, "the wet low cut must kill rumble only — 240Hz ate the tail's body and made the reverb inaudible");
// 混响强度滑竿 0~100（用户 2026-09-26: "房间回响 0~100"）。
// ★ 这两条锁的是一次真实回归: 0.7.18 把量程从 0~50 放大到 0~100 时只改了量程, WET_MAX 仍是 1.05
//   ⇒ 同一个数字的湿度减半, 业主停在满档 50 的滑竿从 1.05 掉到 0.525（整整 −6dB）, 听感就是
//   "感觉现在混响效果几乎没有了"。修法是**重锚 WET_MAX, 不迁移存档值**:
//     50/100*2.1 = 1.05 = 旧满档 ⇒ 现存读数原样复原; 35/100*2.1 = 0.735 = 旧默认 ⇒ 默认值也不动。
//   所以判据是"同数字同湿度": WET_MAX 必须让 50 落在 1.05 —— 而 0.7.24 起业主又要求把映射出的
//   湿度整体 ×2（同日: "把这两个滑竿对应的值增加到 2 倍映射"）⇒ 现在是 4.2, 50 落在 2.1。
//   ★ 判据的**方向**比数值重要: WET_MAX 只许往上抬, 不许调回 1.05 一类的温和值 —— 那是把这 −6dB
//   的回归原样加回去。锚点关系是 WET_MAX = 2 × (让 50 落在 1.05 的那个值), 4.2 就是这个关系的结果。
assert.match(ttsSource, /REVERB_MIX_MAX = 100, REVERB_MIX_DEFAULT = 35/, "reverb must span 0~100 with the default still sitting where the old default did");
assert.match(ttsSource, /REVERB_DECAY = 5\.0, WET_MAX = 4\.2/, "the reverb slider must map to twice the wet level it had before the range was widened: 50 lands on 2.1");
assert.match(ttsSource, /mixPercent\(active\.ttsReverbMix, REVERB_MIX_DEFAULT, REVERB_MIX_MAX\)/, "stored reverb values above the cap must be clamped on read");
// 环境声强度（用户 2026-09-26: "环境噪音感觉不清晰, 是否也可以提供一个滑竿调节强度" → 同日
// "环境噪声设定要变小, 范围 0~50" → 同日收尾 "把当前的两个实际范围值都映射成为滑竿的 0~100…
// 现在环境音范围正好"）。这几次要求合起来只有一个解: **放大刻度, 不动声音**。所以
//   量程 50 → 100（与混响一致, 两根滑竿都是 0~100）;
//   天花板当时**保持 0.08** —— 它既是"要变小"那次从 0.14 压下来的结果, 也是业主认可"正好"的范围。
// 0.7.24 业主又要求把映射出的值整体 ×2 ⇒ 天花板 0.08 → 0.16。**注意这与"量程翻倍"是两件事**:
//   量程翻倍那次若不抬天花板, 同响度必须靠搬存档值（见下一条迁移）; 这次只抬映射, 存档一个不动。
// 天花板不动 ⇒ 存档里的旧数值必须一并 ×2（见 store 的迁移那条）, 否则同响度会被砍半。
assert.match(ttsSource, /AMBIENCE_MIX_MAX = 100, AMBIENCE_MAX = 0\.16/, "ambience must span the same 0~100 as reverb, with the ceiling doubled as the owner asked");
assert.match(ttsSource, /AMBIENCE_MIX_DEFAULT = 60/, "the ambience default must move with its scale: 60 on 0~100 is the loudness 30 on 0~50 used to be");
// 缩放的分母必须是滑竿量程。写死 100 的话, 滑竿拉到满(50) 也只能得到一半强度 ——
// 而"拉满还很轻"这种偏差不会报错, 只会让人以为效果就这么弱。
assert.match(ttsSource, /ambienceLevel = AMBIENCE_MAX \* \(ambMix \/ AMBIENCE_MIX_MAX\)/, "the ambience strength slider must scale by its own range, not a hardcoded 100");
// 环境声的"断续"（用户 2026-09-26: "环境杂音现在太均匀了…偶尔大一点, 又均匀小一会 1~3 秒,
// 然后又大一会半秒几声" → 同日晚些: "太单调了, 噪音也太紧凑, 连续擦擦擦声音, 应该是偶尔嚓-小声嚓-
// 小小声-嚓擦…总之大小声没规律而且不紧凑连续"）。四件事各锁一条:
//   ① 平缓段必须够长,"不紧凑"就落在它的下限上;
//   ② 音节响度必须**逐个**抽, 而不是一个突发段共用一个峰值 —— 段内是平的就一定单调;
//   ③ 音节之间要有空档, 否则首尾相接就是"擦擦擦";
//   ④ 底毯必须低 —— 原来 pink*(0.30+0.70*env) 在 env 归零时仍剩 30% 电平, 谷被填死,
//      滑竿一拉就是一条恒定嘶声, 这才是最初那版"太均匀"的根因。
assert.match(ttsSource, /rate \* \(1\.8 \+ rnd\(\) \* 3\.2\)/, "the calm stretch must be long enough to stop sounding cramped");
assert.match(ttsSource, /var syllables = rnd\(\) < 0\.3 \? 1 : 1 \+ Math\.floor\(rnd\(\) \* 4\)/, "a burst is 1~4 syllables, and a third of them are a single isolated tap");
assert.match(ttsSource, /var peak = 0\.15 \+ Math\.pow\(rnd\(\), 1\.6\) \* 0\.85/, "every syllable needs its own level, biased quiet — one shared peak per burst is exactly what made it monotonous");
assert.match(ttsSource, /var hold = Math\.max\(1, Math\.floor\(rate \* \(0\.06 \+ rnd\(\) \* 0\.20\)\)\)/, "syllables need gaps between them, or they fuse back into 'chchchch'");
// 底床的起伏深度。"不紧凑连续"的另一半在这里: 只轻轻抖一下的底噪听感就是一条一直在响的嘶声,
// 必须让它真的涨落（0.30~1.00）。
assert.match(ttsSource, /var drift = 0\.30 \+ 0\.70 \* Math\.sin\(/, "the calm bed must swell and fade instead of holding one steady hiss");
assert.match(ttsSource, /\* 0\.25 \* \(0\.06 \+ 0\.94 \* envelope\[index\]\)/, "the noise floor must sit far below the envelope, otherwise the gaps are filled in and the ambience sounds uniform again");
assert.match(ttsSource, /Math\.min\(1, \(tone - 1 - k\) \/ \(rate \* 0\.012\)\)/, "each syllable needs its own release ramp so it lands on zero instead of stepping into the next one");
// 平缓段的**尾部**也必须回零。这一条是量出来的, 不是想出来的: 只给突发段做起坡时, 平缓段结束时
// 仍停在自己的漂移值(实测最高 0.30)再猛地接到 0 —— 包络上就是 0.159 / 0.237 的单样本跳变,
// 每个突发段入口一次。补上 40ms 回落之后实测降到 0.006（剩下的那点还比噪声自身的样本间起伏小,
// 与"把包络换成常数"的对照跑法一致判为无点击）。
assert.match(ttsSource, /var fall = Math\.max\(0, Math\.min\(1, \(calm - 1 - ci\) \/ \(rate \* 0\.04\)\)\)/, "the calm stretch must ramp back to zero before the next burst starts");
const asrSource = fs.readFileSync(path.join(root, "app/services/asr.js"), "utf8");
assert.match(asrSource, /api\.speech\.languages\(\)/, "system ASR languages must come from the current Android recognition provider");
assert.match(asrSource, /capability\.languageSelectionSupported[\s\S]*capability\.languages\.indexOf\(profile\.language\)/, "system ASR must never send a language outside the provider catalog");
assert.doesNotMatch(asrSource, /\[\s*["']zh-CN["'][\s\S]*["']en-US["']/, "system ASR must not ship a fabricated language list");
const modelsSource = fs.readFileSync(path.join(root, "app/features/models.js"), "utf8");
assert.match(modelsSource, /system\s*&&\s*!systemUsable[\s\S]*service-unavailable/, "unavailable system speech services must render a status instead of test and edit actions");
const modelEditorSource = fs.readFileSync(path.join(root, "app/features/model-single-editor.js"), "utf8");
assert.match(modelEditorSource, /externalModelId[\s\S]*一个模型卡片只保存/, "each model card must select exactly one external model");
assert.doesNotMatch(modelEditorSource, /model-toggle/, "the active model editor must not expose a multi-model switch list");
assert.match(modelEditorSource, /catalogVoices[\s\S]*saveModelDirectory/, "provider voice names and model directories must be cached outside the single-model card");
assert.match(modelEditorSource, /data-paste-key[\s\S]*data-paste-headers[\s\S]*data-toggle-secret/, "saved credentials must stay editable, accept explicit clipboard paste and expose a visibility toggle");
assert.doesNotMatch(modelEditorSource, /data-copy-key|data-copy-secret|data-copy-headers/, "credential controls must not copy secrets back to the clipboard");
const uiComponentSource = fs.readFileSync(path.join(root, "app/components/ui.js"), "utf8");
assert.match(uiComponentSource, /url:\s*picked\.url[\s\S]*release:\s*function[\s\S]*files\.delete/, "Hermit image picking must pass the current object URL directly to the cropper and defer temporary-file cleanup");
assert.doesNotMatch(uiComponentSource, /fetch\(picked\.url/, "Hermit object URLs must not be fetched as ordinary network resources");
assert.match(uiComponentSource, /cropCanvas[\s\S]*context\.drawImage\(image/, "the crop preview must render through canvas after the managed object URL is decoded");
// 宿主 CSP（default-src 'self' data: blob:）挡的是 HTML 里解析出来的 style 属性；
// CSSOM 写入（element.style.foo = …）不受它约束 —— 用真实 Chrome 加载同一条策略实测过。
// 所以这里只禁止前者，取景框的尺寸仍然必须由 CSSOM 给出（要按屏幕比例撑开，CSS 里写不出来）。
assert.doesNotMatch(uiComponentSource, /\bstyle\s*=\s*["']/, "the cropper must not emit style attributes blocked by the device CSP");
assert.match(uiComponentSource, /\.style\.(?:width|height)\s*=/, "the device CSP allows CSSOM writes, so the crop viewport sizes itself through element.style");
const modelServicesSource = fs.readFileSync(path.join(root, "app/services/model-services.js"), "utf8");
assert.match(modelServicesSource, /catalog\.reviewedLlmModels[\s\S]*rules\[id\]/, "reviewed capabilities must use exact model IDs");
assert.doesNotMatch(modelServicesSource, /\^gpt-5|\^grok-4|\^minimax-m3/, "model-name prefixes must not create capabilities");
assert.match(modelServicesSource, /\/api\/show[\s\S]*runtime-model-details/, "Ollama capabilities must come from the selected runtime's model details");
const chatSessionSource = fs.readFileSync(path.join(root, "app/features/chat-session.js"), "utf8");
assert.doesNotMatch(chatSessionSource, /autoSpeak[\s\S]{0,2000}tts\.prepare/, "automatic readout must play completed third-party audio instead of only preparing it");
const contextSource = fs.readFileSync(path.join(root, "app/services/context.js"), "utf8");
assert.match(contextSource, /本轮唯一允许发言的角色[\s\S]*不得扮演、代替、续写或模拟其他参与角色/, "group turns need an explicit single-speaker identity contract");
assert.match(contextSource, /<other_roles_reference>/, "the active role instructions must be isolated from other role references");
assert.match(contextSource, /<active_role>[\s\S]*<behavior_guidance>/, "behavior guidance must reach the model right after the active role identity");
assert.match(contextSource, /function roleReference\(role, prefix\)[\s\S]*行为指导：[\s\S]*roleReference: roleReference/, "every participant reference must carry its behavior guidance");
assert.match(contextSource, /参与者资料仅用于辨认说话者[\s\S]*不要摘录、概括/, "compression participant profiles must remain reference-only");
assert.match(contextSource, /throughMessageCreatedAt[\s\S]*retainedMessageCount[\s\S]*recent:\s*uncompressed/, "compression must persist its exact boundary and retain every uncompressed message");
assert.match(contextSource, /function compressionRole\(conversation, participantRoles, fallback\)[\s\S]*moderatorRoleId[\s\S]*roles\[0\] \|\| fallback/, "compression must run on the moderator's model with a deterministic fallback");
assert.match(contextSource, /function scheduleCompression[\s\S]*phase: "compressing"[\s\S]*phase: "compressed"/, "compression must run asynchronously and announce both phases");
assert.doesNotMatch(contextSource, /task\.phase\s*=/, "background compression must not rewrite the current turn's task phase");
assert.match(contextSource, /Number\(profile\.maxOutputTokens\) > 0\) profile\.maxOutputTokens/, "compression must not turn an unset output cap into zero");
assert.match(contextSource, /压缩没有返回可用内容/, "an empty compression result must never advance the summary boundary");
assert.match(contextSource, /function retainedCount\(messages, settings\)[\s\S]*total > retain[\s\S]*Math\.max\(2, count\)/, "the retention window must be derived from characters with a two-message floor");
assert.doesNotMatch(contextSource, /recentFullMessages/, "the retention window must no longer come from a per-conversation message count");
assert.match(contextSource, /function compressionRetain\(settings\)[\s\S]*compressionRetainChars/, "the retention length must live in the compression settings");
assert.match(contextSource, /var retained = retainedCount\(history, settings\)[\s\S]*history\.length - retained/, "compression must cut its prefix with the derived retention window");
assert.match(contextSource, /async function permissions\(messages, conversationId\)[\s\S]*lockedMap\[message\.id\] = true/, "frozen history must follow the summary boundary alone, not the retention setting");
assert.match(contextSource, /async function updateSummaryText\(conversationId, text\)[\s\S]*压缩概要不能为空/, "the compression summary must stay hand-editable with an explicit empty guard");
const llmSource = fs.readFileSync(path.join(root, "app/services/llm.js"), "utf8");
assert.match(llmSource, /other-role-history[\s\S]*speakerMismatch/, "other role history and mismatched speaker labels need deterministic guards");
assert.doesNotMatch(llmSource, /compressionRole/, "compression must never be driven by the answering role");
assert.match(llmSource, /selectRole[\s\S]*\{\\"role\\":\\"完整角色名称\\"\}[\s\S]*parseRoleChoice/, "automatic role selection must request and validate one standard role name");
assert.match(llmSource, /app\.services\.context\.roleReference\(role\)/, "routing and scene prompts must reuse the shared role reference so behavior guidance reaches them");
assert.match(chatSessionSource, /conversation\.autoSelectRole[\s\S]*moderatorRoleId[\s\S]*llm\.selectRole/, "group auto-selection must run through the persisted moderator");
assert.match(chatSessionSource, /Math\.random\(\)[\s\S]*fallback:\s*routingFallback/, "failed automatic routing must continue with one random participant and expose its fallback state");
assert.match(chatSessionSource, /kind:\s*["']routing["'][\s\S]*outputText[\s\S]*routingError/, "automatic routing must persist its model output and failure reason as a typed diagnostic record");
const storeSource = fs.readFileSync(path.join(root, "app/data/store.js"), "utf8");
assert.match(storeSource, /messages\(conversationId\)[\s\S]*item\.kind\s*!==\s*["']routing["']/, "normal chat history must filter routing diagnostic records");
assert.match(storeSource, /routingRecords\(conversationId\)/, "developers need a direct reader for persisted routing diagnostics");
assert.match(storeSource, /credentials[\s\S]*credentialRef[\s\S]*withoutSecrets/, "model profiles must persist credentials by reference instead of duplicating secrets");
assert.match(storeSource, /model-directory[\s\S]*saveModelDirectory[\s\S]*modelDirectory/, "provider directories must be stored separately from one-model cards");
const styles = ["styles/base.css", "styles/components.css", "styles/app.css"].map((relative) => fs.readFileSync(path.join(root, relative), "utf8")).join("\n");
assert.match(styles, /\.justify-break,\s*p,\s*li,\s*dd,\s*\.message-text,\s*\.copy-url code\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-all[^}]*text-align:\s*justify/s, "paragraphs, message text and displayed links must default to justify-break wrapping");
const appSource = fs.readFileSync(path.join(root, "app/app.js"), "utf8");
assert.match(appSource, /function scheduleReveal[\s\S]*revealFocusedField/, "focused fields need a deferred correction after keyboard animation");
assert.match(appSource, /document\.addEventListener\('focusin', focusChanged\)/, "every editable field must enter keyboard visibility handling");
assert.match(appSource, /document\.addEventListener\('focusout', focusLeft\)/, "keyboard visibility handling must end when editing finishes");
assert.match(appSource, /visualViewport[\s\S]*scrollParent[\s\S]*scrollTop/, "focused fields need visual viewport and local scroll-container correction");
assert.match(styles, /\.keyboard-open\s+\.bottom-nav\s*\{[^}]*visibility:\s*hidden[^}]*pointer-events:\s*none/s, "the mobile tab bar must not rise above the keyboard");
assert.match(styles, /overflow-x:\s*hidden/, "the app must constrain horizontal overflow");
assert.equal((styles.match(/overflow-x:\s*auto/g) || []).length, 1, "only the role mention strip may scroll horizontally");
assert.match(styles, /\.mention-strip\s*\{[^}]*overflow-x:\s*auto/s, "the fixed mention row must scroll locally when role names overflow");
assert.match(styles, /\.recipient-at\s*\{[^}]*background:\s*transparent/s, "the composer at-sign must not have a background");
assert.match(styles, /\.mention-chip\s*>\s*\.mention-avatar\s*\{[^}]*border-radius:\s*50%/s, "composer role avatars must be circular");
assert.match(styles, /#muteTtsButton\.voice-active\s*\{[^}]*color:\s*var\(--voice-active\)[^}]*background:\s*transparent/s, "active readout must color only the speaker icon");
assert.match(styles, /\.message-avatar-trigger\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/s, "message portrait trigger must retain a full touch target");
assert.match(styles, /\.avatar\s*\{[^}]*box-shadow:\s*0 0 0 1px var\(--border-strong\)/s, "avatars need a subtle outline on light backgrounds");
assert.match(styles, /textarea\[name="introduction"\][\s\S]*textarea\[name="userIntroduction"\][^}]*min-height:\s*103px/s, "both personal introduction editors must use the reduced height");
const chatSource = fs.readFileSync(path.join(root, "app/features/chat.js"), "utf8");
assert.match(chatSource, /dataset\.editConversationProfile\s*=\s*['"]user['"][\s\S]*openPersonalProfile/, "the user message avatar must open conversation personal settings");
assert.doesNotMatch(chatSource, /保存并执行|name=["']regenerate["']/, "message editing must only save; regeneration stays a separate action");
assert.match(chatSource, /包括用户消息和任何角色的回复[\s\S]*deleteMessagesAfter/, "regenerating an older reply must confirm removal of every later message");
// 六个配色卡片曾经把渐变写进 style 属性 ⇒ 被宿主 CSP 静默丢掉, 六块全白。
// 配色色块与相册缩略图只能等弹窗挂上 DOM 之后用 CSSOM 着色。
assert.doesNotMatch(chatSource, /\bstyle\s*=\s*["']/, "chat markup must not carry style attributes the device CSP discards");
assert.match(chatSource, /function paintSwatches[\s\S]*\.style\.backgroundImage\s*=/, "preset gradients must be painted through CSSOM after the dialog opens");
// 相册背景：存宿主文件库的 URL，不存 base64，也不再走 900 KiB 上限的内联选择器。
assert.match(chatSource, /kind:\s*'image',\s*url:\s*picked\.url/, "a gallery background must be stored as the host file URL, never as base64 or an IndexedDB media id");
assert.doesNotMatch(chatSource, /pickInline\(\{\s*accept:\s*['"]image\/\*['"]/, "a gallery background must not go through the inline picker whose 900 KiB ceiling produced the old error");
assert.match(chatSource, /function pickBackgroundImage[\s\S]*ui\.pickLocalImage\(/, "a gallery background must be picked through the album picker the host normalizes itself");
assert.match(chatSource, /ui\.screenAspect\(\)/, "the background crop frame must follow the screen aspect rather than a square");
// 六个色板各备明亮 / 深色两套渐变, 按主题取一套。主题判断只有 app.resolvedTheme() 一处,
// chat.js 不许自己再读 data-theme 或 prefers-color-scheme, 否则两处判断迟早走样。
assert.match(appSource, /app\.resolvedTheme\s*=\s*resolvedTheme/, "the resolved theme must be exposed so a background can follow it");
assert.match(chatSource, /function presetCss\(item\)[\s\S]*app\.resolvedTheme\(\)/, "preset gradients must pick their light or dark variant from the shared resolved theme");
assert.match(chatSource, /prefers-color-scheme: dark[\s\S]*attributeFilter:\s*\[['"]data-theme['"]\]/, "an already painted background must repaint when the theme changes through either path");
const presetObjects = Array.from(chatSource.matchAll(/\{\s*id:\s*'([a-z]+)',\s*name:\s*'([^']+)',\s*light:\s*'([^']+)',\s*dark:\s*'([^']+)'\s*\}/g));
assert.equal(presetObjects.length, 6, "the background panel must offer exactly six presets, each with a light and a dark gradient");
function presetLuminance(hex) {
  const packed = parseInt(hex.slice(1), 16);
  const channels = [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255].map(function (value) {
    const unit = value / 255;
    return unit <= 0.03928 ? unit / 12.92 : Math.pow((unit + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
function presetStops(gradient) {
  return ((/linear-gradient\([^,]+,\s*([^)]+)\)/.exec(gradient) || [, ""])[1].match(/#[0-9a-f]{6}/gi) || []);
}
presetObjects.forEach(function (match) {
  const name = match[2];
  const lightStops = presetStops(match[3]);
  const darkStops = presetStops(match[4]);
  assert.equal(lightStops.length, 3, "the light gradient of " + name + " must carry three colour stops");
  assert.equal(darkStops.length, 3, "the dark gradient of " + name + " must carry three colour stops");
  const light = lightStops.reduce(function (sum, stop) { return sum + presetLuminance(stop); }, 0) / lightStops.length;
  const dark = darkStops.reduce(function (sum, stop) { return sum + presetLuminance(stop); }, 0) / darkStops.length;
  assert.ok(light > 0.4, "the light variant of " + name + " must really be light, but lands at luminance " + light.toFixed(3));
  assert.ok(dark < 0.15, "the dark variant of " + name + " must really be dark, but lands at luminance " + dark.toFixed(3));
});
assert.match(styles, /\.composer-toolbar\s+\.row\s*\{[^}]*gap:\s*8px/s, "composer image and microphone controls need one compact normal gap");
// 输入框无条件就是毛玻璃：本体要半透明 --glass + backdrop-filter。退回实色（--surface）会把
// backdrop-filter 糊成一块纯色、等于没做；而 .composer 整条留底色同样会让玻璃看不出效果。
assert.match(styles, /\.composer-box\s*\{[^}]*background:\s*var\(--glass\)[^}]*backdrop-filter:\s*blur\(/s, "the composer box must be translucent frosted glass, not a solid surface");
assert.doesNotMatch(styles, /\.composer-box\s*\{[^}]*background:\s*var\(--surface\)/s, "a solid --surface on the composer box would hide the frost");
assert.match(styles, /\.composer\s*\{[^}]*background:\s*transparent/s, "the composer bar must not paint an opaque strip behind the glass");
// 顶栏是"浮在消息上的覆盖层"（用户 2026-09-26 要求）：absolute 让它脱出 grid 的第一行,
// 消息才真能滚到它底下; .message-list 顶上要给这块玻璃让出位置。
// 玻璃本身的门禁在下面那一组（顶栏 / 底栏无条件玻璃）。
assert.match(styles, /\.app-shell\s*\{[^}]*position:\s*relative/s, "the shell must anchor the floating top bar");
assert.match(styles, /\.chat-open\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)[^}]*--chat-topbar:/s, "the chat layout must drop the top bar's own grid row and publish its height");
assert.doesNotMatch(styles, /\.chat-open\s*\{[^}]*grid-template-rows:[^;}]*\bauto\b/s, "a top bar that still owns a grid row cannot be scrolled under");
assert.match(styles, /\.chat-open\s+\.topbar\s*\{[^}]*position:\s*absolute[^}]*z-index:\s*\d+/s, "the chat top bar must float above the message list");
assert.match(styles, /\.chat-open\s+\.message-list\s*\{[^}]*padding-top:\s*calc\(var\(--chat-topbar\)/s, "the message list must reserve the floating top bar's height so the first message is not covered");
assert.match(styles, /@media\s*\(max-height:\s*520px\)\s*\{[^}]*--chat-topbar:\s*calc\(54px/s, "the short-screen layout must shorten the reserved top bar height too");
// 沉浸模式：点消息列表的空白处收掉全部控件, 只留背景, 再点一次恢复（用户 2026-09-26:
// "点击消息列表的空白位置, 可以隐藏所有控件（包括标题栏和输入框和对话列表。只显示背景）,
// 再点一次就恢复显示"）。四条一起锁:
//   ① 顶栏 / 消息列表 / 输入区**三块都要隐** —— 用户点名了这三个, 少隐一块就等于没做;
//   ② 只能用 opacity + pointer-events, 不能用 display / visibility —— 前者会让列表滚动位置与
//      输入区真实高度（--chat-composer-h）被重算, 恢复时界面跳一下; 后者会让"再点一次"没有落点,
//      因为隐掉的层也不吃点击了, 而恢复的那次点击正是要落在 .chat-layout 上;
//   ③ 只有列表里的**空白**才算: 黑名单选择器必须覆盖消息行与消息里的按钮, 否则点一条消息
//      就把整个界面藏起来, 那是明显的误触;
//   ④ 状态挂在 #appShell 上, 它跨页面活着 ⇒ close() 里必须清掉。漏掉这条, 从一个"隐着"的
//      对话切到列表页, 下一页的顶栏与输入区全是隐形的 —— 界面看起来就是坏了。
assert.match(styles, /\.chat-chrome-hidden\s+\.topbar,\s*\.chat-chrome-hidden\s+\.message-viewport,\s*\.chat-chrome-hidden\s+\.composer\s*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/s, "all three chat regions must blank out together, and stay out of the way of the restoring tap");
assert.doesNotMatch(styles, /\.chat-chrome-hidden[^{]*\{[^}]*\b(?:display|visibility):/s, "hiding the chrome must not reflow the list or steal the layout: use opacity plus pointer-events");
assert.match(chatSource, /function setChromeHidden\(target, hidden\)/, "the chat page needs one place that knows how the chrome is hidden");
assert.match(chatSource, /input === document\.activeElement\) input\.blur\(\)/, "hiding the composer must drop keyboard focus with it");
assert.match(chatSource, /layout\.addEventListener\('click'[\s\S]{0,600}?node\.closest\('button, a, input, textarea, select, label, img, \.avatar, \.message-row, \.chat-welcome'\)/, "the blank-area test must exclude the message rows themselves, not just the buttons inside them");
assert.match(chatSource, /async function close\(\) \{\s*var target = view; if \(!target\) return;[\s\S]{0,600}?setChromeHidden\(target, false\);/, "close() must clear the hidden chrome before it marks the view closed, or the next page inherits an invisible top bar");
// 全局毛玻璃（用户 2026-09-26：背景充满整个应用, 标题栏 / 底部栏 / 弹窗 / 卡片统一磨砂玻璃）。
// 开关只有一处 —— <html>.has-app-background（= 最近使用的对话设了背景）。上一版那个只在对话页
// 生效的 .has-chat-background 已经废弃, 语义不同, 任何地方都不许再出现。
assert.doesNotMatch(styles, /has-chat-background/, "the chat-scoped background switch is superseded by the app-wide one");
const tokens = fs.readFileSync(path.join(root, "styles/tokens.css"), "utf8");
assert.match(tokens, /--glass-blur:\s*\d+px[^}]*--glass-saturate:\s*[\d.]+/s, "the frost needs one shared radius and saturation, not a per-rule magic number");
// 一条 token 重映射换来全应用玻璃化：所有用 var(--surface*) 的组件自动跟上, 不用逐个列举。
assert.match(tokens, /:root\.has-app-background\s*\{[^}]*--surface:\s*var\(--glass\)[^}]*--surface-raised:\s*var\(--glass\)[^}]*--surface-muted:\s*var\(--glass-muted\)/s, "every solid surface token must fall back to glass while an app background is set");
// --border 换成近乎全白的 --glass-edge 会让胶囊、按钮轮廓在浅色玻璃上直接消失 —— 整套设计里
// "白底白卡"的区分就靠它。这几组必须留在主题色上。
assert.doesNotMatch(tokens, /--border(-strong)?:\s*var\(--glass-edge\)/, "the borders and outlines must stay readable on light glass");
assert.doesNotMatch(tokens, /--danger-soft:\s*var\(--glass/, "semantic alert fills must stay solid enough to read as alerts");
// 背景画在 .app-shell 的 ::before 独立图层上（不直接做 .app-shell 的 background）:
// 非对话页要给背景图加 filter: blur(), 而 background-image 本身不接受 filter。
// 图层用 z-index: -1 压在内容之下, 所以 .app-shell 自己必须是层叠上下文（z-index: 0）,
// 否则负层会掉到 .app-shell 的背景后面, 整块看不见。
assert.match(styles, /\.app-shell\s*\{[^}]*z-index:\s*0/s, "the shell must be a stacking context, or the z-index:-1 background layer vanishes behind it");
assert.match(styles, /html\.has-app-background \.app-shell::before\s*\{[^}]*z-index:\s*-1/s, "the background layer must sit under the shell's content");
assert.match(styles, /html\.has-app-background \.app-shell::before\s*\{[^}]*background-image:\s*var\(--chat-background\)/s, "the app background must be painted on a layer under the shell so it fills every page, not just the chat");
// 图层高度钉在"正常视口"（--viewport-full-height）上, 不跟 .app-shell 缩
// （用户 2026-09-26: 不一定是键盘, 任何窗口变化下背景都要满屏、不能变小）。
// 跟着缩的话, 图层上的 background-size / background-position 都是百分比, 会按新容器重算 ⇒ 照片当场变小。
assert.match(styles, /html\.has-app-background \.app-shell::before\s*\{[^}]*height:\s*var\(--viewport-full-height/s, "the background layer must pin its height to the nominal viewport, or the photo rescales whenever the shell shrinks");
assert.match(styles, /html\.has-app-background \.app-shell::before\s*\{[^}]*top:\s*0/s, "the pinned layer must stay top-anchored, or the photo slides up when the shell shrinks");
assert.doesNotMatch(styles, /html\.has-app-background \.app-shell::before\s*\{[^}]*inset:\s*0/s, "inset:0 ties the layer back to the shrinking shell");
// 正常视口的规则: 宽度变了（转屏 / 分屏 / 宿主窗口）就重新起算; 宽度没变时高度只增不减 ——
// 只减的那些一定是键盘或系统栏, 背景不跟。
assert.match(appSource, /function syncBackgroundViewport\(/, "the shell must track the nominal viewport for the background layer");
assert.match(appSource, /width !== nominalWidth[\s\S]{0,60}?nominalHeight = height/, "a real window resize (rotation / split screen) must restart the nominal size");
assert.match(appSource, /else if \(height > nominalHeight\)/, "the nominal height may only grow while the width is unchanged, so the keyboard cannot shrink the layer");
assert.match(appSource, /setProperty\('--viewport-full-height'/, "the nominal height must reach the stylesheet");
// 取景（百分比）要按正常视口的宽高比算: 键盘弹起时 .app-shell 是压扁的, 拿它当比例会算出错的取景。
assert.match(chatSource, /function shellAspect\(\)\s*\{[\s\S]*?--viewport-full-height/, "the crop framing must be computed against the nominal viewport, not the shrunken shell");
// 非对话页把背景图当"干净底子"用。**这两个数不锁具体值 —— 用户会在真机上反复调**
// （2026-09-26 一天之内 30px → 20px → 10px）。门禁只锁"不变量", 不锁他的口味:
// ① 模糊必须是一个正数, 不透明度必须真的"透明"（=1 就不是透底了）;
// ② 覆盖倍数与模糊半径的耦合必须成立（见下面那条不等式）。
const pageBlur = Number((tokens.match(/--page-bg-blur:\s*([\d.]+)px/) || [])[1]);
const pageOpacity = Number((tokens.match(/--page-bg-opacity:\s*([\d.]+)/) || [])[1]);
assert.ok(Number.isFinite(pageBlur) && pageBlur > 0, "the off-chat background needs a positive blur radius");
assert.ok(Number.isFinite(pageOpacity) && pageOpacity > 0 && pageOpacity < 1, "the off-chat background must be genuinely see-through, not opaque");
assert.match(styles, /html\.has-app-background \.app-shell:not\(\.chat-open\)::before\s*\{[^}]*filter:\s*blur\(var\(--page-bg-blur\)\)[^}]*opacity:\s*var\(--page-bg-opacity\)/s, "off-chat pages must blur the background image and let the rest of it through");
// 柔化带约 3σ = 3R 是绝对宽度, 而缩放的让边 (倍数-1)/2 × 视口宽 会随视口变窄 ⇒ 按最窄的支持机型
// 360px 校验, 不按这台机器的 510px: 窄屏才是危险的那一端。不够就会在四边露出一圈主题底色
// （真机实测踩过一次: blur 30px + scale 1.3 在 510px 上只剩 76px, 而柔化带去到 90px）。
// 这条是"活的": 模糊调大到让边不够时它会自己失败, 提示该把倍数一起加上去。
const pageScale = Number((styles.match(/\.app-shell:not\(\.chat-open\)::before\s*\{[^}]*transform:\s*scale\(([\d.]+)\)/s) || [])[1]);
assert.ok(pageScale > 1, "the blurred layer must be scaled past the viewport or a rim of theme colour shows");
const pageOverhang = (pageScale - 1) / 2 * 360, pageBleed = 3 * pageBlur;
assert.ok(pageOverhang >= pageBleed, "scale " + pageScale + " leaves " + pageOverhang + "px on a 360px viewport but blur " + pageBlur + "px needs " + pageBleed + "px: a rim of theme colour shows on narrow screens");
// 非对话页一条"清掉填充"的规则都不许再留（用户 2026-09-26 当天的收窄被当场撤回）。
// 原话:"按钮组（tab按钮组）整体的也要加半透明背景（覆盖到未激活的按钮）" ——
// 容器不填, 几个按钮就各自浮着、不成组。只清 background 不清 backdrop-filter 还会留下一块
// "比周围更糊的软边矩形", 所以两类都不清。
assert.match(styles, /\.section-tabs\s*\{[^}]*background:\s*var\(--surface-muted\)/s, "the segmented tab strip must keep a translucent track, so the inactive segments sit on something");
assert.match(styles, /\.section-tabs button\[aria-selected="true"\]\s*\{[^}]*background:\s*var\(--surface\)/s, "the active segment must keep a fill, or the strip no longer shows which tab is on");
assert.match(styles, /html\.has-app-background \.section-tabs,[^}]*backdrop-filter:\s*blur\(var\(--glass-blur\)\)/s, "the tab strip is a big surface and must frost the background like the cards do");
const offChatResets = [...styles.matchAll(/html\.has-app-background \.app-shell:not\(\.chat-open\)([^{]*)\{([^}]*)\}/gs)].filter(function (rule) { return /background:\s*transparent/.test(rule[2]); });
assert.equal(offChatResets.length, 0, "no off-chat rule may clear a fill any more");
assert.doesNotMatch(styles, /\.section-tabs\s*\{[^}]*background:\s*transparent/s, "the tab strip track must stay filled");

// 这三块是"外框": 不管有没有背景都浮在内容之上, 所以无条件玻璃, 不能挂在开关上。
assert.match(styles, /\.topbar\s*\{[^}]*background:\s*var\(--glass\)[^}]*;\s*backdrop-filter:\s*blur\(var\(--glass-blur\)\)/s, "the app title bar must always be frosted glass");
assert.match(styles, /\.bottom-nav\s*\{[^}]*position:\s*fixed[^}]*background:\s*var\(--glass\)[^}]*;\s*backdrop-filter:\s*blur\(var\(--glass-blur\)\)/s, "the bottom bar must always be frosted glass");
// 弹窗挂在 body 上, 不在 .app-shell 里 —— 玻璃色靠 <html> 上的开关传下来, 模糊则要单独给。
assert.match(styles, /html\.has-app-background \.modal-sheet[\s\S]*backdrop-filter:\s*blur\(var\(--glass-blur\)\)/, "dialogs must frost the background behind them");
assert.match(styles, /html\.has-app-background \.toast\s*\{[^}]*background:\s*var\(--glass\)/s, "the hard-coded toast colour would stay an opaque slab over the app background");
assert.doesNotMatch(chatSource, /has-chat-background/, "the chat module must not keep the retired chat-scoped switch");
assert.match(chatSource, /root\s*=\s*document\.documentElement[\s\S]*root\.classList\.toggle\('has-app-background'/, "the glass switch must sit on <html>: dialogs and toasts are mounted on body, outside the shell");
assert.match(chatSource, /LAST_CONVERSATION_KEY\s*=\s*'last-conversation'[\s\S]*rememberConversation[\s\S]*refreshAppBackground/, "the app background must be inherited from the most recently opened conversation");
assert.match(chatSource, /refreshAppBackground[\s\S]*remembered\.id[\s\S]*conversation\.background/, "the app background must be re-derived from the remembered conversation, never from a stale copy");
assert.match(chatSource, /app\.features\.chat = \{[^}]*refreshAppBackground:\s*refreshAppBackground/, "the app shell needs to be able to repaint the background at boot");
assert.match(appSource, /refreshAppBackground\(\)[\s\S]*await routeFromHash\(\)/, "the app background must be painted before the first page renders, or it flashes in");
assert.doesNotMatch(styles, /overflow-x:\s*scroll/, "pages and sheets must not force horizontal scrolling");
assert.doesNotMatch(styles, /width:\s*100vw/, "viewport-width sheets can create a horizontal scrollbar");
assert.match(styles, /\.modal-backdrop\s*\{[^}]*right:\s*0[^}]*left:\s*0[^}]*width:\s*100%/s, "sheet backdrops must explicitly span the viewport on older WebViews");
assert.match(styles, /\.modal-sheet\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%/s, "every sheet must fill the backdrop width");
assert.match(styles, /\.modal-actions\s*\{[^}]*display:\s*grid[^}]*gap:\s*18px/s, "sheet action buttons must use a grid gap");
assert.match(styles, /\.topbar-actions\s*\{[^}]*gap:\s*var\(--space-button-group\)/s, "top bar buttons need a normal gap");
assert.match(styles, /\.title-version\s*\{[^}]*margin-left:\s*var\(--space-icon-text\)/s, "the app name and version need an explicit legacy-WebView gap");
assert.match(styles, /\.service-manage\s*\{[^}]*display:\s*grid[^}]*gap:\s*10px/s, "service card buttons need a legacy-WebView grid gap");
assert.match(styles, /\.row,\s*\.row-between\s*\{[^}]*gap:\s*var\(--space-button-group\)/s, "generic horizontal button rows need a normal gap");
assert.match(styles, /\.avatar-actions\s*\{[^}]*gap:\s*var\(--space-button-group\)/s, "avatar action buttons need a normal gap");
assert.match(styles, /\.message-meta\s*\{[^}]*gap:\s*4px/s, "message action buttons need a compact normal gap");
assert.match(styles, /\.role-actions\s*\{[^}]*display:\s*grid[^}]*gap:/s, "role card buttons must use a grid gap");
assert.match(styles, /\.conversation-head\s*>\s*\.avatar-stack\s*\{[^}]*margin-right:\s*16px/s, "conversation cards need an explicit avatar-to-text gap on legacy WebView");
assert.match(styles, /\.conversation-open\s*\{[^}]*display:\s*block/s, "the conversation card body must stay a block so the role-name row spans the full card width on the legacy WebView");
assert.match(styles, /\.role-card-head\s*>\s*\.avatar\s*\{[^}]*margin-right:/s, "role cards need an explicit avatar-to-text gap on legacy WebView");
assert.match(styles, /\.service-summary\s*>\s*\.service-icon\s*\{[^}]*margin-right:\s*12px/s, "service cards need an explicit icon-to-text gap on legacy WebView");
assert.match(styles, /\.role-choice\s*>\s*\.role-choice-avatar\s*\{[^}]*margin-right:/s, "role selector cards need an explicit avatar-to-text gap on legacy WebView");
assert.match(styles, /\.avatar-editor\s*>\s*\.avatar-picker\s*\{[^}]*margin-right:\s*16px/s, "profile editors need an explicit avatar-to-text gap on legacy WebView");
// 头像底部被切平 + 相机角标被切（2026-09-26 业主）: 根因是 .avatar-editor 的 overflow: hidden 剪掉了
// 「inline-flex 头像装 <img> 时基线落在底边」撑出来的 12px 行盒溢出, 以及 bottom: -4px 的角标。
// 门禁一: 这层永远不许裁切。
assert.doesNotMatch(styles, /\.avatar-editor\s*\{[^}]*overflow:\s*hidden/s, "the avatar editor must not clip: an inline-flex avatar holding an <img> puts its baseline on the box bottom and overflows the line box, which flattens the avatar and cuts the camera badge");
// 门禁二: 从按钮到预览外层必须是 flex 链, 这样根本没有行盒, 也就没有基线溢出。
assert.match(styles, /\.avatar-picker\s*\{[^}]*display:\s*flex/s, "the avatar picker button must be a flex container so its avatar never sits on a baseline");
assert.match(styles, /\.avatar-picker\s*>\s*span:not\(\.avatar-edit-badge\)\s*\{[^}]*display:\s*flex/s, "the avatar preview wrapper must be a flex container too, otherwise the baseline line box comes right back");
assert.match(styles, /\.avatar-edit-badge\s*\{[^}]*bottom:\s*-4px/s, "the camera badge hangs below the avatar on purpose: nothing above it may clip");
assert.match(styles, /\.message-row\.assistant\s*>\s*\.message-avatar-trigger\s*\{[^}]*margin-right:\s*7px/s, "assistant bubble pointers must meet the avatar edge on legacy WebView");
assert.match(styles, /\.message-row\.user\s*>\s*\.message-avatar-trigger\s*\{[^}]*margin-left:\s*7px/s, "user bubble pointers must meet the avatar edge on legacy WebView");
assert.doesNotMatch(styles, /\.message-row\.(?:assistant|user)\s*>\s*\.message-avatar-trigger\s*\{[^}]*margin-(?:right|left):\s*-/, "message bubble pointers must not be pulled behind avatars");
assert.match(styles, /\.message-row\.system\s*\{[^}]*justify-content:\s*center/s, "system history messages must render without pretending to be a user or role bubble");
// 气泡轮廓必须是"一个整体"（用户 2026-09-26: "不要有这里的透明交叉情况, 整个气泡应该是一个整体的轮廓"）。
// 旧的尖角是一个 rotate(45deg) 的 12×12 方块压在气泡缘上, 必然与本体重叠; 没背景时同色看不出,
// 一旦对话设了背景, --surface 变成半透明的 --glass, 重叠区就是两层半透明叠加 ⇒ 明显的菱形补丁。
// **半透明叠半透明没有遮盖修法**, 所以尖角不许回来 —— 这条门禁就是拦住它。
// 尖角回来了（用户 2026-09-26: "气泡上的小尾巴没了…请改进"）。当年失败的原因是那个
// 12×12、rotate(45deg) 的小方块**压在气泡边缘上** ⇒ 与本体必然重叠 ⇒ 两层半透明叠出菱形补丁。
// 这次改成**零重叠**: 整个尖角落在气泡盒子外侧（left/right: -12px）, 靠内那条边正好贴住气泡的边。
// 同日追加: "小尖尖也要和气泡主体一样有很细的描边" ⇒ 单层三角做不到（描边要贴着斜边画）,
// 拆成两层伪元素 —— 下层 z-index 0 是"1px 环", 上层 z-index 1 才是玻璃填充。
// 环靠 clip-path: polygon() 的【外三角 + 反向缠绕内三角】挖洞得到: 探针实测同向缠绕是实心三角,
// 反向缠绕才是干净的一条细线; 把环画成实心外三角则整片尖角被边框色染透（就是"透明交叉"）。
assert.doesNotMatch(styles, /message-bubble::(?:before|after)[^}]*rotate\(45deg\)/, "a rotated tail square always overlaps the bubble body: two stacked translucent layers read as one crossing patch");
assert.match(styles, /\.message-row\.assistant \.message-bubble::before\s*\{[^}]*left:\s*-12px[^}]*background:\s*var\(--border\)/s, "the assistant tail's stroke ring must sit entirely outside the bubble box and use the body's own border colour");
assert.match(styles, /\.message-row\.user \.message-bubble::after\s*\{[^}]*right:\s*-12px[^}]*background:\s*var\(--accent-border\)/s, "the user tail's stroke ring must mirror that, using the user bubble's border colour");
// 环必须是"带洞的六点多边形"（外三角 3 点 + 反向缠绕的内三角 3 点）, 3 点就是实心三角、整片染色。
assert.match(styles, /\.message-row\.assistant \.message-bubble::before\s*\{[^}]*clip-path:\s*polygon\([^)]*,[^)]*,[^)]*,[^)]*,[^)]*,[^)]*\)/s, "the tail stroke must be a hollow ring (a six-point polygon), or the translucent fill picks up the border colour across the whole tail");
assert.equal((styles.match(/message-bubble::(?:before|after)[^}]*clip-path:\s*polygon\(/g) || []).length, 4, "both tails need both layers: a ring and a fill");
assert.match(styles, /\.message-row\.assistant \.message-bubble::after,\s*\.message-row\.user \.message-bubble::before\s*\{[^}]*z-index:\s*1[^}]*width:\s*12px[^}]*height:\s*18px[^}]*backdrop-filter:\s*blur\(/s, "the tail needs its own frost, or it reads as an unfrosted patch beside a frosted body");
// 尖角不许悬空（用户 2026-09-26: "避免气泡主体高度小于标准一行高导致小尖尖悬空"）:
// 两层都用 min(10px, 100% - 16px) 定位, 气泡矮下去时跟着上提, 内三角的底边永不越过气泡底边;
// 再加 .message-bubble 的 min-height 保证气泡至少一行高, 让上面那条 min() 正常情况下取不到后一项。
assert.equal((styles.match(/top:\s*min\(10px,\s*calc\(100% - 16px\)\)/g) || []).length, 2, "both tail layers must clamp their top so a short bubble cannot leave the tail hanging below it");
assert.match(styles, /\.message-bubble\s*\{[^}]*min-height:\s*calc\(26px \+ 1\.65 \* 15px\)/s, "the bubble must be at least one line tall, or the tail has no room and dangles");
assert.match(styles, /\.message-row\.assistant \.message-bubble::before,\s*\.message-row\.user \.message-bubble::after\s*\{[^}]*z-index:\s*0[^}]*top:\s*min\(10px/s, "the stroke ring must paint under the frosted fill, or it covers the tail");
// 方向感只剩"朝向说话人那一侧圆角收小"这一条, 别把它一起清了。
assert.match(styles, /\.message-bubble\s*\{[^}]*border-radius:\s*6px\s+16px\s+16px\s+16px/s, "the assistant bubble needs its flattened top-left corner to show who is speaking");
assert.match(styles, /\.message-row\.user \.message-bubble\s*\{[^}]*border-radius:\s*16px\s+6px\s+16px\s+16px/s, "the user bubble needs its flattened top-right corner to show who is speaking");
// 反色文字阴影（用户 2026-09-26: "白字黑阴影, 黑字白阴影, 字跟着主题变, 阴影也跟着变";
// 同日追加: "对话页面里那些'沉浸'在背景上的元素 —— 名字、时间、气泡操作按钮、屏幕底部提示等 —— 都要加"）。
// 这两个色值就是"正文颜色的反色": 浅色主题的正文是深色 ⇒ 描边是白; 深色主题反过来。
// 明暗两套都给一份, 三处（:root / [data-theme=dark] / prefers-color-scheme）缺一不可。
assert.match(tokens, /--text-halo:\s*rgba\(255,\s*255,\s*255/, "the light theme needs a light halo behind its dark text");
assert.equal(tokens.match(/--text-halo:\s*rgba\(0,\s*0,\s*0/g).length, 2, "both dark-theme blocks need a dark halo behind their light text");
// 阴影整体收在一个 token 里, 免得色值与两个半径散在各处。
// 反色阴影必须是"向外扩的一圈实心描边", 不是模糊光晕（用户 2026-09-26: "阴影应该是向外扩不向内
// 收缩"）。大半径模糊会糊住笔画边缘, 字看着发虚、变细 —— 那正是"向内收缩"这个说法的来源。
assert.doesNotMatch(tokens, /--text-halo-shadow:[^;]*0 0 7px/, "a wide blur eats into the strokes and reads as the text shrinking inward");
assert.match(tokens, /--text-halo-shadow:[^;]*1px 1px 0 var\(--text-halo\)[^;]*1px -1px 0 var\(--text-halo\)/, "the halo must be built from 1px corner offsets so it can only grow outward");
// 四个"直接坐在背景上"的容器一个都不能漏: 角色名、气泡下方的时间与四个操作按钮、
// 日期分隔条、输入框玻璃下方的"本轮完成 / 草稿已保存"。
assert.match(styles, /\.message-name,\s*\.message-meta,\s*\.date-divider,\s*\.composer-footer\s*\{[^}]*text-shadow:\s*var\(--text-halo-shadow\)/s, "every element that sits straight on the app background needs the halo — names, timestamps, action buttons and the composer footer");
// 同一条还需把它们从灰改成正文色（用户 2026-09-26: "时间和名称、icon 都用黑色或白色, 不要用灰色了;
// 对话最底部的提示文字也是用黑色或白色"）。--text 就是本主题的黑/白, 别写死 #000/#fff（深色主题要反过来）。
assert.match(styles, /\.message-name,\s*\.message-meta,\s*\.date-divider,\s*\.composer-footer\s*\{[^}]*color:\s*var\(--text\)/s, "these labels must use the theme's black/white, not a grey");
// .message-meta 上一旦出现 overflow: hidden, 时间与四个图标的阴影会被沿 padding box 整段裁掉 ——
// 这一行等于完全没有阴影, 而名字、日期条看起来是有的, 光读代码很难发现（用户 2026-09-26 报的
// 正是"气泡下面的 icon 没有反色阴影"）。阴影必须能溢出盒子, 这条规则就是拦住它的。
assert.doesNotMatch(styles, /\.message-meta\s*\{[^}]*overflow:\s*hidden/s, "overflow: hidden on .message-meta clips the halo off the timestamp and every icon with it");
// 「已压缩」徽章挂在 .message-meta 里, 同样坐在背景上, 也不许再用灰色。
assert.match(styles, /\.frozen-badge\s*\{[^}]*color:\s*var\(--text\)[;}]/s, "the compressed badge sits on the background too, so it must be black or white");
// 消息列表区域里剩下的几处灰: 空对话的欢迎语与起始按钮、打字指示器的三个点。
assert.match(styles, /\.chat-welcome p\s*\{\s*color:\s*var\(--text\)/s, "the empty-chat welcome copy lives in the message area and must not be grey");
assert.match(styles, /\.starter\s*\{[^}]*color:\s*var\(--text\)[;}]/s, "the starter chips must not be grey either");
assert.doesNotMatch(styles, /\.typing-bubble span\s*\{[^}]*var\(--text-soft\)/s, "the typing dots must use the text colour, not grey");
// 四个容器被点名之后, 里面这些小字不能再自己写回灰：写了就会盖掉上面那条（选择器更具体）。
assert.doesNotMatch(styles, /\.message-meta\s*\{[^}]*color:\s*var\(--text-(?:soft|faint)\)/s, "the timestamp and icon buttons must not fall back to grey");
assert.doesNotMatch(styles, /\.date-divider\s*\{[^}]*color:\s*var\(--text-(?:soft|faint)\)/s, "the date divider must not fall back to grey");
assert.doesNotMatch(styles, /\.composer-footer\s*\{[^}]*color:\s*var\(--text-(?:soft|faint)\)/s, "the composer footer must not fall back to grey");
assert.doesNotMatch(styles, /#draftStatus\s*\{[^}]*color:\s*var\(--text-(?:soft|faint)\)/s, "the draft indicator must not fall back to grey either");
assert.doesNotMatch(styles, /\.context-badge\s*\{[^}]*color:\s*var\(--text-(?:soft|faint)\)/s, "the badges live inside .message-meta and would be the only grey left there");
// 消息列表上下两条渐隐带: 消息滚到玻璃底下之前先淡出, 不留"被玻璃边缘切一刀"的半截轮廓。
// 上下渐隐带**不能用 mask**（用户 2026-09-26: "气泡的磨砂透明效果也没有了"）。
// mask 会给 .message-list 建一个 backdrop root, 气泡的 backdrop-filter 于是只采样列表内部的像素,
// 采样不到页面上那层背景图 ⇒ 磨砂整个失效。探针实测: 有 mask 祖先时高频条纹原样清晰,
// 没有 mask 祖先时被糊成灰面。现在改成"自己画一层背景图 + alpha 渐变"（.message-fade）:
// 视觉上与 mask 渐隐等价, 但它只是一个背景层, 不建 backdrop root。
// 下边带的锚点还必须是 --viewport-height 而不是 100%: 盒高钉在"正常视口"（键盘弹起时仍是 780）,
// 输入区顶边却跟着可视区上移 ⇒ 拿 100% 当锚, 渐隐带会留在下面一百多像素, 中间的消息硬切在输入区上沿。
assert.doesNotMatch(styles, /\.message-list\s*\{[^}]*mask-image/s, "a mask on the scroll container creates a backdrop root and kills every bubble's frosted glass");
assert.match(styles, /\.message-fade\s*\{[^}]*position:\s*fixed[^}]*height:\s*var\(--viewport-full-height/s, "the fade bands must use the app background's own box, or the two layers do not line up");
assert.match(styles, /\.message-fade\s*\{[^}]*background-image:\s*var\(--chat-background[^}]*background-size:\s*var\(--chat-background-size[^}]*background-position:\s*var\(--chat-background-position/s, "the fade band must reproduce the app background's framing exactly");
assert.match(styles, /\.message-fade\.is-top\s*\{[^}]*linear-gradient\(to bottom,\s*#000 0,\s*transparent var\(--chat-topbar/s, "the top band must cover the content under the floating top bar");
assert.match(styles, /\.message-fade\.is-bottom\s*\{[^}]*transparent calc\(var\(--viewport-height,\s*100%\) - var\(--chat-composer-h\) - var\(--chat-list-fade\)\)[^}]*#000 calc\(var\(--viewport-height,\s*100%\) - var\(--chat-composer-h\)\)/s, "the bottom band must be anchored to the live viewport, not to the pinned background box, or the keyboard leaves a hard-cut bubble above the composer");
assert.match(styles, /\.message-list\s*\{[^}]*padding:[^;}]*calc\(var\(--chat-composer-h\)/s, "the list's bottom padding must clear the composer, or the newest message gets faded while resting at the bottom");
// 列表铺满整屏 + 输入区浮在上层（用户 2026-09-26: "消息列表底部要到屏幕底部…不是到输入框组件结束"）。
assert.match(styles, /\.chat-layout\s*\{[^}]*--chat-composer-h:\s*0px/s, "the chat layout must publish the composer's measured height");
assert.match(styles, /\.composer\s*\{[^}]*position:\s*absolute[^}]*z-index:\s*25/s, "the composer must float above the full-height message list");
assert.match(styles, /\.jump-latest\s*\{[^}]*z-index:\s*15[^}]*bottom:\s*calc\(var\(--chat-composer-h\)/s, "the back-to-latest button must clear the floating composer");
assert.match(chatSource, /setProperty\('--chat-composer-h'/, "the shell must measure the composer instead of hard-coding its height");
assert.match(chatSource, /new ResizeObserver\(target\.syncComposerInset\)/, "the composer grows with multi-line drafts and the attachment tray, so it must be observed");
assert.match(styles, /\.moderator-avatar-trigger\s*>\s*\.avatar\s*\{[^}]*box-shadow:\s*0 0 0 2px var\(--accent\)/s, "group moderator portraits need a thin bright-yellow ring");
assert.match(styles, /\.auto-role-toggle\[aria-checked="true"\][^}]*background:\s*var\(--accent\)/s, "the magic-wand auto-selection switch needs a clear enabled state");
assert.match(styles, /\.crop-toolbar\s*\{[^}]*display:\s*grid[^}]*gap:/s, "crop controls must use a grid gap");
assert.match(styles, /\.crop-stage\s*\{[^}]*height:\s*min\(420px,\s*calc\(100vw - 44px\)\)/s, "the crop viewport needs a CSP-safe responsive square height on the legacy WebView");
assert.match(styles, /\.crop-stage canvas\s*\{[^}]*width:\s*100%[^}]*height:\s*100%/s, "the canvas preview must fill the responsive crop viewport");
const uiSource = fs.readFileSync(path.join(root, "app/components/ui.js"), "utf8");
assert.doesNotMatch(uiSource, /class="avatar[^\n]*style="/, "avatar markup must not be rejected by the device CSP as an inline style");
assert.doesNotMatch(uiSource, /\bstyle\s*=\s*["']/, "the crop viewport must not emit a style attribute rejected by the device CSP");
assert.match(uiSource, /crop-frame[\s\S]*crop-handle/, "the crop viewport frame must stay a styled element with its handles");
assert.match(uiSource, /touchstart[\s\S]*mousedown/, "the crop viewport needs touch and mouse fallbacks when Pointer Events are unavailable");
assert.match(styles, /\.chip-row\s*>\s*\.chip\s*\{[^}]*margin:/s, "wrapping role buttons need explicit margins");
assert.match(styles, /\.starter-list\s*>\s*\.starter\s*\{[^}]*margin:/s, "starter buttons need explicit margins");
assert.match(styles, /\.bottom-nav\s*\{[^}]*position:\s*fixed[^}]*right:\s*0[^}]*bottom:\s*0[^}]*left:\s*0/s, "mobile tab navigation must be fixed to the viewport from first paint");
const conversationsSource = fs.readFileSync(path.join(root, "app/features/conversations.js"), "utf8");
assert.match(conversationsSource, /想聊就聊，自由自在/);
assert.match(conversationsSource, /comment-dots[\s\S]*data-connection-guide/, "the welcome taxi glyph must be replaced by a chat bubble with a model connection guide");
assert.match(conversationsSource, /data-guide-tab="beginner"[\s\S]*data-guide-tab="professional"[\s\S]*data-guide-tab="international"[\s\S]*data-guide-tab="troubleshooting"/, "the connection guide needs all four requested tabs");
assert.match(conversationsSource, /guide-address-row[\s\S]*ui\.copyUrl[\s\S]*bindCopyUrls/, "guide URLs must use the shared inline copy control");
assert.doesNotMatch(conversationsSource, /guide-links|arrow-up-right-from-square/, "guide URLs must not retain link styling");
assert.match(uiSource, /function copyUrl[\s\S]*data-copy-url[\s\S]*icon\("copy"\)[\s\S]*<code>[\s\S]*function bindCopyUrls/, "displayed URLs must place the shared copy icon before the address text");
assert.match(modelsSource, /service-endpoint[\s\S]*ui\.copyUrl[\s\S]*bindCopyUrls/, "model service endpoints must use the shared inline copy control");
assert.match(styles, /\.copy-url\s*\{[^}]*display:\s*inline-block[^}]*overflow-wrap:\s*anywhere/s, "copyable URLs must stay inline and wrap inside the viewport");
assert.match(styles, /\.connection-guide-sheet\s*\{[^}]*height:\s*75%[^}]*max-height:\s*75%/s, "the connection guide sheet must keep a stable 75 percent viewport height");
assert.match(styles, /\.section-tabs\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*nowrap/s, "all section tab groups must stay on one row");
assert.match(styles, /\.section-tabs button\s*\{[^}]*padding:\s*10px 6px[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s, "tab buttons need compact horizontal padding and ellipsis");
assert.match(conversationsSource, /搜索对话、角色或全部消息/);
assert.match(conversationsSource, /ensureSearchIndex[\s\S]*store\.messages\(conversations\[i\]\.id\)/, "conversation search must lazily index every stored message");
assert.match(conversationsSource, /共 ["']?\s*\+\s*conversations\.length\s*\+\s*["'] 个对话/, "conversation total belongs below the search field");
assert.match(conversationsSource, /role-choice-avatar[\s\S]*roles\.openEditor/, "conversation participants need a direct role settings entry");
assert.match(conversationsSource, /selectionOrder[\s\S]*moderatorRoleId:\s*selected\[0\]/, "the first selected participant must remain the moderator and first stored role");
assert.match(conversationsSource, /data-moderator-badge[\s\S]*主持/, "conversation settings must visibly mark the moderator");
assert.match(conversationsSource, /data-menu="settings"[\s\S]*常规设定/, "conversation management must open the merged conversation settings");
// 对话背景在列表页的卡片菜单里也要能进：与对话内菜单共用同一个面板，
// 但列表页没有开着的聊天实例，所以只传 conversationId。
assert.match(conversationsSource, /data-menu="background"[\s\S]*ui\.icon\('image'\)[\s\S]*对话背景/, "the conversation-list card menu must also offer the background panel");
assert.match(conversationsSource, /command === 'background'\) return app\.features\.chat\.backgroundSettings\(id\)/, "the list-page background entry must reuse the chat background panel");
// 全局背景 = 最近打开过的那个对话的背景, 所以删掉它之后必须重算 —— 否则会把一个已经不存在
// 的对话的背景继续铺在整个应用上。三个删除入口都要管: 列表页卡片菜单、对话内菜单、清空数据。
assert.match(conversationsSource, /deleteConversation\(id\)[\s\S]*refreshAppBackground\(\)/, "deleting the conversation that supplied the app background must repaint it");
assert.match(chatSource, /deleteConversation\(conversation\.id\)[\s\S]*refreshAppBackground\(\)/, "deleting the chat that supplied the app background must repaint it too");
assert.match(chatSource, /close: close, backgroundSettings: backgroundSettings/, "the background panel must be reachable outside the chat feature");
assert.match(conversationsSource, /CONVERSATION_SETTING_TABS[\s\S]*基础设定[\s\S]*个人设定[\s\S]*场景设定/, "basic, profile and scene settings must live in one modal as three sub-tabs");
assert.match(conversationsSource, /conversation-settings-sheet/, "the merged settings modal must reuse the fixed-height sheet");
assert.match(conversationsSource, /submitText: editing \? "保存更改" : "开始对话"/, "the new-conversation dialog must share the merged settings content");
assert.match(conversationsSource, /data-edit-participant[\s\S]*roles\.openEditor/, "participant avatars must open the standard role editor");
assert.match(chatSource, /id="autoRoleToggle"[\s\S]*wand-magic-sparkles/, "group chat needs the right-side magic-wand auto-selection switch");
assert.match(chatSource, /data-chat-menu="settings"[\s\S]*常规设定/, "open-chat management must reach the same merged conversation settings");
assert.doesNotMatch(chatSource, /自动选角开发记录|data-chat-menu=["']routing-records/, "routing diagnostics must stay out of the user interface");
assert.doesNotMatch(styles, /\.routing-record(?:-output)?\s*\{/, "removed routing diagnostics UI must not leave unused styles");
assert.match(chatSource, /aria-disabled', 'true'\); edit\.title = '历史已被压缩，请修改压缩概要'/, "compressed history must keep its pencil visible but disabled and explain why");
assert.match(chatSource, /toLocaleDateString\(app\.i18n\.locale\(\)/, "message date dividers must follow the interface language instead of a hardcoded Chinese locale");
assert.match(chatSource, /is-frozen[\s\S]*frozen-badge/, "compressed history must be marked as frozen in the message meta");
assert.match(chatSource, /updateSummaryText\(target\.conversation\.id,/, "the chat menu must save the compression summary through the context service");
assert.match(chatSource, /!currentBusy\(target\)\) status\(target, '正在压缩历史上下文…'\)/, "background compression must not overwrite the status of an in-flight turn");
assert.match(styles, /\.message-row\.is-frozen[\s\S]*opacity:\s*\.6/, "compressed history must render in a faded frozen style");
assert.match(styles, /\.frozen-badge\s*\{[^}]*display:\s*inline-flex/s, "the frozen badge must stay inline next to the timestamp");
const rolesSource = fs.readFileSync(path.join(root, "app/features/roles.js"), "utf8");
for (const label of ["角色档案", "语言模型", "朗读发音"]) assert.match(rolesSource, new RegExp(label));
assert.match(html, /app\/data\/role-templates\.js/, "the role template catalog must load before the role feature");
assert.match(rolesSource, /!editing \? '<button[^']*data-open-role-templates/, "only the new-role editor may expose the template gallery");
assert.match(rolesSource, /template\.name[\s\S]*template\.systemPrompt[\s\S]*template\.behaviorGuidance[\s\S]*syncAvatar\(\)/, "template selection must fill the identity, the behavior guidance and the avatar");
assert.match(rolesSource, /name="systemPrompt" rows="4"/, "the identity and personality field must be a four-row input");
assert.match(rolesSource, /name="behaviorGuidance" rows="4"/, "the behavior guidance field must be a four-row input");
assert.match(rolesSource, /DEFAULT_BEHAVIOR_GUIDANCE_EN[\s\S]*defaultBehaviorGuidance\(\)/, "new roles must start from the bilingual default behavior guidance");
assert.match(rolesSource, /systemPrompt: u\.formValue\(target, "systemPrompt"\)[\s\S]*behaviorGuidance: u\.formValue\(target, "behaviorGuidance"\)/, "the role editor must persist the behavior guidance");
assert.doesNotMatch(rolesSource.match(/openTemplateGallery\(async function \(template\)[\s\S]*?\}\); \}\)\);/)[0], /llmProfileId|ttsProfileId|openingScene/, "template selection must not replace model, voice or scene settings");
assert.match(styles, /\.role-template-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s, "the mobile gallery must use a compact two-column card grid");
assert.match(styles, /\.role-template-profession\s*\{[^}]*-webkit-line-clamp:\s*2/s, "long professions must stay visually balanced");
assert.match(rolesSource, /data-role-avatar-name>[\s\S]*未命名[\s\S]*点击头像更换[\s\S]*使用模版/, "the avatar row must show the live role name, concise replacement hint and template action");
assert.match(rolesSource, /function syncAvatar\(\)[\s\S]*data-role-avatar-name[\s\S]*name \|\| "未命名"/, "the avatar heading must follow role-name edits");
assert.match(rolesSource, /role-template-help">点击角色卡片直接应用/, "the gallery must use the concise direct-apply hint");
assert.match(rolesSource, /data-template-tab="all"[\s\S]*全部[\s\S]*data-template-tab="male"[\s\S]*男性[\s\S]*data-template-tab="female"[\s\S]*女性[\s\S]*data-template-tab="other"[\s\S]*其他/, "the gallery needs all, male, female and other category tabs");
assert.match(rolesSource, /activeTab !== "all"/, "the default all tab must keep every template visible");
assert.match(rolesSource, /data-template-category[\s\S]*classList\.toggle\("is-hidden"/, "template tabs must filter the visible cards without rebuilding the editor");
assert.match(styles, /\.role-template-trigger\s*\{[^}]*min-height:\s*68px[^}]*flex-direction:\s*column/s, "the gallery trigger must stack the mosaic and small label at the right of the avatar row");
assert.match(styles, /\.role-template-card\s*\{[^}]*min-height:\s*210px[^}]*padding:\s*14px 10px 8px/s, "template cards need a smaller bottom inset below age and gender");
const templateContext = vm.createContext({ window: { chataxi: { data: {} } } });
const templateSource = fs.readFileSync(path.join(root, "app/data/role-templates.js"), "utf8");
vm.runInContext(templateSource, templateContext, { filename: "app/data/role-templates.js" });
const templateCatalog = templateContext.window.chataxi.data.roleTemplates;
assert.equal(templateCatalog.sourceSchemaVersion, 2);
assert.equal(templateCatalog.count, 27);
assert.equal(templateCatalog.items.length, 27);
assert.deepEqual(Object.fromEntries(["male", "female", "other"].map(category => [category, templateCatalog.items.filter(item => item.category === category).length])), { male: 9, female: 9, other: 9 });
assert.equal(new Set(templateCatalog.items.map(item => item.id)).size, 27);
assert.equal(new Set(templateCatalog.items.map(item => item.name)).size, 27);
assert.equal(new Set(templateCatalog.items.map(item => item.nameEn)).size, 27, "English template names must be unique");
assert.ok(templateCatalog.items.every(item => item.categoryLabelEn), "every template needs a bilingual category label");
for (const template of templateCatalog.items) {
  assert.ok(template.name && template.profession && template.categoryLabel && template.systemPrompt, `${template.id} has incomplete display or role data`);
  assert.ok(template.nameEn && template.professionEn && template.systemPromptEn, `${template.id} has incomplete English display or role data`);
  assert.ok(template.systemPrompt.includes(template.name), `${template.id} prompt must identify the character by name`);
  assert.ok(template.systemPromptEn.includes(template.nameEn), `${template.id} English prompt must identify the character by name`);
  assert.ok(template.behaviorGuidance && template.behaviorGuidanceEn, `${template.id} has incomplete behavior guidance`);
  assert.equal(template.behaviorGuidance.split("\n").length, 3, `${template.id} behavior guidance must keep three separate rules`);
  assert.equal(template.behaviorGuidanceEn.split("\n").length, 3, `${template.id} English behavior guidance must keep three separate rules`);
  assert.doesNotMatch(template.behaviorGuidanceEn, /[\u4e00-\u9fff]/, `${template.id} English behavior guidance must not contain Chinese`);
  assert.doesNotMatch(template.behaviorGuidance, /身份性格/, `${template.id} behavior guidance must not describe who the character is`);
  assert.doesNotMatch(template.nameEn, /[\u4e00-\u9fff]/, `${template.id} English name must not contain Chinese`);
  assert.doesNotMatch(template.professionEn, /[\u4e00-\u9fff]/, `${template.id} English profession must not contain Chinese`);
  if (template.category === "other") assert.equal(template.age, null, `${template.id} must not invent a non-human age`);
  else assert.ok(Number(template.age) >= 18, `${template.id} must retain its adult age`);
  assert.equal("openingScene" in template, false, `${template.id} must not carry scene design into this feature`);
  const avatarPath = path.join(root, template.avatar.replace(/^\.\//, "")), bytes = fs.readFileSync(avatarPath);
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF", `${template.id} avatar must be WebP`);
  assert.equal(bytes.subarray(8, 12).toString("ascii"), "WEBP", `${template.id} avatar must use the WebP codec`);
  assert.ok(bytes.length <= 80 * 1024, `${template.id} avatar is unexpectedly large`);
}
const mosaicBytes = fs.readFileSync(path.join(root, "app/assets/role-templates/template-mosaic.webp"));
assert.equal(mosaicBytes.subarray(8, 12).toString("ascii"), "WEBP", "template entry mosaic must be a packaged WebP");
assert.match(rolesSource, /repairElevenLabsVoiceNames[\s\S]*discover\("tts", refreshed, \{ persist: false \}\)[\s\S]*store\.put\("tts-profiles"/, "legacy ElevenLabs ID-only voice catalogs must recover account names before the role picker is built");
assert.match(rolesSource, /已上线/); assert.match(fs.readFileSync(path.join(root, "app/services/profiles.js"), "utf8"), /已下线/);
const settingsSource = fs.readFileSync(path.join(root, "app/features/settings.js"), "utf8");
for (const label of ["界面", "对话", "压缩", "系统"]) assert.match(settingsSource, new RegExp(label));
assert.match(settingsSource, /作者[\s\S]*zhyuzh3d/);
assert.match(settingsSource, /tapCount\s*\+=\s*1[\s\S]*tapCount\s*<\s*3[\s\S]*setRuntimeMode\("live"\)/, "local to live needs three deliberate taps");
assert.match(settingsSource, /改为本地运行[\s\S]*setRuntimeMode\("local"\)/);
for (const name of ["conversations", "roles", "models", "profile"]) assert.match(settingsSource, new RegExp('toggle\\("' + name + '"'));
// 压缩滑竿的三个界限是产品约定：触发 4000~32000、保留 2000~10000、目标 500~2000。
assert.match(settingsSource, /range\("compressionThresholdChars", "触发字数"[\s\S]{0,80}4000, 32000,/, "trigger length must span 4000~32000");
assert.match(settingsSource, /range\("compressionRetainChars", "压缩保留字数"[\s\S]{0,80}2000, 10000,/, "retention length must span 2000~10000");
assert.match(settingsSource, /range\("compressionTargetChars", "压缩目标"[\s\S]{0,80}500, 2000,/, "compression target must span 500~2000");
assert.match(settingsSource, /\["compressionThresholdChars", "compressionRetainChars", "compressionTargetChars", "ttsReverbMix"[^\]]*\]\.forEach/, "every compression number must round-trip through the settings form");
assert.doesNotMatch(conversationsSource, /name="recentFullMessages"|data-output="recentFullMessages"/, "the per-conversation retained-N control must be gone");
// 朗读音效的设置项（用户 2026-09-26: 先要"设置-对话下面增加一个打开混响的开关" + "滑竿调节强度";
// 同日追加: "混响和环境声不用开关, 默认滑竿 0 就是关, 不是 0 就是打开。所以可以去掉 Switch
// 开关控件, 只留强度滑竿了, 合并"）。
// 开关控件必须**不存在** —— 留着就是界面上两处表达同一件事, 而"到底关不关"又说不清。
assert.doesNotMatch(settingsSource, /toggle\("ttsReverb"/, "the reverb switch control must be gone: the slider itself is the switch");
assert.doesNotMatch(settingsSource, /toggle\("ttsAmbience"/, "the ambience switch control must be gone too");
assert.doesNotMatch(settingsSource, /linkSlider/, "with no switches there is nothing left to link; a leftover linkSlider would grey the sliders out for good");
// 滑竿标题合并成功能名（原开关的标题）, 拉到 0 就是关。量程由用户 2026-09-26 收尾指定:
// "把当前的两个实际范围值都映射成为滑竿的 0~100" —— 两根滑竿现在都是 0~100。
// 环境声那侧只放大刻度: 天花板当时仍是 0.08, 存档旧值由 store 的迁移一并 ×2, 默认值跟着换成 60。
// 0.7.24 业主再把两根滑竿映射出的值各 ×2 ⇒ 天花板 0.08 → 0.16（读数与存档照旧不动）。
assert.match(settingsSource, /range\("ttsReverbMix", "朗读房间混响"[\s\S]{0,110}0, 100, 5, "%"/, "reverb is a 0~100% slider whose 0 means off");
assert.match(settingsSource, /range\("ttsAmbienceMix", "背景环境声"[\s\S]{0,110}0, 100, 5, "%"/, "ambience must be the same 0~100% slider, so both controls read on one scale");
// 存档里的旧值可能超出滑竿量程。显示值必须按**各自的**量程钳一次, 否则升级上来的人会看到读数
// 写着 120% 而滑竿卡在最右端 —— 一个看起来像坏掉、又没人知道是这次改量程造成的界面。
assert.match(settingsSource, /ttsReverbMix == null \? 35 : Math\.min\(100, settings\.ttsReverbMix\)/, "the reverb slider must default to 35 and clamp stale values into its 0~100 range");
assert.match(settingsSource, /ttsAmbienceMix == null \? 60 : Math\.min\(100, settings\.ttsAmbienceMix\)/, "the ambience slider must default to 60 and clamp stale values into its 0~100 range");
// 设置页与"我的"页的内容块不再自带底板（用户 2026-09-26: "设置-界面、对话、压缩上的组件也不应该
// 有背景（参考设置-系统就是对的）" 与 "我的-各种组件直接沉浸落在背景上, 不应该有整体背景, 只是输入
// 控件有背景"）。判据必须落在**类名**上而不是 background 上:
//   设了对话背景时那块"整体背景"的真正来源是 html.has-app-background .card 补的 backdrop-filter
//   —— 填充早就被清成 transparent 了, 可模糊不看填充: 元素自己透明, 被它折射的背照照样糊出一块
//   矩形。所以只把 background 改成 transparent 永远修不掉它, 必须让这几个面板不再是 .card。
assert.doesNotMatch(settingsSource, /class="card card-body form-grid settings-panel/, "the settings panels must not be cards: their frosted backdrop is what reads as an overall background");
assert.match(settingsSource, /class="form-grid settings-panel/, "the settings panels keep their layout hook and take padding from CSS instead of from .card-body");
const meSource = fs.readFileSync(path.join(root, "app/features/me.js"), "utf8");
assert.doesNotMatch(meSource, /class="card/, "the profile page's blocks must sit on the background: only input controls keep a surface");
assert.match(meSource, /class="form-grid my-panel"/, "the profile block keeps its layout hook and takes padding from CSS");
assert.match(styles, /\.settings-page \.settings-panel:not\(\.system-panel\), \.my-page \.my-panel \{ padding: 24px 0; \}/, "the panels that lost their card must keep the spacing the card-body used to provide");
assert.doesNotMatch(styles, /\.settings-page \.card-body/, "no rule may be left clearing padding off a card those pages no longer contain");
// 开关的去向要在存储里交代: 旧布尔字段必须被迁移掉。漏了这一步, "开关关着、滑竿却非零"的人
// 一升级混响就会自己冒出来 —— 那看起来就像个 bug, 而且没人会想到是这次合并造成的。
assert.match(storeSource, /if \(settings\.ttsReverb === false && Number\(settings\.ttsReverbMix\) > 0\) settings\.ttsReverbMix = 0;/, "an explicitly-off reverb switch must migrate to a zeroed slider");
assert.match(storeSource, /if \(settings\.ttsAmbience === false && Number\(settings\.ttsAmbienceMix\) > 0\) settings\.ttsAmbienceMix = 0;/, "same for the ambience switch");
// 环境声量程 50 → 100 的存档迁移: 旧值 ×2, 而且**只能乘一次**（ttsMixRange100 这个一次性标记）。
// "只乘一次"比"乘 2"本身更要紧 —— 漏了标记的话每次 seed() 都会再乘一遍, 用不了几天滑竿就会自己
// 顶到 100 并永远停在满档, 而现象看起来完全不像"量程迁移"造成的, 极难反查。
assert.match(storeSource, /if \(settings\.ttsMixRange100 !== true\) \{[\s\S]{0,300}Math\.min\(100, Math\.max\(0, Number\(settings\.ttsAmbienceMix\)\) \* 2\)[\s\S]{0,80}settings\.ttsMixRange100 = true;/, "stored ambience values must be re-scaled to 0~100, exactly once, behind a one-shot flag");
assert.match(storeSource, /delete settings\.ttsReverb;[\s\S]{0,80}delete settings\.ttsAmbience;/, "the switch fields themselves must not survive the migration");
assert.match(settingsSource, /\["autoSpeak", "autoCompress"\]\.forEach/, "only the real switches round-trip through the settings form now");
// 滑竿读数原来写死 " 字", 混响强度会显示成 "55 字"。单位必须由字段自己带出来。
assert.match(settingsSource, /slider\.dataset\.suffix/, "the range readout must take its unit from the field, not a hardcoded unit");
// "归零即关"必须落在引擎里, 而不只是写在设置页上: 读到 0 就不给湿声、也不开环境声。
assert.match(ttsSource, /var on = reverbEnabled == null \? mix > 0 : Boolean\(reverbEnabled\) && mix > 0;/, "reverb must be off whenever the slider reads 0");
assert.match(ttsSource, /if \(!\(ambMix > 0\)\) \{ stopAmbience\(\); return; \}/, "ambience must be off whenever the slider reads 0");
assert.match(ttsSource, /function mixPercent\(raw, fallback, max\)/, "slider values must be clamped on read: an old stored value can exceed the new cap");
// ------------------------------------------------------------------------------------------
// 朗读音频缓存（用户 2026-09-26）: "相同的文本、相同的模型、相同的音色每次生成的音频文件都是一样的,
// 所以我们如果缓存最近生成的 100 条 TTS 声音… 每次要进行朗读的任务前, 都检查一下 hash 是否存在,
// 如果存在则直接使用已有的音频文件, 不需要再次调用 TTS 接口"。
const ttsCacheSource = fs.readFileSync(path.join(root, "app/services/tts-cache.js"), "utf8");
assert.match(storeSource, /"tts-cache"\]/, "the cache collection must be registered, or store.put refuses the write outright");
assert.match(html, /app\/services\/tts-cache\.js[\s\S]*app\/services\/tts\.js/, "the cache service must load before tts.js");
assert.match(ttsCacheSource, /MAX_ENTRIES = 100/, "the cache holds the 100 most recent clips");
// 键 = **最终请求**的摘要, 不是"文字 + 模型 + 音色"的字面拼接。只哈希那三样, "同句同模型同音色、
// 但改了语速"就会命中旧音频（听感是错的）; 反过来同句的不同语速会各占一条, 100 条额度很快被占满。
assert.match(ttsCacheSource, /String\(request && request\.method[\s\S]{0,160}String\(request && request\.url[\s\S]{0,160}String\(request && request\.bodyText/, "the key must be the digest of the final request, not three literal fields");
assert.match(ttsCacheSource, /window\.crypto\.subtle\.digest\("SHA-256"/, "the digest should be SHA-256, with the weak hash only as a documented fallback");
// 记录里只有文件句柄, 音频本体在媒体库里（用户: "缓存的音频文件应当存在数据库记录中, 包含文件路径"）。
assert.match(ttsCacheSource, /app\.data\.media\.put\(clip\.blob/, "the audio body belongs in the media store, not inside the DB record");
assert.match(ttsCacheSource, /record\.mediaId = mediaRecord\.id/, "the record must carry only the file handle");
assert.match(ttsCacheSource, /var record = \{ hash: hash, kind: ""/, "the record carries its own key so the LRU can address it through list()");
// LRU: 命中要刷新 usedAt（否则退化成 FIFO）, 淘汰要连音频本体一起删（否则 IndexedDB 只增不减）。
assert.match(ttsCacheSource, /record\.usedAt = Date\.now\(\);/, "a hit must refresh usedAt, otherwise LRU degrades into FIFO");
assert.match(ttsCacheSource, /values\.length - MAX_ENTRIES/, "the prune must evict down to the cap");
assert.match(ttsCacheSource, /app\.data\.media\.remove\(record\.mediaId\)/, "eviction must delete the audio body as well as the record");
assert.match(ttsCacheSource, /files\.delete\(\{ logicalFileId: record\.logicalFileId \}\)/, "eviction must also release a cache-owned host file");
// 缓存是加速器不是依赖: 任何一步失败都只能是"这次没命中", 不能把朗读弄成播不出声。
assert.match(ttsCacheSource, /catch \(_\) \{ return null; \}/, "a broken cache must degrade to a miss, never to a failed playback");
// 接进 tts.js: 打接口之前查、拿到音频之后存; speak 还要在**流式之前**查一次。
assert.match(ttsSource, /var cacheKey = await app\.services\.ttsCache\.keyFor\(request\);[\s\S]{0,60}var cached = await app\.services\.ttsCache\.take\(cacheKey\);/, "synthesize must consult the cache before it calls the TTS endpoint");
assert.match(ttsSource, /app\.services\.ttsCache\.store\(cacheKey, sseClip/, "SSE audio must be cached too");
assert.match(ttsSource, /app\.services\.ttsCache\.store\(cacheKey, fileClip/, "the legacy host-file fallback still asks the cache; it now always gets false back, so the file is deleted after playback");
assert.match(ttsSource, /app\.services\.ttsCache\.store\(cacheKey, clip, \{ chars: text\.length/, "inline-base64 audio must be cached");
assert.match(ttsSource, /if \(await app\.services\.ttsCache\.store\(cacheKey, fileClip[\s\S]{0,80}\)\) fileClip\.cacheOwned = true;/, "a cached host file is owned by the cache and must survive the playback");
assert.match(ttsSource, /clip\.logicalFileId && !clip\.cacheOwned/, "disposeClip must spare cache-owned host files");
assert.match(ttsSource, /var cacheKey = await cacheKeyFor\(resolved\.profile, clean\);[\s\S]{0,140}var cachedClip = await app\.services\.ttsCache\.take\(cacheKey\);/, "speak() must check the cache before it opens a streaming path");
// **流式那条路必须回写**。这是用户 2026-09-26 报的那个 bug 的根因: 缓存原来只挂在整段合成那条路上,
// 而 speak() 一旦判定服务支持流式就走流式分支 —— 那条路既不查也不写 ⇒ 支持流式的服务
// "每点一次朗读就重新生成一次", 缓存从头到尾一次都不会命中。只查不写等于没查。
assert.match(ttsSource, /await owner\.finishPcm\(\);[\s\S]{0,140}await cacheStreamedClip\(owner, cacheKey, resolved\.profile, clean\)/, "streamed PCM must be written back under the same key, or a streaming service can never hit");
assert.match(ttsSource, /function cacheStreamedClip\(owner, cacheKey, profile, text\)/, "the streaming writeback needs its own helper: raw PCM has to be wrapped before the cache can hold it");
assert.match(ttsSource, /function wavFromPcm\(chunks, sampleRate, bytes\)/, "raw PCM needs a container, and WAV is the one decodeAudioData already accepts on the existing clip path");
assert.match(ttsSource, /if \(!cacheKey \|\| !owner \|\| owner\.cancelled \|\| !owner\.finished \|\| owner\.cacheOverflow\) return false;/, "a stopped or oversized playback must never enter the cache: a stored half-sentence would be replayed forever, and nothing about it would look like a cache bug");
// 查键与真发出去的请求必须是同一份材料。各拼一遍迟早漂移, 那时缓存要么永不命中, 要么命中错的一条,
// 而这两种错都不会报错。
assert.match(ttsSource, /function nonStreamRequest\(profile, text, stream\)/, "the cache key and the real request must come from one shared builder");
assert.match(ttsSource, /function cacheKeyFor\(profile, text\)/, "speak() needs the same key material synthesize() uses");
// 混响只挂在 Web Audio 总线上, 而宿主播放器（api.audio.play）在 WebView 之外出声 ⇒ 音频根本不进
// AudioContext, 混响器与环境声都挂不上去。宿主对**没有 Content-Length 的响应**一律落成宿主文件
// （NativeHttpClient.request: declaredLength < 0 直接进 file 分支）, ElevenLabs / OpenAI 这类 chunked
// 的 TTS 正好命中 —— 于是那条路上永远没有混响（业主 2026-09-26: "我把混响效果拉到 100 仍然没有混响
// 效果, 之前是有的啊"）。页面按同源 url 去 fetch 也不行: happ 的 CSP 是 connect-src 'none'
// （LocalContentGateway.headers, liveUrl 为空的实例就走这一支）, fetch 会被直接拦掉。
// 唯一的出路是原生字节流: openStream/readStream 把音频原样取回页面 ⇒ Blob ⇒ 带混响的解码路。
assert.match(ttsSource, /async function streamAudioBody\(request, task\)/, "binary speech must come back through the native byte stream, or it lands in a host file that can only play outside the reverb bus");
assert.match(ttsSource, /network\.requestByteStream\(\{/, "the byte stream is the only channel that hands the audio bytes back to the page");
assert.match(ttsSource, /if \(!network \|\| typeof network\.requestByteStream !== "function"\) return null;/, "a host without the byte stream must fall back to network.request instead of losing the playback");
assert.match(ttsSource, /if \(!sseProtocol\) \{\s*var streamed = await streamAudioBody\(request, task\);/, "synthesize must try the byte stream first for every non-SSE service, before falling back to network.request");
assert.match(ttsSource, /if \(error && \(error\.streamUnavailable \|\| error\.code === "E_NETWORK" && error\.retryable === true\)\) return null;/, "only a missing capability or one retryable connection abort may fall back to the old request flow: falling back on any other failure would silently drop the reverb again");
assert.match(ttsSource, /var clip = \{ blob: new Blob\(\[streamed\.bytes\], \{ type: streamed\.mime \}\)/, "the streamed bytes must become a blob clip so the existing decodeAudioData path (the one that feeds the reverb bus) picks it up");
// 缓存侧: 宿主文件条目是 0.7.22 之前的产物, 它既没有混响也取不回字节 ⇒ 当未命中让它自愈, 并且不再写入。
assert.match(ttsCacheSource, /if \(record\.kind === "file"\) return null;/, "a legacy host-file entry can never carry the reverb: treat it as a miss so it heals into a blob entry");
assert.doesNotMatch(ttsCacheSource, /record\.kind = "file"/, "host-file entries must no longer be written: each one would hold a slot and a host file forever without ever being a usable hit");
assert.match(ttsCacheSource, /files\.delete\(\{ logicalFileId: record\.logicalFileId \}\)/, "dropping a legacy host-file record must still release the host file it owned");
// 观感两处（用户 2026-09-26）: 阴影强度收到"原来的 66%"（.5 → .33）; 滚到底时最新那条不能被底部淡出带糊住。
// 明暗两侧必须同值 —— 只改一侧就等于在另一套主题里留下"还是太重"的半个修复。
assert.match(tokens, /--text-halo: rgba\(255, 255, 255, \.33\);/, "the light-theme halo must sit at 66% of its previous strength (.5 -> .33)");
assert.match(tokens, /--text-halo: rgba\(0, 0, 0, \.33\);/, "the dark-theme halo must sit at the same .33, in both dark blocks");
assert.doesNotMatch(tokens, /--text-halo: rgba\([^)]*\.5\)/, "no halo definition may be left behind at the old .5 strength");
assert.match(styles, /\.message-meta \*[\s\S]{0,80}text-shadow: var\(--text-halo-shadow\)/, "every descendant of the immersive rows must get the halo, not just the container (native controls do not inherit text-shadow)");
assert.match(styles, /calc\(var\(--chat-composer-h\) \+ var\(--chat-list-fade\) \+ 12px\)/, "the list bottom padding must clear the whole fade band, or the newest message's meta is washed out at the bottom");
// 角色编辑页与模型页的"试听"必须走 speak() 这个公共入口（用户 2026-09-26 要求混响与环境声对
// 两处试听同样有效）。speak() 是唯一会在出声前 applyAudioFx + startAmbience 的地方 ——
// 哪一处改成自己合成自己播, 那次试听就会静默地绕过混响, 而界面上完全看不出来。
assert.match(rolesSource, /data-preview-tts[\s\S]{0,500}?app\.services\.tts\.speak\(/, "the role editor preview must go through speak(), or it silently bypasses the shared bus");
assert.match(modelsSource, /data-test-service[\s\S]*?app\.services\.tts\.speak\(/, "the model page preview must go through speak() too");
assert.match(conversationsSource, /delete next\.recentFullMessages;/, "saving a chat must drop the legacy retained-N field");
assert.match(storeSource, /compressionBound\(settings\.compressionRetainChars, 2000, 10000, 4000\)/, "the retention length must be clamped to 2000~10000 on load");
assert.match(storeSource, /compressionBound\(settings\.compressionThresholdChars, 4000, 32000, 10000\)/, "the trigger length must be clamped to 4000~32000 on load");
assert.match(storeSource, /delete conversations\[conversationIndex\]\.recentFullMessages;/, "migration must drop the legacy retained-N field from stored chats");
assert.match(settingsSource, /deleteConversation[\s\S]*releaseMedia[\s\S]*system-tts[\s\S]*user-profile/, "selective clearing must release media and preserve system services");
assert.match(settingsSource, /deleteConversation\(conversations\[conversationIndex\]\.id\)[\s\S]*refreshAppBackground\(\)/, "clearing every conversation must also drop the app background it supplied");
assert.match(html, /brand-mark[^>]*>[\s\S]*app\/assets\/icon\.webp/, "the top bar must use the packaged chataxi icon");
assert.doesNotMatch(rolesSource + conversationsSource + chatSource + fs.readFileSync(path.join(root, "app/features/models.js"), "utf8"), /icon\(["'](?:pen|user-pen|wrench)["']\)/, "edit and configuration buttons must use the gear icon");
assert.match(styles, /\.role-actions\s*\{[^}]*border-top:\s*0/s);
assert.match(styles, /\.service-manage\s*\{[^}]*border-top:\s*0/s);
assert.match(styles, /\.model-toggle\s*\{[^}]*border-bottom:\s*0/s);
assert.match(styles, /\.system-mark\s*\{[^}]*margin-right:\s*16px/s, "the system logo needs an explicit legacy-WebView text gap");
assert.match(styles, /\.system-hero h2\s*>\s*\.badge\s*\{[^}]*margin-left:/s, "the version badge needs an explicit legacy-WebView text gap");
assert.doesNotMatch(styles, /\.about-(?:panel|hero|mark|copy)/, "the About panel rename must not leave its old class names behind");

// 「按 Enter 发送」已取消：Enter 始终换行，Ctrl / ⌘ + Enter 始终发送。
assert.doesNotMatch(settingsSource, /enterToSend/, "the settings form must no longer offer Enter-to-send");
assert.match(chatSource, /event\.key === 'Enter'[\s\S]*\(event\.ctrlKey \|\| event\.metaKey\)\)/, "only Ctrl / ⌘ + Enter may send from the composer");
assert.doesNotMatch(chatSource, /enterToSend/, "the composer must not read the retired setting");
assert.match(chatSource, /'Enter 换行'/, "the composer hint must state that Enter inserts a newline");
assert.doesNotMatch(storeSource, /enterToSend: false,/, "the retired default must not stay in the settings seed");
assert.match(storeSource, /delete settings\.enterToSend;/, "loading old settings must drop the retired field");

// 系统页顶部是「备份软件和数据」：先由系统文件选择器定位置，再由宿主整包导出。
// 标记里必须直接带 data-backup-app：只查字符串存在会被下面的点击处理器蒙过去。
assert.match(settingsSource, /data-settings-panel="system">'\s*\+\s*'<button class="button primary full system-backup" type="button" data-backup-app>'\s*\+\s*ui\.icon\("box-archive"\)\s*\+\s*'备份软件和数据<\/button>'/, "the system panel must open with the hooked software-and-data backup button");
assert.match(settingsSource, /main\.querySelector\("\[data-backup-app\]"\)\.addEventListener\("click"/, "the backup button must be wired to the host call");
assert.match(settingsSource, /hermit\.call\("app\.backup"\)/, "the button must go through the host's self-backup method");
assert.match(settingsSource, /result\.cancelled[\s\S]*已取消备份/, "a dismissed picker must be reported instead of silently ignored");
assert.match(settingsSource, /备份完成" \+ " · " \+[\s\S]*sizeText/, "the receipt must report the produced file and its size");
assert.match(styles, /\.system-backup i\s*\{[^}]*margin-right:/s, "the backup icon needs an explicit legacy-WebView text gap");

// 压缩概要弹窗固定 80% 高，说明文字之外的高度全给输入框。
assert.match(chatSource, /form\.closest\('\.modal-sheet'\)\.classList\.add\('summary-sheet'\)/, "the summary editor must use the fixed-height sheet");
// 断言到具体声明：`height` 前一个字符是空格，跨行正则会误命中 min-height / max-height。
const summarySheetRule = styles.match(/\.summary-sheet\s*\{([^}]*)\}/s);
const editableSheetDeclarations = (rule) => rule[1].split(";").map((item) => item.replace(/\s+/g, ""));
assert.ok(summarySheetRule, "the summary sheet needs its own rule");
assert.ok(editableSheetDeclarations(summarySheetRule).includes("height:80%"), "the summary editor must be fixed at 80% height");
const summaryEditorRule = styles.match(/\.summary-sheet \.summary-edit \.prompt-editor\s*\{([^}]*)\}/s);
assert.ok(summaryEditorRule, "the summary textarea needs its own rule");
assert.ok(editableSheetDeclarations(summaryEditorRule).includes("height:100%"), "the summary textarea must take the remaining height");

const references = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
for (const reference of references) {
  if (reference.startsWith("/__hermit/")) continue;
  assert.ok(reference.startsWith("./"), `runtime asset must use a relative path: ${reference}`);
  const target = path.join(root, reference.slice(2));
  assert.ok(fs.existsSync(target) && fs.statSync(target).isFile(), `missing runtime asset: ${reference}`);
}
assert.equal(references.some((item) => /^https?:/i.test(item)), false, "external runtime assets are forbidden");

const jsFiles = [];
for (const relative of ["app", "tools", "tests"]) {
  const start = path.join(root, relative);
  if (!fs.existsSync(start)) continue;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (/\.(?:js|mjs)$/.test(entry.name)) jsFiles.push(target);
    }
  };
  visit(start);
}
for (const file of jsFiles) execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });

const runtimeFiles = ["index.html", "hermit.json", ...references.filter((item) => item.startsWith("./")).map((item) => item.slice(2))];
const referencedScripts = new Set(references.filter((item) => item.endsWith(".js")).map((item) => path.join(root, item.slice(2))));
for (const file of jsFiles.filter((file) => file.startsWith(path.join(root, "app") + path.sep))) assert.ok(referencedScripts.has(file), `runtime script is not loaded: ${file}`);
const uniqueRuntimeFiles = new Set(runtimeFiles);
assert.equal(uniqueRuntimeFiles.size, runtimeFiles.length, "index.html has duplicate asset references");

const trackedText = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8" })
  .trim().split("\n").filter(Boolean).filter((file) => !file.startsWith("release/") && !file.startsWith(".git/"));
const forbiddenBrand = new RegExp("chat" + "taxi", "i");
const secretPatterns = [
  /sk[-_][A-Za-z0-9_-]{20,}/,
  /xai-[A-Za-z0-9_-]{20,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /Bearer\s+[A-Za-z0-9._-]{24,}/
];
for (const relative of trackedText) {
  const target = path.join(root, relative);
  if (!fs.statSync(target).isFile()) continue;
  const content = fs.readFileSync(target, "utf8");
  assert.equal(forbiddenBrand.test(content), false, `brand name must be chataxi in ${relative}`);
  for (const pattern of secretPatterns) assert.equal(pattern.test(content), false, `possible secret in ${relative}`);
}

const tests = fs.readdirSync(path.join(root, "tests")).filter((file) => file.endsWith(".test.mjs")).map((file) => "tests/" + file);
execFileSync(process.execPath, ["--test", ...tests], { cwd: root, stdio: "inherit" });
if (process.env.CHATAXI_DOM_MODULE) execFileSync(process.execPath, ["tests/ui-flow.mjs"], { cwd: root, stdio: "inherit" });
execFileSync("python3", ["-B", "tests/package.test.py"], { cwd: root, stdio: "inherit" });
console.log(`verified ${jsFiles.length} JavaScript files and ${references.length} runtime references`);
