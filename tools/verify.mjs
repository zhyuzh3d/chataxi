#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const hermit = JSON.parse(fs.readFileSync(path.join(root, "hermit.json"), "utf8"));

assert.equal(hermit.schema, 2);
assert.equal(hermit.happId, "io.github.zhyuzh3d.chataxi");
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
assert.match(modelEditorSource, /data-copy-key[\s\S]*data-copy-headers/, "saved credentials must stay editable, masked and explicitly copyable");
const modelServicesSource = fs.readFileSync(path.join(root, "app/services/model-services.js"), "utf8");
assert.match(modelServicesSource, /catalog\.reviewedLlmModels[\s\S]*rules\[id\]/, "reviewed capabilities must use exact model IDs");
assert.doesNotMatch(modelServicesSource, /\^gpt-5|\^grok-4|\^minimax-m3/, "model-name prefixes must not create capabilities");
assert.match(modelServicesSource, /\/api\/show[\s\S]*runtime-model-details/, "Ollama capabilities must come from the selected runtime's model details");
const chatSessionSource = fs.readFileSync(path.join(root, "app/features/chat-session.js"), "utf8");
assert.doesNotMatch(chatSessionSource, /autoSpeak[\s\S]{0,2000}tts\.prepare/, "automatic readout must play completed third-party audio instead of only preparing it");
const contextSource = fs.readFileSync(path.join(root, "app/services/context.js"), "utf8");
assert.match(contextSource, /本轮唯一允许发言的角色[\s\S]*不得扮演、代替、续写或模拟其他参与角色/, "group turns need an explicit single-speaker identity contract");
assert.match(contextSource, /<active_role>[\s\S]*<other_roles_reference>/, "the active role instructions must be isolated from other role references");
assert.match(contextSource, /参与者资料仅用于辨认说话者[\s\S]*不要摘录、概括/, "compression participant profiles must remain reference-only");
assert.match(contextSource, /throughMessageCreatedAt[\s\S]*retainedMessageCount[\s\S]*recent:\s*uncompressed/, "compression must persist its exact boundary and retain every uncompressed message");
const llmSource = fs.readFileSync(path.join(root, "app/services/llm.js"), "utf8");
assert.match(llmSource, /other-role-history[\s\S]*speakerMismatch/, "other role history and mismatched speaker labels need deterministic guards");
assert.match(llmSource, /compressionRole\s*=\s*participantRoles[\s\S]*participantRoles\[0\]/, "group compression must use the first participant role");
assert.match(llmSource, /selectRole[\s\S]*\{\\"role\\":\\"完整角色名称\\"\}[\s\S]*parseRoleChoice/, "automatic role selection must request and validate one standard role name");
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
const chatSource = fs.readFileSync(path.join(root, "app/features/chat.js"), "utf8");
assert.match(chatSource, /dataset\.editConversationProfile\s*=\s*['"]user['"][\s\S]*openPersonalProfile/, "the user message avatar must open conversation personal settings");
assert.doesNotMatch(chatSource, /保存并执行|name=["']regenerate["']/, "message editing must only save; regeneration stays a separate action");
assert.match(chatSource, /包括用户消息和任何角色的回复[\s\S]*deleteMessagesAfter/, "regenerating an older reply must confirm removal of every later message");
assert.match(styles, /\.composer-toolbar\s+\.row\s*\{[^}]*gap:\s*8px/s, "composer image and microphone controls need one compact normal gap");
assert.doesNotMatch(styles, /overflow-x:\s*scroll/, "pages and sheets must not force horizontal scrolling");
assert.doesNotMatch(styles, /width:\s*100vw/, "viewport-width sheets can create a horizontal scrollbar");
assert.match(styles, /\.modal-backdrop\s*\{[^}]*right:\s*0[^}]*left:\s*0[^}]*width:\s*100%/s, "sheet backdrops must explicitly span the viewport on older WebViews");
assert.match(styles, /\.modal-sheet\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%/s, "every sheet must fill the backdrop width");
assert.match(styles, /\.modal-actions\s*\{[^}]*display:\s*grid[^}]*gap:\s*18px/s, "sheet action buttons must use a grid gap");
assert.match(styles, /\.topbar-actions\s*\{[^}]*gap:\s*var\(--space-button-group\)/s, "top bar buttons need a normal gap");
assert.match(styles, /\.title-version\s*\{[^}]*margin-left:\s*var\(--space-icon-text\)/s, "the app name and version need an explicit legacy-WebView gap");
assert.match(styles, /\.profile-actions\s*\{[^}]*gap:\s*var\(--space-button-group\)/s, "service card buttons need a normal gap");
assert.match(styles, /\.row,\s*\.row-between\s*\{[^}]*gap:\s*var\(--space-button-group\)/s, "generic horizontal button rows need a normal gap");
assert.match(styles, /\.avatar-actions\s*\{[^}]*gap:\s*var\(--space-button-group\)/s, "avatar action buttons need a normal gap");
assert.match(styles, /\.message-meta\s*\{[^}]*gap:\s*4px/s, "message action buttons need a compact normal gap");
assert.match(styles, /\.role-actions\s*\{[^}]*display:\s*grid[^}]*gap:/s, "role card buttons must use a grid gap");
assert.match(styles, /\.conversation-open\s*>\s*\.avatar-stack\s*\{[^}]*margin-right:\s*16px/s, "conversation cards need an explicit avatar-to-text gap on legacy WebView");
assert.match(styles, /\.role-card-head\s*>\s*\.avatar\s*\{[^}]*margin-right:/s, "role cards need an explicit avatar-to-text gap on legacy WebView");
assert.match(styles, /\.service-summary\s*>\s*\.service-icon\s*\{[^}]*margin-right:\s*12px/s, "service cards need an explicit icon-to-text gap on legacy WebView");
assert.match(styles, /\.role-choice\s*>\s*\.role-choice-avatar\s*\{[^}]*margin-right:/s, "role selector cards need an explicit avatar-to-text gap on legacy WebView");
assert.match(styles, /\.avatar-editor\s*>\s*\.avatar-picker\s*\{[^}]*margin-right:\s*16px/s, "profile editors need an explicit avatar-to-text gap on legacy WebView");
assert.match(styles, /\.message-row\.assistant\s*>\s*\.message-avatar-trigger\s*\{[^}]*margin-right:\s*7px/s, "assistant bubble pointers must meet the avatar edge on legacy WebView");
assert.match(styles, /\.message-row\.user\s*>\s*\.message-avatar-trigger\s*\{[^}]*margin-left:\s*7px/s, "user bubble pointers must meet the avatar edge on legacy WebView");
assert.doesNotMatch(styles, /\.message-row\.(?:assistant|user)\s*>\s*\.message-avatar-trigger\s*\{[^}]*margin-(?:right|left):\s*-/, "message bubble pointers must not be pulled behind avatars");
assert.match(styles, /\.moderator-avatar-trigger\s*>\s*\.avatar\s*\{[^}]*box-shadow:\s*0 0 0 2px var\(--accent\)/s, "group moderator portraits need a thin bright-yellow ring");
assert.match(styles, /\.auto-role-toggle\[aria-checked="true"\][^}]*background:\s*var\(--accent\)/s, "the magic-wand auto-selection switch needs a clear enabled state");
assert.match(styles, /\.crop-toolbar\s*\{[^}]*display:\s*grid[^}]*gap:/s, "crop controls must use a grid gap");
assert.match(styles, /\.crop-stage\s*\{[^}]*height:\s*320px[^}]*aspect-ratio:/s, "the crop viewport needs an explicit legacy height before aspect-ratio enhancement");
const uiSource = fs.readFileSync(path.join(root, "app/components/ui.js"), "utf8");
assert.match(uiSource, /stage\.style\.height\s*=\s*Math\.round\(width\)/, "the crop viewport must be resized to a visible square at runtime");
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
assert.match(chatSource, /id="autoRoleToggle"[\s\S]*wand-magic-sparkles/, "group chat needs the right-side magic-wand auto-selection switch");
assert.doesNotMatch(chatSource, /自动选角开发记录|data-chat-menu=["']routing-records/, "routing diagnostics must stay out of the user interface");
assert.doesNotMatch(styles, /\.routing-record(?:-output)?\s*\{/, "removed routing diagnostics UI must not leave unused styles");
const rolesSource = fs.readFileSync(path.join(root, "app/features/roles.js"), "utf8");
for (const label of ["角色档案", "语言模型", "朗读发音"]) assert.match(rolesSource, new RegExp(label));
assert.match(rolesSource, /repairElevenLabsVoiceNames[\s\S]*discover\("tts", refreshed, \{ persist: false \}\)[\s\S]*store\.put\("tts-profiles"/, "legacy ElevenLabs ID-only voice catalogs must recover account names before the role picker is built");
assert.match(rolesSource, /已上线/); assert.match(fs.readFileSync(path.join(root, "app/services/profiles.js"), "utf8"), /已下线/);
const settingsSource = fs.readFileSync(path.join(root, "app/features/settings.js"), "utf8");
for (const label of ["界面", "对话", "压缩", "关于"]) assert.match(settingsSource, new RegExp(label));
assert.match(settingsSource, /作者[\s\S]*zhyuzh3d/);
assert.match(settingsSource, /tapCount\s*\+=\s*1[\s\S]*tapCount\s*<\s*3[\s\S]*setRuntimeMode\("live"\)/, "local to live needs three deliberate taps");
assert.match(settingsSource, /改为本地运行[\s\S]*setRuntimeMode\("local"\)/);
for (const name of ["conversations", "roles", "models", "profile"]) assert.match(settingsSource, new RegExp('toggle\\("' + name + '"'));
assert.match(settingsSource, /deleteConversation[\s\S]*releaseMedia[\s\S]*system-tts[\s\S]*user-profile/, "selective clearing must release media and preserve system services");
assert.match(html, /brand-mark[^>]*>[\s\S]*app\/assets\/icon\.webp/, "the top bar must use the packaged chataxi icon");
assert.doesNotMatch(rolesSource + conversationsSource + chatSource + fs.readFileSync(path.join(root, "app/features/models.js"), "utf8"), /icon\(["'](?:pen|user-pen|wrench)["']\)/, "edit and configuration buttons must use the gear icon");
assert.match(styles, /\.role-actions\s*\{[^}]*border-top:\s*0/s);
assert.match(styles, /\.profile-actions\s*\{[^}]*border-top:\s*0/s);
assert.match(styles, /\.model-toggle\s*\{[^}]*border-bottom:\s*0/s);
assert.match(styles, /\.about-hero\s*>\s*\.about-mark\s*\{[^}]*margin-right:\s*16px/s, "the About logo needs an explicit legacy-WebView text gap");
assert.match(styles, /\.about-hero h2\s*>\s*\.badge\s*\{[^}]*margin-left:/s, "the version badge needs an explicit legacy-WebView text gap");

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
