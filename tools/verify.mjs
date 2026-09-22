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
assert.equal(hermit.happId, "com.airen.chataxi", "chataxi ships under the reversed airen.com domain namespace");
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
assert.match(modelEditorSource, /data-paste-key[\s\S]*data-paste-headers[\s\S]*data-toggle-secret/, "saved credentials must stay editable, accept explicit clipboard paste and expose a visibility toggle");
assert.doesNotMatch(modelEditorSource, /data-copy-key|data-copy-secret|data-copy-headers/, "credential controls must not copy secrets back to the clipboard");
const uiComponentSource = fs.readFileSync(path.join(root, "app/components/ui.js"), "utf8");
assert.match(uiComponentSource, /url:\s*picked\.url[\s\S]*release:\s*function[\s\S]*files\.delete/, "Hermit image picking must pass the current object URL directly to the cropper and defer temporary-file cleanup");
assert.doesNotMatch(uiComponentSource, /fetch\(picked\.url/, "Hermit object URLs must not be fetched as ordinary network resources");
assert.match(uiComponentSource, /cropCanvas[\s\S]*context\.drawImage\(image/, "the crop preview must render through canvas after the managed object URL is decoded");
assert.doesNotMatch(uiComponentSource, /stage\.style|preview\.style/, "the cropper must not use inline styles blocked by the device CSP");
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
assert.match(styles, /\.composer-toolbar\s+\.row\s*\{[^}]*gap:\s*8px/s, "composer image and microphone controls need one compact normal gap");
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
assert.match(styles, /\.message-row\.assistant\s*>\s*\.message-avatar-trigger\s*\{[^}]*margin-right:\s*7px/s, "assistant bubble pointers must meet the avatar edge on legacy WebView");
assert.match(styles, /\.message-row\.user\s*>\s*\.message-avatar-trigger\s*\{[^}]*margin-left:\s*7px/s, "user bubble pointers must meet the avatar edge on legacy WebView");
assert.doesNotMatch(styles, /\.message-row\.(?:assistant|user)\s*>\s*\.message-avatar-trigger\s*\{[^}]*margin-(?:right|left):\s*-/, "message bubble pointers must not be pulled behind avatars");
assert.match(styles, /\.message-row\.system\s*\{[^}]*justify-content:\s*center/s, "system history messages must render without pretending to be a user or role bubble");
assert.match(styles, /\.moderator-avatar-trigger\s*>\s*\.avatar\s*\{[^}]*box-shadow:\s*0 0 0 2px var\(--accent\)/s, "group moderator portraits need a thin bright-yellow ring");
assert.match(styles, /\.auto-role-toggle\[aria-checked="true"\][^}]*background:\s*var\(--accent\)/s, "the magic-wand auto-selection switch needs a clear enabled state");
assert.match(styles, /\.crop-toolbar\s*\{[^}]*display:\s*grid[^}]*gap:/s, "crop controls must use a grid gap");
assert.match(styles, /\.crop-stage\s*\{[^}]*height:\s*min\(420px,\s*calc\(100vw - 44px\)\)/s, "the crop viewport needs a CSP-safe responsive square height on the legacy WebView");
assert.match(styles, /\.crop-stage canvas\s*\{[^}]*width:\s*100%[^}]*height:\s*100%/s, "the canvas preview must fill the responsive crop viewport");
const uiSource = fs.readFileSync(path.join(root, "app/components/ui.js"), "utf8");
assert.doesNotMatch(uiSource, /class="avatar[^\n]*style="/, "avatar markup must not be rejected by the device CSP as an inline style");
assert.doesNotMatch(uiSource, /stage\.style|preview\.style/, "the crop viewport must not rely on inline styles rejected by the device CSP");
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
assert.match(settingsSource, /\["compressionThresholdChars", "compressionRetainChars", "compressionTargetChars"\]\.forEach/, "every compression number must round-trip through the settings form");
assert.doesNotMatch(conversationsSource, /name="recentFullMessages"|data-output="recentFullMessages"/, "the per-conversation retained-N control must be gone");
assert.match(conversationsSource, /delete next\.recentFullMessages;/, "saving a chat must drop the legacy retained-N field");
assert.match(storeSource, /compressionBound\(settings\.compressionRetainChars, 2000, 10000, 4000\)/, "the retention length must be clamped to 2000~10000 on load");
assert.match(storeSource, /compressionBound\(settings\.compressionThresholdChars, 4000, 32000, 10000\)/, "the trigger length must be clamped to 4000~32000 on load");
assert.match(storeSource, /delete conversations\[conversationIndex\]\.recentFullMessages;/, "migration must drop the legacy retained-N field from stored chats");
assert.match(settingsSource, /deleteConversation[\s\S]*releaseMedia[\s\S]*system-tts[\s\S]*user-profile/, "selective clearing must release media and preserve system services");
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
