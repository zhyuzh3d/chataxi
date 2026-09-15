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
  const context = vm.createContext({ window, localStorage, URL, Blob, TextEncoder, TextDecoder, Uint8Array, Uint32Array, Float32Array, DataView, btoa, atob, console, setTimeout, clearTimeout, AbortController });
  const load = (file) => vm.runInContext(fs.readFileSync(root + file, 'utf8'), context, { filename: file });
  ['app/core/namespace.js', 'app/core/utils.js', 'app/core/events.js'].forEach(load);
  const app = window.chataxi;
  app.platform = { hermit: { awaitReady: async () => false, available: () => false, api: () => null } };
  ['app/data/store.js', 'app/services/catalog.js', 'app/services/model-registry.js', 'app/services/model-services.js', 'app/services/providers.js', 'app/services/middleware.js', 'app/services/context.js', 'app/services/llm.js', 'app/services/profiles.js', 'app/features/chat-session.js'].forEach(load);
  app.data.media = { remove: async (id) => removedMedia.push(id), put: async () => { throw Error('no images expected'); } };
  app.services.tts = { speak: async () => {} };
  files.forEach(load);
  return { app, context, values, removedMedia, fault(fn) { fault = fn; }, load };
}
async function fixture() {
  const env = runtime(), { app } = env, s = app.data.store;
  await s.init();
  await s.put('llm-profiles', 'p', { id: 'p', name: '测试服务', model: 'fixture', endpoint: 'https://example.com/v1/responses', enabled: true });
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
  const applied = app.services.context.applyToRole({ id: 'a', name: 'A', systemPrompt: '角色设定' }, null, [{ id: 'a', name: 'A', systemPrompt: '角色设定' }], seen[2]);
  assert.match(applied.systemPrompt, /名称：「测试用户」/); assert.match(applied.systemPrompt, /本对话专用背景/);
  assert.doesNotMatch(applied.systemPrompt, /通用用户背景/);
});

test('group context shares one summary and keeps the timeline latest N across user and every role', async () => {
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
  const settings = await app.data.store.get('meta', 'settings'); settings.autoCompress = true; settings.compressionThresholdChars = 1;
  app.platform.network = { requestJson: async () => ({ data: { output_text: '摘要' } }) };
  const current = { id: 'a', name: 'A', systemPrompt: 'A 的设定', llmProfileId: 'p' }, other = { id: 'b', name: 'B', systemPrompt: 'B 的设定' };
  const prepared = await app.services.context.prepare({ id: 'c', recentFullMessages: 5 }, current, messages, settings, {});
  assert.deepEqual(plain(prepared.recent.map(message => message.id)), ['b1', 'u2', 'b2', 'a2', 'u3']);
  assert.deepEqual(plain(prepared.recent.map(message => message.kind === 'user' ? 'user' : message.roleId)), ['b', 'user', 'b', 'a', 'user']);
  const shared = await app.services.context.prepare({ id: 'c', recentFullMessages: 5 }, other, messages, settings, {});
  assert.equal(shared.summary.id, 'c'); assert.equal(shared.summary.text, '摘要'); assert.equal(shared.summary.compressedByRoleId, 'a');
  const merged = app.services.context.applyToRole(current, null, [current, other]);
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
  const prepared = await app.services.context.prepare({ id: 'c', recentFullMessages: 5 }, { id: 'a', name: 'A' }, messages, settings, {});
  assert.equal(prepared.summary, null);
  assert.deepEqual(plain(prepared.recent.map(message => message.id)), ['u1', 'a1', 'b1', 'u2', 'a2', 'b2', 'u3']);
});

test('successive compression merges the previous summary and only advances through messages before retained N', async () => {
  const { app } = await fixture(), requests = [];
  const make = index => ({ id: 'm' + String(index).padStart(2, '0'), conversationId: 'c', kind: index % 2 ? 'assistant' : 'user', roleId: index % 2 ? 'a' : '', roleName: index % 2 ? 'A' : '', status: 'done', text: '消息' + index + 'xxxxxx', createdAt: index + 1 });
  const messages = Array.from({ length: 10 }, (_, index) => make(index));
  const settings = await app.data.store.get('meta', 'settings'); settings.autoCompress = true; settings.compressionThresholdChars = 60; settings.compressionTargetChars = 400;
  app.platform.network = { requestJson: async options => { requests.push(JSON.parse(options.bodyText)); return { data: { output_text: requests.length === 1 ? '概要一' : '概要二' } }; } };
  const roles = [
    { id: 'a', name: 'A', systemPrompt: 'A 的角色介绍', llmProfileId: 'p' },
    { id: 'b', name: 'B', systemPrompt: 'B 的角色介绍', llmProfileId: 'p' }
  ];
  const first = await app.services.context.prepare({ id: 'c', recentFullMessages: 5 }, roles[0], messages, settings, {}, roles, { name: '用户甲', introduction: '用户介绍' });
  assert.equal(first.summary.throughMessageId, 'm04'); assert.equal(first.summary.sourceMessageCount, 5);
  assert.deepEqual(plain(first.recent.map(message => message.id)), ['m05', 'm06', 'm07', 'm08', 'm09']);
  assert.match(requests[0].instructions, /参与者资料仅用于辨认说话者/); assert.match(requests[0].instructions, /用户「用户甲」介绍：用户介绍/);
  assert.match(requests[0].instructions, /角色「A」介绍：A 的角色介绍/); assert.match(requests[0].instructions, /角色「B」介绍：B 的角色介绍/);
  assert.doesNotMatch(JSON.stringify(requests[0].input), /A 的角色介绍|B 的角色介绍|用户介绍/);
  const expanded = messages.concat(Array.from({ length: 4 }, (_, index) => make(index + 10)));
  const second = await app.services.context.prepare({ id: 'c', recentFullMessages: 5 }, roles[0], expanded, settings, {}, roles, { name: '用户甲', introduction: '用户介绍' });
  assert.equal(second.summary.text, '概要二'); assert.equal(second.summary.throughMessageId, 'm08'); assert.equal(second.summary.throughMessageCreatedAt, 9);
  assert.equal(second.summary.sourceMessageCount, 9); assert.equal(second.summary.retainedMessageCount, 5);
  assert.deepEqual(plain(second.recent.map(message => message.id)), ['m09', 'm10', 'm11', 'm12', 'm13']);
  assert.match(JSON.stringify(requests[1].input), /已有压缩上下文.*概要一/); assert.match(JSON.stringify(requests[1].input), /消息5/); assert.doesNotMatch(JSON.stringify(requests[1].input), /消息4/);
  assert.deepEqual(Object.keys(await app.services.context.editable(expanded, 'c', 5)), ['m09', 'm10', 'm11', 'm12', 'm13']);
});

test('group compression always uses the first participant model even when another role answers', async () => {
  const { app } = await fixture();
  const conversation = await app.data.store.get('conversations', 'c'), roles = await app.data.store.list('roles');
  const active = roles.find(role => role.id === 'b'), original = app.services.context.prepare; let compressor;
  app.services.context.prepare = async function (currentConversation, role, messages, settings, task, participants, userProfile) {
    compressor = role.id; return { summary: null, recent: messages, compressed: false, retainedCount: 5, uncompressedCount: messages.length };
  };
  app.platform.network = { requestSse: async options => { await options.onEvent({ data: '{"type":"response.output_text.delta","delta":"B 回复"}' }); await options.onEvent({ data: '{"type":"response.completed","response":{}}' }); } };
  await app.services.llm.complete(active, [{ id: 'u', kind: 'user', text: '问题', media: [], status: 'done', createdAt: 1 }], { cancelled: false }, conversation, roles, { name: '用户', introduction: '' });
  app.services.context.prepare = original;
  assert.equal(compressor, 'a');
});

test('schema migration initializes the moderator and auto-selection state, infers conversation type, clamps N and removes legacy icon avatars', async () => {
  const { app } = await fixture(), s = app.data.store;
  const conversation = await s.get('conversations', 'c'); conversation.kind = 'group'; conversation.roleIds = ['a']; conversation.activeRoleIds = ['b', 'a']; conversation.recentFullMessages = 2; await s.put('conversations', 'c', conversation);
  const role = await s.get('roles', 'a'); role.avatarIcon = 'robot'; role.avatarColor = '#123456'; await s.put('roles', 'a', role);
  await s.init();
  const migratedConversation = await s.get('conversations', 'c'), migratedRole = await s.get('roles', 'a');
  assert.equal(migratedConversation.kind, 'single'); assert.equal(migratedConversation.recentFullMessages, 5);
  assert.deepEqual(plain(migratedConversation.activeRoleIds), ['a']);
  assert.equal(migratedConversation.moderatorRoleId, 'a'); assert.equal(migratedConversation.autoSelectRole, false);
  assert.equal(migratedConversation.userName, ''); assert.equal(migratedConversation.userIntroduction, ''); assert.equal(migratedConversation.userAvatarMediaId, '');
  assert.equal(Object.hasOwn(migratedRole, 'avatarIcon'), false); assert.equal(Object.hasOwn(migratedRole, 'avatarColor'), false);
  assert.equal(Object.hasOwn(await s.get('meta', 'settings'), 'recentFullMessages'), false);
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

test('message editing is unrestricted before compression and limited to recent N after the summary boundary', async () => {
  const { app } = await fixture(), s = app.data.store;
  const messages = Array.from({ length: 12 }, (_, index) => ({ id: 'm' + index, conversationId: 'c', kind: index % 2 ? 'assistant' : 'user', roleId: 'a', status: 'done', text: String(index), createdAt: index + 1 }));
  for (const message of messages) await s.putMessage(message);
  assert.equal(Object.keys(await app.services.context.editable(messages, 'c', 5)).length, 12);
  await s.put('summaries', 'c', { id: 'c', conversationId: 'c', text: '摘要', throughMessageId: 'm5', throughCreatedAt: 6, updatedAt: 20 });
  assert.deepEqual(Object.keys(await app.services.context.editable(messages, 'c', 5)), ['m7', 'm8', 'm9', 'm10', 'm11']);
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

test('long CJK and emoji replies round-trip under the Hermit record limit and clean old chunks', async () => {
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
  app.platform.hermit = {
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
  app.platform.hermit.awaitReady = async () => true; app.platform.hermit.available = () => true;
  app.platform.hermit.on = (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); };
  app.platform.hermit.api = () => ({ speech: { availability: async () => ({ available: true }), start: async () => ({ subscriptionId: 'speech-1' }), cancel: async () => {}, stop: async () => {} } });
  await app.services.asr.startSystem({}, { final() { transcripts++; } });
  const lateFinal = listeners.get('speech.final');
  await app.services.asr.cancelSystem(); lateFinal({ alternatives: [{ text: 'late' }] });
  assert.equal(transcripts, 0); assert.equal(listeners.size, 0);
});

test('system ASR requests RMS events and forwards real microphone levels to the test UI', async () => {
  const env = runtime(['app/services/asr.js']), { app } = env; const listeners = new Map(); let startParams, level;
  app.platform.hermit.awaitReady = async () => true; app.platform.hermit.available = () => true;
  app.platform.hermit.on = (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); };
  app.platform.hermit.api = () => ({ speech: {
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
  app.platform.hermit.awaitReady = async () => true; app.platform.hermit.available = () => true;
  app.platform.hermit.on = (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); };
  app.platform.hermit.api = () => ({ speech: {
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
  app.platform.hermit.awaitReady = async () => true; app.platform.hermit.available = () => true;
  app.platform.hermit.api = () => ({ speech: { availability: async () => { reached.resolve(); return availability.promise; }, start: async () => { starts++; return { subscriptionId: 'late' }; }, cancel: async () => {} } });
  const starting = app.services.asr.startSystem({}, {});
  await reached.promise; await app.services.asr.cancelSystem(); availability.resolve({ available: true });
  await assert.rejects(starting, /已取消/); assert.equal(starts, 0);
});
