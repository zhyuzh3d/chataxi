// Optional DOM-only bilingual check. No browser or external model request is used.
// Point CHATAXI_DOM_MODULE to a locally installed linkedom module; it is never shipped.
//
// 目的：证明英文界面在真实渲染路径上不留中文，而且中文切回中文、再切英文都成立
// （界面语言的翻译层缓存的是「原始中文」，所以来回切换必须能够复现两种语言）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.CHATAXI_DOM_MODULE) throw Error('Set CHATAXI_DOM_MODULE to a test-only linkedom installation');
const { parseHTML } = require(process.env.CHATAXI_DOM_MODULE);
const root = fileURLToPath(new URL('../', import.meta.url));
const { window, document } = parseHTML(fs.readFileSync(root + 'index.html', 'utf8'));
const data = new Map();
Object.defineProperty(document, 'activeElement', { get() { return this._focus || this.body; } });
window.HTMLElement.prototype.focus = function () { document._focus = this; };
window.HTMLElement.prototype.getClientRects = function () { return [1]; };
Object.defineProperty(window.HTMLElement.prototype, 'elements', { get() { return { namedItem: name => this.querySelector('[name="' + name + '"]') }; } });
Object.defineProperty(window.HTMLInputElement.prototype, 'checked', { get() { return this.hasAttribute('checked'); }, set(value) { if (value) this.setAttribute('checked', ''); else this.removeAttribute('checked'); } });
Object.defineProperty(window.HTMLTextAreaElement.prototype, 'maxLength', { get() { return Number(this.getAttribute('maxlength') || -1); } });
const location = { hash: '#/conversations' };
const history = { state: null, replaceState(state, _, hash) { this.state = state; location.hash = hash; }, pushState(state, _, hash) { this.state = state; location.hash = hash; }, back() {} };
// 关键：系统语言是英文，因此默认偏好「跟随系统」应当落到英文界面。
const context = vm.createContext({
  window, document, location, history, navigator: { language: 'en-US', languages: ['en-US'] },
  MutationObserver: window.MutationObserver, localStorage: { get length() { return data.size; }, key(i) { return [...data.keys()][i]; }, getItem(key) { return data.get(key) ?? null; }, setItem(key, value) { data.set(key, value); }, removeItem(key) { data.delete(key); } },
  URL, Blob, TextEncoder, Uint8Array, Uint32Array, btoa, atob, console, setTimeout, clearTimeout, AbortController, Event: window.Event, requestAnimationFrame: fn => setTimeout(fn, 0)
});
const scripts = [...fs.readFileSync(root + 'index.html', 'utf8').matchAll(/<script src="\.\/([^"]+)"/g)].map(match => match[1]);
for (const script of scripts) vm.runInContext(fs.readFileSync(root + script, 'utf8'), context, { filename: script });
const app = window.chataxi;
app.platform.hermit.awaitReady = async () => false;
app.platform.hermit.info = async () => ({ runtimeMode: 'browser', bridgeMode: 'none' });
app.services.tts.stop = async () => {};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(fn, description) { for (let i = 0; i < 250; i++) { if (fn()) return; await tick(); } throw Error(description + '\n' + document.body.textContent.slice(-1200)); }
function field(name, value) { const node = document.querySelector('#modalForm [name="' + name + '"]'); assert.ok(node, name); if (arguments.length > 1) { if (node.type === 'checkbox') node.checked = value; else node.value = value; } return node; }
function submit() { document.querySelector('#modalForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); }
function click(selector) { const node = document.querySelector(selector); assert.ok(node, selector); node.click(); }
function type(selector, text) { const node = document.querySelector(selector); node.value = text; node.dispatchEvent(new window.Event('input', { bubbles: true })); }
// 收集可见文案里的中文，用来证明英文界面没有漏译。
function cjk(selector) {
  const found = [], skip = 'script,style,code,pre,textarea,[data-i18n-ignore]';
  (function walk(node) {
    if (node.nodeType === 3) { const text = String(node.data).trim(); if (/[\u4e00-\u9fff]/.test(text)) found.push(text); return; }
    if (node.nodeType !== 1 || (node.matches && node.matches(skip))) return;
    for (const child of Array.from(node.childNodes)) walk(child);
  })(document.querySelector(selector));
  return found;
}
const label = selector => (document.querySelector(selector) || {}).textContent;

document.dispatchEvent(new window.Event('DOMContentLoaded'));
await until(() => document.querySelector('[data-create]'), 'boot');
assert.equal(app.i18n.preference(), 'system', 'a fresh install follows the system language');
assert.equal(app.i18n.current(), 'en', 'an English system must land on the English interface');
assert.equal(label('#pageSubtitle'), 'Chat freely, on your own terms');
assert.equal(label('#bottomNav [data-route="conversations"] span'), 'Chats');
assert.deepEqual(Array.from(document.querySelectorAll('#bottomNav [data-route] span')).map(node => node.textContent), ['Chats', 'Roles', 'Models', 'Me', 'Settings']);
assert.equal(document.documentElement.lang, 'en');
assert.deepEqual(cjk('#bottomNav'), []);
// 首次安装按界面语言写入的默认内容也必须是英文。
const seeded = await app.data.store.get('meta', 'settings');
assert.doesNotMatch(seeded.compressionPrompt, /[\u4e00-\u9fff]/);
const seededProfile = await app.data.store.get('meta', 'user-profile');
assert.equal(seededProfile.name, 'Me');

// 翻译引擎：精确词条、插值规则、带插值的捕获组、首尾空白、未知文本原样保留。
assert.equal(app.i18n.t('全部'), 'All');
assert.equal(app.i18n.t('共 3 个角色'), '3 roles');
assert.equal(app.i18n.t(' 全部 '), ' All ');
assert.equal(app.i18n.t('未收录的一句话'), '未收录的一句话');
assert.equal(app.i18n.pick('跟随系统', 'Follow system'), 'Follow system');
assert.equal(app.i18n.english('推荐用于对话模型'), 'Recommended for chat models');
assert.equal(app.i18n.t('我想跟你说个有趣的事情'), 'I want to tell you something interesting');
assert.equal(app.i18n.english('使用陈佳宁模板'), 'Use the 陈佳宁 template');
// 对话卡片的角色名称行是拼装句（单聊/群聊 + 不间断空格 + 竖线 + 角色名），只能靠插值规则整体翻译。
assert.equal(app.i18n.english('单聊\u00a0|\u00a0Nora Quinn'), 'Direct chat\u00a0|\u00a0Nora Quinn');
assert.equal(app.i18n.english('群聊\u00a0|\u00a0Nora Quinn · Puffkin'), 'Group chat\u00a0|\u00a0Nora Quinn · Puffkin');

// 走到角色模板画廊：这一屏同时用到字典翻译和按语言取值的数据字段。
click('[data-create]');
await until(() => document.querySelector('#modalForm [name="apiKey"]'), 'guided model service form');
assert.equal(label('#modalSubtitle') ?? '', '');
app.platform.network.requestJson = async options => options.method === 'GET'
  ? { data: { data: [{ id: 'gpt-4.1', owned_by: 'openai', supported_parameters: ['temperature'] }] } }
  : { data: { output_text: 'OK' } };
field('apiKey', 'fixture-key'); click('[data-fetch-models]');
await until(() => /gpt-4\.1/.test(label('[data-picker="externalModelId"] [data-picker-label]')), 'guided model discovery');
click('[data-picker="externalModelId"]');
await until(() => document.querySelector('.subsheet [data-choice="gpt-4.1"]'), 'model choice sheet');
assert.match(label('.subsheet .choice-group-label'), /Recommended for chat model/);
click('.subsheet [data-choice="gpt-4.1"]'); await tick();
click('[data-test-model]');
await until(() => /Connected/.test(label('#connectionStatus')), 'guided model test');
field('enabled', true); submit();
await until(() => document.querySelector('#modalForm [name="systemPrompt"]'), 'guided role form');
assert.equal(label('[data-role-avatar-name]'), 'Untitled');
assert.equal(label('.avatar-copy > small'), 'Tap the avatar to change it');
assert.equal(label('[data-open-role-templates] span'), 'Use template');
click('[data-open-role-templates]');
await until(() => document.querySelector('.role-template-grid'), 'role template gallery');
const card = id => document.querySelector('[data-role-template="' + id + '"]');
assert.equal(document.querySelectorAll('[data-role-template]').length, 27);
assert.deepEqual(Array.from(document.querySelectorAll('[data-template-tab]')).map(node => node.textContent), ['All', 'Male', 'Female', 'Other']);
assert.equal(label('.role-template-help'), 'Tap a role card to apply it');
assert.equal(card('lin-xiaoyu').querySelector('strong').textContent, 'Nora Quinn');
assert.match(card('lin-xiaoyu').querySelector('.role-template-profession').textContent, /^Animation freshman/);
assert.deepEqual(Array.from(card('lin-xiaoyu').querySelectorAll('.role-template-meta small')).map(node => node.textContent), ['18', 'Female']);
assert.equal(card('pao-rong').querySelector('strong').textContent, 'Puffkin');
assert.equal(card('pao-rong').querySelector('.role-template-meta small').textContent, 'Other');
assert.equal(card('pao-rong').querySelectorAll('.role-template-meta small').length, 1, 'non-human templates must not invent an age');
assert.equal(card('lin-xiaoyu').getAttribute('aria-label'), 'Use the Nora Quinn template');
assert.deepEqual(cjk('.role-template-grid'), [], 'the English gallery must not leak Chinese');

// 切到中文：同一批节点必须整体回到中文；再切回英文也必须恢复。
app.i18n.setPreference('zh-CN'); await tick();
assert.equal(card('lin-xiaoyu').querySelector('strong').textContent, '陈佳宁');
assert.equal(label('.role-template-help'), '点击角色卡片直接应用');
assert.deepEqual(Array.from(document.querySelectorAll('[data-template-tab]')).map(node => node.textContent), ['全部', '男性', '女性', '其他']);
app.i18n.setPreference('en'); await tick();
assert.equal(card('lin-xiaoyu').querySelector('strong').textContent, 'Nora Quinn');
assert.equal(label('.role-template-help'), 'Tap a role card to apply it');
assert.deepEqual(cjk('.role-template-grid'), []);

// 应用英文模板后，角色名称与提示词都应当是英文。
// 头像要走 canvas/Image，DOM 测试里没有这些实现，所以按既有套件的做法替换成固定 Blob。
app.features.roles.templateAvatarBlob = async () => new Blob(['avatar'], { type: 'image/jpeg' });
app.data.media.put = async () => ({ id: 'template-avatar-fixture' });
click('[data-role-template="lin-xiaoyu"]');
await until(() => !document.querySelector('.role-template-grid'), 'template applied');
assert.equal(field('name').value, 'Nora Quinn');
assert.match(field('systemPrompt').value, /^I'm Nora Quinn, 18/);
// 模板自带的行为指导也要按界面语言取英文版，并且不能漏中文。
assert.equal(field('behaviorGuidance').value, app.data.roleTemplates.items.find(item => item.id === 'lin-xiaoyu').behaviorGuidanceEn, 'the template must bring its own English behavior guidance');
assert.doesNotMatch(field('behaviorGuidance').value, /[\u4e00-\u9fff]/, 'the English behavior guidance must not leak Chinese');
assert.equal(field('behaviorGuidance').value.split('\n').length, 3, 'the guidance keeps its three separate rules');
assert.equal(field('behaviorGuidance').getAttribute('rows'), '4');

// 常规设定的三个子 tab 在英文界面下整体翻译，且沿用固定高度的弹窗。
const settingsLlm = (await app.data.store.list('llm-profiles')).find(profile => profile.type !== 'system');
assert.ok(settingsLlm, 'the guided flow must have saved a usable model service');
await app.data.store.put('roles', 'i18n-settings-role', { id: 'i18n-settings-role', name: 'Nora Quinn', introduction: '', systemPrompt: 'Stay brief.', behaviorGuidance: 'Keep it short.', enabled: true, avatarMediaId: '', model: 'gpt-4.1', llmProfileId: settingsLlm.id });
await app.data.store.put('conversations', 'i18n-settings-conversation', { id: 'i18n-settings-conversation', title: 'Chat with Nora', kind: 'single', roleIds: ['i18n-settings-role'], activeRoleIds: ['i18n-settings-role'], moderatorRoleId: 'i18n-settings-role', lastMessage: '', createdAt: Date.now(), updatedAt: Date.now() });
await app.features.conversations.openConversationSettings(await app.data.store.get('conversations', 'i18n-settings-conversation'));
await until(() => document.querySelector('#modalForm [data-conversation-tab]'), 'merged settings in English');
assert.equal(label('#modalTitle'), 'Conversation settings');
assert.deepEqual(Array.from(document.querySelectorAll('[data-conversation-tab]')).map(node => node.textContent), ['Basic setup', 'Profile', 'Scene setup']);
assert.ok(document.querySelector('.modal-sheet.conversation-settings-sheet'), 'the merged settings keep the fixed-height sheet');
assert.deepEqual(cjk('[data-conversation-panel="basic"]'), [], 'the English basic tab must not leak Chinese');
click('[data-conversation-tab="personal"]');
assert.deepEqual(cjk('[data-conversation-panel="personal"]'), [], 'the English profile tab must not leak Chinese');
click('[data-conversation-tab="scene"]');
assert.deepEqual(cjk('[data-conversation-panel="scene"]'), [], 'the English scene tab must not leak Chinese');
click('[data-conversation-tab="basic"]');
click('[data-edit-participant]');
await until(() => document.querySelector('#modalForm [name="behaviorGuidance"]'), 'English role editor from a participant avatar');
assert.equal(label('.field > span'), 'Role name');
assert.deepEqual(cjk('.role-editor [data-role-tab]'), [], 'the English role editor tabs must not leak Chinese');
app.components.closeModal();
await until(() => document.querySelector('#modalForm [data-conversation-tab]'), 'merged settings back in English');
assert.deepEqual(Array.from(document.querySelectorAll('[data-conversation-tab]')).map(node => node.textContent), ['Basic setup', 'Profile', 'Scene setup']);
app.components.closeModal(); await tick();

// 模型卡片：地址一行右端是「测试」，复制 / 编辑 / 删除 并排在一行，英文界面同样不能漏出中文。
app.components.closeModal(true, true);
await app.navigate('models', { modelsTab: 'llm' });
await until(() => document.querySelector('.model-service-card'), 'models page cards');
const modelCard = document.querySelector('.model-service-card');
assert.equal(modelCard.querySelector('.service-endpoint [data-test-service]').textContent, 'Test');
assert.deepEqual(Array.from(modelCard.querySelectorAll('.service-manage > .button')).map(node => node.textContent), ['Copy', 'Edit', 'Delete']);
assert.equal(modelCard.querySelector('.service-manage .icon-button'), null, 'no icon-only action button is left in the management row');
assert.equal(document.querySelector('.section-toolbar').lastElementChild.tagName, 'P', 'the note follows the add button');
assert.deepEqual(cjk('.models-page'), [], 'the English model page must not leak Chinese');

// 设置页：界面语言选择器与界面文案。
app.i18n.setPreference('en', { silent: true });
app.components.closeModal(true, true);
await app.navigate('settings');
await until(() => document.querySelector('[data-settings-panel="interface"]'), 'settings page');
assert.equal(label('[data-picker="uiLanguage"] [data-picker-label]'), 'Follow system');
assert.match(label('[data-settings-panel="interface"]'), /Interface theme[\s\S]*Interface language[\s\S]*Image clarity when sending/);
assert.deepEqual(cjk('[data-settings-panel="interface"]'), []);
// 「默认语言」输入框已经移除：语音语言只剩朗读/识别自己的字段。
assert.equal(document.querySelector('[data-settings-panel="interface"] [name="language"]'), null, 'the retired default-language input must be gone');
assert.equal(label('[data-picker="imageDetail"] [data-picker-label]'), 'Auto');
click('[data-picker="imageDetail"]');
await until(() => document.querySelector('.subsheet [data-choice="low"]'), 'image clarity choices');
assert.deepEqual(Array.from(document.querySelectorAll('.subsheet [data-choice]')).map(node => node.textContent), ['Auto', 'Low', 'High']);
app.components.closeSubsheet(true);
await tick();
assert.deepEqual(Array.from(document.querySelectorAll('.settings-tabs [data-settings-tab]')).map(node => node.textContent), ['Interface', 'Chats', 'Context', 'System']);
// 压缩设置页：滑竿读数带中文单位，英文界面必须换成 chars，且整块不能漏中文。
click('.settings-tabs [data-settings-tab="compression"]');
assert.match(label('[data-settings-panel="compression"]'), /Automatic context compression[\s\S]*Compress history automatically[\s\S]*Trigger length[\s\S]*Retention length[\s\S]*Compression target[\s\S]*Compression prompt/);
const thresholdSlider = document.querySelector('[data-settings-panel="compression"] [name="compressionThresholdChars"]');
const retainSlider = document.querySelector('[data-settings-panel="compression"] [name="compressionRetainChars"]');
const targetSlider = document.querySelector('[data-settings-panel="compression"] [name="compressionTargetChars"]');
assert.deepEqual([thresholdSlider.getAttribute('min'), thresholdSlider.getAttribute('max'), thresholdSlider.getAttribute('value')], ['4000', '32000', '10000']);
assert.deepEqual([retainSlider.getAttribute('min'), retainSlider.getAttribute('max'), retainSlider.getAttribute('value')], ['2000', '10000', '4000']);
assert.deepEqual([targetSlider.getAttribute('min'), targetSlider.getAttribute('max'), targetSlider.getAttribute('value')], ['500', '2000', '1000']);
assert.equal(label('[data-output="compressionThresholdChars"]'), '10000 chars');
assert.equal(label('[data-output="compressionRetainChars"]'), '4000 chars');
assert.equal(label('[data-output="compressionTargetChars"]'), '1000 chars');
assert.deepEqual(cjk('[data-settings-panel="compression"]'), [], 'the English compression tab must not leak Chinese');
click('.settings-tabs [data-settings-tab="system"]');
assert.match(label('.system-panel'), /Back up app and data[\s\S]*Author[\s\S]*zhyuzh3d/);
assert.deepEqual(cjk('.system-panel'), []);
// 备份回执是拼装句：整句没有字典键，必须由 i18nEnPatterns 的规则译出来。
assert.equal(app.i18n.t('备份完成 · chataxi-20260922-120000.hermit-backup.zip · 2 KB'), 'Backup saved · chataxi-20260922-120000.hermit-backup.zip · 2 KB');
// 界面语言选中即生效，并且要切回来仍然正确。
click('[data-picker="uiLanguage"]');
await until(() => document.querySelector('.subsheet [data-choice="zh-CN"]'), 'language picker');
assert.equal(label('.subsheet [data-choice="zh-CN"]'), 'Chinese');
click('.subsheet [data-choice="zh-CN"]'); await tick();
assert.equal(app.i18n.current(), 'zh-CN');
assert.equal(label('#bottomNav [data-route="conversations"] span'), '对话');
// 选择器的值标签是渲染期写入的节点，切回中文时也必须跟着还原。
assert.equal(label('[data-picker="theme"] [data-picker-label]'), '跟随系统');
assert.equal(label('[data-picker="imageDetail"] [data-picker-label]'), '自动');
app.i18n.setPreference('en'); await tick();
assert.equal(label('#bottomNav [data-route="conversations"] span'), 'Chats');
assert.equal(label('[data-picker="theme"] [data-picker-label]'), 'Follow system');
assert.equal(label('[data-picker="imageDetail"] [data-picker-label]'), 'Auto');
assert.deepEqual(cjk('.system-panel'), []);

// 界面语言是独立字段，不能顶替语音语言：朗读/识别的 language 兜底必须原样保留。
assert.match(label('[data-settings-panel="interface"]'), /Interface language/);
assert.deepEqual(cjk('[data-settings-panel="interface"]'), []);
const settingsAfter = await app.data.store.get('meta', 'settings');
assert.equal(settingsAfter.language, 'zh-CN', 'the speech language fallback must survive untouched');
assert.ok(['system', 'zh-CN', 'en'].includes(settingsAfter.uiLanguage), 'the interface language must stay one of the three options');

// 对话列表卡片的角色名称行：整行横跨卡片正文（不再缩进在文本列里），英文界面也不能漏中文。
await app.data.store.put('roles', 'i18n-card-role', { id: 'i18n-card-role', name: 'Nora Quinn', introduction: '', systemPrompt: 'Stay brief.', enabled: true, avatarMediaId: '', model: '' });
await app.data.store.put('conversations', 'i18n-card-conversation', { id: 'i18n-card-conversation', title: 'Chat with Nora', kind: 'single', roleIds: ['i18n-card-role'], activeRoleIds: ['i18n-card-role'], moderatorRoleId: 'i18n-card-role', lastMessage: '', createdAt: Date.now(), updatedAt: Date.now() });
await app.navigate('conversations');
await until(() => document.querySelector('.conversation-card .meta'), 'conversation card with a seeded chat');
const cardRow = document.querySelector('.conversation-card .meta');
assert.equal(cardRow.parentElement.className, 'card-button conversation-open', 'the role-name row spans the whole card body instead of the indented text column');
assert.equal(cardRow.previousElementSibling.className, 'conversation-head', 'the avatar and the text column stay in the head row above it');
assert.match(cardRow.textContent, /^Direct chat\s*\|\s*Nora Quinn/, 'the English role-name row must translate the chat type');
assert.doesNotMatch(document.querySelector('.conversation-title time').textContent, /[\u4e00-\u9fff]/, 'the time stamp must follow the interface language, not a hardcoded Chinese locale');
assert.deepEqual(cjk('#conversationList'), [], 'the English conversation list must not leak Chinese');

// 自动压缩之后的冻结历史与「压缩概要」入口：英文界面同样不能漏中文，
// 被压缩的消息只能改概要这一点也要用英文说清楚。
const freezeStart = Date.now();
await app.data.store.putMessage({ id: 'i18n-freeze-0', conversationId: 'i18n-card-conversation', kind: 'system', systemType: 'scene', text: 'Rainy night in the old station.', media: [], status: 'done', createdAt: freezeStart });
for (let index = 1; index <= 4; index += 1) await app.data.store.putMessage({ id: 'i18n-freeze-' + index, conversationId: 'i18n-card-conversation', kind: index % 2 ? 'assistant' : 'user', roleId: index % 2 ? 'i18n-card-role' : '', roleName: index % 2 ? 'Nora Quinn' : '', text: 'Stored message ' + index, media: [], status: 'done', createdAt: freezeStart + index });
await app.data.store.put('summaries', 'i18n-card-conversation', { id: 'i18n-card-conversation', conversationId: 'i18n-card-conversation', text: 'Earlier context in one line.', throughMessageId: 'i18n-freeze-2', throughMessageCreatedAt: freezeStart + 2, sourceMessageCount: 3, compressedByRoleName: 'Nora Quinn', updatedAt: Date.now() });
await app.openChat('i18n-card-conversation');
await until(() => document.querySelector('.message-row.is-frozen'), 'frozen history rendered in English');
assert.equal(label('.message-row.is-frozen .frozen-badge'), 'Compressed');
assert.equal(document.querySelector('.message-row.is-frozen [aria-label="Edit this message"]').getAttribute('title'), 'This history is already compressed — edit the compression summary instead');
const frozenRows = Array.from(document.querySelectorAll('.message-row.is-frozen'));
assert.equal(frozenRows.length, 3, 'every message inside the summary boundary is frozen');
frozenRows.forEach(row => { const pencil = row.querySelector('[aria-label="Edit this message"]'); assert.ok(pencil, 'a frozen message keeps a visible pencil'); assert.equal(pencil.getAttribute('aria-disabled'), 'true'); });
assert.equal(document.querySelectorAll('.message-row:not(.is-frozen) [aria-disabled="true"]').length, 0, 'messages after the boundary stay editable');
assert.deepEqual(cjk('.message-list-inner'), [], 'the frozen history must not leak Chinese');
document.querySelector('.message-row.is-frozen [aria-label="Edit this message"]').click();
await tick(); await tick();
assert.equal(label('#toastRoot .toast'), 'This history is already compressed — edit the compression summary instead');
assert.equal(document.querySelector('#modalForm'), null, 'a frozen pencil never opens the message editor');
click('#chatMenuButton');
await until(() => document.querySelector('[data-chat-menu="summary"]'), 'chat menu in English');
assert.equal(label('[data-chat-menu="summary"]'), 'Compression summary · available');
click('[data-chat-menu="summary"]');
await until(() => document.querySelector('#modalForm [name="summary0"]'), 'compression summary sheet in English');
assert.ok(document.querySelector('.modal-sheet.summary-sheet'), 'the summary editor uses the fixed-height sheet');
assert.ok(document.querySelector('#modalForm .summary-edit > .field > .prompt-editor'), 'the summary textarea owns the flexible row of that sheet');
assert.equal(label('#modalTitle'), 'Edit the compression summary');
assert.equal(field('summary0').value, 'Earlier context in one line.');
assert.deepEqual(cjk('#modalForm'), [], 'the English summary sheet must not leak Chinese');
field('summary0', '   '); submit(); await tick(); await tick();
assert.equal(document.querySelector('.form-error').textContent, 'The compression summary cannot be empty');
assert.ok(document.querySelector('#modalForm'), 'an empty summary keeps the sheet open');
field('summary0', 'Hand-edited summary.'); submit();
await until(() => !document.querySelector('#modalForm'), 'summary saves in English');
const savedFreezeSummary = await app.data.store.get('summaries', 'i18n-card-conversation');
assert.equal(savedFreezeSummary.text, 'Hand-edited summary.'); assert.equal(savedFreezeSummary.throughMessageId, 'i18n-freeze-2');
assert.equal(label('#toastRoot .toast'), 'Compression summary updated');

console.log('bilingual UI checks passed (no layout, browser, device or provider acceptance claimed)');
