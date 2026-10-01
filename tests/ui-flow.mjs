// Optional DOM-only integration check. No browser or external model request is used.
// Point CHATAXI_DOM_MODULE to a locally installed linkedom module; it is never shipped.
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
Object.defineProperty(window.HTMLSelectElement.prototype, 'value', { get() { const option = this.querySelector('option[selected]') || this.querySelector('option'); return option ? option.value : ''; }, set(value) { this.querySelectorAll('option').forEach(option => { if (option.value === value) option.setAttribute('selected', ''); else option.removeAttribute('selected'); }); } });
Object.defineProperty(window.HTMLTextAreaElement.prototype, 'maxLength', { get() { return Number(this.getAttribute('maxlength') || -1); } });
const location = { hash: '#/conversations' };
const history = { state: null, replaceState(state, _, hash) { this.state = state; location.hash = hash; }, pushState(state, _, hash) { this.state = state; location.hash = hash; }, back() {} };
const context = vm.createContext({ window, document, location, history, navigator: { language: 'zh-CN', languages: ['zh-CN'] }, MutationObserver: window.MutationObserver, localStorage: { get length() { return data.size; }, key(i) { return [...data.keys()][i]; }, getItem(key) { return data.get(key) ?? null; }, setItem(key, value) { data.set(key, value); }, removeItem(key) { data.delete(key); } }, URL, Blob, TextEncoder, Uint8Array, Uint32Array, btoa, atob, console, setTimeout, clearTimeout, AbortController, Event: window.Event, requestAnimationFrame: fn => setTimeout(fn, 0) });
const scripts = [...fs.readFileSync(root + 'index.html', 'utf8').matchAll(/<script src="\.\/([^\"]+)"/g)].map(match => match[1]);
for (const script of scripts) vm.runInContext(fs.readFileSync(root + script, 'utf8'), context, { filename: script });
const app = window.chataxi;
app.platform.haminn.awaitReady = async () => false;
app.platform.haminn.info = async () => ({ runtimeMode: 'browser', bridgeMode: 'none' });
app.services.tts.stop = async () => {};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(fn, description) { for (let i = 0; i < 250; i++) { if (fn()) return; await tick(); } throw Error(description + '\n' + document.body.textContent.slice(-1500)); }
function field(name, value) { const node = document.querySelector('#modalForm [name="' + name + '"]'); assert.ok(node, name); if (arguments.length > 1) { if (node.type === 'checkbox') node.checked = value; else node.value = value; } return node; }
function submit() { document.querySelector('#modalForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); }
function click(selector) { const node = document.querySelector(selector); assert.ok(node, selector); node.click(); }
function type(selector, text) { const node = document.querySelector(selector); node.value = text; node.dispatchEvent(new window.Event('input', { bubbles: true })); }
document.dispatchEvent(new window.Event('DOMContentLoaded'));
await until(() => document.querySelector('[data-create]'), 'boot');
assert.equal(document.querySelector('#pageSubtitle').textContent, '想聊就聊，自由自在');
assert.ok(document.querySelector('.welcome-emblem .fa-comment-dots'));
let copiedGuideAddress = ''; app.platform.haminn.copyText = async value => { copiedGuideAddress = value; };
click('[data-connection-guide]');
await until(() => document.querySelector('.subsheet [data-guide-tab="beginner"]'), 'connection guide');
assert.ok(document.querySelector('.subsheet.connection-guide-sheet'));
assert.deepEqual(Array.from(document.querySelectorAll('.subsheet [data-guide-tab]')).map(button => button.textContent), ['新手', '专业', '国际', '问题']);
assert.match(document.querySelector('[data-guide-panel="beginner"]').textContent, /DeepSeek[\s\S]*Kimi[\s\S]*硅基流动/);
assert.equal(document.querySelectorAll('[data-guide-panel="beginner"] a').length, 0);
assert.equal(document.querySelector('[data-guide-panel="beginner"] code').textContent, 'https://platform.deepseek.com/api_keys');
const guideUrl = document.querySelector('[data-copy-url="https://platform.deepseek.com/api_keys"]');
assert.ok(guideUrl.querySelector('code')); assert.ok(guideUrl.querySelector('.fa-copy'));
assert.equal(guideUrl.firstElementChild.classList.contains('fa-copy'), true);
click('[data-copy-url="https://platform.deepseek.com/api_keys"]'); await until(() => copiedGuideAddress === 'https://platform.deepseek.com/api_keys', 'guide address copy');
click('.subsheet [data-guide-tab="professional"]'); assert.match(document.querySelector('[data-guide-panel="professional"]:not(.is-hidden)').textContent, /Ollama 软件/);
click('.subsheet [data-guide-tab="international"]'); assert.match(document.querySelector('[data-guide-panel="international"]:not(.is-hidden)').textContent, /OpenRouter[\s\S]*Requesty[\s\S]*302\.AI/);
click('.subsheet [data-guide-tab="troubleshooting"]'); assert.match(document.querySelector('[data-guide-panel="troubleshooting"]:not(.is-hidden)').textContent, /智能体开发模式/);
app.components.closeSubsheet();
click('[data-create]');
await until(() => document.querySelector('#modalForm [name="apiKey"]'), 'guided model service form');
assert.match(document.querySelector('[data-fetch-models]').textContent, /获取模型列表/);
assert.match(document.querySelector('[data-test-model]').textContent, /连接并测试/);
// 目录没获取成功之前，提交按钮就是「获取模型列表」。
assert.equal(document.querySelector('#modalSubmit').textContent, '获取模型列表');
assert.equal(document.querySelector('#modalSubmit').dataset.mode, 'fetch');
app.platform.network.requestJson = async options => options.method === 'GET'
  ? { data: { data: [{ id: 'gpt-4.1', owned_by: 'openai', supported_parameters: ['temperature'] }] } }
  : { data: { output_text: 'OK' } };
field('apiKey', 'fixture-key'); submit();
await until(() => document.querySelector('#modalSubmit').textContent === '保存设置', 'submit button turns into save after a successful catalog fetch');
assert.equal(document.querySelector('#modalSubmit').dataset.mode, 'save');
assert.ok(document.querySelector('#modalForm'), 'fetching the catalog through the submit button keeps the editor open');
assert.match(document.querySelector('[data-picker="externalModelId"] [data-picker-label]').textContent, /gpt-4\.1/);
assert.match(document.querySelector('#catalogStatus').textContent, /请选择一个模型。/);
// 但是「提示不写在版面里」：状态行带 visually-hidden（CSS 把它移出版面），看得见的是顶部 toast。
assert.ok(document.querySelector('#catalogStatus').classList.contains('visually-hidden'));
assert.ok(document.querySelector('#connectionStatus').classList.contains('visually-hidden'));
assert.match(document.querySelector('#toastRoot .toast').textContent, /请选择一个模型。/);
assert.equal(document.querySelector('.model-toggle'), null, 'one model card does not expose a multi-model switch list');
click('[data-picker="externalModelId"]'); await until(() => document.querySelector('.subsheet .choice-group-label'), 'grouped model choice sheet');
assert.match(document.querySelector('.subsheet .choice-group-label').textContent, /推荐用于对话模型/); click('.subsheet [data-choice="gpt-4.1"]'); await tick();
click('[data-test-model]'); await until(() => /连接成功/.test(document.querySelector('#connectionStatus').textContent), 'guided model test');
assert.match(document.querySelector('#toastRoot .toast').textContent, /连接成功/);
field('enabled', true); submit();
await until(() => document.querySelector('#modalForm [name="systemPrompt"]'), 'guided role form');
assert.ok(document.querySelector('#avatarPreview .fa-user'), 'unnamed role uses the user icon fallback');
assert.equal(document.querySelector('[data-role-avatar-name]').textContent, '未命名');
assert.equal(document.querySelector('.avatar-copy > small').textContent, '点击头像更换');
type('#modalForm [name="name"]', '临时角色'); assert.equal(document.querySelector('[data-role-avatar-name]').textContent, '临时角色');
type('#modalForm [name="name"]', ''); assert.equal(document.querySelector('[data-role-avatar-name]').textContent, '未命名');
assert.ok(document.querySelector('[data-open-role-templates]'), 'new role editor exposes the template gallery');
assert.equal(document.querySelector('[data-open-role-templates] span').textContent, '使用模版');
click('[data-open-role-templates]'); await until(() => document.querySelector('.role-template-grid'), 'role template gallery');
assert.equal(document.querySelector('.role-template-help').textContent, '点击角色卡片直接应用');
assert.deepEqual(Array.from(document.querySelectorAll('[data-template-tab]')).map(button => button.textContent), ['全部', '男性', '女性', '其他']);
assert.equal(document.querySelectorAll('[data-role-template]').length, 27);
assert.equal(document.querySelectorAll('[data-role-template]:not(.is-hidden)').length, 27);
assert.deepEqual(Array.from(document.querySelectorAll('[data-role-template]:not(.is-hidden)')).map(button => button.dataset.templateCategory), Array(9).fill(['male', 'female', 'other']).flat());
click('[data-template-tab="male"]');
assert.equal(document.querySelectorAll('[data-role-template]:not(.is-hidden)').length, 9);
assert.ok(Array.from(document.querySelectorAll('[data-role-template]:not(.is-hidden)')).every(button => button.dataset.templateCategory === 'male'));
click('[data-template-tab="female"]');
assert.equal(document.querySelectorAll('[data-role-template]:not(.is-hidden)').length, 9);
assert.match(document.querySelector('[data-role-template="lin-xiaoyu"]').textContent, /陈佳宁[\s\S]*动画专业大一学生、校园社团分镜师[\s\S]*18岁[\s\S]*女/);
click('[data-template-tab="other"]');
assert.equal(document.querySelectorAll('[data-role-template]:not(.is-hidden)').length, 9);
assert.ok(Array.from(document.querySelectorAll('[data-role-template]:not(.is-hidden)')).every(button => button.dataset.templateCategory === 'other'));
assert.match(document.querySelector('[data-role-template="pao-rong"]').textContent, /泡绒[\s\S]*卡通幻想生物·未寄信邮差[\s\S]*其他/);
assert.doesNotMatch(document.querySelector('[data-role-template="pao-rong"]').textContent, /岁/);
click('[data-template-tab="all"]'); assert.equal(document.querySelectorAll('[data-role-template]:not(.is-hidden)').length, 27);
app.components.closeSubsheet();
field('name', '测试搭档'); field('systemPrompt', '你是测试搭档，清晰回答问题。'); submit();
await until(() => document.querySelector('#selectionSummary'), 'guided conversation form');
assert.equal(document.querySelector('#modalSubmit').disabled, false);
assert.equal(document.querySelector('[name="kind"]'), null); assert.equal(document.querySelector('[name="recentFullMessages"]'), null, 'the per-conversation retained-N slider must be gone');
submit();
await until(() => document.querySelector('#messageInput'), 'chat opened');
// 对话刚开始（还没有消息）时的欢迎面板：角色头像本身就是按钮，点它打开标准角色编辑弹窗。
assert.ok(document.querySelector('.chat-welcome'), 'an empty conversation shows the welcome panel');
const welcomeAvatar = document.querySelector('.chat-welcome-avatar');
assert.ok(welcomeAvatar, 'the welcome avatars are clickable buttons');
assert.equal(welcomeAvatar.dataset.editWelcomeRole, (await app.data.store.list('roles'))[0].id);
assert.equal(welcomeAvatar.getAttribute('aria-label'), '编辑角色 测试搭档');
assert.ok(welcomeAvatar.querySelector('.avatar.large'), 'the welcome avatar keeps its large style inside the button');
click('.chat-welcome-avatar');
await until(() => document.querySelector('#modalForm [name="systemPrompt"]'), 'standard role editor from the welcome avatar');
assert.equal(field('name').value, '测试搭档');
assert.equal(field('systemPrompt').value, '你是测试搭档，清晰回答问题。');
app.components.closeModal(true, true); await tick();
assert.ok(document.querySelector('.chat-welcome-avatar'), 'closing the editor leaves the welcome panel intact');
console.log('passed: the welcome-panel avatar opens the standard role editor');
const conversations = await app.data.store.list('conversations');
assert.equal(conversations.length, 1);
const id = conversations[0].id;
assert.equal((await app.data.store.list('roles'))[0].name, '测试搭档');
console.log('passed: model service → role → conversation onboarding');

await app.navigate('roles');
const originalTemplateAvatarBlob = app.features.roles.templateAvatarBlob;
const originalMediaPut = app.data.media.put;
const originalMediaRemove = app.data.media.remove;
let removedTemplateAvatar = '';
app.features.roles.templateAvatarBlob = async () => new Blob(['avatar'], { type: 'image/jpeg' });
app.data.media.put = async () => ({ id: 'template-avatar-fixture' });
app.data.media.remove = async mediaId => { removedTemplateAvatar = mediaId; };
click('[data-add-role]'); await until(() => document.querySelector('[data-open-role-templates]'), 'new role template trigger');
assert.equal(field('behaviorGuidance').getAttribute('rows'), '4', 'behavior guidance is a four-row field');
assert.equal(field('systemPrompt').getAttribute('rows'), '4', 'identity and personality is a four-row field');
assert.match(field('behaviorGuidance').value, /我必须根据情景自主对话[\s\S]*我每次回复必须用第一人称[\s\S]*我必须独立思考/, 'a new role starts from the default behavior guidance');
const templateModelBefore = field('llmProfileId').value;
click('[data-open-role-templates]'); await until(() => document.querySelector('[data-role-template="lin-xiaoyu"]'), 'template gallery selection'); click('[data-template-tab="female"]');
click('[data-role-template="lin-xiaoyu"]'); await until(() => field('name').value === '陈佳宁', 'template applied');
assert.equal(document.querySelector('[data-role-avatar-name]').textContent, '陈佳宁');
assert.equal(field('systemPrompt').value, app.data.roleTemplates.items.find(item => item.id === 'lin-xiaoyu').systemPrompt);
assert.equal(field('behaviorGuidance').value, app.data.roleTemplates.items.find(item => item.id === 'lin-xiaoyu').behaviorGuidance, 'a template brings its own behavior guidance');
assert.equal(field('llmProfileId').value, templateModelBefore, 'template must not replace the selected model');
assert.match(document.querySelector('#avatarPreview img').getAttribute('src'), /lin-xiaoyu\.webp$/);
app.components.closeModal(); await until(() => removedTemplateAvatar === 'template-avatar-fixture', 'cancelled template avatar cleanup');
app.features.roles.templateAvatarBlob = originalTemplateAvatarBlob;
app.data.media.put = originalMediaPut;
app.data.media.remove = originalMediaRemove;
assert.equal((await app.data.store.list('roles')).length, 1, 'previewing a template must not create a role');
await app.openChat(id);
console.log('passed: schema 2 role template gallery applies profile fields and cleans up cancelled avatar');

click('#chatMenuButton'); await until(() => document.querySelector('[data-chat-menu="settings"]'), 'merged conversation settings menu');
// 菜单顺序以 chat.js 的 manageChat 为准: settings / background / voice / summary / export / pin / delete。
// 这里只取前三项。曾经写的是 ['settings','voice','summary'] —— 「对话背景」那一项落地之后这条就过期了,
// 于是整个 DOM 流程套件从这一行直接抛错退出, 后面所有断言都跑不到（看起来像"界面坏了"）。
assert.deepEqual(Array.from(document.querySelectorAll('[data-chat-menu]')).slice(0, 3).map(button => button.dataset.chatMenu), ['settings', 'background', 'voice']);
let generatedSceneRequest;
app.services.llm.generateScene = async (moderator, participants, conversation, userProfile, modes, guidance) => {
  generatedSceneRequest = { moderator, participants, conversation, userProfile, modes, guidance };
  return { text: '深夜，雨中的旧车站只剩最后一盏灯。远处传来列车缓慢靠站的声音。' };
};
click('[data-chat-menu="settings"]'); await until(() => document.querySelector('#modalForm [name="openingScene"]'), 'merged settings sheet');
assert.equal(document.querySelector('#modalTitle').textContent, '常规设定');
assert.ok(document.querySelector('.modal-sheet.conversation-settings-sheet'), 'the merged settings use the fixed-height sheet');
assert.deepEqual(Array.from(document.querySelectorAll('[data-conversation-tab]')).map(button => button.textContent), ['基础设定', '个人设定', '场景设定']);
assert.deepEqual(Array.from(document.querySelectorAll('[data-conversation-tab]')).map(button => button.getAttribute('aria-selected')), ['true', 'false', 'false']);
click('[data-conversation-tab="scene"]');
assert.ok(document.querySelector('[data-conversation-panel="scene"]:not(.is-hidden)'), 'scene settings are a sub-tab of the same modal');
assert.equal(document.querySelector('[data-conversation-panel="basic"]').className.includes('is-hidden'), true, 'only one settings sub-tab is visible at a time');
assert.deepEqual(Array.from(document.querySelectorAll('[data-scene-tab]')).map(button => button.textContent), ['手工设定', '自动生成']);
assert.equal(document.querySelector('.scene-settings-content > .helper'), null, 'legacy scene explanation is removed');
click('[data-scene-tab="auto"]');
assert.ok(document.querySelector('[data-scene-panel="auto"]:not(.is-hidden)'));
assert.deepEqual(Array.from(document.querySelectorAll('[data-scene-mode]')).map(button => button.textContent), ['闲聊', '思辨', '学习', '工作', '倾诉']);
assert.match(fs.readFileSync(root + 'styles/app.css', 'utf8'), /\.scene-mode-chip \+ \.scene-mode-chip \{ margin-left: 8px; \}/);
assert.equal(document.querySelector('[name="sceneGenerationPrompt"]').getAttribute('placeholder'), '补充关键词');
assert.equal(document.querySelector('[name="sceneGenerationPrompt"]').tagName, 'INPUT');
assert.equal(document.querySelector('[data-generate-scene] span').textContent, '生成');
click('[data-scene-mode="思辨"]'); click('[data-scene-mode="学习"]');
assert.equal(document.querySelector('[data-scene-mode="思辨"]').getAttribute('aria-pressed'), 'false');
assert.equal(document.querySelectorAll('[data-scene-mode][aria-pressed="true"]').length, 1);
field('sceneGenerationPrompt', '围绕一张旧车票展开'); click('[data-generate-scene]');
await until(() => /远处传来列车/.test(field('openingScene').value), 'generated opening scene fills the editor');
assert.equal(generatedSceneRequest.moderator.name, '测试搭档'); assert.equal(generatedSceneRequest.participants.length, 1);
assert.deepEqual(Array.from(generatedSceneRequest.modes), ['学习']); assert.equal(generatedSceneRequest.guidance, '围绕一张旧车票展开');
assert.match(document.querySelector('[data-scene-generation-status]').textContent, /可继续编辑后保存/);
assert.ok(document.querySelector('[data-scene-generation-status]').classList.contains('visually-hidden'));
assert.match(document.querySelector('#toastRoot .toast').textContent, /可继续编辑后保存/);
submit();
await until(() => document.querySelector('.message-row.system'), 'opening scene materialized');
let sceneMessages = await app.data.store.messages(id);
assert.equal(sceneMessages.length, 1); assert.equal(sceneMessages[0].kind, 'system'); assert.equal(sceneMessages[0].systemType, 'scene');
assert.match(sceneMessages[0].text, /远处传来列车/);
assert.equal(document.querySelector('.message-row.system .message-name').textContent, '系统');
assert.equal(document.querySelector('.message-row.system .message-avatar-trigger'), null); assert.equal(document.querySelector('.message-row.system [data-regenerate-message]'), null);
click('.message-row.system [aria-label="编辑这条消息"]'); await until(() => document.querySelector('#modalForm [name="text"]'), 'ordinary scene message edit');
field('text', '深夜，雨中的旧车站只剩一盏灯。'); submit(); await until(() => !document.querySelector('#modalForm'), 'scene message edit saved');
sceneMessages = await app.data.store.messages(id); assert.equal(sceneMessages.length, 1); assert.equal(sceneMessages[0].text, '深夜，雨中的旧车站只剩一盏灯。');
console.log('passed: opening scene materializes once as an editable system message');

type('#messageInput', '离开后保留这份草稿');
await app.navigate('conversations');
assert.match(document.querySelector('.draft-preview').textContent, /保留这份草稿/);
await app.openChat(id);
assert.equal(document.querySelector('#messageInput').value, '离开后保留这份草稿');
let calls = 0;
app.services.llm.complete = async () => { calls++; return { text: '<script>unsafe()</script>纯文本回复', images: [], usage: null }; };
click('#sendButton');
await until(() => calls === 1 && !app.features.chatSession.active(id), 'send completes');
await tick(); await tick();
assert.equal((await app.data.store.messages(id)).length, 3);
assert.equal(document.querySelector('#messageInput').value, '');
assert.equal(document.querySelector('#messageListInner script'), null);
assert.match(document.querySelector('#messageListInner').textContent, /<script>unsafe\(\)<\/script>/);
console.log('passed: draft persistence, message sending, safe model text');

await app.features.conversations.manage(id);
click('[data-menu="settings"]');
await until(() => document.querySelector('#selectionSummary'), 'edit conversation');
field('title', '重新命名的对话'); submit();
await until(() => document.querySelector('#pageTitle').textContent === '重新命名的对话', 'renamed');
await app.navigate('conversations');
type('#listSearch', '不存在的关键词'); assert.match(document.querySelector('#conversationList').textContent, /没有找到/);
type('#listSearch', '重新命名'); assert.equal(document.querySelectorAll('[data-open]').length, 2); assert.ok(Array.from(document.querySelectorAll('[data-open]')).every(button => button.dataset.open === id));
console.log('passed: editing conversation and list filtering');

// 基础设定里的角色头像直接打开标准角色编辑弹窗；回来时这一轮所有子 tab 的未保存输入都要还在。
await app.features.conversations.manage(id);
click('[data-menu="settings"]'); await until(() => document.querySelector('[data-edit-participant]'), 'merged settings participants');
field('title', '未保存的标题草稿');
click('[data-edit-participant]'); await until(() => document.querySelector('#modalForm [name="behaviorGuidance"]'), 'participant avatar opens the standard role editor');
assert.equal(field('behaviorGuidance').getAttribute('rows'), '4');
assert.equal(field('systemPrompt').getAttribute('rows'), '4');
assert.equal(document.querySelector('#modalForm [name="name"]').value, '测试搭档');
app.components.closeModal();
await until(() => document.querySelector('#modalForm [name="title"]'), 'merged settings reopened after the role editor');
assert.equal(field('title').value, '未保存的标题草稿', 'unsubmitted settings survive the role-editor round trip');
assert.ok(document.querySelector('[data-edit-participant]'), 'the participants list is rebuilt in the reopened settings');
app.components.closeModal(); await tick();
assert.equal(document.querySelector('#modalForm'), null, 'cancelling the merged settings leaves nothing behind');
console.log('passed: participant avatar opens the standard role editor and returns to the merged settings');

// 行为指导不能只存在界面上：它必须随角色一起进入发给模型的上下文。
const guidanceRole = { id: 'guidance-role', name: '陈佳宁', systemPrompt: '我是陈佳宁，动画专业大一学生。', behaviorGuidance: '我必须自己把对话推下去，注意节奏。\n我每次只用第一人称说很少几句。', llmProfileId: '', model: '' };
const guidancePeer = { id: 'guidance-peer', name: '泡绒', systemPrompt: '我是泡绒，云端邮差。', behaviorGuidance: '我先把对方没说出口的部分接住。', llmProfileId: '', model: '' };
// 先取共享拼装函数的结果：applyToRole 会就地改写角色对象，顺序反了会拿到被覆盖后的身份性格。
assert.equal(app.services.context.roleReference(guidanceRole), '角色「陈佳宁」：\n我是陈佳宁，动画专业大一学生。\n行为指导：\n我必须自己把对话推下去，注意节奏。\n我每次只用第一人称说很少几句。', 'the shared role reference must join identity and guidance');
assert.doesNotMatch(app.services.context.roleReference({ id: 'x', name: '无指导', systemPrompt: '只有身份。' }), /行为指导/, 'a role without guidance must not gain an empty guidance heading');
const roleContext = app.services.context.applyToRole(guidanceRole, [guidanceRole, guidancePeer], { name: '测试用户', introduction: '喜欢直接、清晰的回答。' }).systemPrompt;
assert.match(roleContext, /<active_role>[\s\S]*我是陈佳宁，动画专业大一学生。[\s\S]*<\/active_role>[\s\S]*<behavior_guidance>[\s\S]*我必须自己把对话推下去，注意节奏。\n我每次只用第一人称说很少几句。[\s\S]*<\/behavior_guidance>/, 'the active role behavior guidance must follow its identity block');
assert.match(roleContext, /<other_roles_reference>[\s\S]*泡绒[\s\S]*我先把对方没说出口的部分接住。/, 'other participants must carry their own behavior guidance');
console.log('passed: behavior guidance travels with the role into the model context');

await app.openChat(id);
const unchangedMessage = document.querySelector('.message-row');
app.services.llm.complete = async () => { throw Error('模拟服务暂时不可用'); };
type('#messageInput', '失败后重试'); click('#sendButton');
await until(() => document.querySelector('.message-error') && !app.features.chatSession.active(id), 'failed reply rendered');
await tick(); await tick();
const retry = document.querySelector('.message-bubble .button');
assert.equal(retry.disabled, false, 'retry must be enabled after leaving busy state');
assert.equal(document.querySelector('.message-row'), unchangedMessage, 'unchanged message nodes are reused');
app.services.llm.complete = async () => ({ text: '重试恢复', images: [] }); retry.click();
await until(() => document.querySelector('#messageListInner').textContent.includes('重试恢复') && !app.features.chatSession.active(id), 'retry recovered');
assert.equal((await app.data.store.messages(id)).length, 5);
let entered, late;
const requestStarted = new Promise(resolve => { entered = resolve; });
app.services.llm.complete = async () => { entered(); return new Promise(resolve => { late = resolve; }); };
type('#messageInput', '停止这次请求'); click('#sendButton'); await requestStarted;
assert.equal(document.querySelector('#sendButton').getAttribute('aria-label'), '停止本轮回复');
click('#sendButton');
await until(() => !app.features.chatSession.active(id), 'turn stopped');
late({ text: '迟到的结果', images: [] }); await tick(); await tick();
assert.equal((await app.data.store.messages(id)).at(-1).status, 'cancelled');
assert.equal(document.querySelector('#messageListInner').textContent.includes('迟到的结果'), false);
console.log('passed: enabled retry after error, stable message nodes, UI stop with late response');

// ── 绘图永远独立占一条消息：超时或失败都不许并进那条原始文字消息（业主 2026-09-27） ──
// 这一段跑的是**真实点击路径**。静态门禁只能证明写法，证明不了"点下去不炸"：曾经那个缺陷
// 就是按钮看着正常、点下去抛 ReferenceError: id is not defined（会话 id 取了作用域里不存在的 id）。
const drawCard = { profile: { id: 'chp-fixture' }, modelId: 'render' };
// 重新绘制走的是另一条路：resolveCard 只认消息里记下的那张卡片（它的兜底 available 是模块内部的，桩打不到），
// 所以这里必须把 resolveCard 也一起接管，否则"重新绘制"会以为卡片没了、直接失败。
const originalDrawAvailable = app.services.draw.available, originalDrawResolveCard = app.services.draw.resolveCard, originalDrawGenerate = app.services.draw.generate, originalDrawMediaPut = app.data.media.put;
const drawBlob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
let drawCalls = 0, lastDrawPrompt = '';
// failure 给第几次调用就第几次抛（模拟插件请求超时），不给就一路成功。
const drawingStub = failure => { app.services.draw.generate = async options => { drawCalls += 1; lastDrawPrompt = options.prompt; if (failure === drawCalls) throw Error('绘图插件请求超时'); return { blob: drawBlob, mime: 'image/png', job: { id: 'job-' + drawCalls } }; }; };
app.services.draw.available = async () => drawCard;
app.services.draw.resolveCard = async () => drawCard;
app.data.media.put = async () => ({ id: 'draw-media-fixture' });
app.services.llm.complete = async () => ({ text: '给你看看我现在的样子。', images: [], action: { type: 'draw', prompt: '雨夜的旧车站, 少女侧身站在灯下' } });
drawingStub(1);
type('#messageInput', '发张你的照片看看'); click('#sendButton');
await until(() => drawCalls === 1, 'the drawing action reaches the drawing client');
await until(() => !app.features.chatSession.drawing(id) && !app.features.chatSession.active(id), 'the failed drawing releases its slot');
await app.features.chat.renderMessages(); await tick();
const afterFailedDraw = await app.data.store.messages(id), drawMessage = afterFailedDraw.at(-1), replyMessage = afterFailedDraw.at(-2);
assert.notEqual(drawMessage.id, replyMessage.id, 'the drawing is its own message; it is never merged into the reply that asked for it');
assert.equal(drawMessage.kind, 'assistant'); assert.equal(drawMessage.text, '');
assert.equal(drawMessage.status, 'error', 'a timeout leaves the drawing message in its own failed state');
assert.equal(drawMessage.draw.prompt, '雨夜的旧车站, 少女侧身站在灯下');
assert.equal(replyMessage.status, 'done', 'a failed drawing must not damage the reply that asked for it');
assert.equal(replyMessage.text, '给你看看我现在的样子。');
assert.equal(replyMessage.media.length, 0, 'the drawing result never gets attached to the reply message');
assert.equal(replyMessage.draw, undefined, 'the reply message carries no drawing record');
assert.equal(replyMessage.error, '');
const drawRow = document.querySelector('[data-message-id="' + drawMessage.id + '"]');
assert.ok(drawRow, 'the failed drawing gets its own bubble');
assert.match(drawRow.querySelector('.message-error').textContent, /绘图插件请求超时/);
const redraw = drawRow.querySelector('.message-bubble .button');
assert.equal(redraw.textContent, '重新绘制这张图'); assert.equal(redraw.disabled, false);
// 这一击就是原缺陷的现场：游离的 id 会在这里抛 ReferenceError，按钮看着在、其实什么也不会发生。
redraw.click();
await until(() => drawCalls === 2, '重新绘制这张图 must really start another drawing');
await until(() => !app.features.chatSession.drawing(id), 'the redraw finishes');
const afterRedraw = await app.data.store.messages(id);
assert.equal(afterRedraw.length, afterFailedDraw.length, '重新绘制 reuses the same image message instead of appending a record');
assert.equal(afterRedraw.at(-1).id, drawMessage.id);
assert.equal(afterRedraw.at(-1).status, 'done'); assert.equal(afterRedraw.at(-1).media.length, 1);
assert.equal(afterRedraw.at(-2).id, replyMessage.id, 'the reply that asked for the image stays exactly where it was');
assert.equal(lastDrawPrompt, '雨夜的旧车站, 少女侧身站在灯下', 'the redraw reuses the prompt stored on the message instead of asking the model again');
// 正文为空、只带绘图动作的那一轮：绘图依然独占一条消息，那条空的文本消息不许留下。
const beforeActionOnlyList = await app.data.store.messages(id), beforeActionOnlyTurn = beforeActionOnlyList.length;
// 历史里本来就有一条被用户停止的助手消息（text 被清空），所以判据只能是"空正文消息没有变多"。
const emptyAssistantCount = list => list.filter(message => message.kind === 'assistant' && !message.text && !message.draw).length;
app.services.llm.complete = async () => ({ text: '', images: [], action: { type: 'draw', prompt: '一只趴在窗台的橘猫' } });
drawingStub();
type('#messageInput', '画只猫'); click('#sendButton');
await until(() => drawCalls === 3, 'the action-only turn also reaches the drawing client');
await until(() => !app.features.chatSession.drawing(id) && !app.features.chatSession.active(id), 'the action-only drawing finishes');
const actionOnlyTurn = await app.data.store.messages(id), addedByActionOnlyTurn = actionOnlyTurn.slice(beforeActionOnlyTurn);
assert.equal(addedByActionOnlyTurn.length, 2, 'an action-only turn adds the user message plus exactly one drawing message');
assert.equal(addedByActionOnlyTurn[0].kind, 'user'); assert.equal(addedByActionOnlyTurn[0].text, '画只猫');
assert.equal(addedByActionOnlyTurn[1].kind, 'assistant'); assert.equal(addedByActionOnlyTurn[1].text, '');
assert.equal(addedByActionOnlyTurn[1].draw.prompt, '一只趴在窗台的橘猫');
assert.equal(addedByActionOnlyTurn[1].status, 'done'); assert.equal(addedByActionOnlyTurn[1].media.length, 1);
assert.equal(emptyAssistantCount(actionOnlyTurn), emptyAssistantCount(beforeActionOnlyList), 'an action-only turn removes its own empty text message instead of leaving it behind');

// ── 生成中那一条下面的「停止」：生图消息与角色消息各一个（业主 2026-09-27） ──────────────
// 两条任务的生命周期不同 —— 绘图**不占** tasks[id]（见 chat-session.js 文件头的 drawTasks 注释）,
// 所以两个按钮必须各走各的开关（cancelDraw / stop）。这一段跑真实点击, 证明"按下去真的停、
// 状态真的落地、按钮自己会消失", 而不是只证明代码里写了两个函数名。
let drawCancelled = false;
// 假插件：只有拿到 task.cancelled 才收手 —— 与真 draw.js 的轮询同构, 否则这个测试会自己骗自己。
app.services.draw.generate = options => new Promise((resolve, reject) => {
  drawCalls += 1; lastDrawPrompt = options.prompt;
  const poll = () => {
    if (options.task.cancelled) { drawCancelled = true; const error = Error('本轮已停止'); error.cancelled = true; reject(error); return; }
    setTimeout(poll, 10);
  };
  poll();
});
app.services.llm.complete = async () => ({ text: '', images: [], action: { type: 'draw', prompt: '一张要中途停下的图' } });
type('#messageInput', '画一张, 我中途喊停'); click('#sendButton');
await until(() => app.features.chatSession.drawing(id), 'the drawing task is running');
await until(() => document.querySelector('[data-stop-generation="drawing"]'), '生图中的消息下面必须有停止按钮');
assert.equal(document.querySelector('[data-stop-generation="drawing"]').textContent.trim(), '停止');
document.querySelector('[data-stop-generation="drawing"]').click();
await until(() => drawCancelled, 'the stop button must really cancel the drawing, not just redraw the screen');
await until(() => !app.features.chatSession.drawing(id), 'the cancelled drawing releases its slot');
await until(() => !document.querySelector('[data-stop-generation="drawing"]'), '停掉之后按钮必须跟着走了');
await tick();
const stoppedDraw = (await app.data.store.messages(id)).at(-1);
assert.equal(stoppedDraw.status, 'cancelled', '被停掉的绘图要落成 cancelled, 不能永远挂在"正在绘制图片…"');
assert.equal(stoppedDraw.error, '本轮已停止');
// 「action 不受对话控制」的可执行判据：先起一张在跑的图, 再让正文进入生成, 然后按**正文**那一条
// 的停止 —— 绘图必须还活着。这正是把两个按钮分成两条路径的理由。
let drawStillAlive = false;
app.services.draw.generate = options => new Promise((resolve, reject) => {
  drawStillAlive = true;
  const poll = () => { if (options.task.cancelled) { const error = Error('本轮已停止'); error.cancelled = true; reject(error); return; } setTimeout(poll, 10); };
  poll();
});
app.services.llm.complete = async () => ({ text: '', images: [], action: { type: 'draw', prompt: '这一张不许被对话停掉' } });
type('#messageInput', '再画一张'); click('#sendButton');
await until(() => drawStillAlive && Boolean(app.features.chatSession.drawing(id)), 'a detached drawing is running again');
let enteredReply, releaseReply;
const replyStarted = new Promise(resolve => { enteredReply = resolve; });
app.services.llm.complete = async () => { enteredReply(); return new Promise(resolve => { releaseReply = resolve; }); };
type('#messageInput', '绘图还在跑的时候停正文'); click('#sendButton');
await replyStarted;
await until(() => document.querySelector('[data-stop-generation="pending"]'), '角色生成中的消息下面必须有停止按钮');
document.querySelector('[data-stop-generation="pending"]').click();
await until(() => !app.features.chatSession.active(id), 'the reply-level stop button must stop the turn');
assert.equal(Boolean(app.features.chatSession.drawing(id)), true, '对话级的停止不许把绘图一起掐掉: action 不受对话控制');
releaseReply({ text: '迟到的回复', images: [] }); await tick(); await tick();
assert.equal((await app.data.store.messages(id)).at(-1).status, 'cancelled', '被停掉的正文落成 cancelled');
app.features.chatSession.cancelDraw(id);
await until(() => !app.features.chatSession.drawing(id), 'clean up the detached drawing before restoring the stubs');
app.services.draw.available = originalDrawAvailable; app.services.draw.resolveCard = originalDrawResolveCard; app.services.draw.generate = originalDrawGenerate; app.data.media.put = originalDrawMediaPut;
console.log('passed: drawing is always its own message and 重新绘制这张图 really redraws');

// ── 全屏看图：基线是高度充满，手机的系统返回只关掉看图这一层（业主 2026-09-27） ──────────
// 跑的是真实事件路径。静态门禁只能证明"写了 popstate"，证明不了"按返回真的会关掉、而且只关这一层"。
// 基线（scale = 1）现在表示"图片高度等于屏幕高"，缩放数值本身在无布局的测试环境里量不出来，
// 但"打开时就是基线、返回后整层消失、自己关掉时把压进去的那一格历史收回来"这三件事是可判定的。
const backPressed = history.back.bind(history);
let historyBacks = 0;
history.back = () => { historyBacks += 1; return backPressed(); };
const opened = app.components.imageViewer.open({ src: '/__haminn/files/viewer-fixture', alt: '测试图', onDownload: () => {}, onSetBackground: () => {} });
await tick();
assert.ok(document.querySelector('.image-viewer'), '点图片必须打开全屏看图');
// 底部那条工具栏是**唯一**的动作出口（业主 2026-09-27: 右上角那个单独的关闭按钮、以及底部的
// 提示词都撤掉了, 动作收进一条磨砂工具栏; 第六轮又在最左边加了「画廊」）。所以这里同时核对
// "四个都在, 且就这四个", 以及次序 —— 业主明说画廊在底部菜单的**左侧**。
assert.deepEqual(Array.from(document.querySelectorAll('.image-viewer-toolbar [data-viewer-action]')).map(node => node.dataset.viewerAction), ['gallery', 'download', 'background', 'close'], '看图底部必须是 画廊 / 下载 / 设为背景 / 关闭 四个动作, 且次序如此');
// 这一次打开没给画廊（只有一张图）⇒ 那个按钮必须自己藏起来。摆在那里点了没反应是最糟的样子。
assert.equal(document.querySelector('[data-viewer-action="gallery"]').hidden, true, '只有一张图时「画廊」按钮必须隐藏');
assert.equal(document.querySelector('.image-viewer-caption'), null, '底部不再显示提示词');
assert.equal(document.querySelector('.image-viewer-close'), null, '右上角那个单独的关闭按钮已经撤掉');
assert.equal(document.querySelector('.image-viewer img').style.transform, 'translate(0px,0px) scale(1)', '一打开就停在基线（高度充满），不是缩进屏幕里');
assert.equal(history.state.chataxiImageViewer, true, '打开看图必须压一格带标记的历史记录');
assert.equal(document.body.style.overflow, 'hidden', '看图期间要锁住页面滚动');
window.dispatchEvent(new window.Event('popstate'));
await opened; await tick();
assert.equal(document.querySelector('.image-viewer'), null, '系统返回（含侧滑）必须关掉看图');
assert.equal(document.body.style.overflow, '', '关闭后必须还原页面滚动');
// 自己关掉（这里走工具栏的「关闭」）时要把那一格历史收回来，否则它会吞掉用户的下一次返回。
historyBacks = 0;
const reopened = app.components.imageViewer.open({ src: '/__haminn/files/viewer-fixture', alt: '测试图' });
await tick();
// 没给回调的两个动作必须自己藏起来 —— 摆在那里点了没反应是最糟的样子。
assert.deepEqual(Array.from(document.querySelectorAll('.image-viewer-toolbar [data-viewer-action]:not([hidden])')).map(node => node.dataset.viewerAction), ['close'], '没有下载 / 设为背景回调时, 那两个按钮必须隐藏, 只留关闭');
document.querySelector('[data-viewer-action="close"]').click();
await reopened; await tick();
assert.equal(document.querySelector('.image-viewer'), null, '工具栏上的「关闭」照常关掉看图');
assert.equal(historyBacks, 1, '自己关掉时要调一次 history.back() 收掉压进去的那一格');
history.back = backPressed;
console.log('passed: full-screen viewer fills the height and the back gesture only closes the viewer');

// ── 画廊侧栏 / 点画面切控件 / 上下滑动换图（业主 2026-09-27 第六轮）──────────────────────
// 这三件事全发生在同一块画面上，而且彼此咬合：**「点一下」原来就是"关掉看图"**，现在改成了切控件；
// 上下滑动又和放大后的平移抢同一根手指。所以静态门禁不够（它只能证明写法与它一致），必须走真实事件。
const galleryHits = [];
const galleryEntry = (index, name) => ({
  src: '/__haminn/files/g' + index + '-fixture', alt: '图 ' + index,
  onDownload: () => { galleryHits.push('download:' + name); },
  onSetBackground: () => { galleryHits.push('background:' + name); }
});
// index = 1：一打开看的就必须是第二张（不是第一张）—— 这一条是"从某张图点进来就接着看它"的全部意义。
const galleryOpened = app.components.imageViewer.open({
  src: '/__haminn/files/g2-fixture', alt: '图 2', index: 1,
  gallery: [galleryEntry(1, 'one'), galleryEntry(2, 'two'), galleryEntry(3, 'three')]
});
await tick();
const viewerStage = document.querySelector('.image-viewer-stage');
// linkedom 没有真实布局、也没有指针捕获，这两样就地打桩：这一段要验的是**判定逻辑**（点 / 划 /
// 定轴 / 换图），不是引擎本身。桩打在同一批节点上，组件内部拿到的引用不受影响。
viewerStage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
viewerStage.setPointerCapture = () => {};
const viewerRoot = () => document.querySelector('.image-viewer');
const galleryPanel = document.querySelector('.image-viewer-gallery');
const currentSrc = () => String(document.querySelector('.image-viewer img').getAttribute('src') || '');
// 切控件要等一个双击窗口（DOUBLE_TAP_MS = 320）才落地，所以下面每次手势之间都要让时间走过去。
const settled = () => new Promise(resolve => setTimeout(resolve, 360));
const firePointer = (type, x, y) => {
  const event = new window.Event(type, { bubbles: true });
  event.clientX = x; event.clientY = y; event.pointerId = 1; event.pointerType = 'touch';
  viewerStage.dispatchEvent(event);
};
const tapStage = async () => { await settled(); firePointer('pointerdown', 10, 10); firePointer('pointerup', 10, 10); await settled(); };
const swipeStage = async (fromY, toY) => {
  await settled();  // 让上一次按下离这一次足够远：320ms 内的两次按下会被判成双击
  firePointer('pointerdown', 10, fromY);
  firePointer('pointermove', 10, Math.round((fromY + toY) / 2));
  firePointer('pointermove', 10, toY);
  firePointer('pointerup', 10, toY);
  await tick(); await tick();
};

assert.ok(galleryPanel, '给了多张图时必须渲染出画廊侧栏');
assert.equal(document.querySelectorAll('.image-viewer-thumb').length, 3, '侧栏要列出这一组里的每一张');
assert.deepEqual(Array.from(document.querySelectorAll('.image-viewer-toolbar [data-viewer-action]:not([hidden])')).map(node => node.dataset.viewerAction), ['gallery', 'download', 'background', 'close'], '有画廊时四个按钮都要露面, 且「画廊」在最左');
assert.equal(document.querySelector('.image-viewer-thumb.is-current').dataset.galleryIndex, '1', '打开时"我正在看的那张"必须在侧栏里被标出来');
assert.equal(galleryPanel.classList.contains('is-open'), false, '侧栏一开始是收着的');
document.querySelector('[data-viewer-action="gallery"]').click();
assert.equal(galleryPanel.classList.contains('is-open'), true, '点「画廊」必须把侧栏推出来');

// 点第三张：换图，而且**两个动作要跟着换成这一张的** —— 不然切过去再按「下载」，存下来的还是第一张。
document.querySelectorAll('.image-viewer-thumb')[2].click();
await tick(); await tick(); await tick();
assert.ok(/g3-fixture$/.test(currentSrc()), '点缩略图必须换成那一张');
assert.equal(document.querySelector('.image-viewer-thumb.is-current').dataset.galleryIndex, '2', '当前是哪张要跟着动');
assert.deepEqual(galleryHits, [], '光是换图不该触发任何动作');
document.querySelector('[data-viewer-action="download"]').click();
await tick(); await tick(); await tick();
assert.deepEqual(galleryHits, ['download:three'], '换图之后按「下载」, 存的必须是当前这一张');

// 点画面一下 = 切控件显隐（**不是**关掉看图 —— 同一个"点一下"不可能既是关闭又是切控件）。
await tapStage();
assert.equal(viewerRoot().classList.contains('is-ui-hidden'), true, '点一下画面必须把控件藏起来');
assert.ok(viewerRoot(), '点画面只切控件, 不许把看图关掉');
assert.equal(galleryPanel.classList.contains('is-open'), true, '藏控件只是"看不见", 侧栏的打开状态要留着');
await tapStage();
assert.equal(viewerRoot().classList.contains('is-ui-hidden'), false, '再点一下要把控件放回来');

// 上下滑动换前后一张（未放大时纵向没有可平移的余地，这一划就不是平移而是换图）。
await swipeStage(100, 320);
assert.ok(/g2-fixture$/.test(currentSrc()), '手指往下划 = 上一张');
await swipeStage(320, 100);
assert.ok(/g3-fixture$/.test(currentSrc()), '手指往上划 = 下一张');
// 位移不到门槛（SWIPE_MIN = 56）就不许翻页，否则手一抖就换了图。
// **方向必须是"要是门槛低一点就真的会翻过去"的那一侧**：这里从最后一张往回（af 到上一张），
// 所以一旦门槛被调低，这一划就会落到另一张图上、断言当场红。要是选成"往前翻"，因为已经在
// 最后一张、本来就翻不动，这条断言会恒绿 —— 那正是"出现过型断言"的假绿。
const beforeShallow = currentSrc();
await swipeStage(120, 160);
assert.equal(currentSrc(), beforeShallow, '滑动不到门槛时必须回位, 不许一抖就翻页');

document.querySelector('[data-viewer-action="close"]').click();
await galleryOpened; await tick();
assert.equal(document.querySelector('.image-viewer'), null, '画廊开着也能照常关掉看图');
console.log('passed: the gallery drawer switches images, a tap toggles the controls and a vertical swipe flips pages');

// ── 图片消息：改提示词 / 重新生成 / 删除（业主 2026-09-27） ────────────────────────────
// 三条都是"看起来行、点下去才知道"的东西，所以全部走真实点击路径：重新生成要真的再提交一次
// 绘图任务、铅笔打开的是提示词编辑器（不是那条恒为空的正文）、删除必须先确认。
const fireSubmit = node => node.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
// 画布上的假图片：这一段要真的点开气泡里的缩略图，所以得让 displayUrl 认得桩出来的那个 mediaId。
// **必须赶在这一段的第一次 renderMessages 之前装上** —— renderMessages 按消息签名做节点缓存
// （chat.js:313），签名不变就复用旧节点；等渲染完了再装桩，缩略图那一格仍然是"图片不可用"。
const renderedDisplayUrl = app.data.media.displayUrl;
app.data.media.displayUrl = async value => String((value && value.mediaId) || value || '') === 'draw-media-fixture' ? '/__haminn/files/draw-fixture' : '';
await app.features.chat.renderMessages(); await tick();
const drawnMessage = actionOnlyTurn.at(-1);
const drawnRow = () => document.querySelector('[data-message-id="' + drawnMessage.id + '"]');
assert.ok(drawnRow(), 'the drawn image message is on screen');
assert.ok(drawnRow().querySelector('[aria-label="修改绘图提示词"]'), '图片消息的铅笔要说清改的是绘图提示词');
assert.equal(drawnRow().querySelector('[data-regenerate-message]').getAttribute('aria-label'), '重新生成这张图');

// 1) 重新生成 = 重新发起绘图：沿用同一条消息，不新增记录，也不动提示词。
let redrawCalls = 0;
app.services.draw.available = async () => drawCard;
app.services.draw.resolveCard = async () => drawCard;
app.data.media.put = async () => ({ id: 'draw-media-fixture' });
app.services.draw.generate = async () => { redrawCalls += 1; return { blob: drawBlob, mime: 'image/png', job: { id: 'job-redraw' } }; };
const beforeRedraw = (await app.data.store.messages(id)).length;
drawnRow().querySelector('[data-regenerate-message]').click();
await until(() => redrawCalls === 1 && !app.features.chatSession.drawing(id), 'the regenerate button really starts another drawing');
const afterRedrawTurn = await app.data.store.messages(id);
assert.equal(afterRedrawTurn.length, beforeRedraw, '重新生成图片不能新增消息');
// 不能再用 .at(-1) 认这条消息：后面的段落（见「生成中那一条下面的停止」）还会往这个对话里加消息。
// "没有新增记录"由上面那句 lengths 相等来判，这里按 id 取那一条。
const redrawnMessage = afterRedrawTurn.filter(message => message.id === drawnMessage.id)[0];
assert.ok(redrawnMessage, '重新生成沿用同一条图片消息');
assert.equal(redrawnMessage.status, 'done');
assert.equal(redrawnMessage.draw.prompt, '一只趴在窗台的橘猫', '重新生成原样沿用消息里的提示词');
// 这条消息必须记着当初用的是哪张卡片、哪个模型，否则重新生成就只能猜（业主 2026-09-27）。
assert.equal(redrawnMessage.draw.profileId, 'chp-fixture', '图片消息要记下生图用的卡片');
assert.equal(redrawnMessage.draw.modelId, 'render', '图片消息要记下生图用的模型');
app.services.draw.available = originalDrawAvailable; app.services.draw.resolveCard = originalDrawResolveCard; app.services.draw.generate = originalDrawGenerate; app.data.media.put = originalDrawMediaPut;
await app.features.chat.renderMessages(); await tick();

// 1b) 编辑提示词必须**同步改写真实进上下文的动作块**（业主 2026-09-27：气泡里的提示词就是真实
//     消息里动作块的内容，改的时候要一起保存）。气泡上那行取自 `draw.prompt`（= 实际发给绘图模型
//     的参数，是事实），而模型历史里看到的是 `rawText` 里那段 `<<<chataxi-action …>>>`。两份数据
//     不同步就是"界面上是 A、模型看到的还是 B"，而这种不一致在界面上**完全看不出来**，所以只能靠
//     自己造记录来验。三种位置各造一条：
//       ① 块在这条绘图消息**自己**身上（正文为空的那一轮就是这样）；
//       ② 块在**同轮的前一条** assistant 消息上（正文 + 块的那一轮被拆成了两条消息）；
//       ③ 紧挨着的**上一轮**也带块 —— 只有 replyTo 不同。它绝不许被改：这是"往前找"最容易犯的错。
const blockText = prompt => '我画一张给你看吧。\n\n<<<chataxi-action\n{"type":"draw","prompt":"' + prompt + '","selfPortrait":false}\n>>>';
assert.ok(drawnMessage.replyTo, '绘图消息要带着那一轮的用户消息 id —— 它就是判断"同轮"的依据');
const layout = await app.data.store.messages(id);
const at = layout.findIndex(message => message.id === drawnMessage.id);
const beforeCreatedAt = at > 0 ? layout[at - 1].createdAt : drawnMessage.createdAt - 2;
const between = (low, high) => (low + high) / 2;
await app.data.store.putMessage(Object.assign({}, drawnMessage, { rawText: blockText('一只趴在窗台的橘猫') }));
await app.data.store.putMessage({
  id: 'message-sibling-block', conversationId: id, kind: 'assistant', roleId: drawnMessage.roleId, roleName: drawnMessage.roleName,
  replyTo: drawnMessage.replyTo, text: '我画一张给你看吧。', rawText: blockText('一只趴在窗台的橘猫'),
  media: [], status: 'done', createdAt: between(beforeCreatedAt, drawnMessage.createdAt)
});
await app.data.store.putMessage({
  id: 'message-other-turn-block', conversationId: id, kind: 'assistant', roleId: drawnMessage.roleId, roleName: drawnMessage.roleName,
  replyTo: 'message-another-turn', text: '上一轮。', rawText: blockText('上一轮的画面'),
  media: [], status: 'done', createdAt: between(beforeCreatedAt - 1, beforeCreatedAt)
});
const withBlock = await app.data.store.messages(id);
assert.equal(withBlock[withBlock.findIndex(message => message.id === drawnMessage.id) - 1].id, 'message-sibling-block', '同轮那一条必须正好排在绘图消息前面（否则这条用例验的不是"紧邻"）');
assert.equal(drawnMessage.media[0].alt, '一只趴在窗台的橘猫', '编辑前 alt 是旧提示词');
// 铅笔拿的是**渲染时缓存的那份记录**，所以造完记录必须重渲染一次，否则弹窗里那份还是旧快照
// （旧快照没有 rawText，一保存就把刚造的那条块覆盖没了 —— 这条用例自己会骗自己）。
await app.features.chat.renderMessages(); await tick();

// 2) 铅笔改的是绘图提示词，不是那条恒为空的正文。
drawnRow().querySelector('[aria-label="修改绘图提示词"]').click();
await until(() => document.querySelector('#modalForm [name="text"]'), 'the drawing prompt editor opens');
assert.equal(document.querySelector('#modalTitle').textContent, '编辑绘图提示词');
assert.equal(document.querySelector('#modalForm [name="text"]').value, '一只趴在窗台的橘猫', '编辑器里装的是消息里的提示词');
const deleteEntry = document.querySelector('#modalForm [data-delete-message]');
assert.ok(deleteEntry, '编辑弹窗底部必须有删除入口');
assert.equal(deleteEntry.getAttribute('type'), 'button', '删除按钮不能是提交按钮，否则点它等于保存并关闭');
field('text', '雨夜的车站, 少女撑着伞侧身站着'); fireSubmit(document.querySelector('#modalForm'));
await until(() => !document.querySelector('#modalForm'), 'the prompt editor closes');
const afterPromptEdit = (await app.data.store.messages(id)).filter(message => message.id === drawnMessage.id)[0];
assert.equal(afterPromptEdit.draw.prompt, '雨夜的车站, 少女撑着伞侧身站着');
assert.equal(afterPromptEdit.text, '', '图片消息的正文仍然为空 —— 改的是提示词');
assert.equal(afterPromptEdit.media.length, 1, '改提示词不能把已经画好的图弄丢');
assert.equal(document.querySelector('#toastRoot .toast').textContent, '绘图提示词已保存');
await app.features.chat.renderMessages(); await tick();
assert.match(drawnRow().querySelector('.message-caption').textContent, /雨夜的车站/, '气泡下面回显的必须换成新提示词');
// 1b 的断言：保存时动作块必须跟着一起改（三种位置）。
const editedPrompt = '雨夜的车站, 少女撑着伞侧身站着';
const afterBlockEdit = await app.data.store.messages(id);
const selfAfter = afterBlockEdit.filter(message => message.id === drawnMessage.id)[0];
assert.ok(selfAfter.rawText.includes('"prompt":"' + editedPrompt + '"'), '① 这条绘图消息自己原文里的动作块必须跟着改成同一个提示词');
assert.equal(selfAfter.rawText.includes('"prompt":"一只趴在窗台的橘猫"'), false, '① 旧提示词不许残留在动作块里');
const siblingAfter = afterBlockEdit.filter(message => message.id === 'message-sibling-block')[0];
assert.ok(siblingAfter.rawText.includes('"prompt":"' + editedPrompt + '"'), '② 同轮前一条消息里那个块也必须一起改 —— 正文 + 块的那一轮就靠它承载');
assert.equal(siblingAfter.rawText.includes('我画一张给你看吧。'), true, '② 只改块里的提示词，那条消息的正文一个字都不许动');
assert.equal(siblingAfter.editedAt > 0, true, '② 被同步改写过的记录要留下 editedAt');
const otherTurnAfter = afterBlockEdit.filter(message => message.id === 'message-other-turn-block')[0];
assert.ok(otherTurnAfter.rawText.includes('"prompt":"上一轮的画面"'), '③ 不同轮的消息里的块绝不许被改');
assert.equal(otherTurnAfter.editedAt, undefined, '③ 没被改动的消息不许留下 editedAt');
// ③ 上面那条还不够狠：那个块排在 index-2 上，本来就不会被看。真正要挡的是"前一条就在 index-1 上、
//    也带着块，唯一区别是 replyTo 属于别的轮"。把同轮那条的 replyTo 改掉再编辑一次，它必须一字不动。
const siblingRecord = (await app.data.store.messages(id)).filter(message => message.id === 'message-sibling-block')[0];
await app.data.store.putMessage(Object.assign({}, siblingRecord, { replyTo: 'message-another-turn' }));
await app.features.chat.renderMessages(); await tick();
drawnRow().querySelector('[aria-label="修改绘图提示词"]').click();
await until(() => document.querySelector('#modalForm [name="text"]'), 'the drawing prompt editor opens for the guard case');
field('text', '凌晨的旧车站, 空无一人'); fireSubmit(document.querySelector('#modalForm'));
await until(() => !document.querySelector('#modalForm'), 'the prompt editor closes for the guard case');
const guardCase = await app.data.store.messages(id);
assert.ok(guardCase.filter(message => message.id === drawnMessage.id)[0].rawText.includes('"prompt":"凌晨的旧车站, 空无一人"'), '自己那条照旧要跟着改');
assert.ok(guardCase.filter(message => message.id === 'message-sibling-block')[0].rawText.includes('"prompt":"' + editedPrompt + '"'), 'replyTo 不同就不是同一轮：它就在前一条、也带着块，但绝不许被改');
assert.equal(selfAfter.media[0].alt, editedPrompt, '图片的 alt 文本是提示词的副本，要跟着一起改');
assert.equal(selfAfter.media.length, 1, '改提示词还是不能把已经画好的图弄丢');
assert.equal(afterBlockEdit.filter(message => message.id === 'message-sibling-block')[0].text, '我画一张给你看吧。', '同步只落在 rawText 上，不进正文');

// 4) 「设为背景」必须先确认（业主 2026-09-27 第三轮）：它改的是**对话设置**，而且一设就铺满整个
//    界面 —— 在看图时误触一次，用户得再进对话设置里换回来。静态门禁只能证明"confirm 写在 save
//    之前"，这里要证明的是两条路径各自的**后果**：取消什么都不写、确认才落库、落库只记 mediaId。
//    顺便盯住"看图自己收起来"：设完背景还留着那一层，用户会以为没生效。
const viewerThumb = drawnRow().querySelector('.message-image');
assert.ok(viewerThumb, '画好的图片要能在气泡里点开（这一段要用它进全屏看图）');
viewerThumb.click(); await tick();
assert.ok(document.querySelector('.image-viewer'), '点缩略图打开全屏看图');
const backgroundBefore = (await app.data.store.get('conversations', id)).background;
document.querySelector('[data-viewer-action="background"]').click();
await until(() => document.querySelector('#modalForm'), '「设为背景」必须先弹确认');
assert.equal(document.querySelector('#modalTitle').textContent, '设为对话背景？');
click('.modal-backdrop');
await until(() => !document.querySelector('#modalForm'), '点遮罩关掉确认框');
await tick();
assert.ok(document.querySelector('.image-viewer'), '取消之后看图这一层照旧开着 —— 用户接着看他的图');
assert.deepEqual((await app.data.store.get('conversations', id)).background, backgroundBefore, '取消就必须什么都不写');
document.querySelector('[data-viewer-action="background"]').click();
await until(() => document.querySelector('#modalForm'), '确认框要能再开一次（在途闸不能把它锁死）');
submit();
await until(() => !document.querySelector('#modalForm'), '确认之后确认框关闭');
await until(() => !document.querySelector('.image-viewer'), '设为背景之后看图自己收起来');
const backgroundAfter = (await app.data.store.get('conversations', id)).background;
assert.equal(backgroundAfter && backgroundAfter.kind, 'image', '确认之后才真的写进对话背景');
assert.equal(backgroundAfter && backgroundAfter.mediaId, 'draw-media-fixture', '背景只登记 mediaId');
assert.equal(backgroundAfter && backgroundAfter.url, undefined, '不许写 url：没有取景参数时它按 1:1 推，竖图会被放大过头');
assert.match(document.querySelector('#toastRoot').textContent, /已设为对话背景/);
// 这一段故意把背景设上了（那正是它的终点），但后面有"没有背景图时长按空地也不许收控件"的段落，
// 前提是**当前对话没有背景** —— 不还原就会在别处炸，而且报的是那一段的错，查起来很容易跑偏。
const restoredConversation = await app.data.store.get('conversations', id);
if (backgroundBefore === undefined) delete restoredConversation.background; else restoredConversation.background = backgroundBefore;
await app.data.store.put('conversations', id, restoredConversation);
await app.features.chat.refreshAppBackground();
app.data.media.displayUrl = renderedDisplayUrl;
await app.features.chat.renderMessages(); await tick();

// 5) 缩略图懒加载（业主 2026-09-27 第五轮）：没进视口的图片，**地址根本不去取**。
//    这条只能靠运行时证明 —— 静态门禁能看到"地址挪进了 loadThumb"，看不到"真的没提前取"。
//    沙箱里本来没有 IntersectionObserver（走的是"立刻加载"的降级路），所以这里补一个假的，
//    数 displayUrl 被调了几次。
const ioSeen = []; let ioCallback = null, ioAuto = false;
context.IntersectionObserver = function (callback) {
  ioCallback = callback;
  this.observe = node => { if (ioAuto) { callback([{ target: node, isIntersecting: true }]); return; } ioSeen.push(node); };
  this.unobserve = node => { const at = ioSeen.indexOf(node); if (at >= 0) ioSeen.splice(at, 1); };
  this.disconnect = () => { ioSeen.length = 0; };
};
// 上面那几轮已经把这张缩略图加载过了（那时还没有 IntersectionObserver，走的是降级路），
// 它的占位标记已是 "2"、观察器不会再选它 ⇒ 必须先让记录真的变一次。renderMessages 按消息签名
// 复用节点，签名变了才会重建出一个待取的新缩略图。updatedAt 不参与任何渲染（消息列表只按
// createdAt 排序与分组），改它不会影响别处的断言。
const lazyMessage = (await app.data.store.messages(id)).filter(message => (message.media || []).length)[0];
assert.ok(lazyMessage, '这一段需要一条带图片的消息');
lazyMessage.updatedAt = Date.now();
await app.data.store.putMessage(lazyMessage);
let thumbResolves = 0;
app.data.media.displayUrl = async () => { thumbResolves += 1; return '/__haminn/files/draw-fixture'; };
await app.features.chat.renderMessages(); await tick();
assert.ok(ioSeen.length, '有图片的消息必须把缩略图交给观察器，而不是渲染时就去取地址');
assert.equal(document.querySelectorAll('.message-image[data-media-pending="1"]').length, ioSeen.length, '每一张待取的缩略图都要带占位标记（CSS 靠它给出 9:16 的尺寸）');
assert.equal(thumbResolves, 0, '还没进视口就解析地址 ⇒ 这次优化等于没做');
// 进视口之后才取。假观察器不会自己触发，这里手动喂一次相交。
const lazyThumb = ioSeen[0];
ioCallback([{ target: lazyThumb, isIntersecting: true }]);
await until(() => thumbResolves === 1, '相交之后必须真的去解析地址');
assert.equal(ioSeen.includes(lazyThumb), false, '取过一次就要把它摘掉，否则每次滚动都会重新取一遍');
assert.equal(lazyThumb.dataset.mediaPending, '2', '地址在途时仍要占着位（图还没到，占位盒不能先塌掉）');
// 收拾：后面还有段落要渲染图片列表，让假观察器从此"立即相交"，等价于恢复原来的行为。
ioAuto = true;
ioSeen.slice().forEach(node => ioCallback([{ target: node, isIntersecting: true }]));
app.data.media.displayUrl = renderedDisplayUrl;

// 6) 删除：入口在编辑弹窗底部，而且必须先确认（确认层会叠在编辑弹窗上面）。
drawnRow().querySelector('[aria-label="修改绘图提示词"]').click();
await until(() => document.querySelector('#modalForm [data-delete-message]'), 'the editor reopens for deletion');
document.querySelector('#modalForm [data-delete-message]').click();
await until(() => document.querySelector('.subsheet form'), 'deleting asks for confirmation first');
assert.equal(document.querySelector('.subsheet .modal-head h2').textContent, '删除这条消息？');
const beforeDelete = (await app.data.store.messages(id)).length;
fireSubmit(document.querySelector('.subsheet form'));
await until(() => !document.querySelector('.subsheet') && !document.querySelector('#modalForm'), 'confirming deletes the message and closes both layers');
const afterDelete = await app.data.store.messages(id);
assert.equal(afterDelete.length, beforeDelete - 1, '只删掉这一条');
assert.equal(afterDelete.some(message => message.id === drawnMessage.id), false, '这条消息必须从库里消失');
assert.equal(document.querySelector('[data-message-id="' + drawnMessage.id + '"]'), null, '删掉的消息不再渲染');
assert.equal(document.querySelector('#toastRoot .toast').textContent, '消息已删除');
console.log('passed: editing a drawing prompt, re-drawing that image and deleting a message after confirmation');

await app.navigate('settings');
const general = document.querySelector('#generalForm'); assert.ok(general);
assert.equal(general.querySelector('[name="recentFullMessages"]'), null, 'the retained-N count is derived from characters, so no message-count control exists anywhere');
// 压缩区间只有三个字数滑竿：触发 / 保留 / 目标，条数不再出现。
const compressionPanel = general.querySelector('[data-settings-panel="compression"]');
const retainSlider = compressionPanel.querySelector('[name="compressionRetainChars"]');
assert.ok(retainSlider, 'the retention length slider must exist');
assert.deepEqual([retainSlider.getAttribute('min'), retainSlider.getAttribute('max'), retainSlider.getAttribute('step'), retainSlider.getAttribute('value')], ['2000', '10000', '1000', '4000']);
const triggerSlider = compressionPanel.querySelector('[name="compressionThresholdChars"]');
assert.deepEqual([triggerSlider.getAttribute('min'), triggerSlider.getAttribute('max'), triggerSlider.getAttribute('value')], ['4000', '32000', '10000']);
assert.doesNotMatch(document.body.textContent, /固定携带最近消息|最近完整消息数量/, 'no message-count copy may survive');
// 「按 Enter 发送」已取消：Enter 始终换行，Ctrl / ⌘ + Enter 始终发送。
assert.equal(general.querySelector('[name="enterToSend"]'), null, 'the Enter-to-send toggle must be gone');
// 分类名从「关于」改为「系统」，顶部第一个元素是「备份软件和数据」。
click('.settings-tabs [data-settings-tab="system"]');
const systemPanel = document.querySelector('[data-settings-panel="system"]');
assert.ok(systemPanel, 'the system panel exists');
assert.equal(systemPanel.firstElementChild.dataset.backupApp, '', 'the backup button is the first thing in the system panel');
assert.equal(document.querySelector('.settings-tabs [data-settings-tab="about"]'), null, 'the About tab is now the system tab');
assert.match(systemPanel.textContent, /备份软件和数据[\s\S]*zhyuzh3d/, 'the app facts stay under the backup button');
// 测试宿主里没有 HaminnApp 桥：点它必须如实报错，而不是静默什么都不做。
click('[data-backup-app]'); await tick(); await tick(); await tick();
assert.match(document.querySelector('#toastRoot .toast').textContent, /不在 HaminnApp 中/);
click('.settings-tabs [data-settings-tab="interface"]');
click('[data-picker="theme"]'); await until(() => document.querySelector('.subsheet [data-choice="dark"]'), 'custom theme sheet');
click('.subsheet [data-choice="dark"]'); await tick(); assert.equal(general.querySelector('[name="theme"]').value, 'dark');
general.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await until(() => document.documentElement.getAttribute('data-theme') === 'dark', 'theme saved');
await app.navigate('roles'); click('[data-edit-role]'); await until(() => document.querySelector('#modalForm [name="systemPrompt"]'), 'role editor');
assert.equal(document.querySelector('[data-open-role-templates]'), null, 'existing role editor must not expose the template gallery');
assert.ok(document.querySelector('button.avatar-picker[data-choose-avatar]')); assert.equal(document.querySelector('.avatar-editor').textContent.includes('选择本地图片'), false);
assert.match(fs.readFileSync(root + 'app/components/ui.js', 'utf8'), /data-crop-stage/); assert.doesNotMatch(fs.readFileSync(root + 'app/components/ui.js', 'utf8'), /name="crop[XY]"/);
assert.ok(document.querySelector('#temperatureField').classList.contains('is-hidden'), 'unsupported temperature is hidden');
assert.equal(document.querySelector('#ttsModelField'), null); assert.ok(document.querySelector('#ttsVoiceField').classList.contains('is-hidden')); assert.ok(document.querySelector('#voicePromptField').classList.contains('is-hidden'));
let previewText, previewRole; app.services.tts.speak = async (text, role) => { previewText = text; previewRole = role; };
click('[data-preview-tts]'); await until(() => previewText, 'role TTS preview'); assert.equal(previewText, '你好！欢迎使用朗读功能。'); assert.equal(previewRole.ttsProfileId, 'system-tts');
const roleNameBeforeChoice = field('name').value; click('[data-picker="llmProfileId"]'); await until(() => document.querySelector('.subsheet [data-choice]'), 'nested model choice sheet');
click('.subsheet [data-choice]'); await tick(); assert.equal(field('name').value, roleNameBeforeChoice, 'closing a nested choice sheet preserves the role form');
assert.equal(document.querySelector('#modalForm [name="model"]'), null); assert.ok(document.querySelector('#reasoningField').classList.contains('is-hidden'), 'unsupported reasoning is hidden'); app.components.closeModal();
await app.navigate('models', { modelsTab: 'llm' });
await app.data.store.put('llm-profiles', 'xai-empty', { id: 'xai-empty', name: 'xAI / Grok', family: 'xai', apiStyle: 'openai-chat', endpoint: 'https://api.x.ai/v1/chat/completions', apiKey: 'fixture', models: [], enabled: true });
let xaiDiscoveryRequest, xaiTestRequest;
app.platform.network.requestJson = async options => {
  if (options.method === 'GET') { xaiDiscoveryRequest = options; return { data: { models: [{ id: 'grok-fixture', input_modalities: ['text', 'image'], output_modalities: ['text'] }] } }; }
  xaiTestRequest = options; return { data: { choices: [{ message: { content: 'OK' } }] } };
};
await app.features.models.renderServices('llm');
click('[data-edit-service="xai-empty"]'); await until(() => document.querySelector('[data-fetch-models]'), 'legacy empty xAI model editor');
click('[data-fetch-models]'); await until(() => /grok-fixture/.test(document.querySelector('[data-picker="externalModelId"] [data-picker-label]').textContent), 'xAI directory loaded');
click('[data-test-model]'); await until(() => xaiTestRequest && /连接成功/.test(document.querySelector('#connectionStatus').textContent), 'legacy empty xAI model repaired through discovery');
submit(); await until(() => !document.querySelector('#modalForm'), 'repaired xAI service saved');
assert.equal((await app.data.store.get('llm-profiles', 'xai-empty')).externalModelId, 'grok-fixture');
assert.equal(xaiDiscoveryRequest.url, 'https://api.x.ai/v1/language-models');
assert.equal(JSON.parse(xaiTestRequest.bodyText).model, 'grok-fixture');
assert.match(document.querySelector('[data-test-service="xai-empty"]').textContent, /^测试$/);
const xaiCard = document.querySelector('[data-test-service="xai-empty"]').closest('.model-service-card');
const xaiEndpoint = xaiCard.querySelector('.service-endpoint');
assert.ok(xaiEndpoint, 'the address row is rendered for a configured service');
assert.equal(xaiEndpoint.querySelector('[data-test-service]'), document.querySelector('[data-test-service="xai-empty"]'), 'the test button sits at the end of the address row');
assert.deepEqual(Array.from(xaiCard.querySelectorAll('.service-manage > .button')).map(button => [button.textContent, Boolean(button.querySelector('i'))]), [['复制', true], ['编辑', true], ['删除', true]], 'copy, edit and delete share one row and each carries an icon plus a label');
assert.equal(xaiCard.querySelector('.service-manage .icon-button'), null, 'no icon-only action button is left in the management row');
const modelsToolbar = document.querySelector('.section-toolbar');
assert.equal(modelsToolbar.firstElementChild.tagName, 'BUTTON', 'the add button leads the toolbar');
assert.equal(modelsToolbar.lastElementChild.tagName, 'P', 'the explanatory note sits below the add button');
assert.match(modelsToolbar.lastElementChild.textContent, /每张卡片对应一个模型/);
console.log('passed: empty xAI service discovers, enables and tests a language model');
// 连接测试是可选的：目录获取成功之后可以直接保存，未测试的卡片保存为 unverified。
await app.data.store.put('llm-profiles', 'xai-untested', { id: 'xai-untested', name: 'xAI / Untested', family: 'xai', apiStyle: 'openai-chat', endpoint: 'https://api.x.ai/v1/chat/completions', apiKey: 'fixture', models: [], enabled: true });
await app.features.models.renderServices('llm');
click('[data-edit-service="xai-untested"]'); await until(() => document.querySelector('#modalSubmit'), 'untested model editor');
assert.equal(document.querySelector('#modalSubmit').dataset.mode, 'fetch');
click('[data-fetch-models]'); await until(() => /grok-fixture/.test(document.querySelector('[data-picker="externalModelId"] [data-picker-label]').textContent), 'untested catalog loaded');
assert.equal(document.querySelector('#modalSubmit').textContent, '保存设置');
submit(); await until(() => !document.querySelector('#modalForm'), 'a fetched catalog saves without a connection test');
assert.equal(document.querySelector('.error-box'), null);
assert.equal((await app.data.store.get('llm-profiles', 'xai-untested')).validationState, 'unverified', 'saving without testing records an unverified model');
assert.equal((await app.data.store.get('llm-profiles', 'xai-untested')).externalModelId, 'grok-fixture');
console.log('passed: a fetched catalog saves without a connection test');
// 绘图卡上的画幅（业主 2026-09-30：「在绘图模型设置中增加 CHP 渲染模型的分辨率选择，
// 锁定 9:16 分辨率」）。两件事一起断：**选项来自插件公布的帧表**（不是界面里写死的一份
// 清单，所以 1:1 那条不许出现），以及挑中的那一条真的存进卡片 —— 存不下来只是个摆设。
{
  const originalDiscover = app.services.modelServices.discover;
  app.services.modelServices.discover = async (kind) => kind !== 'image' ? originalDiscover(kind)
    : { models: [{ id: 'render', name: '重画成品图', ready: true, capabilitySource: 'capability-directory',
        frames: [{ ratio: '1:1', resolution: ['1024x1024'] }, { ratio: '9:16', resolution: ['768x1344', '576x1024', '432x768'] }],
        defaults: { ref_strength: 0.95 } }], voices: [], catalogState: 'fetched', warnings: [], discovered: true };
  await app.data.store.put('image-profiles', 'chp-canvas', { id: 'chp-canvas', name: '画幅测试卡', family: 'chp', endpoint: 'http://192.168.124.31:8189', apiKey: 'fixture', models: [], enabled: true });
  await app.navigate('models', { modelsTab: 'image' });
  click('[data-edit-service="chp-canvas"]'); await until(() => document.querySelector('[data-picker="resolution"]'), 'drawing card canvas row');
  assert.equal(document.querySelector('[data-picker="resolution"] [data-picker-label]').textContent, '先获取模型列表', '还没读到插件目录时，画幅那一行说清要先获取模型列表');
  click('[data-fetch-models]'); await until(() => /重画成品图/.test(document.querySelector('[data-picker="externalModelId"] [data-picker-label]').textContent), 'drawing scenario loaded');
  click('[data-picker="resolution"]'); await until(() => document.querySelector('.subsheet [data-choice="576x1024"]'), 'canvas choices opened');
  assert.deepEqual(Array.from(document.querySelectorAll('.subsheet [data-choice]')).map(button => button.dataset.choice),
    ['768x1344', '576x1024', '432x768'], '只列插件为这个场景公布的 9:16 档：1:1 那条不许进来');
  click('.subsheet [data-choice="576x1024"]'); await until(() => document.querySelector('[data-picker="resolution"] [data-picker-label]').textContent === '576x1024', 'canvas chosen');
  submit(); await until(() => !document.querySelector('#modalForm'), 'drawing card saved');
  assert.equal((await app.data.store.get('image-profiles', 'chp-canvas')).resolution, '576x1024', '用户挑中的那条要存进卡片');
  app.services.modelServices.discover = originalDiscover;
  console.log('passed: the drawing card offers the canvases the plugin publishes and keeps the chosen one');
}
let savedElevenLabs;
app.platform.network.requestJson = async options => options.url.includes('/v1/models')
  ? { data: [{ model_id: 'eleven_multilingual_v2', name: 'Eleven Multilingual v2', can_do_text_to_speech: true }] }
  : { data: { voices: [{ voice_id: 'voice-fixture', name: 'Fixture Voice' }], has_more: false } };
app.services.tts.testService = async () => ({ modelId: 'eleven_multilingual_v2', voiceId: 'voice-fixture' });
await app.navigate('models', { modelsTab: 'tts' });
app.features.models.openService('tts', null, next => { savedElevenLabs = next; });
field('family', 'elevenlabs').dispatchEvent(new window.Event('change', { bubbles: true }));
field('apiKey', 'fixture-eleven'); click('[data-fetch-models]');
await until(() => /Eleven Multilingual v2/.test(document.querySelector('[data-picker="externalModelId"] [data-picker-label]').textContent), 'ElevenLabs directory succeeds');
click('[data-test-model]'); await until(() => /连接成功/.test(document.querySelector('#connectionStatus').textContent), 'ElevenLabs model and voice baseline succeeds');
submit(); await until(() => savedElevenLabs, 'connected ElevenLabs service saves without a false changed-signature error');
assert.equal(savedElevenLabs.voices[0].id, 'voice-fixture');
assert.equal(savedElevenLabs.voices[0].name, 'Fixture Voice');
assert.ok(savedElevenLabs.enabledModelIds.includes('eleven_multilingual_v2'));
assert.equal(document.querySelector('.error-box'), null);
console.log('passed: ElevenLabs connection result saves immediately after model and voice discovery');
const legacyElevenLabs = await app.data.store.get('tts-profiles', savedElevenLabs.id);
legacyElevenLabs.voices = [{ id: 'voice-fixture' }];
await app.data.store.put('tts-profiles', legacyElevenLabs.id, legacyElevenLabs);
await app.navigate('roles'); click('[data-edit-role]');
await until(() => document.querySelector('#modalForm [name="ttsProfileId"]'), 'role editor repairs legacy ElevenLabs voice labels');
field('ttsProfileId', legacyElevenLabs.id).dispatchEvent(new window.Event('change', { bubbles: true })); await tick();
assert.equal(document.querySelector('[data-picker="ttsVoice"] [data-picker-label]').textContent, 'Fixture Voice');
click('[data-picker="ttsVoice"]'); await until(() => document.querySelector('.subsheet [data-choice="voice-fixture"]'), 'role voice picker opens with repaired label');
assert.equal(document.querySelector('.subsheet [data-choice="voice-fixture"] span').textContent, 'Fixture Voice');
app.components.closeSubsheet(); app.components.closeModal();
assert.equal((await app.data.store.get('tts-profiles', legacyElevenLabs.id)).voices[0].name, 'Fixture Voice');
console.log('passed: role ElevenLabs picker uses account voice names and repairs legacy ID-only catalogs');
await app.navigate('models', { modelsTab: 'llm' });
const secretProfile = await app.data.store.get('llm-profiles', 'xai-empty');
secretProfile.apiKey = 'demoCredentialAlphaOmega';
secretProfile.customHeaders = JSON.stringify({ Authorization: 'Bearer demoHeaderAlphaOmega', 'X-Client-Key': 'demoClientAlphaOmega' });
await app.data.store.put('llm-profiles', secretProfile.id, secretProfile); await app.features.models.renderServices('llm');
let clipboardSecret = ''; app.platform.haminn.readClipboardText = async () => clipboardSecret;
click('[data-edit-service="xai-empty"]'); await until(() => document.querySelector('#modalForm [name="apiKey"]'), 'edit model');
assert.equal(document.querySelector('[name="apiKey"]').type, 'password'); assert.equal(document.querySelector('[name="apiKey"]').value, 'demoCredentialAlphaOmega');
assert.equal(document.querySelectorAll('.secret-editor [name="apiKey"]').length, 1); assert.equal(document.querySelector('[name="clear_apiKey"]'), null);
assert.equal(document.querySelector('.secret-mask').textContent, 'demo••••••mega');
assert.equal(document.querySelector('[name="customHeaders"]').type, 'password'); assert.equal(document.querySelector('[name="customHeaders"]').value, secretProfile.customHeaders);
assert.equal(document.body.textContent.includes('demoCredentialAlphaOmega'), false, 'saved API key must not be rendered as visible text');
assert.equal(document.body.textContent.includes('demoHeaderAlphaOmega'), false, 'saved Header secret must not be rendered as visible text');
const apiKeyVisibility = document.querySelector('.secret-editor [name="apiKey"] ~ [data-toggle-secret]');
click('.secret-editor [name="apiKey"] ~ [data-toggle-secret]'); assert.equal(document.querySelector('[name="apiKey"]').type, 'text'); assert.ok(apiKeyVisibility.querySelector('.fa-eye-slash'));
click('.secret-editor [name="apiKey"] ~ [data-toggle-secret]'); assert.equal(document.querySelector('[name="apiKey"]').type, 'password'); assert.ok(apiKeyVisibility.querySelector('.fa-eye'));
clipboardSecret = 'demoCredentialAlphaOmega'; click('[data-paste-key]'); await until(() => document.querySelector('[name="apiKey"]').value === clipboardSecret, 'paste saved API key from clipboard');
clipboardSecret = secretProfile.customHeaders; click('[data-paste-headers]'); await until(() => document.querySelector('[name="customHeaders"]').value === clipboardSecret, 'paste saved Header credentials from clipboard');
submit(); await until(() => !document.querySelector('#modalForm'), 'save unchanged masked credentials');
assert.equal((await app.data.store.get('llm-profiles', 'xai-empty')).apiKey, 'demoCredentialAlphaOmega');
assert.equal((await app.data.store.get('llm-profiles', 'xai-empty')).customHeaders, secretProfile.customHeaders);
uiConfirmTest: {
  app.components.closeModal();
  let dismissed;
  const waiting = app.components.confirm({ title: '确认测试', message: '遮罩关闭也要有终态' }).then(result => { dismissed = result; });
  click('.modal-backdrop'); await waiting;
  assert.equal(dismissed, false);
}
let escaped;
const escapedConfirmation = app.components.confirm({ title: 'Escape', message: 'test' }).then(value => { escaped = value; });
const escape = new window.Event('keydown', { bubbles: true, cancelable: true }); escape.key = 'Escape'; document.dispatchEvent(escape); await escapedConfirmation;
assert.equal(escaped, false);
await Promise.all([app.navigate('roles'), app.navigate('models', { modelsTab: 'asr' })]);
assert.equal(app.state.route, 'models'); assert.equal(document.querySelector('#modelsContent').getAttribute('aria-labelledby'), 'models-tab-asr');
assert.deepEqual(Array.from(document.querySelectorAll('.section-tabs button')).map(button => button.textContent), ['对话模型', '朗读模型', '语音输入', '绘图模型']);
assert.equal(document.querySelector('.section-tabs i'), null, 'model category tabs have no icons');
assert.equal(document.querySelector('[data-edit-service="system-asr"]'), null, 'unavailable system ASR must not expose an editor');
assert.equal(document.querySelector('[data-test-service="system-asr"]'), null, 'unavailable system ASR must not expose a recording test');
assert.match(document.querySelector('.model-service-card').textContent, /不可用/, 'unavailable system ASR must be labelled clearly');
console.log('passed: settings/theme, masked credentials with clipboard paste and explicit reveal, confirmation dismissal and rapid navigation');
app.components.closeModal();

await app.navigate('me');
const userForm = document.querySelector('#userProfileForm'); assert.ok(userForm); assert.ok(userForm.querySelector('.avatar-picker.round'));
userForm.elements.namedItem('name').value = '测试用户'; userForm.elements.namedItem('introduction').value = '喜欢直接、清晰的回答。';
userForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await tick(); await tick();
assert.equal((await app.data.store.get('meta', 'user-profile')).name, '测试用户');
assert.equal((await app.data.store.get('meta', 'user-profile')).introduction, '喜欢直接、清晰的回答。');
assert.equal(document.querySelectorAll('#bottomNav [data-route]').length, 5);
await app.navigate('conversations');
assert.equal(document.querySelector('.page-heading'), null); assert.equal(document.querySelector('[data-filter]'), null); assert.match(document.querySelector('#pageTitle').textContent, /chataxi.*v\d+\.\d+\.\d+/);
const firstRole = (await app.data.store.list('roles'))[0];
app.data.media.toDataUrl = async mediaId => ({
  'role-avatar-fixture': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
  'user-avatar-fixture': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAC'
}[mediaId] || '');
const savedUserProfile = await app.data.store.get('meta', 'user-profile'); savedUserProfile.avatarMediaId = 'user-avatar-fixture'; await app.data.store.put('meta', 'user-profile', savedUserProfile);
firstRole.avatarMediaId = 'role-avatar-fixture'; await app.data.store.put('roles', firstRole.id, firstRole);
const secondRole = { ...firstRole, id: 'second-role', name: '第二个超长角色', avatarMediaId: '' };
await app.data.store.put('roles', secondRole.id, secondRole);
const group = await app.data.store.get('conversations', id); group.kind = 'group'; group.roleIds = [firstRole.id, secondRole.id]; group.activeRoleIds = group.roleIds.slice(); await app.data.store.put('conversations', id, group);
await app.navigate('conversations'); assert.match(document.querySelector('.meta').textContent, /群聊\s\|\s测试搭档 · 第二个超长角色/);
const conversationCard = document.querySelector('.conversation-card');
assert.ok(conversationCard.querySelector('.conversation-head > .avatar-stack + .list-copy'), 'the head row keeps the avatar and the text column together');
assert.equal(conversationCard.querySelector('.meta').parentElement.className, 'card-button conversation-open', 'the role-name row spans the whole card body instead of the indented text column');
assert.equal(conversationCard.querySelector('.list-copy .meta'), null, 'the role-name row must not stay inside the text column');
assert.equal(document.querySelectorAll('.conversation-action-rail').length, 1); assert.ok(document.querySelector('.conversation-action-open .fa-comment')); assert.ok(document.querySelector('[data-manage] .fa-gear'));
click('[data-manage]'); await until(() => document.querySelector('[data-menu="settings"]'), 'conversation management sheet'); app.components.closeModal();
click('.conversation-action-open'); await until(() => document.querySelector('#pageTitle').textContent === '重新命名的对话', 'conversation rail open');
assert.ok(document.querySelector('.composer-recipients')); assert.equal(document.querySelector('.chat-role-strip'), null);
assert.equal(document.querySelectorAll('.composer-recipients .mention-avatar').length, 2); assert.equal(document.querySelector('[data-all-roles]'), null);
assert.equal(document.querySelector('[data-role-toggle="' + secondRole.id + '"] .mention-name').textContent, '第二个超...');
assert.equal(document.querySelectorAll('[data-role-toggle][aria-pressed="true"]').length, 1);
click('#chatMenuButton'); await until(() => document.querySelector('[data-chat-menu="voice"]'), 'chat voice menu'); click('[data-chat-menu="voice"]'); await until(() => document.querySelector('[name="autoSpeak"]'), 'conversation readout settings');
assert.match(document.querySelector('#streamTtsPlaybackStatus').textContent, /完整音频播放/, 'system TTS reports its actual playback path without a manual stream switch'); app.components.closeModal();
click('[data-role-toggle="' + secondRole.id + '"]');
assert.equal(document.querySelectorAll('[data-role-toggle][aria-pressed="true"]').length, 1);
let mentioned;
app.services.llm.complete = async role => { mentioned = role.id; return { text: '继续完成', images: [] }; };
click('#sendButton');
await until(() => mentioned === secondRole.id && !app.features.chatSession.active(id), 'empty mention continues one role');
const latestTurn = (await app.data.store.messages(id)).slice(-2); assert.match(latestTurn[0].text, /@第二个超长角色.*继续回答/); assert.equal(latestTurn[1].roleId, secondRole.id);
await tick(); await tick();
assert.ok(document.querySelector('[data-regenerate-message]')); assert.ok(document.querySelector('[aria-label="编辑这条消息"] .fa-pencil'));
let editGenerated = 0; app.services.llm.complete = async () => { editGenerated++; return { text: '不应生成', images: [] }; };
click('[data-message-id="' + latestTurn[1].id + '"] [aria-label="编辑这条消息"]'); await until(() => document.querySelector('#modalForm [name="text"]'), 'message edit sheet');
assert.equal(document.querySelector('#modalSubmit').textContent, '保存'); assert.equal(document.querySelector('#modalForm [name="regenerate"]'), null);
field('text', '只保存修改后的回复'); submit(); await until(() => !document.querySelector('#modalForm'), 'message edit saves without generation');
assert.equal((await app.data.store.messages(id)).find(message => message.id === latestTurn[1].id).text, '只保存修改后的回复'); assert.equal(editGenerated, 0);
assert.equal(document.querySelectorAll('.message-row.assistant [data-edit-chat-role]').length > 0, true, 'every stored role avatar opens the role editor');
assert.ok(document.querySelector('[data-message-id="' + latestTurn[1].id + '"] [data-edit-chat-role="' + secondRole.id + '"]'), 'text fallback role avatar still edits its role');
click('.message-row.assistant [data-edit-chat-role="' + firstRole.id + '"]'); await until(() => document.querySelector('#modalForm [name="systemPrompt"]'), 'message role avatar opens the role editor sheet');
field('name', '即时更新搭档'); field('systemPrompt', '这是在对话中保存的新角色设定。'); submit();
await until(() => !document.querySelector('#modalForm') && /即时更新搭档/.test(document.querySelector('#pageSubtitle').textContent), 'saved role refreshes the open chat');
assert.equal(document.querySelector('[data-role-toggle="' + firstRole.id + '"] .mention-name').textContent, '即时更新...');
let hotRole; app.services.llm.complete = async role => { hotRole = role; return { text: '已使用新设定', images: [] }; };
click('[data-role-toggle="' + firstRole.id + '"]'); type('#messageInput', '验证角色修改立即生效'); click('#sendButton');
await until(() => hotRole && !app.features.chatSession.active(id), 'next reply uses role saved from the message avatar sheet');
assert.equal(hotRole.name, '即时更新搭档'); assert.equal(hotRole.systemPrompt, '这是在对话中保存的新角色设定。');
click('.message-row.user [data-edit-conversation-profile="user"]'); await until(() => document.querySelector('#modalForm [name="userName"]'), 'user message avatar opens conversation personal settings');
assert.equal(document.querySelector('#modalTitle').textContent, '常规设定');
assert.equal(document.querySelector('[data-conversation-tab="personal"]').getAttribute('aria-selected'), 'true', 'the user avatar opens the profile sub-tab of the merged settings');
assert.equal(document.querySelector('#conversationAvatarPreview .avatar').dataset.avatarMedia || '', (await app.data.store.get('meta', 'user-profile')).avatarMediaId || '', 'conversation avatar defaults to the global personal avatar');
assert.equal(field('userName').value, '测试用户', 'conversation identity starts from the global name');
assert.equal(field('userIntroduction').value, '喜欢直接、清晰的回答。', 'conversation identity starts from the global introduction');
field('userName', '本对话的我'); field('userIntroduction', '只用于这个对话的介绍。'); submit();
await until(() => !document.querySelector('#modalForm') && document.querySelector('.message-row.user .message-name').textContent === '本对话的我', 'saved conversation profile refreshes user messages');
const personalized = await app.data.store.get('conversations', id); assert.equal(personalized.userName, '本对话的我'); assert.equal(personalized.userIntroduction, '只用于这个对话的介绍。');
let nextUserContext; app.services.llm.complete = async (_role, _history, _task, _conversation, _roles, userProfile) => { nextUserContext = userProfile; return { text: '已使用个人设定', images: [] }; };
type('#messageInput', '验证个人设定立即生效'); click('#sendButton');
await until(() => nextUserContext && !app.features.chatSession.active(id), 'next reply uses the saved conversation profile');
assert.deepEqual(JSON.parse(JSON.stringify(nextUserContext)), { name: '本对话的我', introduction: '只用于这个对话的介绍。' });
click('.message-row.user [data-edit-conversation-profile="user"]'); await until(() => document.querySelector('#modalForm [name="userName"]'), 'conversation identity reopens with saved values');
field('userName', ''); field('userIntroduction', ''); submit();
await until(() => !document.querySelector('#modalForm') && document.querySelector('.message-row.user .message-name').textContent === '测试用户', 'cleared conversation identity falls back to global profile');
const clearedPersonalized = await app.data.store.get('conversations', id); assert.equal(clearedPersonalized.userName, ''); assert.equal(clearedPersonalized.userIntroduction, '');
let releaseRouting, releaseAnswer;
app.services.llm.selectRole = async (_moderator, candidates) => new Promise(resolve => { releaseRouting = () => resolve(candidates.find(role => role.id === secondRole.id)); });
app.services.llm.complete = async role => new Promise(resolve => { releaseAnswer = () => resolve({ text: role.name + '自主回答', images: [] }); });
click('#autoRoleToggle'); await until(() => document.querySelector('#autoRoleToggle').getAttribute('aria-checked') === 'true', 'automatic role selection enabled');
click('#sendButton');
await until(() => releaseRouting && document.querySelector('.routing-indicator') && document.querySelector('#messageListInner').textContent.includes('请你们自主回答。'), 'empty automatic turn and routing indicator rendered');
assert.equal(document.querySelector('.routing-indicator .typing-bubble').children.length, 3);
releaseRouting();
await until(() => releaseAnswer && !document.querySelector('.routing-indicator') && Array.from(document.querySelectorAll('.message-row.assistant')).at(-1).querySelector('.typing-bubble'), 'routing indicator replaced by selected role typing bubble');
releaseAnswer(); await until(() => !app.features.chatSession.active(id), 'automatic role answer completed');
const automaticTurn = (await app.data.store.messages(id)).slice(-2); assert.equal(automaticTurn[0].text, '请你们自主回答。'); assert.equal(automaticTurn[1].roleId, secondRole.id);
const beforeBulk = (await app.data.store.messages(id)).at(-1).createdAt;
await Promise.all(Array.from({ length: 150 }, (_, index) => app.data.store.putMessage({ id: 'bulk-' + index, conversationId: id, kind: 'user', text: '长对话性能消息 ' + index, media: [], status: 'done', createdAt: beforeBulk + index + 1 })));
await app.features.chat.renderMessages();
assert.equal(document.querySelectorAll('.message-row').length, 120, 'chat initially mounts only the latest bounded message window');
assert.match(document.querySelector('.history-window-control').textContent, /加载更早消息/);
click('.history-window-control button'); await until(() => document.querySelectorAll('.message-row').length > 120, 'older messages load incrementally');
let stopCalls = 0; app.services.tts.stop = async () => { stopCalls++; };
click('#muteTtsButton'); await tick(); await tick(); assert.equal((await app.data.store.get('conversations', id)).ttsMuted, true, 'mute preference saved');
assert.ok(document.querySelector('#muteTtsButton .fa-volume-xmark')); assert.equal(stopCalls, 0, 'mute does not stop current playback');
app.events.emit('tts:state', { speaking: true, muted: true }); assert.ok(document.querySelector('#muteTtsButton').classList.contains('voice-active')); assert.ok(document.querySelector('#muteTtsButton .fa-volume-xmark'));
app.events.emit('tts:state', { speaking: false, muted: true }); assert.equal(document.querySelector('#muteTtsButton').classList.contains('voice-active'), false);
await app.navigate('conversations'); await app.openChat(id); assert.equal(document.querySelector('[data-role-toggle="' + secondRole.id + '"]').getAttribute('aria-pressed'), 'true', 'last automatically selected role is remembered');
assert.equal(document.querySelector('select, datalist'), null, 'rendered flows do not use native list menus');
// ── 自动压缩之后的冻结历史：原消息不能再改，只能改「压缩概要」 ──────────────
const frozenTimeline = await app.data.store.messages(id);
const boundaryMessage = frozenTimeline[frozenTimeline.length - 21];
await app.data.store.put('summaries', id, { id, conversationId: id, text: '第一版概要', throughMessageId: boundaryMessage.id, throughMessageCreatedAt: boundaryMessage.createdAt, sourceMessageCount: frozenTimeline.length - 20, retainedMessageCount: 6, compressedByRoleId: secondRole.id, compressedByRoleName: secondRole.name, updatedAt: Date.now() });
await app.features.chat.renderMessages(); await tick();
const boundaryRow = document.querySelector('[data-message-id="' + boundaryMessage.id + '"]');
assert.ok(boundaryRow.classList.contains('is-frozen'), 'messages inside the summary boundary render as frozen history');
assert.equal(boundaryRow.querySelector('.frozen-badge').textContent, '已压缩');
assert.equal(boundaryRow.querySelector('.frozen-badge').getAttribute('title'), '这条消息已经压缩进概要，不再按原文参与上下文，也不能单独修改');
const frozenPencil = boundaryRow.querySelector('[aria-label="编辑这条消息"]');
assert.ok(frozenPencil.classList.contains('is-disabled'), 'the frozen pencil looks disabled');
assert.equal(frozenPencil.getAttribute('aria-disabled'), 'true');
document.querySelectorAll('.message-row.is-frozen [data-regenerate-message]').forEach(button => { assert.ok(button.classList.contains('is-disabled')); assert.equal(button.getAttribute('aria-disabled'), 'true'); });
frozenPencil.click(); await tick(); await tick();
assert.equal(document.querySelector('#toastRoot .toast').textContent, '历史已被压缩，请修改压缩概要');
assert.equal(document.querySelector('#modalForm'), null, 'a frozen pencil never opens the message editor');
const uncompressedRow = document.querySelector('.message-row:not(.is-frozen)');
assert.equal(uncompressedRow.querySelector('[aria-label="编辑这条消息"]').getAttribute('aria-disabled'), null, 'messages after the summary boundary stay editable');
assert.ok(uncompressedRow.querySelector('[data-regenerate-message]') || uncompressedRow.classList.contains('user'), 'assistant replies after the boundary keep their regenerate action');
// ── 对话菜单里的「压缩概要」必须可编辑、可保存 ────────────────────────────
click('#chatMenuButton'); await until(() => document.querySelector('[data-chat-menu="summary"]'), 'chat menu exposes the compression summary');
assert.equal(document.querySelector('[data-chat-menu="summary"]').textContent, '压缩概要 · 已生成');
click('[data-chat-menu="summary"]'); await until(() => document.querySelector('#modalForm [name="summary0"]'), 'compression summary sheet');
assert.equal(document.querySelector('#modalTitle').textContent, '编辑压缩概要');
// 概要正文通常很长：弹窗固定占 80% 高，说明文字之外的高度全给输入框（高度判据在 verify.mjs）。
assert.ok(document.querySelector('.modal-sheet.summary-sheet'), 'the summary editor uses the fixed-height sheet');
assert.ok(document.querySelector('#modalForm .summary-edit > .field > .prompt-editor'), 'the summary textarea owns the flexible row of that sheet');
assert.equal(field('summary0').value, '第一版概要');
field('summary0', '   '); submit(); await tick(); await tick();
assert.equal(document.querySelector('.form-error').textContent, '压缩概要不能为空');
assert.ok(document.querySelector('.form-error').classList.contains('visually-hidden'), 'the dialog error is a record, not a layout row');
assert.equal(document.querySelector('#toastRoot .toast').textContent, '压缩概要不能为空');
assert.ok(document.querySelector('#toastRoot .toast').classList.contains('is-danger'), 'a rejected submit surfaces as a danger toast');
assert.ok(document.querySelector('#modalForm'), 'an empty summary is rejected without closing the sheet');
field('summary0', '手工修订后的概要'); submit(); await until(() => !document.querySelector('#modalForm'), 'compression summary saves and closes');
const editedSummary = await app.data.store.get('summaries', id);
assert.equal(editedSummary.text, '手工修订后的概要'); assert.equal(editedSummary.throughMessageId, boundaryMessage.id); assert.ok(editedSummary.editedAt > 0);
assert.equal(document.querySelector('#toastRoot .toast').textContent, '压缩概要已更新');
assert.equal(app.services.context.requestMessages({ summary: editedSummary, recent: [] })[0].text, '手工修订后的概要', 'the edited summary replaces the frozen history in the next request');
// ── 沉浸模式：**只有设了背景图**的对话才有这套机制, 而且手势是不对称的 ────────────
// 业主 2026-09-27 两轮原话: ①"如果对话界面没有背景图片, 点击空地就不要隐藏 UI 元素";
// ②"点按空白隐藏 UI 控件, 改为长按空白处隐藏, 恢复显示只要点击不需长按"。
// 所以要验四件事: 没有背景图 ⇒ 长按也不发生; 有背景图 ⇒ **长按**才藏; 轻点就恢复;
// 手指挪动（在滚动）与长按消息都不算。
// 事件从列表气泡/空白冒泡到 .chat-layout 上那一组监听器, 所以必须 dispatchEvent ——
// 判据是"冒泡真的到得了祖先", node.click() 证明不了。
const LEFT_PRESS_MS = 500;
function pointer(node, type, x, y) {
  assert.ok(node, 'the pointer target must exist');
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  // linkedom 里没有 PointerEvent, 用 Event 补上被测代码真正读的那两个坐标。
  // 用 defineProperty 而不是直接赋值: 属性若在原型上是只读访问器, 严格模式下赋值会抛。
  Object.defineProperty(event, 'clientX', { value: x, configurable: true });
  Object.defineProperty(event, 'clientY', { value: y, configurable: true });
  node.dispatchEvent(event);
}
async function longPress(node, x = 40, y = 40) {
  pointer(node, 'pointerdown', x, y);
  await new Promise(resolve => setTimeout(resolve, LEFT_PRESS_MS + 80));
  pointer(node, 'pointerup', x, y);
  await tick();
}
async function tap(node, x = 40, y = 40) { pointer(node, 'pointerdown', x, y); pointer(node, 'pointerup', x, y); await tick(); }
const shellNode = document.getElementById('appShell');
const hiddenRegions = ['.topbar', '.message-viewport', '.composer'];
const hiddenState = () => shellNode.classList.contains('chat-chrome-hidden');
assert.equal(hiddenState(), false, 'the chat page opens with every control visible');
await longPress(document.querySelector('.message-list-inner'));
assert.equal(hiddenState(), false, '没有背景图的时候, 长按空地也不许收控件');
await tap(document.querySelector('.chat-layout'));
assert.equal(hiddenState(), false, '没有背景图时也不存在"再点一次恢复"这回事');
// 给它设一张背景图 —— 这才是"只显示背景"这件事有意义的前提。
const withBackground = Object.assign({}, await app.data.store.get('conversations', id), { background: { kind: 'image', url: 'https://example.test/background.png' } });
await app.data.store.put('conversations', id, withBackground);
await app.features.chat.refreshAppBackground();
assert.equal(document.documentElement.classList.contains('has-app-background'), true, '设了背景图之后背景层才会铺上');
// ① 轻点**不**藏 —— 这正是要改掉"一点就藏"的原因（滚动起手、想点气泡边缘却点空都会误触）。
await tap(document.querySelector('.message-list-inner'));
assert.equal(hiddenState(), false, '轻点空白不藏: 只有按住半秒才算"我要沉浸"');
// ② 长按才藏。
await longPress(document.querySelector('.message-list-inner'));
assert.equal(hiddenState(), true, '设了背景图之后, 长按空白处才收掉全部控件');
hiddenRegions.forEach(selector => assert.equal(document.querySelector(selector).getAttribute('aria-hidden'), 'true', selector + ' must leave the accessibility tree with it'));
// ③ 恢复只要轻点, 不需要长按。
await tap(document.querySelector('.chat-layout'));
assert.equal(hiddenState(), false, '轻点一下就把控件显示回来');
hiddenRegions.forEach(selector => assert.equal(document.querySelector(selector).getAttribute('aria-hidden'), null, selector + ' must be exposed again'));
// ④ 长按到一半手指挪走 = 用户在滚动列表, 不能把界面收掉。
pointer(document.querySelector('.message-list-inner'), 'pointerdown', 40, 40);
pointer(document.querySelector('.message-list-inner'), 'pointermove', 40, 120);
await new Promise(resolve => setTimeout(resolve, LEFT_PRESS_MS + 80));
pointer(document.querySelector('.message-list-inner'), 'pointerup', 40, 120);
await tick();
assert.equal(hiddenState(), false, '手指挪动超过容差就当滚动, 长按必须取消');
// ⑤ 长按消息不算空白（用户说的是"空白位置"）: 那是消息自己的区域。
await longPress(document.querySelector('.message-row .message-bubble'));
assert.equal(hiddenState(), false, 'a long press on a message bubble is not a blank-area press');
// 隐着的时候离开对话, 下一页不能继承这个状态: 类是挂在跨页面的 #appShell 上的。
await longPress(document.querySelector('.message-list-inner'));
assert.equal(hiddenState(), true, 'hide again before leaving');
await app.features.chat.close();
assert.equal(hiddenState(), false, 'leaving the conversation must clear the hidden chrome, or the list page opens invisible');
console.log('passed: five tabs, user profile, compact mention, mute state and message regeneration controls');
console.log('DOM flow checks passed (no layout, browser, device or provider acceptance claimed)');
process.exit(0);
