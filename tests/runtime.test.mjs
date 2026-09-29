import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));

function runtime(files = []) {
  const values = new Map();
  const removedMedia = [];
  let fault = null;
  const localStorage = {
    get length() { return values.size; }, key(i) { return [...values.keys()][i]; },
    getItem(k) { return values.get(k) ?? null; }, removeItem(k) { if (fault) fault(k, null); values.delete(k); },
    setItem(k, v) { if (fault) fault(k, v); values.set(k, v); }
  };
  const window = { crypto: globalThis.crypto, setTimeout, addEventListener() {} };
  // 界面语言模块按生产顺序装载：document 只用于判断何时应用，这里没有 DOM，所以应用阶段会直接返回。
  const document = { readyState: 'complete', documentElement: null, addEventListener() {}, createTreeWalker: () => ({ nextNode: () => false }) };
  const context = vm.createContext({ window, document, navigator: { language: 'zh-CN', languages: ['zh-CN'] }, localStorage, URL, Blob, TextEncoder, TextDecoder, Uint8Array, Uint32Array, Float32Array, DataView, btoa, atob, console, setTimeout, clearTimeout, AbortController });
  const load = (file) => vm.runInContext(fs.readFileSync(root + file, 'utf8'), context, { filename: file });
  ['app/core/namespace.js', 'app/core/utils.js', 'app/core/events.js', 'app/core/i18n.js', 'app/data/i18n-en.js'].forEach(load);
  const app = window.chataxi;
  app.platform = { haminn: { awaitReady: async () => false, available: () => false, api: () => null } };
  ['app/data/store.js', 'app/services/catalog.js', 'app/services/model-registry.js', 'app/services/model-services.js', 'app/services/providers.js', 'app/services/middleware.js', 'app/services/context.js', 'app/services/actions.js', 'app/services/llm.js', 'app/services/profiles.js', 'app/features/chat-session.js'].forEach(load);
  app.data.media = { remove: async (id) => removedMedia.push(id), put: async () => { throw Error('no images expected'); } };
  // tts.js 会在合成前后访问朗读缓存（app/services/tts-cache.js）。它是 tts 的服务级依赖, 所以和
  // store/catalog 一样预先装载 —— 否则每个 TTS 测试都得自己把它列进 files。
  load('app/services/tts-cache.js');
  app.services.tts = { speak: async () => {} };
  files.forEach(load);
  return { app, context, values, removedMedia, fault(fn) { fault = fn; }, load };
}
async function fixture() {
  const env = runtime(), { app } = env, s = app.data.store;
  await s.init();
  await s.put('llm-profiles', 'p', { id: 'p', name: '测试服务', model: 'fixture', endpoint: 'https://example.com/v1/responses', systemRoleMode: 'native', enabled: true });
  for (const id of ['a', 'b']) await s.put('roles', id, { id, name: id.toUpperCase(), llmProfileId: 'p', enabled: true });
  await s.put('conversations', 'c', { id: 'c', title: '回归场景', kind: 'group', roleIds: ['a', 'b'], createdAt: 1, updatedAt: 1 });
  return env;
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const result = (text) => ({ text, images: [], usage: null, contextTrimmed: false });
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function installStreamingAudio(env, onStart = () => {}) {
  class FakeAudioContext {
    constructor() { this.state = 'running'; this.destination = {}; this.currentTime = 0; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    createBuffer(_channels, length, sampleRate) { const samples = new Float32Array(length); return { length, sampleRate, getChannelData: () => samples }; }
    createBufferSource() {
      return { buffer: null, connect() {}, start() { if (this.buffer && this.buffer.length > 1) onStart(this.buffer); setTimeout(() => this.onended && this.onended(), 0); }, stop() {} };
    }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  }
  env.context.window.AudioContext = FakeAudioContext;
  assert.equal(env.app.services.tts.unlockPlayback(), true);
}

function fakeSocket(onSend) {
  const queue = [], waiters = [], frames = [];
  function push(event) { const waiter = waiters.shift(); if (waiter) waiter(event); else queue.push(event); }
  return {
    frames,
    session: {
      async sendText(raw) { const frame = JSON.parse(raw); frames.push(frame); if (onSend) onSend(frame, push); return { accepted: true }; },
      next() { if (queue.length) return Promise.resolve(queue.shift()); return new Promise(resolve => waiters.push(resolve)); },
      async close() { push({ type: 'closed', code: 1000 }); }
    }
  };
}

test('an opening scene materializes exactly once as the first ordinary system message', async () => {
  const { app } = await fixture(), store = app.data.store;
  const conversation = await store.get('conversations', 'c'); conversation.openingSceneDraft = '凌晨三点，旧车站停电。'; await store.put('conversations', 'c', conversation);
  const first = await store.prepareOpeningScene('c'), second = await store.prepareOpeningScene('c');
  const messages = await store.messages('c'), saved = await store.get('conversations', 'c');
  assert.equal(first.created, true); assert.equal(second.created, false); assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'system'); assert.equal(messages[0].systemType, 'scene'); assert.equal(messages[0].text, '凌晨三点，旧车站停电。');
  assert.equal(Object.hasOwn(saved, 'openingSceneDraft'), false);
});

test('an opening scene is never inserted retroactively after normal history exists', async () => {
  const { app } = await fixture(), store = app.data.store;
  await store.putMessage({ id: 'u0', conversationId: 'c', kind: 'user', text: '已经开始', media: [], status: 'done', createdAt: 2 });
  const conversation = await store.get('conversations', 'c'); conversation.openingSceneDraft = '不应插入'; await store.put('conversations', 'c', conversation);
  const result = await store.prepareOpeningScene('c');
  assert.equal(result.created, false); assert.deepEqual(plain((await store.messages('c')).map(message => message.kind)), ['user']);
  assert.equal(Object.hasOwn(await store.get('conversations', 'c'), 'openingSceneDraft'), false);
});

test('scene generation uses the moderator model with user, role, mode and guidance context', async () => {
  const { app } = await fixture(), store = app.data.store;
  const roleA = await store.get('roles', 'a'), roleB = await store.get('roles', 'b');
  roleA.systemPrompt = 'A 是严谨的历史研究者。'; roleB.systemPrompt = 'B 是善于倾听的主持人。';
  await store.put('roles', 'a', roleA); await store.put('roles', 'b', roleB);
  const conversation = await store.get('conversations', 'c'); conversation.moderatorRoleId = 'b'; await store.put('conversations', 'c', conversation);
  let captured;
  app.services.middleware.compileLlm = (profile, role, messages, options) => {
    captured = { profile: plain(profile), role: plain(role), messages: plain(messages), options: plain(options) };
    return { url: 'https://example.com/v1/responses', headers: {}, body: { fixture: true } };
  };
  app.services.providers.parse = () => ({ text: '雨夜的图书馆即将闭馆，三人围坐在最后一盏阅读灯下。' + '灯'.repeat(210), usage: { output_tokens: 24 }, rawId: 'scene-1' });
  app.platform.network = { requestJson: async options => { assert.deepEqual(JSON.parse(options.bodyText), { fixture: true }); return { data: {} }; } };
  const generated = await app.services.llm.generateScene(roleB, [roleB, roleA], conversation, { name: '小舟', introduction: '正在学习城市史。' }, ['学习', '思辨'], '围绕一张旧地图展开', {});
  assert.match(generated.text, /雨夜的图书馆/);
  assert.ok(Array.from(generated.text).length <= 200, 'generated scene is hard-limited to 200 characters');
  assert.equal(captured.profile.allowImageGeneration, false); assert.equal(captured.options.stream, false);
  assert.equal(captured.profile.maxOutputTokens, 500);
  assert.match(captured.role.systemPrompt, /对话主持人「B」/);
  assert.match(captured.role.systemPrompt, /小舟[\s\S]*正在学习城市史/);
  assert.match(captured.role.systemPrompt, /角色「B」[\s\S]*善于倾听[\s\S]*角色「A」[\s\S]*历史研究者/);
  assert.match(captured.role.systemPrompt, /100 个汉字左右[\s\S]*不能超过 200 个汉字/);
  assert.match(captured.messages[0].text, /场景模式：学习[\s\S]*学习目标[\s\S]*具体问题[\s\S]*围绕一张旧地图展开/);
  assert.doesNotMatch(captured.messages[0].text, /场景模式：思辨/);
});

test('each scene mode has a focused and materially different planning instruction', async () => {
  const { app } = await fixture(), instruction = app.services.llm.sceneModeInstruction;
  assert.match(instruction('工作'), /正式、专业[\s\S]*目标[\s\S]*职责[\s\S]*约束[\s\S]*决策/);
  assert.match(instruction('学习'), /正式、专注[\s\S]*学科、知识点或技能任务[\s\S]*学习目标[\s\S]*不渲染氛围/);
  assert.match(instruction('思辨'), /多种立场[\s\S]*关键前提[\s\S]*观点张力[\s\S]*不预设结论/);
  assert.match(instruction('闲聊'), /日常交流[\s\S]*小事件[\s\S]*氛围细节[\s\S]*故事感/);
  assert.match(instruction('倾诉'), /共情空间[\s\S]*生活片段[\s\S]*环境与氛围[\s\S]*不要诊断/);
  assert.notEqual(instruction('工作'), instruction('学习'));
});

test('group chat responds once per role, in conversation order, with previous answer in context', async () => {
  const { app } = await fixture(), seen = [];
  app.services.llm.complete = async (role, history) => { seen.push({ role: role.id, history: plain(history) }); return result(role.name); };
  await app.features.chatSession.run('c', { text: '问题', roleIds: ['b', 'a', 'a'] });
  assert.deepEqual(seen.map(x => x.role), ['a', 'b']);
  assert.equal(seen[1].history.at(-1).text, 'A');
  const messages = await app.data.store.messages('c');
  assert.deepEqual(plain(messages.map(x => x.status)), ['done', 'done', 'done']);
  assert.equal(messages[1].replyTo, messages[0].id);
});

test('language model completion emits incremental text before the streamed response finishes', async () => {
  const { app } = await fixture(), updates = [];
  const role = await app.data.store.get('roles', 'a'), conversation = await app.data.store.get('conversations', 'c');
  app.platform.network = { requestSse: async options => {
    assert.equal(JSON.parse(options.bodyText).stream, true);
    await options.onEvent({ data: '{"type":"response.output_text.delta","delta":"逐段"}' });
    await options.onEvent({ data: '{"type":"response.output_text.delta","delta":"输出"}' });
    await options.onEvent({ data: '{"type":"response.completed","response":{"usage":{"output_tokens":2}}}' });
  } };
  const task = { cancelled: false, onDelta: update => updates.push(update.text) };
  const result = await app.services.llm.complete(role, [], task, conversation, [role]);
  assert.deepEqual(updates, ['逐段', '逐段输出']);
  assert.equal(result.text, '逐段输出'); assert.equal(result.streamed, true); assert.equal(result.usage.output_tokens, 2);
});

test('a retryable native network abort restarts one language-model stream and replaces partial text', async () => {
  const { app } = await fixture(); let attempts = 0, retries = 0; const updates = [];
  const role = await app.data.store.get('roles', 'a'), conversation = await app.data.store.get('conversations', 'c');
  app.platform.network = { requestSse: async options => {
    attempts++;
    if (attempts === 1) {
      await options.onEvent({ data: '{"type":"response.output_text.delta","delta":"几个字"}' });
      const error = Error('Software caused connection abort'); error.code = 'E_NETWORK'; error.retryable = true; throw error;
    }
    await options.onEvent({ data: '{"type":"response.output_text.delta","delta":"完整回复"}' });
    await options.onEvent({ data: '{"type":"response.completed","response":{"usage":{"output_tokens":4}}}' });
  } };
  const task = { cancelled: false, onDelta: update => updates.push(update.text), onStreamRetry: async () => { retries++; updates.push(''); } };
  const completed = await app.services.llm.complete(role, [], task, conversation, [role]);
  assert.equal(attempts, 2); assert.equal(retries, 1); assert.deepEqual(updates, ['几个字', '', '完整回复']);
  assert.equal(completed.text, '完整回复'); assert.equal(task.streamingRetried, true);
});

test('a retried reply resets its partial bubble and streaming readout before continuing', async () => {
  const { app } = await fixture(); let attempts = 0, stops = 0; const voices = [];
  app.state.activeConversationId = 'c';
  const conversation = await app.data.store.get('conversations', 'c'); conversation.kind = 'single'; conversation.roleIds = ['a']; conversation.autoSpeak = true; await app.data.store.put('conversations', 'c', conversation);
  app.services.tts = {
    createStream: async () => { const owner = { started: false, text: '', append(delta) { this.text += delta; }, async finish(text) { this.finished = text; } }; voices.push(owner); return owner; },
    stop: async () => { stops++; }, speak: async () => {}
  };
  app.platform.network = { requestSse: async options => {
    attempts++;
    if (attempts === 1) {
      await options.onEvent({ data: '{"type":"response.output_text.delta","delta":"残留片段"}' });
      const error = Error('Software caused connection abort'); error.code = 'E_NETWORK'; error.retryable = true; throw error;
    }
    await options.onEvent({ data: '{"type":"response.output_text.delta","delta":"重试后的完整回复"}' });
    await options.onEvent({ data: '{"type":"response.completed","response":{}}' });
  } };
  await app.features.chatSession.run('c', { text: '请回答', roleIds: ['a'] });
  await new Promise(resolve => setTimeout(resolve, 0));
  const messages = await app.data.store.messages('c'), answer = messages.find(message => message.kind === 'assistant');
  assert.equal(attempts, 2); assert.equal(stops, 1); assert.equal(voices.length, 2);
  assert.equal(voices[0].text, '残留片段'); assert.equal(voices[1].text, '重试后的完整回复');
  assert.equal(voices[1].finished, '重试后的完整回复'); assert.equal(answer.text, '重试后的完整回复'); assert.equal(answer.status, 'done');
});

test('an empty group turn can mention one role and carries every participant definition', async () => {
  const { app } = await fixture(); let participants;
  app.services.llm.complete = async (role, _history, _task, _conversation, allRoles) => { participants = allRoles; return result(role.name); };
  await app.features.chatSession.run('c', { text: '', media: [], roleIds: ['b'], continueOnly: true });
  const messages = await app.data.store.messages('c');
  assert.equal(messages.length, 2); assert.match(messages[0].text, /@B.*继续回答/); assert.equal(messages[1].roleId, 'b');
  assert.deepEqual(plain(participants.map(role => role.id)), ['a', 'b']);
});

test('automatic role selection persists a typed routing record while normal history stays clean', async () => {
  const { app } = await fixture();
  const conversation = await app.data.store.get('conversations', 'c'); conversation.moderatorRoleId = 'a'; conversation.autoSelectRole = true; await app.data.store.put('conversations', 'c', conversation);
  let routing, answered;
  app.services.llm.selectRole = async (moderator, candidates, history, task) => {
    routing = { moderator: moderator.id, candidates: candidates.map(role => role.id), history: plain(history) };
    task.routingTrace = { serviceId: 'p', serviceName: '测试服务', modelId: 'fixture', protocol: 'openai-responses', outputText: '{"role":"B"}', responseId: 'response-1', usage: { output_tokens: 7 } };
    return candidates.find(role => role.id === 'b');
  };
  app.services.llm.complete = async role => { answered = role.id; return result('B 的回答'); };
  await app.features.chatSession.run('c', { text: '谁适合回答？', roleIds: ['a'] });
  assert.equal(routing.moderator, 'a'); assert.deepEqual(plain(routing.candidates), ['a', 'b']); assert.equal(routing.history.at(-1).text, '谁适合回答？');
  assert.equal(answered, 'b');
  const messages = await app.data.store.messages('c');
  assert.deepEqual(plain(messages.map(message => message.kind === 'user' ? message.text : message.roleId)), ['谁适合回答？', 'b']);
  const records = await app.data.store.routingRecords('c');
  assert.equal(records.length, 1); assert.equal(records[0].kind, 'routing'); assert.equal(records[0].status, 'done');
  assert.equal(records[0].text, '{"role":"B"}'); assert.equal(records[0].selectedRoleId, 'b'); assert.equal(records[0].fallback, false);
  assert.equal(records[0].modelId, 'fixture'); assert.equal(records[0].responseId, 'response-1'); assert.equal(records[0].userMessageId, messages[0].id);
  assert.deepEqual(plain((await app.data.store.get('conversations', 'c')).activeRoleIds), ['b']);
});

test('an empty automatic group turn is stored before routing and uses the shared continuation text', async () => {
  const { app } = await fixture();
  const conversation = await app.data.store.get('conversations', 'c'); conversation.moderatorRoleId = 'a'; conversation.autoSelectRole = true; await app.data.store.put('conversations', 'c', conversation);
  const phases = []; app.events.on('chat:changed', event => phases.push(event.phase));
  app.services.llm.selectRole = async (_moderator, candidates, history) => {
    assert.equal(history.at(-1).text, '请你们自主回答。');
    assert.equal((await app.data.store.messages('c')).at(-1).text, '请你们自主回答。');
    return candidates[1];
  };
  app.services.llm.complete = async role => result(role.name + ' 继续回答');
  await app.features.chatSession.run('c', { text: '', media: [], roleIds: ['a'], continueOnly: true });
  const messages = await app.data.store.messages('c');
  assert.equal(messages[0].text, '请你们自主回答。'); assert.equal(messages[1].roleId, 'b');
  assert.ok(phases.indexOf('accepted') < phases.indexOf('routing'));
  assert.ok(phases.indexOf('routing') < phases.indexOf('generating'));
});

test('automatic role selection records parser failure and fallback without polluting normal history', async () => {
  const { app } = await fixture();
  const conversation = await app.data.store.get('conversations', 'c'); conversation.moderatorRoleId = 'a'; conversation.autoSelectRole = true; await app.data.store.put('conversations', 'c', conversation);
  const events = []; app.events.on('chat:changed', event => events.push(plain(event)));
  app.services.llm.selectRole = async (_moderator, _candidates, _history, task) => { task.routingTrace = { serviceId: 'p', modelId: 'fixture', protocol: 'openai-responses', outputText: '我建议 B 回答' }; throw Error('返回格式错误'); };
  let answered; app.services.llm.complete = async role => { answered = role.id; return result('随机角色回答'); };
  await app.features.chatSession.run('c', { text: '继续', roleIds: ['a'] });
  assert.ok(['a', 'b'].includes(answered));
  const routed = events.find(event => event.phase === 'routed'); assert.equal(routed.fallback, true); assert.equal(routed.roleId, answered); assert.match(routed.error, /返回格式错误/);
  assert.equal((await app.data.store.messages('c')).length, 2);
  const records = await app.data.store.routingRecords('c'); assert.equal(records.length, 1); assert.equal(records[0].status, 'error'); assert.equal(records[0].fallback, true);
  assert.equal(records[0].text, '我建议 B 回答'); assert.match(records[0].error, /返回格式错误/); assert.equal(records[0].selectedRoleId, answered);
});

test('automatic role selection only accepts the standard JSON role name or one exact unique name', async () => {
  const { app } = await fixture(), roles = await app.data.store.list('roles');
  assert.equal(app.services.llm.parseRoleChoice('{"role":"B"}', roles).id, 'b');
  assert.equal(app.services.llm.parseRoleChoice('A', roles).id, 'a');
  assert.throws(() => app.services.llm.parseRoleChoice('{"role":"不存在"}', roles), /唯一且有效/);
});

test('moderator routing sends participant profiles, user profile and current full context to the model', async () => {
  const { app } = await fixture(), roles = await app.data.store.list('roles'), conversation = await app.data.store.get('conversations', 'c');
  roles[0].systemPrompt = 'A 负责统筹'; roles[1].systemPrompt = 'B 负责技术';
  let request; app.platform.network = { requestJson: async options => { request = JSON.parse(options.bodyText); return { data: { output_text: '{"role":"B"}' } }; } };
  const chosen = await app.services.llm.selectRole(roles[0], roles, [{ id: 'u', kind: 'user', text: '请解决技术问题', media: [], status: 'done', createdAt: 1 }], { cancelled: false }, conversation, { name: '用户甲', introduction: '偏好简洁回答' });
  assert.equal(chosen.id, 'b');
  assert.match(request.instructions, /群聊主持人「A」/); assert.match(request.instructions, /角色「A」[\s\S]*A 负责统筹/); assert.match(request.instructions, /角色「B」[\s\S]*B 负责技术/); assert.match(request.instructions, /用户甲[\s\S]*偏好简洁回答/);
  assert.match(JSON.stringify(request), /请解决技术问题/);
});

test('the requested speaker gets an isolated identity contract and wrong role labels are blocked', async () => {
  const { app } = await fixture();
  const roles = await app.data.store.list('roles'), active = roles.find(role => role.id === 'a'), other = roles.find(role => role.id === 'b');
  active.systemPrompt = '坚持 A 的说话方式。'; other.systemPrompt = '坚持 B 的说话方式。';
  const conversation = await app.data.store.get('conversations', 'c');
  const history = [
    { id: 'u', kind: 'user', text: '请回答', media: [], status: 'done', createdAt: 1 },
    { id: 'b', kind: 'assistant', roleId: 'b', roleName: 'B', text: 'B 的历史回答', media: [], status: 'done', createdAt: 2 }
  ];
  let request;
  app.platform.network = { requestSse: async options => { request = JSON.parse(options.bodyText); await options.onEvent({ data: '{"type":"response.output_text.delta","delta":"[A] A 自己回答"}' }); await options.onEvent({ data: '{"type":"response.completed","response":{}}' }); } };
  const result = await app.services.llm.complete(active, history, { cancelled: false, onDelta() {} }, conversation, roles, { name: '用户', introduction: '' });
  assert.equal(result.text, 'A 自己回答');
  assert.match(request.instructions, /本轮唯一允许发言的角色是「A」/); assert.match(request.instructions, /不得扮演、代替、续写或模拟其他参与角色/);
  assert.match(request.instructions, /<active_role>[\s\S]*坚持 A 的说话方式/); assert.match(request.instructions, /<other_roles_reference>[\s\S]*坚持 B 的说话方式/);
  assert.equal(request.input[1].role, 'user'); assert.match(request.input[1].content, /其他角色「B」的历史发言.*禁止模仿/); assert.match(request.input.at(-1).content, /只有「A」被点名回答/);
  let emitted = false;
  app.platform.network.requestSse = async options => { await options.onEvent({ data: '{"type":"response.output_text.delta","delta":"[B] 我替 B 回答"}' }); };
  await assert.rejects(app.services.llm.complete(active, history, { cancelled: false, onDelta() { emitted = true; } }, conversation, roles, {}), /其他角色「B」.*已拦截/);
  assert.equal(emitted, false);
});

test('conversation personal settings override global name and introduction independently without merging', async () => {
  const { app } = await fixture(), seen = [];
  await app.data.store.put('meta', 'user-profile', { name: '测试用户', introduction: '通用用户背景', avatarMediaId: '' });
  app.services.llm.complete = async (_role, _history, _task, _conversation, _roles, userProfile) => { seen.push(plain(userProfile)); return result('完成'); };
  await app.features.chatSession.run('c', { text: '第一轮', roleIds: ['a'] });
  const conversation = await app.data.store.get('conversations', 'c'); conversation.userName = '对话称呼'; conversation.userIntroduction = ''; conversation.userAvatarMediaId = 'conversation-avatar'; await app.data.store.put('conversations', 'c', conversation);
  await app.features.chatSession.run('c', { text: '第二轮', roleIds: ['b'] });
  conversation.userName = ''; conversation.userIntroduction = '本对话专用背景'; await app.data.store.put('conversations', 'c', conversation);
  await app.features.chatSession.run('c', { text: '第三轮', roleIds: ['a'] });
  assert.deepEqual(seen, [
    { name: '测试用户', introduction: '通用用户背景' },
    { name: '对话称呼', introduction: '通用用户背景' },
    { name: '测试用户', introduction: '本对话专用背景' }
  ]);
  const resolved = app.services.profiles.userForConversation(conversation, { name: '测试用户', introduction: '通用用户背景', avatarMediaId: 'global-avatar' });
  assert.deepEqual(plain(resolved), { name: '测试用户', introduction: '本对话专用背景', avatarMediaId: 'conversation-avatar' });
  const applied = app.services.context.applyToRole({ id: 'a', name: 'A', systemPrompt: '角色设定' }, [{ id: 'a', name: 'A', systemPrompt: '角色设定' }], seen[2]);
  assert.match(applied.systemPrompt, /名称：「测试用户」/); assert.match(applied.systemPrompt, /本对话专用背景/);
  assert.doesNotMatch(applied.systemPrompt, /通用用户背景/);
});

test('the drawing tool discipline joins the role behaviour guidance instead of standing apart', () => {
  const { app } = runtime();
  const role = { id: 'a', name: 'A', systemPrompt: '角色设定', behaviorGuidance: '我每次回复必须用第一人称，只生成很少的几句对话。' };
  // 不传工具纪律时一个字都不许出现 —— 没配绘图卡片就不该把动作块的事说给模型。
  const without = app.services.context.applyToRole(role, [role]);
  assert.doesNotMatch(without.systemPrompt, /工具纪律那句/);
  // 传了就必须和角色自己的行为指导**并进同一段**：段里那句「必须严格遵守」是唯一让模型让路的东西，
  // 另起一段就等于把工具条款降级成一份并列的参考资料（现场失败正是模型选了角色那条「少说几句」）。
  const withTool = app.services.context.applyToRole(role, [role], null, '工具纪律那句');
  assert.match(withTool.systemPrompt, /只生成很少的几句对话。\n工具纪律那句/);
  assert.equal((withTool.systemPrompt.match(/<behavior_guidance>/g) || []).length, 1);
  // 角色没写行为指导时也要单独成段 —— 否则一个没设行为指导的角色会整条工具纪律都收不到。
  const bare = { id: 'a', name: 'A', systemPrompt: '角色设定' };
  const bareWithTool = app.services.context.applyToRole(bare, [bare], null, '工具纪律那句');
  assert.match(bareWithTool.systemPrompt, /<behavior_guidance>\n以下行为指导[\s\S]*工具纪律那句/);
  // 空串 / 纯空白按「没有」处理，不许拼出一个空的行为指导段。
  const blank = app.services.context.applyToRole(bare, [bare], null, '   ');
  assert.doesNotMatch(blank.systemPrompt, /<behavior_guidance>/);
  // applyToRole 返回新对象：原角色记录的系统提示词不能被就地改写。
  assert.equal(role.systemPrompt, '角色设定');
  assert.notEqual(withTool.systemPrompt, role.systemPrompt);
});

// 历史组装必须保住「因」（业主 2026-09-27，plan §⑲）。以前动作块在入库前就被切走，模型在自己的
// 全部历史里看不到一个「我是怎么写块、块有没有被执行」的样本，只能把「说一句话」归纳成出图的原因。
// 这两条测试跑的是真实链路：complete() 真的解析一次带动作块的流式回复，hydrateMessages() 真的组装一次历史。
test('a reply keeps the original text with its action block, so the model keeps its own how-to sample', async () => {
  const { app } = await fixture();
  const role = await app.data.store.get('roles', 'a'), conversation = await app.data.store.get('conversations', 'c');
  const raw = '我画一张给你看吧。\n\n<<<chataxi-action\n{"type":"draw","prompt":"雨夜的旧车站","selfPortrait":false}\n>>>';
  app.platform.network = { requestSse: async options => {
    await options.onEvent({ data: JSON.stringify({ type: 'response.output_text.delta', delta: raw }) });
    await options.onEvent({ data: '{"type":"response.completed","response":{"usage":{"output_tokens":9}}}' });
  } };
  const completed = await app.services.llm.complete(role, [], { cancelled: false, onDelta() {} }, conversation, [role]);
  // 显示 / 朗读 / 预览读的是切过的 text：这一段一个字都不能变，否则动作块会露到界面上。
  assert.equal(completed.text, '我画一张给你看吧。');
  assert.equal(completed.action.prompt, '雨夜的旧车站');
  // 进上下文的是 rawText —— 含动作块的原文。
  assert.equal(completed.rawText, raw, 'rawText 必须是模型原样输出（含动作块），不能被切掉');
  assert.ok(completed.rawText.includes('<<<chataxi-action'), 'rawText 里必须留着哨兵，模型才认得出自己当初的写法');
});

test('a drawing turn reaches the model as its own words plus a machine receipt in the user voice', async () => {
  const { app } = await runtime();
  const block = '<<<chataxi-action\n{"type":"draw","prompt":"雨夜的旧车站","selfPortrait":false}\n>>>';
  const turn = (extra) => Object.assign({
    id: 'a' + Math.random(), conversationId: 'c', kind: 'assistant', roleId: 'a', roleName: 'A',
    text: '我画一张给你看吧。', rawText: '我画一张给你看吧。\n\n' + block,
    draw: { prompt: '雨夜的旧车站' }, status: 'done', media: [], createdAt: 1
  }, extra);
  const history = await app.services.llm.hydrateMessages([
    { id: 'u1', kind: 'user', text: '给我看看你的样子', media: [], status: 'done', createdAt: 0 },
    turn({ id: 'a1' }),
    turn({ id: 'a2', status: 'error', error: '连接超时' }),
    turn({ id: 'a3', status: 'cancelled' }),
    turn({ id: 'a4', status: 'drawing' }),
    { id: 'a5', kind: 'assistant', roleId: 'a', roleName: 'A', text: '就是聊聊天。', status: 'done', media: [], createdAt: 2 },
    // 没写过动作块的一次失败：status 是 error, 但没有 draw 记录 ⇒ 不许凭空发一条"绘图失败"回执。
    { id: 'a6', kind: 'assistant', roleId: 'a', roleName: 'A', text: '', status: 'error', error: '模型超时', media: [], createdAt: 3 },
    // v0.7.39 之前的记录：有 draw、状态 done, 但**一个 rawText 都没有**（那一轮的原文从来没被留下）。
    // 对它发回执, 就等于用历史把提示词里「只有你写了动作块的回合才会有这条回执」当场证伪。
    { id: 'a7', kind: 'assistant', roleId: 'a', roleName: 'A', text: '', draw: { prompt: '旧图' }, status: 'done', media: [], createdAt: 4 }
  ], {}, { id: 'a', name: 'A' }, {}, {}, {});

  // 模型自己的话（含动作块）在上下文里。
  assert.match(history[1].text, /\{"type":"draw","prompt":"雨夜的旧车站","selfPortrait":false\}/, '进上下文的原文必须连动作块的 JSON 一起在');
  // 回执**紧挨**在那条消息之后, 且是 user 身份 —— system 会被 mapSystemMessages 抽到请求最前面, 位置就丢了。
  assert.equal(history[2].speakerKind, 'draw-receipt');
  assert.equal(history[2].role, 'user');
  assert.match(history[2].text, /^\[本机系统消息\]/, '回执必须自报来源是本机系统消息');
  assert.match(history[2].text, /成功执行你上一条消息里的绘图动作块/);
  // 地址不许给：可复制的 URL 形态正是模型抄进正文当图片的那半截。
  const receipts = history.filter(entry => entry.speakerKind === 'draw-receipt');
  assert.equal(receipts.length, 3, '成功 / 出错 / 取消三态各一条；正在绘制与「根本没写块」都不发');
  assert.equal(receipts.every(entry => entry.role === 'user'), true, '回执一律 user 身份（system 会被抽到请求最前面，位置就丢了）');
  assert.equal(receipts.every(entry => /^\[本机系统消息\]/.test(entry.text)), true, '三条回执都要自报来源：只给成功那条标，失败与取消两条就会被读成用户说的话');
  assert.equal(receipts.every(entry => !/__haminn\/files|https?:\/\//.test(entry.text)), true, '回执里不许出现任何地址');
  // 差态的两种写法必须能被区分：只留成功的话, "写了块但失败"和"根本没写块"在历史里长得一样。
  assert.match(receipts[1].text, /出错[\s\S]*图片没有生成/);
  assert.match(receipts[2].text, /已被取消[\s\S]*没有生成图片/);
  assert.equal(history[7].speakerKind, 'active-role-history'); assert.match(history[7].text, /<<<chataxi-action/, '正在绘制的那一轮原文照旧进上下文, 只是还没有回执');
  assert.equal(history.length, 9, '空正文的失败轮与旧格式记录都不留下任何条目, 也不许留回执');
  assert.equal(history.some(entry => entry.role === 'system' && entry.speakerKind === 'draw-receipt'), false, '回执绝不许用 system 身份');
});

// **这条测试的判据是"别再把中间那一环丢掉"。** 前面两条测试是手工构造消息, 所以它们永远绿 ——
// 而 2026-09-27 的真实故障恰恰断在中间: `settle()` 把原文挂在 result.rawText 上, 但 `chat-session.js`
// 把 result 抄进 pending 时只抄了 text ⇒ 原文从来没落库 ⇒ 历史里那条正例还是被抽掉了「因」,
// 模型第一轮出图、第二轮起再也不写块。手写的 fixture 看不见这种断链, 只有真链路能看见。
test('the action block and its receipt survive the real reply path all the way into the model context', async () => {
  const { app } = await fixture(), store = app.data.store;
  const raw = '我画一张给你看吧。\n\n<<<chataxi-action\n{"type":"draw","prompt":"雨夜的旧车站","selfPortrait":false}\n>>>';
  // 第二轮是**纯动作轮**（正文为空）：那条动作块只能靠绘图消息自己承载（carryRaw 那条路径）。
  const actionOnlyRaw = '<<<chataxi-action\n{"type":"draw","prompt":"窗台上的橘猫","selfPortrait":false}\n>>>';
  const replies = [raw, actionOnlyRaw];
  // 真 complete()：只替换传输层, 让真 settle() 去切块。
  app.platform.network = { requestSse: async options => {
    const text = replies.shift() || '';
    await options.onEvent({ data: JSON.stringify({ type: 'response.output_text.delta', delta: text }) });
    await options.onEvent({ data: '{"type":"response.completed","response":{"usage":{"output_tokens":120}}}' });
  } };
  // 绘图客户端 stub：只要 runDraw 能跑完, 不碰真插件。
  let produced = 0;
  app.services.draw = {
    available: async () => ({ profile: { id: 'card' }, modelId: 'render' }),
    resolveCard: async () => ({ profile: { id: 'card' }, modelId: 'render' }),
    newTask: () => ({ cancelled: false }),
    generate: async () => ({ blob: new Blob([new Uint8Array([1, 2, 3])]), mime: 'image/png' }),
    portraitReference: async () => ''
  };
  app.data.media.put = async () => ({ id: 'media-' + (produced += 1) });

  await app.features.chatSession.run('c', { text: '给我看看你的样子', roleIds: ['a'] });
  // 绘图是**分离任务**（run() 不 await 它）：不能等 `drawing()` 变空 —— 那条消息可能还没被置位。
  // 判据只能落在库里：等到那条绘图记录真的落成 done。
  const settleDraw = async (expected) => {
    for (let i = 0; i < 400; i += 1) {
      const list = await store.messages('c');
      const drawn = list.filter(message => message.draw && message.draw.prompt);
      if (drawn.length === expected && drawn.every(message => message.status === 'done')) return drawn;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('timeout: 第 ' + expected + ' 条绘图记录始终没有落成 done');
  };
  const [firstDraw] = await settleDraw(1);

  const messages = await store.messages('c');
  const reply = messages.filter(message => message.kind === 'assistant' && message.text)[0];
  assert.ok(reply, '这一轮应该留下一条带正文的 assistant 消息');
  // ① 原文真的落库了 —— 这一条断言就是这次故障的哨兵。
  assert.equal(Object.prototype.hasOwnProperty.call(reply, 'rawText'), true, '正文消息必须把 rawText 一起落库, 否则动作块进不了历史（模型只看得到一句承诺）');
  assert.equal(reply.rawText, raw, 'rawText 必须是模型原样输出（含动作块）');
  assert.equal(reply.text, '我画一张给你看吧。', '落库的 text 仍然是切过的正文, 界面不受影响');
  // ② 绘图记录与图片照旧。
  assert.equal(firstDraw.status, 'done', '这一轮要真的画出图来');
  assert.equal(firstDraw.media.length, 1, '画出来的图要挂在那条绘图消息上');
  assert.equal(messages.filter(message => message.kind === 'assistant' && !message.text && !message.draw).length, 0, '空正文的回复不许留下空气泡');

  // ③ 纯动作轮（正文为空）：块只能靠绘图消息自己承载 —— 这条路径同样走全程。
  await app.features.chatSession.run('c', { text: '再画一个', roleIds: ['a'] });
  const all = await settleDraw(2);
  const actionOnly = all.filter(message => message.draw.prompt === '窗台上的橘猫')[0];
  assert.ok(actionOnly, '纯动作轮要留下那条绘图消息');
  assert.equal(actionOnly.text, '', '纯动作轮没有正文');
  assert.equal(Object.prototype.hasOwnProperty.call(actionOnly, 'rawText'), true, '纯动作轮必须把原文挂在绘图消息上');
  assert.equal(actionOnly.rawText, actionOnlyRaw, '正文为空时, 绘图消息的 rawText 就是那条动作块唯一的载体');
  assert.equal((await store.messages('c')).filter(message => message.kind === 'assistant' && !message.text && !message.draw).length, 0, '纯动作轮也不许留下空气泡');

  // ④ 真组装一次：模型**真正收到**的上下文里必须有它自己写过的块 + 本机回执。
  const messages2 = await store.messages('c');
  const history = await app.services.llm.hydrateMessages(messages2, {}, await store.get('roles', 'a'), {}, {}, {});
  const withBlock = history.filter(entry => entry.text && entry.text.includes('<<<chataxi-action'));
  assert.equal(withBlock.length, 2, '两轮都写过块 ⇒ 上下文里必须恰好有两条带动作块的历史 —— 这就是模型「我当初怎么做的」范例');
  assert.match(withBlock[0].text, /\{"type":"draw","prompt":"雨夜的旧车站"/);
  assert.match(withBlock[1].text, /\{"type":"draw","prompt":"窗台上的橘猫"/);
  const at = history.indexOf(withBlock[0]);
  assert.equal(history[at + 1].speakerKind, 'draw-receipt', '回执必须紧跟在那条带动作块的消息之后');
  assert.equal(history[at + 1].role, 'user');
  assert.match(history[at + 1].text, /^\[本机系统消息\][\s\S]*成功执行你上一条消息里的绘图动作块/);
});

// 编辑绘图提示词时要把**真实进上下文的动作块**改成同一个值（业主 2026-09-27）。这是纯文本改写，
// 所以判据只有两条：① 只动 prompt 那一个值，模型原文其余部分一字不差；② 找不到可改的块时返回空串，
// 让调用方跳过 —— 旧记录没有块，绝不许伪造一个（那会凭空给出一个它从没写过的范例）。
test('rewriting an existing action block touches only the prompt value, never the rest of the model text', () => {
  const { app } = runtime();
  const retarget = app.services.actions.retarget;
  // 模型写得不规范（多空格、键序不同）也要只改值，其余一字不动。
  const raw = '我画一张给你看吧。\n\n<<<chataxi-action\n{ "selfPortrait" : false , "type" : "draw" ,  "prompt"  :  "一只趴在窗台的橘猫" }\n>>>';
  const next = retarget(raw, '雨夜的旧车站');
  assert.equal(next, '我画一张给你看吧。\n\n<<<chataxi-action\n{ "selfPortrait" : false , "type" : "draw" ,  "prompt"  :  "雨夜的旧车站" }\n>>>', '只许替换 prompt 的值，键序、空白、正文一字不动');
  assert.equal(next.includes('<<<chataxi-action'), true, '改完仍然是同一条动作块');
  // 引号、反斜杠、换行必须按 JSON 转义 —— 否则改完的原文会被切成畸形块，动作直接失效。
  const escaped = retarget(raw, 'a "quoted" \\ back\nnewline');
  assert.equal(escaped.includes('"prompt"  :  "a \\"quoted\\" \\\\ back\\nnewline"'), true, '提示词里的引号、反斜杠、换行都要按 JSON 转义写回');
  // 转义写对了，块就还能被切出来；`parse()` 会把提示词里的连续空白压成单空格（它原本就这么做），
  // 所以这里比的是压过之后的值 —— 重点是"没被切成畸形块"。
  assert.equal(app.services.actions.split(escaped).action.prompt, 'a "quoted" \\ back newline', '改完必须还能被 split 解析成一条有效的动作（不是畸形块）');
  assert.equal(app.services.actions.split(escaped).invalid, false);
  // 没有块 / 块里没有 prompt 键 / 原文本身就缺失 ⇒ 空串（调用方据此跳过，不伪造）。
  assert.equal(retarget('只是聊聊天。', '雨夜的旧车站'), '');
  assert.equal(retarget('', '雨夜的旧车站'), '');
  assert.equal(retarget(undefined, '雨夜的旧车站'), '', '旧记录没有 rawText：绝不许凭空造一个块出来');
  assert.equal(retarget('<<<chataxi-action\n{"type":"draw","selfPortrait":false}\n>>>', '雨夜的旧车站'), '');
});

test('the retention window is derived from the retention chars, not a fixed message count', async () => {
  const { app } = await fixture();
  const line = (id, length) => ({ id, kind: 'user', text: 'x'.repeat(length), status: 'done', createdAt: Number(id) });
  const messages = [line('1', 10), line('2', 10), line('3', 10), line('4', 10), line('5', 10)];
  // 保留 25 字：从最近一条往前累加到 30 字时用掉 3 条，所以 k=3。
  assert.equal(app.services.context.retainedCount(messages, { compressionRetainChars: 25 }), 3);
  // 保留字数调大只会多留，不会少留。
  assert.equal(app.services.context.retainedCount(messages, { compressionRetainChars: 45 }), 5);
  // 保留字数调到很小也至少留 2 条：刚发生的一问一答不会被立刻折进概要。
  assert.equal(app.services.context.retainedCount(messages, { compressionRetainChars: 1 }), 2);
  // 不足 2 条时不会凭空多留。
  assert.equal(app.services.context.retainedCount([line('1', 500)], { compressionRetainChars: 10 }), 1);
  assert.equal(app.services.context.retainedCount([], { compressionRetainChars: 10 }), 0);
  // 缺省保留字数按 4000 算。
  const wide = [line('1', 100), line('2', 100), line('3', 100), line('4', 3900)];
  assert.equal(app.services.context.retainedCount(wide, {}), 3);
  assert.equal(app.services.context.retainedCount(wide, {}), app.services.context.retainedCount(wide, { compressionRetainChars: 4000 }));
  // 同样 4000 字预算，消息越长保留的条数越少。
  assert.equal(app.services.context.retainedCount([line('1', 4000), line('2', 4000), line('3', 4000)], { compressionRetainChars: 4000 }), 2);
});

test('group context shares one summary and keeps a char-derived retention window across user and every role', async () => {
  const { app } = await fixture();
  const messages = [
    { id: 'u1', kind: 'user', text: '用户一', status: 'done', createdAt: 1 },
    { id: 'a1', kind: 'assistant', roleId: 'a', roleName: 'A', text: '角色 A 一', status: 'done', createdAt: 2 },
    { id: 'b1', kind: 'assistant', roleId: 'b', roleName: 'B', text: '角色 B 一', status: 'done', createdAt: 3 },
    { id: 'u2', kind: 'user', text: '用户二', status: 'done', createdAt: 4 },
    { id: 'b2', kind: 'assistant', roleId: 'b', roleName: 'B', text: '角色 B 二', status: 'done', createdAt: 5 },
    { id: 'a2', kind: 'assistant', roleId: 'a', roleName: 'A', text: '角色 A 二', status: 'done', createdAt: 6 },
    { id: 'u3', kind: 'user', text: '用户三', status: 'done', createdAt: 7 }
  ];
  // 保留条数不再逐对话配置，而是由「压缩保留字数」按字数推导：
  // 从最近一条往前累加到 20 字时刚好是 5 条（3+6+6+3+6），所以 k=5。
  const settings = await app.data.store.get('meta', 'settings'); settings.autoCompress = true; settings.compressionThresholdChars = 1; settings.compressionTargetChars = 2; settings.compressionRetainChars = 20;
  app.platform.network = { requestJson: async () => ({ data: { output_text: '摘要' } }) };
  const current = { id: 'a', name: 'A', systemPrompt: 'A 的设定', llmProfileId: 'p' }, other = { id: 'b', name: 'B', systemPrompt: 'B 的设定', llmProfileId: 'p' };
  const conversation = { id: 'c', moderatorRoleId: 'b' };
  // 压缩是后台任务：本轮先用现有历史回答，概要随后才写回存储。
  const prepared = await app.services.context.prepare(conversation, current, messages, settings, [current, other], {});
  assert.equal(prepared.summary, null); assert.equal(prepared.compressionPending, true);
  assert.deepEqual(plain(prepared.recent.map(message => message.id)), ['u1', 'a1', 'b1', 'u2', 'b2', 'a2', 'u3']);
  const job = app.services.context.compressionJob('c');
  assert.ok(job, 'compression must still be pending when prepare returns');
  const written = await job;
  assert.equal(written.throughMessageId, 'a1'); assert.equal(written.sourceMessageCount, 2); assert.equal(written.retainedMessageCount, 5);
  assert.equal(written.compressedByRoleId, 'b'); assert.equal(written.compressedByRoleName, 'B');
  const shared = await app.services.context.prepare(conversation, other, messages, settings, [current, other], {});
  assert.equal(shared.summary.id, 'c'); assert.equal(shared.summary.text, '摘要'); assert.equal(shared.summary.compressedByRoleId, 'b');
  assert.deepEqual(plain(shared.recent.map(message => message.id)), ['b1', 'u2', 'b2', 'a2', 'u3']);
  assert.deepEqual(plain(shared.recent.map(message => message.kind === 'user' ? 'user' : message.roleId)), ['b', 'user', 'b', 'a', 'user']);
  const requestMessages = app.services.context.requestMessages(shared);
  assert.equal(requestMessages[0].kind, 'system'); assert.equal(requestMessages[0].systemType, 'summary'); assert.equal(requestMessages[0].text, '摘要');
  const merged = app.services.context.applyToRole(current, [current, other]);
  assert.match(merged.systemPrompt, /A 的设定/); assert.match(merged.systemPrompt, /B 的设定/);
});

test('all uncompressed timeline messages stay in context before the first compression', async () => {
  const { app } = await fixture();
  const messages = [
    { id: 'u1', kind: 'user', text: '用户一', status: 'done', createdAt: 1 },
    { id: 'a1', kind: 'assistant', roleId: 'a', text: 'A 一', status: 'done', createdAt: 2 },
    { id: 'b1', kind: 'assistant', roleId: 'b', text: 'B 一', status: 'done', createdAt: 3 },
    { id: 'u2', kind: 'user', text: '用户二', status: 'done', createdAt: 4 },
    { id: 'a2', kind: 'assistant', roleId: 'a', text: 'A 二', status: 'done', createdAt: 5 },
    { id: 'b2', kind: 'assistant', roleId: 'b', text: 'B 二', status: 'done', createdAt: 6 },
    { id: 'u3', kind: 'user', text: '用户三', status: 'done', createdAt: 7 }
  ];
  const settings = await app.data.store.get('meta', 'settings'); settings.autoCompress = true; settings.compressionThresholdChars = 100000;
  const prepared = await app.services.context.prepare({ id: 'c' }, { id: 'a', name: 'A' }, messages, settings, {});
  assert.equal(prepared.summary, null);
  assert.deepEqual(plain(prepared.recent.map(message => message.id)), ['u1', 'a1', 'b1', 'u2', 'a2', 'b2', 'u3']);
});

test('successive compression merges the previous summary and only advances through messages before the retention window', async () => {
  const { app } = await fixture(), requests = [];
  const make = index => ({ id: 'm' + String(index).padStart(2, '0'), conversationId: 'c', kind: index % 2 ? 'assistant' : 'user', roleId: index % 2 ? 'a' : '', roleName: index % 2 ? 'A' : '', status: 'done', text: '消息' + index + 'xxxxxx', createdAt: index + 1 });
  const messages = Array.from({ length: 10 }, (_, index) => make(index));
  const settings = await app.data.store.get('meta', 'settings'); settings.autoCompress = true; settings.compressionThresholdChars = 60; settings.compressionTargetChars = 20; settings.compressionRetainChars = 40;
  // 主持人 B 绑在另一个模型服务上：压缩必须用主持人的模型，而不是第一位参与角色的。
  await app.data.store.put('llm-profiles', 'p-moderator', { id: 'p-moderator', name: '主持人服务', model: 'moderator-fixture', endpoint: 'https://example.com/v1/responses', systemRoleMode: 'native', enabled: true });
  app.platform.network = { requestJson: async options => { requests.push(JSON.parse(options.bodyText)); return { data: { output_text: requests.length === 1 ? '概要一' : '概'.repeat(60) } }; } };
  const roles = [
    { id: 'a', name: 'A', systemPrompt: 'A 的角色介绍', llmProfileId: 'p' },
    { id: 'b', name: 'B', systemPrompt: 'B 的角色介绍', llmProfileId: 'p-moderator' }
  ];
  const conversation = { id: 'c', moderatorRoleId: 'b' };
  const first = await app.services.context.prepare(conversation, roles[0], messages, settings, roles, { name: '用户甲', introduction: '用户介绍' });
  const firstSummary = await app.services.context.compressionJob('c');
  assert.equal(first.summary, null); assert.equal(firstSummary.throughMessageId, 'm04'); assert.equal(firstSummary.sourceMessageCount, 5);
  assert.equal(firstSummary.compressedByRoleId, 'b'); assert.equal(firstSummary.compressionTargetChars, 20);
  assert.equal(requests[0].model, 'moderator-fixture');
  assert.match(requests[0].instructions, /不超过约 20 个中文字符/); assert.match(requests[0].instructions, /参与者资料仅用于辨认说话者/);
  assert.match(requests[0].instructions, /用户「用户甲」介绍：用户介绍/); assert.match(requests[0].instructions, /角色「A」介绍：A 的角色介绍/);
  assert.match(requests[0].instructions, /角色「B」介绍：B 的角色介绍/);
  assert.doesNotMatch(JSON.stringify(requests[0].input), /A 的角色介绍|B 的角色介绍|用户介绍/);
  const expanded = messages.concat(Array.from({ length: 4 }, (_, index) => make(index + 10)));
  const second = await app.services.context.prepare(conversation, roles[0], expanded, settings, roles, { name: '用户甲', introduction: '用户介绍' });
  // 本轮仍然用上一版概要：新概要要等后台任务写成。
  assert.equal(second.summary.throughMessageId, 'm04');
  const secondSummary = await app.services.context.compressionJob('c');
  assert.equal(secondSummary.throughMessageId, 'm08'); assert.equal(secondSummary.throughMessageCreatedAt, 9);
  assert.equal(secondSummary.sourceMessageCount, 9); assert.equal(secondSummary.retainedMessageCount, 5);
  // 概要正文按压缩目标截断：模型多写也不会让概要超出目标字数。
  assert.equal(secondSummary.text.length, 20); assert.match(secondSummary.text, /^概+$/);
  assert.match(JSON.stringify(requests[1].input), /已有压缩上下文.*概要一/); assert.match(JSON.stringify(requests[1].input), /消息5/); assert.doesNotMatch(JSON.stringify(requests[1].input), /消息4/);
  settings.compressionThresholdChars = 100000;
  const third = await app.services.context.prepare(conversation, roles[0], expanded, settings, roles, { name: '用户甲', introduction: '用户介绍' });
  assert.equal(third.summary.throughMessageId, 'm08');
  assert.deepEqual(plain(third.recent.map(message => message.id)), ['m09', 'm10', 'm11', 'm12', 'm13']);
  assert.deepEqual(Object.keys(await app.services.context.editable(expanded, 'c')), ['m09', 'm10', 'm11', 'm12', 'm13']);
});

test('an empty compression result never advances the summary boundary', async () => {
  const { app } = await fixture(), phases = [];
  const messages = Array.from({ length: 8 }, (_, index) => ({ id: 'm' + index, conversationId: 'c', kind: index % 2 ? 'assistant' : 'user', roleId: 'a', roleName: 'A', status: 'done', text: '消息' + index + 'xxxxxxxx', createdAt: index + 1 }));
  const settings = await app.data.store.get('meta', 'settings'); settings.autoCompress = true; settings.compressionThresholdChars = 1; settings.compressionTargetChars = 10; settings.compressionRetainChars = 20;
  app.events.on('chat:changed', event => { if (event.conversationId === 'c') phases.push(event.phase); });
  app.platform.network = { requestJson: async () => ({ data: { output_text: '   ' } }) };
  const prepared = await app.services.context.prepare({ id: 'c' }, { id: 'a', name: 'A', llmProfileId: 'p' }, messages, settings, [], {});
  assert.equal(prepared.summary, null);
  assert.equal(await app.services.context.compressionJob('c'), null);
  assert.deepEqual(phases, ['compressing', 'compress-failed']);
  assert.equal(await app.services.context.get('c'), null);
  // 失败只是背景任务的一次报错：历史一条都不能丢，边界也不能被推进。
  assert.deepEqual(Object.keys(await app.services.context.editable(messages, 'c')), messages.map(message => message.id));
});

test('automatic compression runs in the background so a reply never waits for it', async () => {
  const { app } = await fixture(), s = app.data.store;
  const conversation = await s.get('conversations', 'c');
  conversation.moderatorRoleId = 'b'; await s.put('conversations', 'c', conversation);
  const settings = await s.get('meta', 'settings');
  settings.autoCompress = true; settings.compressionThresholdChars = 1; settings.compressionTargetChars = 5; settings.compressionRetainChars = 20; await s.put('meta', 'settings', settings);
  const roles = await s.list('roles'), phases = [];
  app.events.on('chat:changed', event => { if (event.conversationId === 'c') phases.push(event.phase); });
  // 压缩请求一直挂着不返回，用来证明本轮回复不会等它。
  let release; const pending = new Promise(resolve => { release = resolve; });
  app.platform.network = {
    requestJson: async () => pending,
    requestSse: async options => { await options.onEvent({ data: '{"type":"response.output_text.delta","delta":"B 回复"}' }); await options.onEvent({ data: '{"type":"response.completed","response":{}}' }); }
  };
  const messages = Array.from({ length: 12 }, (_, index) => ({ id: 'm' + index, conversationId: 'c', kind: index % 2 ? 'assistant' : 'user', roleId: 'a', roleName: 'A', status: 'done', text: '消息' + index + 'xxxxxxxx', createdAt: index + 1 }));
  const reply = await app.services.llm.complete(roles.find(role => role.id === 'b'), messages, { cancelled: false }, conversation, roles, { name: '用户', introduction: '' });
  assert.match(reply.text, /B 回复/);
  assert.equal(reply.contextCompressed, false);
  assert.equal(await s.get('summaries', 'c'), null);
  assert.deepEqual(phases, ['compressing']);
  release({ data: { output_text: '迟到概要' } });
  const written = await app.services.context.compressionJob('c');
  assert.equal(written.text, '迟到概要'); assert.equal(written.compressedByRoleId, 'b');
  assert.equal((await s.get('summaries', 'c')).text, '迟到概要');
  assert.deepEqual(phases, ['compressing', 'compressed']);
});

test('schema migration initializes the moderator and auto-selection state, infers conversation type, drops the legacy retained-N field and removes legacy icon avatars', async () => {
  const { app } = await fixture(), s = app.data.store;
  const conversation = await s.get('conversations', 'c'); conversation.kind = 'group'; conversation.roleIds = ['a']; conversation.activeRoleIds = ['b', 'a']; conversation.recentFullMessages = 2; await s.put('conversations', 'c', conversation);
  const role = await s.get('roles', 'a'); role.avatarIcon = 'robot'; role.avatarColor = '#123456'; await s.put('roles', 'a', role);
  // 旧版把设置存成滑竿范围外的值，seed() 必须就地收进新界限。
  const before = await s.get('meta', 'settings'); before.compressionThresholdChars = 99999; before.compressionRetainChars = 99999; await s.put('meta', 'settings', before);
  // 绘图卡片的家族标识随插件由 CVP 更名为 CHP。老卡片上存的还是 cvp，必须一起搬过来：
  // 绘图家族只有一项，靠 family() 的第三层兜底看着还能用，但 providerId() 会退回
  // "custom"、sourceMode() 会从 local 掉成 official —— 表现是"卡片突然不算本地服务了"。
  await s.put('image-profiles', 'draw', {
    id: 'draw', name: '绘图', family: 'cvp', type: 'cvp', protocol: 'cvp', providerPresetId: 'cvp', discovery: 'cvp',
    endpoint: 'http://192.168.124.31:8189', model: 'render', enabled: true
  });
  await s.init();
  const migratedConversation = await s.get('conversations', 'c'), migratedRole = await s.get('roles', 'a');
  assert.equal(migratedConversation.kind, 'single');
  assert.equal(Object.hasOwn(migratedConversation, 'recentFullMessages'), false);
  assert.deepEqual(plain(migratedConversation.activeRoleIds), ['a']);
  assert.equal(migratedConversation.moderatorRoleId, 'a'); assert.equal(migratedConversation.autoSelectRole, false);
  assert.equal(migratedConversation.userName, ''); assert.equal(migratedConversation.userIntroduction, ''); assert.equal(migratedConversation.userAvatarMediaId, '');
  assert.equal(Object.hasOwn(migratedRole, 'avatarIcon'), false); assert.equal(Object.hasOwn(migratedRole, 'avatarColor'), false);
  const migratedSettings = await s.get('meta', 'settings');
  assert.equal(Object.hasOwn(migratedSettings, 'recentFullMessages'), false);
  assert.equal(migratedSettings.compressionThresholdChars, 32000);
  assert.equal(migratedSettings.compressionRetainChars, 10000);
  const renamedImage = await s.get('image-profiles', 'draw');
  for (const field of ['family', 'type', 'protocol', 'providerPresetId', 'discovery']) {
    assert.equal(renamedImage[field], 'chp', '绘图卡片的 ' + field + ' 要随插件一起搬到 CHP');
  }
  assert.equal(renamedImage.endpoint, 'http://192.168.124.31:8189', '改名不许动插件地址');
  assert.equal(renamedImage.model, 'render', '改名不许动已经选好的能力');
});

// 环境声滑竿的量程从 0~50 改回 0~100（用户 2026-09-26 收尾: "把当前的两个实际范围值都映射成为
// 滑竿的 0~100…现在环境音范围正好"）。刻度放大而天花板不动 ⇒ 存档旧值必须 ×2 才能保持同响度。
// 单独立一条测试, 因为风险不在"乘 2"本身, 而在**乘几次**: seed() 每次 init() 都跑, 少了那个一次性
// 标记就会越乘越大, 用不了几天滑竿自己顶到 100 并永远停在满档 —— 而现象完全不像"量程迁移"造成的。
// 同时钉住混响那一侧: 它的回归是靠重锚 WET_MAX 修的, 存档值必须**一点不动**。
test('the ambience slider is re-scaled to 0~100 exactly once, so an existing setting keeps its loudness', async () => {
  const { app } = await fixture(), s = app.data.store;
  const before = await s.get('meta', 'settings');
  before.ttsAmbienceMix = 20; before.ttsReverbMix = 50;
  delete before.ttsMixRange100;                 // 模拟"量程迁移还没跑过"的旧存档
  await s.put('meta', 'settings', before);
  await s.init();
  const once = await s.get('meta', 'settings');
  assert.equal(once.ttsAmbienceMix, 40, '20 on 0~50 must become 40 on 0~100: same scale position, same loudness');
  assert.equal(once.ttsReverbMix, 50, 'reverb is fixed by re-anchoring WET_MAX, so its stored value must not be touched');
  await s.init();
  await s.init();
  const thrice = await s.get('meta', 'settings');
  assert.equal(thrice.ttsAmbienceMix, 40, 'the one-shot flag must stop seed() from doubling the value on every boot');
});

test('schema migration keeps the moderator first in every conversation participant order', async () => {
  const { app } = await fixture(), s = app.data.store;
  const conversation = await s.get('conversations', 'c'); conversation.roleIds = ['a', 'b']; conversation.moderatorRoleId = 'b'; await s.put('conversations', 'c', conversation);
  await s.init();
  const migrated = await s.get('conversations', 'c');
  assert.equal(migrated.moderatorRoleId, 'b'); assert.deepEqual(plain(migrated.roleIds), ['b', 'a']);
});

test('model credentials are stored once by reference and hydrated without replacing the profile identity', async () => {
  const env = runtime(), { app, values } = env; await app.data.store.init();
  const saved = await app.data.store.put('llm-profiles', 'secure-model', {
    id: 'secure-model', family: 'openai', externalModelId: 'gpt-fixture', singleModelVersion: 1,
    apiKey: 'fixture-secret-value', customHeaders: '{"X-Test":"private"}', enabled: true
  });
  assert.ok(saved.credentialRef);
  const rawProfile = JSON.parse(values.get('chataxi.v1.llm-profiles.secure-model'));
  const rawCredential = JSON.parse(values.get('chataxi.v1.credentials.' + saved.credentialRef));
  assert.equal(rawProfile.apiKey, undefined); assert.equal(rawProfile.customHeaders, undefined);
  assert.equal(rawCredential.apiKey, 'fixture-secret-value'); assert.equal(rawCredential.customHeaders, '{"X-Test":"private"}');
  const hydrated = await app.data.store.get('llm-profiles', 'secure-model');
  assert.equal(hydrated.id, 'secure-model'); assert.equal(hydrated.apiKey, 'fixture-secret-value');
});

test('single-model cards share a credential reference and keep reusable directories outside each card', async () => {
  const env = runtime(), { app, values } = env; await app.data.store.init();
  const first = await app.data.store.put('llm-profiles', 'first', { id: 'first', family: 'openai', externalModelId: 'model-a', model: 'model-a', singleModelVersion: 1, models: [{ id: 'model-a' }], apiKey: 'fixture-shared', enabled: true });
  await app.data.store.saveModelDirectory('llm', first.id, [{ id: 'model-a' }, { id: 'model-b' }], []);
  const second = await app.data.store.put('llm-profiles', 'second', { id: 'second', family: 'openai', externalModelId: 'model-b', model: 'model-b', singleModelVersion: 1, models: [{ id: 'model-b' }], credentialRef: first.credentialRef, enabled: true });
  assert.equal(second.credentialRef, first.credentialRef); assert.equal((await app.data.store.get('llm-profiles', 'second')).apiKey, 'fixture-shared');
  assert.deepEqual(plain((await app.data.store.modelDirectory('first')).models.map(item => item.id)), ['model-a', 'model-b']);
  assert.equal(JSON.parse(values.get('chataxi.v1.llm-profiles.first')).models.length, 1); assert.equal(JSON.parse(values.get('chataxi.v1.llm-profiles.second')).models.length, 1);
  await app.data.store.remove('llm-profiles', 'first'); assert.ok(values.has('chataxi.v1.credentials.' + first.credentialRef));
  await app.data.store.remove('llm-profiles', 'second'); assert.equal(values.has('chataxi.v1.credentials.' + first.credentialRef), false);
});

test('legacy multi-model profiles migrate into stable single-model cards and remap role references', async () => {
  const env = runtime(), { app, values } = env;
  values.set('chataxi.v1.llm-profiles.legacy', JSON.stringify({
    id: 'legacy', family: 'openai', name: '旧服务', apiKey: 'fixture-key', endpoint: 'https://api.openai.com/v1/responses',
    modelsDiscovered: true, models: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }],
    enabledModelIds: ['model-a', 'model-b'], defaultModelId: 'model-a', enabled: true
  }));
  values.set('chataxi.v1.roles.role-b', JSON.stringify({ id: 'role-b', name: 'B', llmProfileId: 'legacy', model: 'model-b', enabled: true }));
  await app.data.store.init();
  const profiles = (await app.data.store.list('llm-profiles')).filter(item => item.sourceProfileId === 'legacy');
  assert.equal(profiles.length, 2); assert.ok(profiles.every(item => item.singleModelVersion === 1 && item.models.length === 1));
  assert.deepEqual(plain(profiles.map(item => item.externalModelId).sort()), ['model-a', 'model-b']);
  const role = await app.data.store.get('roles', 'role-b'), selected = await app.data.store.get('llm-profiles', role.llmProfileId);
  assert.equal(selected.externalModelId, 'model-b');
});

test('large provider model directories are stored outside the profile record and hydrate transparently', async () => {
  const { app } = await fixture(), models = Array.from({ length: 96 }, (_, index) => ({
    id: 'provider/model-' + index,
    name: 'Model ' + index,
    supportedParameters: ['temperature', 'max_tokens'],
    description: 'directory entry ' + index
  }));
  const profile = { id: 'large-directory', family: 'openrouter', name: 'Large', apiKey: 'fixture', models, enabledModelIds: models.map(item => item.id), enabled: true };
  await app.data.store.put('llm-profiles', profile.id, profile);
  const reloaded = await app.data.store.get('llm-profiles', profile.id);
  assert.equal(reloaded.models.length, 96);
  assert.equal(reloaded.models[95].id, 'provider/model-95');
  await app.data.store.remove('llm-profiles', profile.id);
  assert.equal(await app.data.store.get('llm-profiles', profile.id), null);
});

test('an interrupted language model stream is an error even after partial text', async () => {
  const { app } = await fixture();
  const role = await app.data.store.get('roles', 'a'), conversation = await app.data.store.get('conversations', 'c');
  app.platform.network = { requestSse: async options => {
    await options.onEvent({ data: '{"type":"response.output_text.delta","delta":"partial"}' });
  } };
  await assert.rejects(
    app.services.llm.complete(role, [], { cancelled: false, onDelta() {} }, conversation, [role]),
    /明确完成事件前中断/
  );
});

test('message editing is unrestricted before compression and frozen only inside the summary boundary', async () => {
  const { app } = await fixture(), s = app.data.store;
  const messages = Array.from({ length: 12 }, (_, index) => ({ id: 'm' + index, conversationId: 'c', kind: index % 2 ? 'assistant' : 'user', roleId: 'a', status: 'done', text: String(index), createdAt: index + 1 }));
  for (const message of messages) await s.putMessage(message);
  const before = await app.services.context.permissions(messages, 'c');
  assert.equal(before.compressed, false); assert.equal(Object.keys(before.editable).length, 12); assert.deepEqual(Object.keys(before.locked), []);
  await s.put('summaries', 'c', { id: 'c', conversationId: 'c', text: '摘要', throughMessageId: 'm5', throughCreatedAt: 6, updatedAt: 20 });
  const after = await app.services.context.permissions(messages, 'c');
  assert.equal(after.compressed, true);
  assert.deepEqual(Object.keys(after.locked), ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
  assert.deepEqual(Object.keys(after.editable), ['m6', 'm7', 'm8', 'm9', 'm10', 'm11']);
  // 冻结范围只由概要边界决定：改「固定携带最近 N 条」不会让已经压缩的消息换个样子，
  // permissions 只吃消息和对话 id，连 N 都不需要。
  assert.equal(app.services.context.permissions.length, 2);
  assert.deepEqual(Object.keys(await app.services.context.editable(messages, 'c')), ['m6', 'm7', 'm8', 'm9', 'm10', 'm11']);
});

test('the compression summary stays hand-editable without moving its boundary', async () => {
  const { app } = await fixture(), s = app.data.store;
  await s.put('summaries', 'c', { id: 'c', conversationId: 'c', text: '旧概要', throughMessageId: 'm5', throughMessageCreatedAt: 6, sourceMessageCount: 5, retainedMessageCount: 5, updatedAt: 20 });
  const updated = await app.services.context.updateSummaryText('c', '  新概要  ');
  assert.equal(updated.text, '新概要'); assert.ok(updated.editedAt > 0); assert.equal(updated.throughMessageId, 'm5'); assert.equal(updated.sourceMessageCount, 5);
  const reloaded = await app.services.context.get('c');
  assert.equal(reloaded.text, '新概要');
  // 改过的概要立刻参与下一次组装，替换掉边界之前的历史消息。
  const requestMessages = app.services.context.requestMessages({ summary: reloaded, recent: [] });
  assert.equal(requestMessages.length, 1); assert.equal(requestMessages[0].text, '新概要'); assert.equal(requestMessages[0].systemType, 'summary');
  await assert.rejects(app.services.context.updateSummaryText('c', '   '), /压缩概要不能为空/);
  assert.equal((await app.services.context.get('c')).text, '新概要');
  await assert.rejects(app.services.context.updateSummaryText('missing', '任意内容'), /还没有生成压缩概要/);
});

test('conversation mute suppresses future automatic readout without affecting generation', async () => {
  const { app } = await fixture(); let spoken = 0;
  app.state.activeConversationId = 'c';
  app.services.tts = { createStream: async () => null, prepare: async () => false, speak: async () => { spoken++; } };
  app.services.llm.complete = async () => result('需要朗读的回复');
  const conversation = await app.data.store.get('conversations', 'c'); conversation.autoSpeak = true; conversation.ttsMuted = true; await app.data.store.put('conversations', 'c', conversation);
  await app.features.chatSession.run('c', { text: '静音轮', roleIds: ['a'] }); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(spoken, 0);
  conversation.ttsMuted = false; await app.data.store.put('conversations', 'c', conversation);
  await app.features.chatSession.run('c', { text: '恢复轮', roleIds: ['a'] }); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(spoken, 1);
});

test('automatic readout always attempts the capability-driven stream before full-audio fallback', async () => {
  const { app } = await fixture(); let requested = 0, prepared = 0, spoken = 0;
  app.state.activeConversationId = 'c';
  app.services.tts = { createStream: async () => { requested++; return null; }, prepare: async () => { prepared++; return true; }, speak: async () => { spoken++; } };
  app.services.llm.complete = async () => result('完整回复后朗读');
  const conversation = await app.data.store.get('conversations', 'c'); conversation.autoSpeak = true; conversation.streamTtsPlayback = false; await app.data.store.put('conversations', 'c', conversation);
  await app.features.chatSession.run('c', { text: '请回答', roleIds: ['a'] }); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requested, 1); assert.equal(prepared, 0); assert.equal(spoken, 1);
});

test('automatic readout falls back once when a stream channel fails before returning audio', async () => {
  const { app } = await fixture(); let spoken = 0;
  app.state.activeConversationId = 'c';
  app.services.tts = { createStream: async () => ({ append() {}, finish: async () => { const error = Error('stream unavailable'); error.streamReceived = false; throw error; } }), speak: async () => { spoken++; }, stop: async () => {} };
  app.services.llm.complete = async () => result('仍应完整朗读');
  const conversation = await app.data.store.get('conversations', 'c'); conversation.autoSpeak = true; await app.data.store.put('conversations', 'c', conversation);
  await app.features.chatSession.run('c', { text: '请回答', roleIds: ['a'] });
  for (let i = 0; i < 100 && !spoken; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(spoken, 1);
});

test('automatic readout falls back when audio bytes arrived but playback never started', async () => {
  const { app } = await fixture(); let spoken = 0;
  app.state.activeConversationId = 'c';
  app.services.tts = { createStream: async () => ({ started: false, append() {}, finish: async () => { const error = Error('Software caused connection abort'); error.streamReceived = true; throw error; } }), speak: async () => { spoken++; }, stop: async () => {} };
  app.services.llm.complete = async () => result('仍应自动朗读');
  const conversation = await app.data.store.get('conversations', 'c'); conversation.autoSpeak = true; await app.data.store.put('conversations', 'c', conversation);
  await app.features.chatSession.run('c', { text: '请回答', roleIds: ['a'] });
  for (let i = 0; i < 100 && !spoken; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(spoken, 1);
});

test('muting before a reply completes suppresses its automatic full-audio fallback', async () => {
  const { app } = await fixture(); let muted = false, spoken = 0;
  app.state.activeConversationId = 'c';
  app.services.tts = {
    isMuted: () => muted,
    createStream: async () => ({ started: false, append() {}, finish: async () => { throw Error('stream unavailable'); } }),
    speak: async () => { spoken++; }, stop: async () => {}
  };
  app.services.llm.complete = async () => { muted = true; return result('静音后收到的回复'); };
  const conversation = await app.data.store.get('conversations', 'c'); conversation.autoSpeak = true; await app.data.store.put('conversations', 'c', conversation);
  await app.features.chatSession.run('c', { text: '请回答', roleIds: ['a'] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(spoken, 0);
});

test('one failed role keeps the user message and does not prevent the next role', async () => {
  const { app } = await fixture();
  app.services.llm.complete = async role => { if (role.id === 'a') throw Error('HTTP 503'); return result('B'); };
  await app.features.chatSession.run('c', { text: '问题' });
  assert.deepEqual(plain((await app.data.store.messages('c')).map(x => x.status)), ['done', 'error', 'done']);
  assert.equal(app.features.chatSession.active('c'), null);
});

test('retry replaces exactly the failed message and excludes all later history', async () => {
  const { app } = await fixture(), s = app.data.store;
  const original = [
    { id: 'u1', kind: 'user', text: '第一轮图片', media: [{ mediaId: 'original-image' }], status: 'done' },
    { id: 'a1', kind: 'assistant', roleId: 'a', text: '', status: 'error', error: 'failed' },
    { id: 'b1', kind: 'assistant', roleId: 'b', text: '后来角色的答复', status: 'done' },
    { id: 'u2', kind: 'user', text: '第二轮', status: 'done' }
  ];
  for (const [i, item] of original.entries()) await s.putMessage({ ...item, conversationId: 'c', createdAt: i + 1 });
  let seen;
  app.services.llm.complete = async (_, history) => { seen = plain(history); return result('重试成功'); };
  await app.features.chatSession.run('c', { retryId: 'a1' });
  assert.deepEqual(seen.map(x => x.id), ['u1']);
  assert.equal(seen[0].media[0].mediaId, 'original-image');
  const messages = await s.messages('c');
  assert.equal(messages.length, 4); assert.equal(messages[1].id, 'a1'); assert.equal(messages[1].text, '重试成功');
  assert.equal((await s.get('conversations', 'c')).lastMessage, '第二轮');
});

test('editing an earlier user message can remove later history and resume without duplicating it', async () => {
  const { app } = await fixture(), s = app.data.store;
  await s.putMessage({ id: 'u1', conversationId: 'c', kind: 'user', text: '旧问题', media: [], status: 'done', createdAt: 1 });
  await s.putMessage({ id: 'a1', conversationId: 'c', kind: 'assistant', roleId: 'a', roleName: 'A', text: '旧回答', media: [], status: 'done', createdAt: 2 });
  const edited = { ...(await s.messages('c'))[0], text: '新问题', editedAt: 3 };
  await s.putMessage(edited); await s.deleteMessagesAfter('c', edited.createdAt, false);
  app.services.llm.complete = async role => result(role.name + ' 新回答');
  await app.features.chatSession.run('c', { resumeUserId: 'u1', roleIds: ['a'] });
  const messages = await s.messages('c');
  assert.deepEqual(plain(messages.map(message => message.id === 'u1' ? message.text : message.roleId)), ['新问题', 'a']);
});

test('stop ends the current turn, skips remaining roles and ignores a late successful response', async () => {
  const { app } = await fixture(), started = deferred(), response = deferred(), calls = [];
  app.services.llm.complete = async role => { calls.push(role.id); started.resolve(); return response.promise; };
  const run = app.features.chatSession.run('c', { text: '问题' });
  await started.promise; app.features.chatSession.stop('c'); await run;
  assert.equal(app.features.chatSession.active('c'), null);
  assert.deepEqual(calls, ['a']);
  response.resolve(result('不应出现的迟到响应')); await new Promise(r => setTimeout(r, 0));
  const messages = await app.data.store.messages('c');
  assert.equal(messages.length, 2); assert.equal(messages[1].status, 'cancelled'); assert.equal(messages[1].text, '');
});

test('storage failure before accepting a user message preserves draft and always releases the turn lock', async () => {
  const env = await fixture(), { app } = env;
  await app.data.store.put('drafts', 'c', { id: 'c', text: '不要丢失', media: [] });
  env.fault((key) => { if (key.startsWith('chataxi.v1.messages.')) throw Error('storage full'); });
  await assert.rejects(app.features.chatSession.run('c', { text: '不要丢失' }), /storage full/);
  assert.equal((await app.data.store.get('drafts', 'c')).text, '不要丢失');
  assert.equal(app.features.chatSession.active('c'), null);
  env.fault(null); app.services.llm.complete = async () => result('恢复');
  await app.features.chatSession.run('c', { text: '恢复' });
  assert.equal((await app.data.store.messages('c')).length, 3);
});

test('failure while saving an answer leaves a retriable state and never a stuck busy flag', async () => {
  const env = await fixture(), { app } = env; let injected = false;
  app.services.llm.complete = async () => result('answer');
  env.fault((key, value) => { if (value && key.startsWith('chataxi.v1.messages.')) { const item = JSON.parse(value); if (!injected && item.kind === 'assistant' && item.status === 'done') { injected = true; throw Error('temporary storage failure'); } } });
  await assert.rejects(app.features.chatSession.run('c', { text: '问题' }), /storage failure/);
  assert.equal(app.features.chatSession.active('c'), null);
  assert.equal((await app.data.store.messages('c'))[1].status, 'error');
});

test('disabled model is rejected before consuming or clearing the draft', async () => {
  const { app } = await fixture(), s = app.data.store;
  const profile = await s.get('llm-profiles', 'p'); profile.enabled = false; await s.put('llm-profiles', 'p', profile);
  await assert.rejects(app.features.chatSession.run('c', { text: '问题' }), /已停用/);
  assert.equal((await s.messages('c')).length, 0);
});

test('long CJK and emoji replies round-trip under the Haminn record limit and clean old chunks', async () => {
  const env = runtime(), { app } = env, s = app.data.store; await s.init();
  const text = '中文🙂'.repeat(16000), message = { id: 'long', conversationId: 'c', createdAt: 1, kind: 'assistant', status: 'done', text };
  await s.putMessage(message);
  assert.equal((await s.messages('c'))[0].text, text);
  for (const value of env.values.values()) assert.ok(new TextEncoder().encode(value).length <= 63 * 1024);
  await s.putMessage({ ...message, text: 'short' });
  assert.equal((await s.messages('c'))[0].text, 'short');
  assert.equal((await s.list('message-text')).length, 0);
});

test('deleting a conversation releases its avatar and only unreferenced message media', async () => {
  const { app, removedMedia } = await fixture(), s = app.data.store;
  const conversation = await s.get('conversations', 'c'); conversation.userAvatarMediaId = 'conversation-avatar'; await s.put('conversations', 'c', conversation);
  await s.put('conversations', 'other', { id: 'other', roleIds: ['a'], userAvatarMediaId: 'shared-profile' });
  const globalProfile = await s.get('meta', 'user-profile'); globalProfile.avatarMediaId = 'global-avatar'; await s.put('meta', 'user-profile', globalProfile);
  await s.putMessage({ id: 'm1', conversationId: 'c', createdAt: 1, text: '', media: [{ mediaId: 'shared' }, { mediaId: 'shared-profile' }, { mediaId: 'global-avatar' }, { mediaId: 'private' }] });
  await s.put('drafts', 'other', { id: 'other', text: '', media: [{ mediaId: 'shared' }] });
  await s.deleteConversation('c');
  assert.deepEqual(removedMedia, ['conversation-avatar', 'private']);
});

test('deleting TTS resets default and role references, while LLM dependencies block deletion', async () => {
  const { app } = await fixture(), s = app.data.store;
  await s.put('tts-profiles', 'external', { id: 'external', type: 'openai', enabled: true });
  const settings = await s.get('meta', 'settings'); settings.defaultTtsProfileId = 'external'; await s.put('meta', 'settings', settings);
  const role = await s.get('roles', 'a'); role.ttsProfileId = 'external'; await s.put('roles', 'a', role);
  await assert.rejects(app.services.profiles.validateEnabled('tts', { id: 'external', type: 'openai', enabled: false }), /更换默认配置/);
  await assert.rejects(app.services.profiles.validateEnabled('llm', { id: 'p', type: 'openai', enabled: false }), /更换.*对话模型/);
  await app.services.profiles.remove('tts', 'external');
  assert.equal((await s.get('meta', 'settings')).defaultTtsProfileId, 'system-tts');
  assert.equal((await s.get('roles', 'a')).ttsProfileId, '');
  await assert.rejects(app.services.profiles.remove('llm', 'p'), /仍被/);
});

test('endpoint and header validation rejects credentials, fragments, transport overrides and newline injection', () => {
  const { app } = runtime();
  for (const value of ['javascript:alert(1)', 'https://user:pass@example.com/api', 'https://example.com/api#secret']) assert.throws(() => app.utils.validateEndpoint(value));
  for (const value of ['[]', '{"Host":"evil"}', '{"X-Test":"a\\r\\nb"}', '{"X-Test":{}}']) assert.throws(() => app.utils.parseHeaders(value));
  assert.equal(app.utils.validateEndpoint('http://192.168.1.2:4815/v1/responses'), 'http://192.168.1.2:4815/v1/responses');
});

test('native JSON requests decode streamed bytes regardless of a provider MIME or unknown length', async () => {
  const env = runtime(['app/platform/network.js']), { app } = env;
  const encoded = new TextEncoder().encode('{"data":[{"id":"glm-4-flash"}]}');
  let opened = 0, closed = 0, offset = 0;
  app.platform.haminn = {
    available: () => true,
    awaitReady: async () => true,
    api: () => ({ network: {
      openStream: async () => { opened++; return { streamId: 'json-stream', status: 200, headers: { 'content-type': 'application/octet-stream' }, contentType: 'application/octet-stream', url: 'https://example.com/models' }; },
      readStream: async () => {
        if (offset >= encoded.length) return { streamId: 'json-stream', chunkBase64: '', bytes: 0, done: true };
        const chunk = encoded.slice(offset, offset + 7); offset += chunk.length;
        return { streamId: 'json-stream', chunkBase64: btoa(String.fromCharCode(...chunk)), bytes: chunk.length, done: false };
      },
      closeStream: async () => { closed++; }
    } })
  };
  const response = await app.platform.network.requestJson({ url: 'https://example.com/models', method: 'GET' });
  assert.deepEqual(plain(response.data), { data: [{ id: 'glm-4-flash' }] });
  assert.equal(opened, 1); assert.equal(closed, 0);
});

test('browser ASR sets the actual multipart boundary in Content-Type', async () => {
  const env = runtime(['app/platform/network.js', 'app/services/asr.js']);
  let request;
  env.context.fetch = async (_, options) => { request = options; return { status: 200, url: 'https://example.com/asr', headers: { get: () => 'application/json', forEach() {} }, text: async () => '{"text":"识别文字"}' }; };
  const file = new Blob(['audio'], { type: 'audio/wav' }); file.name = 'sample.wav';
  const text = await env.app.services.asr.transcribeFile(file, { type: 'openai', endpoint: 'https://example.com/asr', model: 'fixture', enabled: true });
  assert.equal(text, '识别文字');
  assert.match(request.headers['Content-Type'], /^multipart\/form-data; boundary=----chataxi/);
  assert.match(new TextDecoder().decode(request.body), /name="file"; filename="sample.wav"/);
});

test('native ASR uploads the managed recording as multipart without loading it into JavaScript', async () => {
  const env = runtime(['app/services/asr.js']), { app } = env; let request;
  app.platform.network = {
    request: async options => { request = options; return { status: 200, bodyText: '{"text":"设备录音识别结果"}', headers: {} }; },
    readText: async result => result.bodyText,
    httpError: () => Error('unexpected HTTP error')
  };
  const text = await app.services.asr.transcribeFile(
    { logicalFileId: '57b0727a-2aca-4a39-8a1e-55e169fe2084', name: 'test.m4a', mime: 'audio/mp4' },
    { family: 'openai', endpoint: 'https://example.com/asr', model: 'whisper-1', language: 'zh', apiKey: 'fixture', enabled: true }
  );
  assert.equal(text, '设备录音识别结果'); assert.equal(request.bodyBytes, undefined);
  assert.deepEqual(plain(request.multipart), [
    { name: 'model', text: 'whisper-1' }, { name: 'language', text: 'zh' }, { name: 'response_format', text: 'json' },
    { name: 'file', logicalFileId: '57b0727a-2aca-4a39-8a1e-55e169fe2084', filename: 'test.m4a', contentType: 'audio/mp4' }
  ]);
});

test('ElevenLabs Scribe uses its native API key header and model_id multipart field', async () => {
  const env = runtime(['app/services/asr.js']), { app } = env; let request;
  app.platform.network = {
    request: async options => { request = options; return { status: 200, bodyText: '{"text":"Scribe 结果"}', headers: {} }; },
    readText: async result => result.bodyText,
    httpError: () => Error('unexpected HTTP error')
  };
  const text = await app.services.asr.transcribeFile(
    { logicalFileId: 'scribe-file', name: 'test.m4a', mime: 'audio/mp4' },
    { family: 'elevenlabs-asr', type: 'elevenlabs-asr', protocol: 'elevenlabs-scribe', endpoint: 'https://api.elevenlabs.io/v1/speech-to-text', model: 'scribe_v1', apiKey: 'fixture', enabled: true }
  );
  assert.equal(text, 'Scribe 结果'); assert.equal(request.headers['xi-api-key'], 'fixture'); assert.equal(request.headers.Authorization, undefined);
  assert.equal(request.multipart[0].name, 'model_id'); assert.equal(request.multipart[0].text, 'scribe_v1');
});

test('connection testing disables image tools and caps output', async () => {
  const env = runtime(); let request;
  env.app.platform.network = { requestJson: async options => { request = JSON.parse(options.bodyText); return { data: { output_text: 'OK' } }; } };
  await env.app.services.llm.test({ apiStyle: 'openai-responses', endpoint: 'https://example.com/v1/responses', model: 'fixture', allowImageGeneration: true, maxOutputTokens: 30000 });
  assert.equal(request.tools, undefined); assert.equal(request.max_output_tokens, 256);
});

test('stopping TTS while its network request is pending prevents late audio playback', async () => {
  const env = runtime(['app/services/tts.js']), { app } = env;
  await app.data.store.init();
  await app.data.store.put('tts-profiles', 'external', { id: 'external', type: 'openai', endpoint: 'https://example.com/tts', model: 'fixture', enabled: true });
  const started = deferred(), response = deferred(); let playback = 0;
  env.context.Audio = class { constructor() { playback++; } async play() {} pause() {} };
  app.platform.network = { request: async () => { started.resolve(); return response.promise; } };
  const speaking = app.services.tts.speak('文本', { ttsProfileId: 'external' });
  await started.promise; await app.services.tts.stop();
  response.resolve({ status: 200, bodyBase64: 'AA==', headers: {} }); await speaking;
  assert.equal(playback, 0);
});

test('an unlocked Web Audio context can autoplay a completed inline TTS response', async () => {
  const env = runtime(['app/services/tts.js']), { app } = env; await app.data.store.init();
  await app.data.store.put('tts-profiles', 'eleven', { id: 'eleven', family: 'elevenlabs', type: 'elevenlabs', apiKey: 'fixture', endpoint: 'https://api.elevenlabs.io/v1/text-to-speech/{voice}', model: 'eleven_v3', voice: 'jessica', models: [{ id: 'eleven_v3', streaming: true }], modelsDiscovered: true, enabledModelIds: ['eleven_v3'], voices: [{ id: 'jessica' }], enabled: true });
  const settings = await app.data.store.get('meta', 'settings'); settings.defaultTtsProfileId = 'eleven'; await app.data.store.put('meta', 'settings', settings);
  let audibleStarts = 0;
  class FakeAudioContext {
    constructor() { this.state = 'running'; this.destination = {}; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    createBuffer() { return {}; }
    createBufferSource() { return { connect() {}, start() { if (this.onended) { audibleStarts++; setTimeout(() => this.onended && this.onended(), 0); } }, stop() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    decodeAudioData(_bytes, done) { const decoded = {}; done(decoded); return Promise.resolve(decoded); }
  }
  env.context.window.AudioContext = FakeAudioContext;
  app.platform.network = { request: async () => ({ status: 200, bodyBase64: 'SUQzBAUG', headers: { 'content-type': 'audio/mpeg' } }) };
  assert.equal(app.services.tts.unlockPlayback(), true);
  await app.services.tts.speak('自动朗读', { ttsProfileId: 'eleven', ttsModel: 'eleven_v3', ttsVoice: 'jessica' });
  assert.equal(audibleStarts, 1);
});

test('backgrounding pauses active Web Audio immediately and foregrounding resumes it', async () => {
  const env = runtime(['app/services/tts.js']), { app } = env; await app.data.store.init();
  await app.data.store.put('tts-profiles', 'external', { id: 'external', family: 'openai-tts', type: 'openai', endpoint: 'https://example.com/tts', model: 'fixture', enabled: true });
  let audibleStarts = 0, suspends = 0, resumes = 0;
  class FakeAudioContext {
    constructor() { this.state = 'running'; this.destination = {}; }
    suspend() { suspends++; this.state = 'suspended'; return Promise.resolve(); }
    resume() { resumes++; this.state = 'running'; return Promise.resolve(); }
    createBuffer() { return {}; }
    createBufferSource() { return { buffer: null, connect() {}, start() { if (this.buffer && this.buffer.decoded) audibleStarts++; }, stop() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    decodeAudioData(_bytes, done) { const decoded = { decoded: true }; done(decoded); return Promise.resolve(decoded); }
  }
  env.context.window.AudioContext = FakeAudioContext;
  app.platform.network = { request: async () => ({ status: 200, bodyBase64: 'SUQzBAUG', headers: { 'content-type': 'audio/mpeg' } }) };
  assert.equal(app.services.tts.unlockPlayback(), true);
  const speaking = app.services.tts.speak('需要跨前后台继续朗读', { ttsProfileId: 'external' });
  for (let i = 0; i < 100 && !audibleStarts; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(audibleStarts, 1);
  assert.equal(await app.services.tts.pauseForBackground(), true); assert.equal(suspends, 1);
  assert.equal(await app.services.tts.resumeAfterBackground(), true); assert.equal(resumes, 1);
  await app.services.tts.stop(); await speaking;
});

test('backgrounding stops Android system TTS and foregrounding restarts it automatically', async () => {
  const env = runtime(['app/services/tts.js']), { app } = env; await app.data.store.init();
  const listeners = new Map(); let speaks = 0, stops = 0;
  app.platform.haminn.awaitReady = async () => true; app.platform.haminn.available = () => true;
  app.platform.haminn.on = (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); };
  app.platform.haminn.api = () => ({ tts: {
    voices: async () => ({ languages: ['zh-CN'], voices: [] }),
    speak: async () => ({ utteranceId: 'utterance-' + (++speaks) }),
    stop: async () => { stops++; }
  } });
  await app.services.tts.speak('系统朗读内容', {}); assert.equal(speaks, 1);
  assert.equal(await app.services.tts.pauseForBackground(), true); assert.equal(stops, 1); assert.equal(listeners.size, 0);
  assert.equal(await app.services.tts.resumeAfterBackground(), true);
  for (let i = 0; i < 100 && speaks < 2; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(speaks, 2);
  await app.services.tts.stop(); assert.equal(stops, 2);
});

test('backgrounding preserves prepared native audio and replays it on foreground without regenerating', async () => {
  const env = runtime(['app/services/tts.js']), { app } = env; await app.data.store.init();
  await app.data.store.put('tts-profiles', 'external', { id: 'external', family: 'openai-tts', type: 'openai', endpoint: 'https://example.com/tts', model: 'fixture', enabled: true });
  const listeners = new Map(); let requests = 0, plays = 0, stops = 0, deletes = 0;
  app.platform.network = { request: async () => { requests++; return { status: 200, file: { logicalFileId: 'prepared-audio' }, headers: {} }; } };
  app.platform.haminn.available = () => true;
  app.platform.haminn.on = (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); };
  app.platform.haminn.api = () => ({
    audio: { play: async () => ({ playbackId: 'playback-' + (++plays) }), stopPlayback: async () => { stops++; } },
    files: { delete: async () => { deletes++; } }
  });
  assert.equal(await app.services.tts.prepare('已生成的朗读', { ttsProfileId: 'external' }, 'message-ready'), true);
  // 宿主文件型 clip 不进缓存（0.7.22）: 那种音频只在 Web Audio 总线之外出声（没有混响）, 页面也取不回
  // 它的字节, 存下来只会是一条永远命中不了的死记录, 还要拖着宿主文件不放。缓存空着才是对的。
  assert.equal(await app.services.ttsCache.count(), 0);
  const firstPlayback = app.services.tts.playReady('message-ready');
  for (let i = 0; i < 100 && !plays; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(await app.services.tts.pauseForBackground(), true); assert.equal(stops, 1); assert.equal(deletes, 0);
  assert.equal(await app.services.tts.resumeAfterBackground(), true);
  for (let i = 0; i < 100 && plays < 2; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(requests, 1); assert.equal(plays, 2);
  await app.services.tts.stop(); await firstPlayback;
  assert.equal(stops, 2);
  // 停播时释放宿主文件 —— 没有任何缓存条目拥有它, 留着只会只增不减。
  assert.equal(deletes, 1);
  assert.equal(await app.services.ttsCache.clear(), true);
  assert.equal(deletes, 1, 'a second release would mean the clip was owned twice');
});

test('complete TTS falls back after a retryable audio stream aborts before playback starts', async () => {
  const env = runtime(['app/services/tts.js']), { app } = env; await app.data.store.init();
  await app.data.store.put('tts-profiles', 'openai-tts', { id: 'openai-tts', family: 'openai', type: 'openai', apiKey: 'fixture', endpoint: 'https://api.openai.com/v1/audio/speech', models: [{ id: 'tts-1', streaming: true, audioStreaming: true }], modelsDiscovered: true, enabledModelIds: ['tts-1'], voices: [{ id: 'alloy' }], enabled: true });
  let streamRequests = 0, completeRequests = 0, plays = 0;
  class FakeAudioContext {
    constructor() { this.state = 'running'; this.destination = {}; this.currentTime = 0; }
    resume() { return Promise.resolve(); }
    createBuffer(_channels, length, sampleRate) { const samples = new Float32Array(length); return { length, sampleRate, getChannelData: () => samples }; }
    createBufferSource() { return { buffer: null, connect() {}, start() { if (this.buffer && this.buffer.decoded) { plays++; setTimeout(() => this.onended && this.onended(), 0); } }, stop() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    decodeAudioData(_bytes, done) { const decoded = { decoded: true }; done(decoded); return Promise.resolve(decoded); }
  }
  env.context.window.AudioContext = FakeAudioContext; assert.equal(app.services.tts.unlockPlayback(), true);
  app.platform.network = {
    requestByteStream: async options => { streamRequests++; await options.onChunk(new Uint8Array(480)); const error = Error('Software caused connection abort'); error.code = 'E_NETWORK'; error.retryable = true; throw error; },
    request: async () => { completeRequests++; return { status: 200, bodyBase64: 'SUQzBAUG', headers: { 'content-type': 'audio/mpeg' } }; }
  };
  await app.services.tts.speak('自动朗读完整回复', { ttsProfileId: 'openai-tts', ttsModel: 'tts-1', ttsVoice: 'alloy' });
  // 两次字节流: 第一次是 speak() 的流式尝试（abort 时还没开声）, 第二次是整段合成回退时的那一次
  // —— 这条通道就是它现在唯一能拿到音频字节的地方, 所以这里必须是 2 而不是 1。
  assert.equal(streamRequests, 2); assert.equal(completeRequests, 1); assert.equal(plays, 1);
});

test('streaming TTS starts PCM playback before the HTTP response finishes', async () => {
  const env = runtime(['app/services/tts.js']), { app } = env; await app.data.store.init();
  await app.data.store.put('tts-profiles', 'openai-tts', { id: 'openai-tts', family: 'openai', type: 'openai', apiKey: 'fixture', endpoint: 'https://api.openai.com/v1/audio/speech', models: [{ id: 'tts-1', streaming: true, audioStreaming: true }], modelsDiscovered: true, enabledModelIds: ['tts-1'], voices: [{ id: 'alloy' }], enabled: true });
  const tail = deferred(), bodies = []; let audibleStarts = 0, responseFinished = false;
  installStreamingAudio(env, () => { audibleStarts++; });
  env.context.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body)); let reads = 0;
    return { status: 200, body: { getReader: () => ({ read: async () => { reads++; if (reads === 1) return { done: false, value: new Uint8Array(480) }; await tail.promise; responseFinished = true; return { done: true }; } }) } };
  };
  const stream = await app.services.tts.createStream({ ttsProfileId: 'openai-tts', ttsModel: 'tts-1', ttsVoice: 'alloy' }, 'message', { autoPlay: true, minBufferSeconds: 0.005 });
  stream.append('这是一个已经完整形成、应立即交给朗读服务的段落。\n');
  for (let i = 0; i < 100 && !audibleStarts; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(audibleStarts, 1); assert.equal(responseFinished, false); assert.equal(bodies[0].response_format, 'pcm');
  tail.resolve(); await stream.finish('这是一个已经完整形成、应立即交给朗读服务的段落。\n');
  assert.equal(app.services.tts.hasReady('message'), true);
  const requestsBeforeReplay = bodies.length;
  await app.services.tts.playReady('message');
  assert.equal(bodies.length, requestsBeforeReplay);
  assert.equal(app.services.tts.hasReady('message'), true);
  await app.services.tts.invalidate('message');
  assert.equal(app.services.tts.hasReady('message'), false);
});

test('streaming TTS pauses when playback catches generation and only resumes after user action', async () => {
  const env = runtime(['app/services/tts.js']), { app } = env; await app.data.store.init();
  await app.data.store.put('tts-profiles', 'openai-tts', { id: 'openai-tts', family: 'openai', type: 'openai', apiKey: 'fixture', endpoint: 'https://api.openai.com/v1/audio/speech', models: [{ id: 'tts-1', streaming: true, audioStreaming: true }], modelsDiscovered: true, enabledModelIds: ['tts-1'], voices: [{ id: 'alloy' }], enabled: true });
  const states = [], bodies = []; let plays = 0;
  app.events.on('tts:state', state => states.push(state));
  installStreamingAudio(env, () => { plays++; });
  env.context.fetch = async (_url, options) => { bodies.push(JSON.parse(options.body)); let read = false; return { status: 200, body: { getReader: () => ({ read: async () => read ? { done: true } : (read = true, { done: false, value: new Uint8Array(480) }) }) } }; };
  const waitFor = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 1)); assert.ok(predicate()); };
  const stream = await app.services.tts.createStream({ ttsProfileId: 'openai-tts', ttsModel: 'tts-1', ttsVoice: 'alloy' }, 'message', { autoPlay: true, minBufferSeconds: 0.005 });
  stream.append('第一段。\n'); await waitFor(() => states.some(state => state.paused));
  stream.append('第二段。\n'); await waitFor(() => bodies.length === 2 && app.services.tts.canResume('message'));
  assert.equal(plays, 1); assert.equal(app.services.tts.canResume('message'), true);
  await app.services.tts.resume('message'); assert.equal(plays, 2);
  await stream.finish('第一段。\n第二段。\n'); assert.equal(app.services.tts.canResume('message'), false);
});

test('Eleven v3 streams completed language-model paragraphs over its dialogue WebSocket', async () => {
  const env = runtime(['app/platform/network.js', 'app/services/tts.js']), { app } = env; await app.data.store.init();
  await app.data.store.put('tts-profiles', 'eleven', { id: 'eleven', family: 'elevenlabs', type: 'elevenlabs', apiKey: 'fixture', endpoint: 'https://api.elevenlabs.io/v1/text-to-speech/{voice}', model: 'eleven_v3', models: [{ id: 'eleven_v3', streaming: true, audioStreaming: true, textStreaming: true }], modelsDiscovered: true, enabledModelIds: ['eleven_v3'], voices: [{ id: 'jane' }], enabled: true });
  const frames = []; let socketUrl = '', plays = 0;
  installStreamingAudio(env, () => { plays++; });
  env.context.WebSocket = class {
    constructor(url) { socketUrl = url; setTimeout(() => this.onopen && this.onopen(), 0); }
    send(raw) { const frame = JSON.parse(raw); frames.push(frame); if (frame.inputs) setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ audio: 'AAAAAA==' }) }), 0); if (frame.close_socket) setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ is_final: true }) }), 0); }
    close() {}
  };
  const text = '这是语言模型刚刚完成的第一段文字，会立刻持续提交给 Eleven v3。\n';
  const stream = await app.services.tts.createStream({ ttsProfileId: 'eleven', ttsModel: 'eleven_v3', ttsVoice: 'jane' }, 'message', { autoPlay: true, minBufferSeconds: 0 });
  stream.append(text); await stream.finish(text);
  assert.match(socketUrl, /\/v1\/text-to-dialogue\/stream-input\?model_id=eleven_v3/);
  assert.deepEqual(frames[0].voices, ['jane']); assert.equal(frames[1].inputs[0].text, text.trim()); assert.equal(frames.at(-1).close_socket, true); assert.equal(plays, 1);
});

test('Eleven non-v3 models use the realtime Text-to-Speech WebSocket', async () => {
  const env = runtime(['app/platform/network.js', 'app/services/tts.js']), { app } = env; await app.data.store.init();
  await app.data.store.put('tts-profiles', 'eleven', { id: 'eleven', family: 'elevenlabs', type: 'elevenlabs', apiKey: 'fixture', endpoint: 'https://api.elevenlabs.io/v1/text-to-speech/{voice}', model: 'eleven_flash_v2_5', models: [{ id: 'eleven_flash_v2_5', streaming: true, audioStreaming: true, textStreaming: true }], modelsDiscovered: true, enabledModelIds: ['eleven_flash_v2_5'], voices: [{ id: 'lulu' }], enabled: true });
  const frames = []; let socketUrl = '', plays = 0;
  installStreamingAudio(env, () => { plays++; });
  env.context.WebSocket = class {
    constructor(url) { socketUrl = url; setTimeout(() => this.onopen && this.onopen(), 0); }
    send(raw) { const frame = JSON.parse(raw); frames.push(frame); if (frame.text && frame.text.trim()) setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ audio: 'AAAAAA==' }) }), 0); if (frame.text === '') setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ isFinal: true }) }), 0); }
    close() {}
  };
  const text = '这是一个已经完成的段落，会进入实时文字转语音连接。\n';
  const stream = await app.services.tts.createStream({ ttsProfileId: 'eleven', ttsModel: 'eleven_flash_v2_5', ttsVoice: 'lulu' }, 'message', { autoPlay: true, minBufferSeconds: 0 });
  stream.append(text); await stream.finish(text);
  assert.match(socketUrl, /\/v1\/text-to-speech\/lulu\/stream-input\?model_id=eleven_flash_v2_5/);
  assert.equal(frames[0].text, ' '); assert.equal(frames[0].xi_api_key, 'fixture'); assert.equal(frames[1].text, text.trim() + ' '); assert.equal(frames.at(-1).text, ''); assert.equal(plays, 1);
});

test('xAI TTS sends incremental text over an authorized native WebSocket and receives PCM deltas', async () => {
  const env = runtime(['app/services/tts.js']), { app } = env; await app.data.store.init();
  await app.data.store.put('tts-profiles', 'xai', { id: 'xai', family: 'xai-tts', type: 'xai-tts', protocol: 'xai-tts', apiKey: 'fixture', endpoint: 'https://api.x.ai/v1/tts', models: [{ id: 'xai-tts', streaming: true, audioStreaming: true, textStreaming: true }], modelsDiscovered: true, enabledModelIds: ['xai-tts'], voices: [{ id: 'eve' }], enabled: true });
  const wire = fakeSocket((frame, push) => { if (frame.type === 'text.done') { push({ type: 'text', text: JSON.stringify({ type: 'audio.delta', delta: 'AAAAAA==' }) }); push({ type: 'text', text: JSON.stringify({ type: 'audio.done' }) }); } });
  let opened; app.platform.network = { openWebSocket: async options => { opened = options; return wire.session; } }; let plays = 0; installStreamingAudio(env, () => { plays++; });
  const text = '第一段完成后立即合成。\n', stream = await app.services.tts.createStream({ ttsProfileId: 'xai', ttsModel: 'xai-tts', ttsVoice: 'eve' }, 'xai-message', { autoPlay: true, minBufferSeconds: 0 });
  stream.append(text); await stream.finish(text);
  assert.equal(opened.headers.Authorization, 'Bearer fixture'); assert.match(opened.url, /^wss:\/\/api\.x\.ai\/v1\/tts/); assert.equal(wire.frames[0].type, 'text.delta'); assert.equal(wire.frames.at(-1).type, 'text.done'); assert.equal(plays, 1);
});

test('Qwen realtime TTS commits each completed paragraph and closes only after session.finished', async () => {
  const env = runtime(['app/services/tts.js']), { app } = env; await app.data.store.init();
  await app.data.store.put('tts-profiles', 'qwen', { id: 'qwen', family: 'qwen-tts', type: 'qwen-tts', protocol: 'qwen-tts', apiKey: 'fixture', endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', models: [{ id: 'qwen3-tts-flash-realtime', streaming: true, audioStreaming: true, textStreaming: true }], modelsDiscovered: true, enabledModelIds: ['qwen3-tts-flash-realtime'], voices: [{ id: 'Cherry' }], enabled: true });
  const wire = fakeSocket((frame, push) => {
    if (frame.type === 'input_text_buffer.commit') { push({ type: 'text', text: JSON.stringify({ type: 'response.audio.delta', delta: 'AAAAAA==' }) }); push({ type: 'text', text: JSON.stringify({ type: 'response.done' }) }); }
    if (frame.type === 'session.finish') push({ type: 'text', text: JSON.stringify({ type: 'session.finished' }) });
  });
  let opened; app.platform.network = { openWebSocket: async options => { opened = options; return wire.session; } }; let plays = 0; installStreamingAudio(env, () => { plays++; });
  const text = '第一段已经完整。\n', stream = await app.services.tts.createStream({ ttsProfileId: 'qwen', ttsModel: 'qwen3-tts-flash-realtime', ttsVoice: 'Cherry' }, 'qwen-message', { autoPlay: true, minBufferSeconds: 0 });
  stream.append(text); await stream.finish(text);
  assert.equal(opened.headers.Authorization, 'Bearer fixture'); assert.match(opened.url, /wss:\/\/dashscope\.aliyuncs\.com\/api-ws\/v1\/realtime\?model=qwen3-tts-flash-realtime/); assert.equal(wire.frames[0].session.mode, 'commit'); assert.ok(wire.frames.some(frame => frame.type === 'input_text_buffer.append')); assert.ok(wire.frames.some(frame => frame.type === 'input_text_buffer.commit')); assert.equal(wire.frames.at(-1).type, 'session.finish'); assert.equal(plays, 1);
});

test('ASR cancel removes event listeners and ignores events from a cancelled session', async () => {
  const env = runtime(['app/services/asr.js']), { app } = env;
  const listeners = new Map(); let transcripts = 0;
  app.platform.haminn.awaitReady = async () => true; app.platform.haminn.available = () => true;
  app.platform.haminn.on = (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); };
  app.platform.haminn.api = () => ({ speech: { availability: async () => ({ available: true }), start: async () => ({ subscriptionId: 'speech-1' }), cancel: async () => {}, stop: async () => {} } });
  await app.services.asr.startSystem({}, { final() { transcripts++; } });
  const lateFinal = listeners.get('speech.final');
  await app.services.asr.cancelSystem(); lateFinal({ alternatives: [{ text: 'late' }] });
  assert.equal(transcripts, 0); assert.equal(listeners.size, 0);
});

test('system ASR requests RMS events and forwards real microphone levels to the test UI', async () => {
  const env = runtime(['app/services/asr.js']), { app } = env; const listeners = new Map(); let startParams, level;
  app.platform.haminn.awaitReady = async () => true; app.platform.haminn.available = () => true;
  app.platform.haminn.on = (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); };
  app.platform.haminn.api = () => ({ speech: {
    availability: async () => ({ available: true, rmsEventsSupported: true }),
    start: async params => { startParams = params; return { subscriptionId: 'speech-rms' }; }, cancel: async () => {}, stop: async () => {}
  } });
  await app.services.asr.startSystem({ language: 'zh-CN' }, { rms(data) { level = data.rmsDb; } });
  listeners.get('speech.rms')({ subscriptionId: 'speech-rms', rmsDb: -7.5 });
  assert.equal(startParams.rmsEvents, true); assert.equal(level, -7.5);
  await app.services.asr.cancelSystem();
});

test('system ASR only sends a language returned by the current recognition provider', async () => {
  const env = runtime(['app/services/asr.js']), { app } = env; const listeners = new Map(), starts = [];
  app.platform.haminn.awaitReady = async () => true; app.platform.haminn.available = () => true;
  app.platform.haminn.on = (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); };
  app.platform.haminn.api = () => ({ speech: {
    availability: async () => ({ available: true, streamingAvailable: true }),
    languages: async () => ({ languageSelectionSupported: true, languages: ['en-US'], preferredLanguage: 'en-US' }),
    start: async params => { starts.push(params); return { subscriptionId: 'speech-language-' + starts.length }; }, cancel: async () => {}, stop: async () => {}
  } });
  await app.services.asr.startSystem({ language: 'zh-CN' }, {}); await app.services.asr.cancelSystem();
  await app.services.asr.startSystem({ language: 'en-US' }, {}); await app.services.asr.cancelSystem();
  assert.equal('language' in starts[0], false); assert.equal(starts[1].language, 'en-US');
});

test('ASR cancellation during capability lookup prevents a later microphone start', async () => {
  const env = runtime(['app/services/asr.js']), { app } = env, availability = deferred(), reached = deferred(); let starts = 0;
  app.platform.haminn.awaitReady = async () => true; app.platform.haminn.available = () => true;
  app.platform.haminn.api = () => ({ speech: { availability: async () => { reached.resolve(); return availability.promise; }, start: async () => { starts++; return { subscriptionId: 'late' }; }, cancel: async () => {} } });
  const starting = app.services.asr.startSystem({}, {});
  await reached.promise; await app.services.asr.cancelSystem(); availability.resolve({ available: true });
  await assert.rejects(starting, /已取消/); assert.equal(starts, 0);
});

// 朗读音频缓存（用户 2026-09-26）: "相同的文本、相同的模型、相同的音色每次生成的音频文件都是一样的…
// 每次要进行朗读的任务前, 都检查一下 hash 是否存在, 如果存在则直接使用已有的音频文件"。
test('speech audio is cached by request digest, so the same line is only synthesized once', async () => {
  const env = runtime(['app/services/tts.js']), { app } = env; await app.data.store.init();
  // 这个装置默认把媒体库打成"不许存", 换成能存能取的, 才能同时验证"音频本体在媒体库、记录里只有句柄"。
  const media = new Map();
  app.data.media = {
    put: async (blob, meta) => { media.set(meta.id, { id: meta.id, blob, mime: blob.type || meta.mime }); return { id: meta.id }; },
    get: async (id) => media.get(id) || null,
    remove: async (id) => { media.delete(id); }
  };
  await app.data.store.put('tts-profiles', 'external', { id: 'external', type: 'openai', endpoint: 'https://example.com/tts', model: 'fixture', voice: 'v1', voices: [{ id: 'v1' }], defaultVoiceId: 'v1', enabled: true });
  let requests = 0;
  app.platform.network = { request: async () => { requests++; return { status: 200, bodyBase64: 'AA==', headers: { 'content-type': 'audio/mpeg' } }; } };
  const service = await app.data.store.get('tts-profiles', 'external');
  await app.services.tts.testService(service);
  assert.equal(requests, 1);
  await app.services.tts.testService(service);
  assert.equal(requests, 1); // 第二次必须命中缓存, 不再打接口
  assert.equal(await app.services.ttsCache.count(), 1);
  // 记录里只应该有文件句柄, 音频本体在媒体库里。
  const record = await app.data.store.get('tts-cache', (await app.data.store.list('tts-cache'))[0].hash);
  assert.equal(record.kind, 'media');
  assert.ok(record.mediaId); assert.equal(record.blob, undefined);
  assert.equal(media.size, 1);
  // 换音色 = 换请求体 = 换键 ⇒ 必须重新合成, 不能拿上一段的音频顶替。
  await app.services.tts.testService(Object.assign({}, service, { voice: 'v2', defaultVoiceId: 'v2', voices: [{ id: 'v2' }] }));
  assert.equal(requests, 2);
  assert.equal(await app.services.ttsCache.count(), 2);
});

// 混响只挂在 Web Audio 总线上, 而宿主播放器（api.audio.play）是在 WebView 之外出声的 —— 音频根本不进
// AudioContext, 混响器与环境声都挂不上去。宿主对**没有 Content-Length 的响应**（chunked ——
// ElevenLabs / OpenAI 这类 TTS 一律如此, NativeHttpClient.request: declaredLength < 0）一律落成宿主
// 文件, 那种 clip 只能交给宿主播放器 ⇒ 那条路上永远没有混响（业主 2026-09-26: "我把混响效果拉到 100
// 仍然没有混响效果, 之前是有的啊"）。页面按同源 url 去 fetch 也不行: happ 的 CSP 是 connect-src 'none'
// （liveUrl 为空的实例走这一支, 见 LocalContentGateway.headers）, fetch 被直接拦掉。
// 所以整段合成改走原生字节流（openStream/readStream, 流式朗读一直在用的那条通道）: 字节回到页面
// ⇒ Blob ⇒ 带混响的解码路。这条测试钉住: 不再走 network.request、真走了 Web Audio 解码、落点是总线
// input 而不是 destination、缓存里存的是媒体型条目。
test('a non-SSE speech response is streamed back as bytes so it plays through the reverb bus', async () => {
  const env = runtime(['app/services/tts.js']), { app } = env; await app.data.store.init();
  const media = new Map();
  app.data.media = {
    put: async (blob, meta) => { media.set(meta.id, { id: meta.id, blob, mime: blob.type || meta.mime }); return { id: meta.id }; },
    get: async (id) => media.get(id) || null,
    remove: async (id) => { media.delete(id); }
  };
  await app.data.store.put('tts-profiles', 'external', { id: 'external', type: 'openai', endpoint: 'https://example.com/tts', model: 'fixture', voice: 'v1', voices: [{ id: 'v1' }], defaultVoiceId: 'v1', enabled: true });
  // 环境声关掉只是为了让用例快: 它要现场合成两段 16 秒级的噪声, 与这条断言无关。
  const settings = await app.data.store.get('meta', 'settings'); settings.ttsAmbienceMix = 0; await app.data.store.put('meta', 'settings', settings);
  let completes = 0, streamed = 0;
  app.platform.network = {
    request: async () => { completes++; return { status: 200, headers: {}, file: { logicalFileId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', url: '/__haminn/files/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', mime: 'audio/mpeg' } }; },
    requestByteStream: async options => { streamed++; await options.onChunk(new Uint8Array([73, 68, 51, 4, 0, 0])); await options.onChunk(new Uint8Array(42)); return { status: 200, headers: { 'content-type': 'audio/mpeg' }, contentType: 'audio/mpeg', url: options.url }; }
  };
  app.platform.haminn.available = () => true;
  const nodes = [], contexts = [];
  function makeNode(kind) { const node = { kind, targets: [], connect(target) { this.targets.push(target); } }; nodes.push(node); return node; }
  class FakeAudioContext {
    constructor() { this.state = 'running'; this.destination = { kind: 'destination' }; this.currentTime = 0; this.sampleRate = 24000; contexts.push(this); }
    resume() { this.state = 'running'; return Promise.resolve(); }
    createBuffer(channels, length, rate) { const planes = Array.from({ length: channels }, () => new Float32Array(length)); return { length, sampleRate: rate, numberOfChannels: channels, getChannelData: index => planes[index] }; }
    createGain() { const node = makeNode('gain'); node.gain = { value: 1, setTargetAtTime() {}, cancelScheduledValues() {} }; return node; }
    createBiquadFilter() { const node = makeNode('biquad'); node.frequency = { value: 0, setTargetAtTime() {} }; node.Q = { value: 0 }; node.gain = { value: 0 }; return node; }
    createConvolver() { const node = makeNode('convolver'); node.buffer = null; return node; }
    createDynamicsCompressor() { const node = makeNode('compressor'); for (const key of ['threshold', 'knee', 'ratio', 'attack', 'release']) node[key] = { value: 0 }; return node; }
    createBufferSource() { const node = makeNode('source'); node.buffer = null; node.loop = false; node.start = function () { setTimeout(() => node.onended && node.onended(), 0); }; node.stop = function () {}; return node; }
    decodeAudioData(_bytes, done) { const decoded = { decoded: true }; done(decoded); return Promise.resolve(decoded); }
  }
  env.context.window.AudioContext = FakeAudioContext;
  assert.equal(app.services.tts.unlockPlayback(), true);
  await app.services.tts.speak('字节流朗读', { ttsProfileId: 'external' });
  assert.equal(streamed, 1, 'binary speech must be read through the native byte stream');
  assert.equal(completes, 0, 'network.request lets the host spill a chunked body into a file, and that clip can only play outside the reverb bus');
  // unlockPlayback() 会起一个 1 采样的静默音源; 只有解出来的那段才带 decoded 标记。
  const audible = nodes.filter(node => node.kind === 'source' && node.buffer && node.buffer.decoded);
  assert.equal(audible.length, 1, 'the streamed bytes must be decoded through Web Audio: that is the only path carrying the reverb');
  const gain = audible[0].targets[0];
  assert.ok(gain && gain.kind === 'gain', 'the decoded clip must be wired through its own gain before it starts');
  assert.notEqual(gain.targets[0], contexts[0].destination, 'the clip must land on the reverb bus input, not straight on destination');
  const record = await app.data.store.get('tts-cache', (await app.data.store.list('tts-cache'))[0].hash);
  assert.equal(record.kind, 'media', 'the cache must hold the audio body, not a host file handle');
  assert.ok(record.mediaId); assert.equal(record.logicalFileId, undefined);
});

// 旧宿主没有 openStream/readStream 时不能把朗读弄丢: 退回老的 network.request 流程, 那条路只是没有混响。
// 顺带钉住"宿主文件型 clip 不进缓存": 存了也永远命中不了, 还要拖着宿主文件不放; 返回 false 之后
// disposeClip 在播完就把它删掉。这一条同时是老爷机上的回归保险。
test('a host without the byte stream still speaks through the old request path, and releases the host file', async () => {
  const env = runtime(['app/services/tts.js']), { app } = env; await app.data.store.init();
  const fileId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  await app.data.store.put('tts-profiles', 'external', { id: 'external', type: 'openai', endpoint: 'https://example.com/tts', model: 'fixture', voice: 'v1', voices: [{ id: 'v1' }], defaultVoiceId: 'v1', enabled: true });
  const settings = await app.data.store.get('meta', 'settings'); settings.ttsAmbienceMix = 0; await app.data.store.put('meta', 'settings', settings);
  let completes = 0, nativePlays = 0, deleted = 0;
  app.platform.network = {
    requestByteStream: async () => { const error = Error('当前 HaminnApp 尚未提供流式网络能力，请更新宿主'); error.streamUnavailable = true; throw error; },
    request: async () => { completes++; return { status: 200, headers: {}, file: { logicalFileId: fileId, url: '/__haminn/files/' + fileId, mime: 'audio/mpeg' } }; }
  };
  const listeners = {};
  app.platform.haminn = {
    awaitReady: async () => true, available: () => true,
    on: (event, handler) => { listeners[event] = handler; return () => { delete listeners[event]; }; },
    api: () => ({
      files: { delete: async () => { deleted++; } },
      audio: { play: async () => { nativePlays++; const playbackId = 'p1'; setTimeout(() => { const done = listeners['audio.playback.done']; if (done) done({ playbackId: playbackId }); }, 0); return { playbackId: playbackId }; }, stopPlayback: async () => {} }
    })
  };
  await app.services.tts.speak('老宿主', { ttsProfileId: 'external' });
  assert.equal(completes, 1, 'the old flow must still run when the host reports no byte-stream capability');
  assert.equal(nativePlays, 1, 'the legacy host file is played by the host player, exactly as before');
  assert.equal(await app.services.ttsCache.count(), 0, 'a host-file clip can never be a usable hit: it must not take a cache slot');
  assert.equal(deleted, 1, 'and with no cache owning it, the host file must be released right after playback');
});


// 缓存必须覆盖**流式**那条路（用户 2026-09-26 追加: "缓存好像没有生效啊, 我在反复点同一个对话内容的
// 朗读按钮, 正常情况应该立即播放无需等待啊, 播放缓存的才对"）。原来缓存只挂在整段合成那条路上,
// 而支持流式音频的服务**永远**走流式分支 —— 那条路既不查也不写, 于是每点一次都重新生成一次,
// 从头到尾一次都不会命中。这条测试就钉住这一点。
test('streamed speech is written back to the cache so the next request is a hit', async () => {
  const env = runtime(['app/services/tts.js']), { app } = env; await app.data.store.init();
  const media = new Map();
  app.data.media = {
    put: async (blob, meta) => { media.set(meta.id, { id: meta.id, blob, mime: blob.type }); return { id: meta.id }; },
    get: async (id) => media.get(id) || null,
    remove: async (id) => { media.delete(id); }
  };
  await app.data.store.put('tts-profiles', 'openai-tts', { id: 'openai-tts', family: 'openai', type: 'openai', apiKey: 'fixture', endpoint: 'https://api.openai.com/v1/audio/speech', models: [{ id: 'tts-1', streaming: true, audioStreaming: true }], modelsDiscovered: true, enabledModelIds: ['tts-1'], voices: [{ id: 'alloy' }], enabled: true });
  let streamRequests = 0, completeRequests = 0, plays = 0;
  class FakeAudioContext {
    constructor() { this.state = 'running'; this.destination = {}; this.currentTime = 0; }
    resume() { return Promise.resolve(); }
    createBuffer(_channels, length, sampleRate) { const samples = new Float32Array(length); return { length, sampleRate, getChannelData: () => samples }; }
    // 只数真正出声的音源: unlockPlayback() 会起一个 1 采样的静默音源, 把它算进来就会多 1。
    createBufferSource() { return { buffer: null, connect() {}, start() { if (this.buffer && (this.buffer.length > 1 || this.buffer.decoded)) plays++; setTimeout(() => this.onended && this.onended(), 0); }, stop() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    decodeAudioData(_bytes, done) { const decoded = { decoded: true }; done(decoded); return Promise.resolve(decoded); }
  }
  env.context.window.AudioContext = FakeAudioContext; assert.equal(app.services.tts.unlockPlayback(), true);
  app.platform.network = {
    requestByteStream: async options => { streamRequests++; await options.onChunk(new Uint8Array(960)); await options.onChunk(new Uint8Array(960)); },
    request: async () => { completeRequests++; return { status: 200, bodyBase64: 'SUQzBAUG', headers: { 'content-type': 'audio/mpeg' } }; }
  };
  const role = { ttsProfileId: 'openai-tts', ttsModel: 'tts-1', ttsVoice: 'alloy' };
  await app.services.tts.speak('反复朗读同一句', role);
  assert.equal(streamRequests, 1); assert.equal(completeRequests, 0); assert.equal(plays, 2);
  assert.equal(await app.services.ttsCache.count(), 1); // 流式音频必须回写进缓存
  const stored = [...media.values()][0];
  assert.equal(stored.blob.type, 'audio/wav'); // 裸 PCM 要套一个 decodeAudioData 认得的容器
  assert.equal(stored.blob.size, 44 + 1920);
  await app.services.tts.speak('反复朗读同一句', role);
  assert.equal(streamRequests, 1); // 第二次必须命中缓存, 不再打接口
  assert.equal(completeRequests, 0);
  assert.equal(plays, 3); // 命中之后仍走既有那条解码播放路径, 不另开一条播放链
});

test('the speech cache keeps the 100 most recent clips and releases both halves when it evicts', async () => {
  const env = runtime([]), { app } = env; await app.data.store.init();
  const media = new Map();
  app.data.media = {
    put: async (blob, meta) => { media.set(meta.id, { id: meta.id, blob }); return { id: meta.id }; },
    get: async (id) => media.get(id) || null,
    remove: async (id) => { media.delete(id); }
  };
  for (let i = 0; i < 105; i++) await app.services.ttsCache.store('k' + i, { blob: new Blob(['a']), mime: 'audio/mpeg' }, { chars: 1 });
  assert.equal(await app.services.ttsCache.count(), 100);
  assert.equal(media.size, 100); // 淘汰要连音频本体一起删, 否则媒体库只增不减
  const kept = await app.data.store.list('tts-cache');
  assert.equal(kept.some(item => item.hash === 'k0'), false); // 最久未用的先走
  assert.equal(kept.some(item => item.hash === 'k104'), true);
});

// 画幅（业主 2026-09-27）：9:16 竖幅、约 1MP。chp/2 把画幅变成插件**手写的帧表**，
// `ratio` 是作者定的**标签、不由数字反推**，校验是成员检查 —— 客户端只选不算，
// 所以这里按标签取那一档，返回的就是表里的字面量（请求体要原样发回去）。
test('the drawing client takes the canvas the frame table labels 9:16 instead of computing one', () => {
  const { app } = runtime(['app/services/draw.js', 'app/services/draw-prompt.js']);
  const pick = app.services.draw.pickSize;
  // 插件 3.0.0 的 render 帧表（照抄 /chp/info）：1:1 在前面，9:16 是第二档。
  const render = [
    { ratio: '1:1', resolution: ['1024x1024'] },
    { ratio: '9:16', resolution: ['768x1344'] },
    { ratio: '16:9', resolution: ['1344x768'] },
    { ratio: '3:4', resolution: ['832x1152'] }
  ];
  assert.equal(pick({ frames: render }), '768x1344', '取的就是标着 9:16 的那一档，而且原样发回去');
  // 表里没有 9:16 就是"读不到"：客户端只选不算，不许自己算一张最接近的出来。
  assert.equal(pick({ frames: [{ ratio: '1:1', resolution: ['512x512', '1024x1024'] }] }), null, '表里没有 9:16 就不许自己挑一张凑合');
  // 表里的顺序就是规范的一部分：同一个标签有多档时取第一档。
  assert.equal(pick({ frames: [{ ratio: '9:16', resolution: ['576x1024'] }, { ratio: '9:16', resolution: ['768x1344'] }] }), '576x1024', '9:16 有多档时取第一档');
  // 一档里能挂多条分辨率，取的是**第一条**（规范 §4.3 第 1 条：该场景的默认画幅就是它的第一项）。
  assert.equal(pick({ frames: [{ ratio: '9:16', resolution: ['576x1024', '1152x2048'] }] }), '576x1024', '同一个 9:16 档里有多条分辨率时取第一条');
  assert.equal(pick({}), null, '没有帧表就报读不到');
  assert.equal(pick({ sizes: [[768, 1344]] }), null, 'chp/1 的 sizes 不再认：旧快照必须先重新获取一次目录');
  // 有参考图时钉在图像提示词开头的那句约束（业主指定原文，只加在发给插件的那一份上）。
  assert.match(app.services.drawPrompt.referencePrefix, /^参考图1仅仅作为角色身份/);
});

// 发现路径：chp/2 的文档是**两张表**（rules 说客户端要什么，abilities 说什么能回答）。
// 卡片 = render 这一个场景；画幅按 abilities 的顺序取该场景的帧；模型挂载点与就绪状态来自
// 回答它的那条能力。地址的解析按规范 §1.3：先原样试用户填的那个，再试推荐的 /chp/info。
test('image discovery reads the two-table chp/2 document and keeps the addresses it publishes', async () => {
  const { app } = runtime(['app/services/draw.js']);
  const document = {
    spec: 'chp/2',
    plugin: { id: 'hamdraw_chp', version: '3.0.0' },
    auth: { required: true, authorized: true },
    endpoints: { info: '/chp/info', jobs: '/chp/api/jobs' },
    rules: [
      { category: 'fast', rule: 'txt-ref-2-img', needs: { prompt: true, image: true }, prompt: { language: 'en' }, defaults: { ref_strength: 0.55 }, typical_seconds: 1.2 },
      { category: 'render', rule: 'txt-ref-2-img', needs: { prompt: true, image: false }, prompt: { language: 'any' }, defaults: { ref_strength: 0.95 }, typical_seconds: 45 }
    ],
    abilities: [
      { name: 'DreamShaper8_LCM.safetensors', files: { checkpoint: 'DreamShaper8_LCM.safetensors' }, ready: true, missing: [], frames: [{ ratio: '1:1', category: 'fast', resolution: ['512x512'] }] },
      {
        name: 'qwen2.1', ready: false, missing: ['vae'],
        files: { unet: 'qwen.safetensors', clip: 'qwen_clip.safetensors', vae: 'qwen_vae.safetensors' },
        frames: [{ ratio: '1:1', category: 'render', resolution: ['1024x1024'] }, { ratio: '9:16', category: 'render', resolution: ['768x1344'] }]
      },
      // 第三条也在播报 render，但它排在后头：规范 §4.3 第 1 条说"跨 abilities 按序扫，命中它的
      // 第一条 frame"，所以回答这个场景的是上面那条，卡片不该把两边的帧拼起来（拼起来的话
      // 就绪状态与画幅来自两个能力，卡片自己就说不通了）。
      { name: 'other', files: { checkpoint: 'other.safetensors' }, ready: true, missing: [], frames: [{ ratio: '9:16', category: 'render', resolution: ['1440x2560'] }] }
    ]
  };
  const asked = [];
  app.platform.network = {
    // ComfyUI 自己的网页根：200 一页 HTML，不是 CHP 文档 —— 这正是"地址里没有路径"时
    // 必须再试一次 /chp/info 的那个情形。
    request: async (options) => { asked.push(options.url); return options.url === 'http://192.168.124.31:8189' ? { status: 200, bodyText: '<html>ComfyUI</html>' } : { status: 200, bodyText: JSON.stringify(document) }; },
    readText: async (response) => response.bodyText
  };
  const service = { id: 'card', endpoint: 'http://192.168.124.31:8189' };
  const found = await app.services.modelServices.discover('image', service, { persist: false });

  assert.deepEqual(asked, ['http://192.168.124.31:8189', 'http://192.168.124.31:8189/chp/info'], '先原样试用户填的地址，再试推荐的 /chp/info');
  assert.equal(found.models.length, 1, 'chataxi 只收 render 这一个场景');
  const card = found.models[0];
  assert.equal(card.id, 'render', '卡片认的必须是 category（请求体字段名），不是 checkpoint 文件名');
  assert.deepEqual(plain(card.frames), [{ ratio: '1:1', resolution: ['1024x1024'] }, { ratio: '9:16', resolution: ['768x1344'] }], '画幅只取回答这个场景的第一条能力的帧（文档序就是菜单序）');
  assert.equal(app.services.draw.pickSize(card), '768x1344', '发现出来的卡片要能直接喂给绘图客户端');
  assert.equal(card.ready, false, '就绪状态挂在**能力**上：render 那一族缺 vae');
  assert.deepEqual(plain(card.missing), ['vae'], '缺哪个角色要点名');
  const role = (name) => card.roles.find((item) => item.role === name);
  assert.deepEqual(plain(card.roles.map((item) => item.role).sort()), ['clip', 'unet', 'vae'], '模型挂载点来自回答它的那条能力');
  assert.equal(role('unet').name, 'qwen.safetensors');
  assert.equal(role('vae').ready, false, '缺的那个角色自己标成未就绪');
  assert.equal(role('clip').ready, true);
  assert.equal(card.promptLanguage, 'any', 'render 的提示词语言来自 rules，不来自能力');
  assert.equal(card.defaults.ref_strength, 0.95);
  assert.equal(card.typicalSeconds, 45);
  assert.equal(service.chpOrigin, 'http://192.168.124.31:8189', '请求地址要按信息接口的同源根补全');
  assert.deepEqual(Object.keys(plain(service.endpoints)), ['info', 'jobs'], '地址表原样存下来，绘图时从它读');

  // 连不上 与 应答了但不是 CHP 文档 必须分开报：前者让用户查 WiFi / ComfyUI，后者让用户查插件。
  app.platform.network = { request: async () => { throw new Error('Timeout'); }, readText: async () => '' };
  await assert.rejects(() => app.services.modelServices.discover('image', { id: 'c', endpoint: 'http://192.168.124.31:8189' }, { persist: false }), /无法连接这个地址/, '连不上要说地址不通');
  app.platform.network = { request: async () => ({ status: 200, bodyText: '<html>ComfyUI</html>' }), readText: async (response) => response.bodyText };
  await assert.rejects(() => app.services.modelServices.discover('image', { id: 'c', endpoint: 'http://192.168.124.31:8189' }, { persist: false }), /这个地址不是 CHP 服务/, '应答了但那里没有插件');
});

// 定妆照必须真的作为参考图发到 CHP（业主 2026-09-27：「请仔细确认能够正确调用定妆照图片作为
// 参考图一起发给 cvp」），请求体必须是 chp/2 的那套字段名，地址一律从文档的 endpoints 里读。
// 这里跑的是真实的 generate()，断的是它真正提交的请求体与真正打的地址 —— 只看源码里有这一行不算数。
test('a self-portrait reference really reaches the CHP request body as image_base64', async () => {
  const { app } = runtime(['app/services/draw.js', 'app/services/draw-prompt.js']);
  const submitted = [], asked = [];
  const model = {
    id: 'render',
    frames: [{ ratio: '1:1', resolution: ['1024x1024'] }, { ratio: '9:16', resolution: ['768x1344'] }],
    defaults: { ref_strength: 0.95 },
    typicalSeconds: 45
  };
  // 故意用**非推荐的**路径，而且地址里带一段路径：客户端只能照文档给的地址打 ——
  // 自己从 endpoint 拼会拼出 …/proxy/chp/jobs，从 chpBase 拼会拼出 …/proxy/chp/jobs，
  // 只有文档给的 /chp/api/jobs 加信息接口的同源根才是对的。
  const profile = {
    id: 'card', endpoint: 'http://192.168.124.31:8189/proxy/chp', chpOrigin: 'http://192.168.124.31:8189',
    endpoints: {
      jobs: '/chp/api/jobs', job: '/chp/api/jobs/{job_id}',
      progress: '/chp/api/jobs/{job_id}/progress', cancel: '/chp/api/jobs/{job_id}/cancel'
    }
  };
  // 只换掉环境给的那三件（目录 / 地址 / 认证）；chpUrl / chpJobUrl / chpAbsolute 走**真**实现，
  // 否则"地址从文档里读"这件事就没有被测到。
  const services = app.services.modelServices;
  services.modelDefinition = () => model;
  services.computedEndpoint = () => profile.endpoint;
  services.authHeaders = () => ({ Authorization: 'Bearer fixture' });
  app.utils.parseHeaders = () => ({});
  app.platform.network = {
    requestJson: async (options) => {
      asked.push(options.method + ' ' + options.url);
      // 提交按"方法"认，不按地址认：地址对不对由下面那条 asked 断言说话，
      // 让桩先按地址挑分支会把"地址拼错了"变成另一条报错。
      if (options.method === 'POST') { submitted.push(JSON.parse(options.bodyText)); return { data: { job: { id: 'job-1' } } }; }
      if (/\/progress$/.test(options.url)) return { data: { job: { state: 'completed', queue_position: 0 } } };
      return { data: { job: { state: 'completed', outputs: [{ url: '/chp/jobs/job-1/output/0', media_type: 'image/png' }] } } };
    },
    requestByteStream: async (options) => { asked.push('GET ' + options.url); options.onChunk(new Uint8Array([137, 80, 78, 71])); return { contentType: 'image/png' }; }
  };
  const portrait = 'data:image/jpeg;base64,AAAA', produce = (extra) => app.services.draw.generate(Object.assign({ profile: profile, modelId: 'render', prompt: '雨夜的旧车站' }, extra));

  const produced = await produce({ referenceDataUrl: portrait });
  assert.equal(submitted.length, 1, '一次绘图只提交一个任务');
  const body = submitted[0];
  assert.equal(body.category, 'render', 'v2 的字段名是 category（取代 v1 的 capability / task）');
  assert.equal(body.resolution, '768x1344', '画幅取 9:16 那一档，发的就是表里的字面量');
  assert.equal('capability' in body, false, 'v1 的 capability 不许再出现');
  assert.equal('size' in body, false, 'v1 的 size 数组不许再出现');
  assert.equal('steps' in body, false, '步数不在规范里：不发就是用插件自己的默认值');
  assert.equal(body.image_base64, portrait, '定妆照必须原样进 image_base64');
  assert.equal(body.ref_strength, 0.95, '参考强度照插件自报的默认值发');
  assert.match(body.prompt, /^参考图1仅仅作为角色身份[\s\S]*雨夜的旧车站$/, '有参考图时提示词开头必须钉上身份约束');
  assert.ok(produced.blob && produced.blob.size, '取回的字节要变成一张真图');
  // 四个请求全部落在文档公布的地址上：提交 → 轮询 → 取状态 → 取图（取图那一条是服务端给的）。
  assert.deepEqual(asked, [
    'POST http://192.168.124.31:8189/chp/api/jobs',
    'GET http://192.168.124.31:8189/chp/api/jobs/job-1/progress',
    'GET http://192.168.124.31:8189/chp/api/jobs/job-1',
    'GET http://192.168.124.31:8189/chp/jobs/job-1/output/0'
  ], '请求地址一律从文档的 endpoints 里读，客户端不许自己拼路径');

  // 没有参考图时不许自己编一张出来：那会把"定妆照没读到"这件事掩盖掉。
  //（插件侧 render.needs.image = false —— 不带参考图就是纯文生图，是它明确支持的路径。）
  submitted.length = 0;
  await produce({});
  assert.equal('image_base64' in submitted[0], false, '没有参考图就不许凭空造一张');
  assert.equal(submitted[0].prompt, '雨夜的旧车站', '没有参考图时不加那句身份约束');
});
