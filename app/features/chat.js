(function (app) {
  "use strict";
  var u = app.utils, ui = app.components, store = app.data.store, session = app.features.chatSession;
  var view = null;
  var revision = 0;
  var MESSAGE_RENDER_INITIAL = 120;
  var MESSAGE_RENDER_STEP = 100;
  function revoke(urls) { urls.splice(0).forEach(function (url) { URL.revokeObjectURL(url); }); }
  function alive(target) { return view === target && !target.closed; }
  function currentBusy(target) { return Boolean(session.active(target.conversation.id)); }
  function shortRoleName(name) { var characters = Array.from(String(name || "")); return characters.length <= 5 ? characters.join("") : characters.slice(0, 4).join("") + "..."; }
  function moderatorRoleId(conversation) { return conversation.moderatorRoleId && conversation.roleIds.indexOf(conversation.moderatorRoleId) >= 0 ? conversation.moderatorRoleId : conversation.roleIds[0]; }
  function displayText(value) { return String(value || "").replace(/\r\n?/g, "\n").replace(/\n[ \t]*\n+/g, "\n"); }
  function rememberMessage(target, message) {
    if (!message || !target.messageSnapshot) return;
    var index = target.messageSnapshot.findIndex(function (item) { return item.id === message.id; });
    if (index < 0) target.messageSnapshot.push(message); else target.messageSnapshot[index] = message;
    target.messageSnapshot.sort(function (left, right) { return left.createdAt - right.createdAt || left.id.localeCompare(right.id); });
  }
  async function selectedMediaCapabilities(target) {
    var role = target.roleMap[target.selected[0]], service = role && await store.get('llm-profiles', role.llmProfileId);
    if (!role || !service || service.enabled === false) return { image: false, video: false };
    var profile = app.services.modelServices.resolveLlm(service, role);
    return { image: app.services.mediaPrep.supports(profile, 'image'), video: app.services.mediaPrep.supports(profile, 'video') };
  }
  async function selectedAsrCapability(target) {
    var id = target.conversation.asrProfileId || target.settings.defaultAsrProfileId || 'system-asr';
    var service = await store.get('asr-profiles', id);
    if (!service || service.enabled === false) return { available: false, service: service || null, message: '语音输入服务未配置或已停用' };
    if ((service.family || service.type) !== 'system') return { available: Boolean(app.services.modelServices.computedEndpoint('asr', service)), service: service, message: '语音输入服务缺少有效地址' };
    var capability = await app.services.asr.systemCapability(false); return Object.assign({ service: service }, capability);
  }
  function mediaKey(media) { return media.mediaId || media.logicalFileId || ''; }

  async function render(id) {
    if (view) await close();
    var conversation = await store.get('conversations', id);
    if (!conversation) throw new Error('对话不存在');
    conversation = (await store.prepareOpeningScene(id)).conversation;
    var roles = await store.list('roles'), profiles = await store.list('llm-profiles');
    var roleMap = {}; roles.forEach(function (role) { roleMap[role.id] = role; });
    var globalUserProfile = await store.get('meta', 'user-profile') || { name: '我', introduction: '', avatarMediaId: '' };
    var target = { conversation: conversation, roleMap: roleMap, profiles: profiles, settings: await store.get('meta', 'settings'), globalUserProfile: globalUserProfile, userProfile: app.services.profiles.userForConversation(conversation, globalUserProfile), draft: await store.get('drafts', id) || { id: id, text: '', media: [] }, urls: [], draftUrls: [], follow: true, closed: false, io: false, speechStarting: false, draftQueue: Promise.resolve(), paint: 0, messageCache: {}, avatarSources: {}, messageRenderLimit: MESSAGE_RENDER_INITIAL, routing: false, autoSelectRole: Boolean(conversation.autoSelectRole) };
    target.asrCapability = await selectedAsrCapability(target);
    // Recover a draft whose user message was accepted before an interrupted draft-clear operation.
    var history = await store.messages(id), lastUser = history.filter(function (item) { return item.kind === 'user'; }).pop();
    target.messageSnapshot = history;
    if (lastUser && target.draft.messageId === lastUser.id) target.draft = { id: id, text: '', media: [] };
    target.draft.messageId = target.draft.messageId || u.id("message");
    view = target; app.state.activeConversationId = id;
    var previousRoleId = (conversation.activeRoleIds || []).find(function (roleId) { return conversation.roleIds.indexOf(roleId) >= 0; });
    target.selected = [previousRoleId || conversation.roleIds[0]].filter(Boolean);
    target.mediaCapabilities = await selectedMediaCapabilities(target);
    var participants = conversation.roleIds.map(function (roleId) { return roleMap[roleId]; }).filter(Boolean);
    document.getElementById('appShell').classList.add('chat-open');
    document.getElementById('bottomNav').classList.add('is-hidden');
    document.getElementById('backButton').classList.remove('is-hidden');
    document.querySelector('#brandBlock .brand-mark').classList.add('is-hidden');
    app.services.tts.setMuted(Boolean(conversation.ttsMuted));
    ui.pageHeader(conversation.title, participants.map(function (role) { return role.name; }).join('、'), '<button class="icon-button" type="button" id="muteTtsButton" aria-label="静音自动朗读" title="静音自动朗读">' + ui.icon(conversation.ttsMuted ? 'volume-xmark' : 'volume-high') + '</button><button class="icon-button" type="button" id="chatMenuButton" aria-label="对话管理">' + ui.icon('ellipsis') + '</button>');
    var main = document.getElementById('mainContent'); main.className = 'main chat-main';
    main.innerHTML = '<section class="chat-layout"><div class="message-viewport"><div class="message-list" id="messageList" aria-label="对话消息"><div class="message-list-inner" id="messageListInner"></div></div><button type="button" class="button secondary jump-latest is-hidden" id="jumpLatest">' + ui.icon('arrow-down') + '回到最新</button></div><div class="composer"><div class="composer-inner"><div class="attachment-tray is-hidden" id="attachmentTray"></div><div class="composer-box">' + (conversation.kind === 'group' ? '<div class="composer-recipients"><span class="recipient-at" aria-label="艾特一位角色">@</span><div class="mention-strip" role="group" aria-label="选择本轮回复角色">' + participants.map(function (role) { return '<button class="chip mention-chip" type="button" data-role-toggle="' + u.escapeHtml(role.id) + '" data-moderator="' + String(role.id === moderatorRoleId(conversation)) + '" aria-pressed="' + (target.selected.indexOf(role.id) >= 0) + '" title="' + u.escapeHtml(role.name) + '">' + ui.roleAvatar(role, 'tiny mention-avatar') + '<span class="mention-name">' + u.escapeHtml(shortRoleName(role.name)) + '</span></button>'; }).join('') + '</div><button class="auto-role-toggle" type="button" id="autoRoleToggle" role="switch" aria-checked="' + String(target.autoSelectRole) + '" aria-label="自动选择回复角色" title="自动选择回复角色">' + ui.icon('wand-magic-sparkles') + '</button></div>' : '') + '<textarea id="messageInput" rows="1" maxlength="16000" placeholder="把你的想法写在这里…" aria-label="消息内容"></textarea><div class="composer-toolbar"><div class="row composer-tools"><button class="icon-button" type="button" id="imageButton" aria-label="添加图片或视频" title="添加图片或视频">' + ui.icon('paperclip') + '</button><button class="icon-button" type="button" id="micButton" aria-label="语音输入" title="语音输入">' + ui.icon('microphone') + '</button><span class="composer-hint" id="composerHint"></span></div><button type="button" class="icon-button send-button" id="sendButton" aria-label="发送消息">' + ui.icon('arrow-up') + '</button></div></div><div class="composer-footer"><span id="composerStatus" role="status" aria-live="polite"></span><span id="draftStatus"></span></div></div></div></section>';
    ui.hydrateAvatars(main);
    var input = document.getElementById('messageInput'); input.value = target.draft.text || '';
    resizeInput(input);
    input.addEventListener('input', function () { target.draft.text = input.value; resizeInput(input); queueDraft(target); syncComposer(target); });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229 && !event.shiftKey && (event.ctrlKey || event.metaKey || target.settings.enterToSend)) { event.preventDefault(); if (!currentBusy(target)) send(target); }
    });
    document.getElementById('sendButton').addEventListener('click', function () { if (currentBusy(target)) { session.stop(id); status(target, '已停止后续回复；已发出的服务请求可能仍计费'); } else send(target); });
    document.getElementById('imageButton').addEventListener('click', ui.action(function () { return chooseMedia(target); }));
    document.getElementById('micButton').addEventListener('click', ui.action(function () { return handleSpeech(target); }));
    document.getElementById('chatMenuButton').addEventListener('click', ui.action(function () { return manageChat(target); }));
    document.getElementById('muteTtsButton').addEventListener('click', ui.action(async function () { var nextMuted = !app.services.tts.isMuted(); app.services.tts.setMuted(nextMuted); var next = await store.get('conversations', id); next.ttsMuted = nextMuted; await store.put('conversations', id, next); target.conversation = next; status(target, nextMuted ? '已静音后续自动朗读；当前播放不会中断' : '已恢复后续自动朗读'); }));
    document.getElementById('jumpLatest').addEventListener('click', function () { target.follow = true; scrollBottom(target); });
    document.getElementById('messageList').addEventListener('scroll', function () { var list = document.getElementById('messageList'); target.follow = list.scrollHeight - list.scrollTop - list.clientHeight < 100; document.getElementById('jumpLatest').classList.toggle('is-hidden', target.follow); });
    main.querySelectorAll('[data-role-toggle]').forEach(function (button) { button.addEventListener('click', ui.action(async function () {
      if (currentBusy(target) || target.autoSelectRole) return;
      var roleId = button.dataset.roleToggle;
      var next = await store.get('conversations', id); next.activeRoleIds = [roleId];
      await store.put('conversations', id, next); target.selected = next.activeRoleIds;
      target.mediaCapabilities = await selectedMediaCapabilities(target);
      syncComposer(target);
    })); });
    var autoRoleToggle = document.getElementById('autoRoleToggle');
    if (autoRoleToggle) autoRoleToggle.addEventListener('click', ui.action(async function () {
      if (currentBusy(target)) return;
      var next = await store.get('conversations', id); if (!next) throw new Error('对话不存在');
      next.autoSelectRole = !target.autoSelectRole; next.updatedAt = Date.now();
      await store.put('conversations', id, next); target.conversation = next; target.autoSelectRole = Boolean(next.autoSelectRole);
      syncComposer(target);
      status(target, target.autoSelectRole ? '已开启自动选角；每轮由主持人先选择回复角色' : '已关闭自动选角；请手工艾特一位角色');
    }));
    var picker = document.getElementById('imagePicker');
    picker.onchange = ui.action(async function () { var files = Array.prototype.slice.call(picker.files || []); picker.value = ''; if (!alive(target)) return; await addFiles(target, files); });
    document.getElementById('videoPicker').onchange = ui.action(async function (event) { var file = event.target.files && event.target.files[0]; event.target.value = ''; if (file && alive(target)) await addBrowserVideo(target, file); });
    document.getElementById('audioPicker').onchange = ui.action(async function (event) { var file = event.target.files && event.target.files[0]; event.target.value = ''; if (file && alive(target)) await transcribe(target, file); });
    target.unsubscribe = app.events.on('chat:changed', function (event) {
      if (!alive(target) || event.conversationId !== id) return;
      if (event.phase === 'accepted') {
        rememberMessage(target, event.message);
        target.draft = { id: id, messageId: u.id('message'), text: '', media: [] }; input.value = ''; resizeInput(input); renderDraft(target).catch(showError);
      }
      if (event.phase === 'delta') {
        var deltaMessage = target.messageSnapshot && target.messageSnapshot.find(function (message) { return message.id === event.messageId; }); if (deltaMessage) deltaMessage.text = event.text;
        status(target, event.fallback ? '服务未提供可读取的响应流，已使用兼容输出' : '正在流式生成…');
        if (!applyMessageDelta(event.messageId, event.text, target)) renderMessages(target).catch(showError);
        syncComposer(target); return;
      }
      if (event.phase === 'notice' || event.phase === 'media') status(target, event.text);
      else if (event.phase === 'routing') { target.routing = true; status(target, '主持人正在选择回复角色…'); }
      else if (event.phase === 'routed') {
        target.routing = false;
        target.selected = [event.roleId]; target.conversation.activeRoleIds = target.selected.slice();
        if (event.fallback) ui.toast('自动选角失败，本次随机选取：' + event.roleName, 5000);
        status(target, (event.fallback ? '已随机选择 ' : '主持人已选择 ') + event.roleName + ' 回复');
        selectedMediaCapabilities(target).then(function (capability) { if (alive(target)) { target.mediaCapabilities = capability; syncComposer(target); } }).catch(showError);
        syncComposer(target); return;
      }
      else if (event.phase === 'idle') { target.routing = false; status(target, event.stopped ? '本轮已停止，可重试已停止的回复' : '本轮完成'); }
      else if (event.phase === 'generating' || event.phase === 'compressing') { target.routing = false; rememberMessage(target, event.message); status(target, session.active(id) ? session.active(id).label : event.phase === 'compressing' ? '正在压缩历史上下文…' : '正在生成…'); }
      else if (event.phase === 'updated') rememberMessage(target, event.message);
      syncComposer(target); renderMessages(target).catch(showError);
    });
    await session.recover(id, history); await renderDraft(target); await renderMessages(target, true); syncComposer(target);
  }
  function showError(error) { ui.toast(u.cleanError(error), 5000); }
  function status(target, text) { if (alive(target)) document.getElementById('composerStatus').textContent = text; }
  function resizeInput(input) { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; }
  function queueDraft(target) { clearTimeout(target.draftTimer); document.getElementById('draftStatus').textContent = '正在保存草稿…'; target.draftTimer = setTimeout(function () { flushDraft(target).catch(function (error) { if (alive(target)) document.getElementById('draftStatus').textContent = '草稿未保存'; showError(error); }); }, 300); }
  function flushDraft(target) {
    clearTimeout(target.draftTimer);
    var draft = u.clone(target.draft); draft.updatedAt = Date.now();
    target.draftQueue = target.draftQueue.catch(function () {}).then(async function () {
      if (draft.text || draft.media.length) await store.put('drafts', target.conversation.id, draft); else await store.remove('drafts', target.conversation.id);
      if (alive(target)) document.getElementById('draftStatus').textContent = draft.text || draft.media.length ? '草稿已保存' : '';
    });
    return target.draftQueue;
  }
  function syncComposer(target) {
    if (!alive(target)) return;
    var busy = currentBusy(target), moderatorId = moderatorRoleId(target.conversation);
    var checkedRoleIds = target.autoSelectRole ? target.conversation.roleIds : target.selected;
    var unavailable = checkedRoleIds.some(function (id) { return !target.roleMap[id] || app.services.profiles.roleStatus(target.roleMap[id], target.profiles); });
    if (target.autoSelectRole && (!target.roleMap[moderatorId] || app.services.profiles.roleStatus(target.roleMap[moderatorId], target.profiles))) unavailable = true;
    var empty = !target.draft.text.trim() && !target.draft.media.length;
    var canContinue = target.conversation.kind === 'group' && target.selected.length === 1;
    var send = document.getElementById('sendButton'); send.innerHTML = ui.icon(busy ? 'stop' : 'arrow-up'); send.setAttribute('aria-label', busy ? '停止本轮回复' : '发送消息'); send.classList.toggle('stopping', busy);
    send.disabled = !busy && (target.io || target.speechStarting || Boolean(target.speechId) || unavailable || (empty && !canContinue));
    document.getElementById('messageInput').readOnly = busy;
    document.getElementById('imageButton').disabled = busy || target.io || !target.mediaCapabilities || !target.mediaCapabilities.image && !target.mediaCapabilities.video;
    var mic = document.getElementById('micButton'), speechAvailable = Boolean(target.asrCapability && target.asrCapability.available);
    mic.classList.toggle('is-hidden', !speechAvailable); mic.disabled = !speechAvailable || busy || target.io || target.speechStarting;
    var selectedRole = target.roleMap[target.selected[0]];
    document.getElementById('composerHint').textContent = busy ? '点击方块停止' : unavailable ? '角色配置需要修复' : target.conversation.kind === 'group' ? target.autoSelectRole ? (empty ? '空消息将发送“请你们自主回答。”' : '主持人将自动选择回复角色') : (empty ? '空消息将请 ' + (selectedRole ? selectedRole.name : '所选角色') + ' 继续' : '将由 ' + (selectedRole ? selectedRole.name : '所选角色') + ' 回复') : target.settings.enterToSend ? 'Enter 发送' : 'Enter 换行';
    document.querySelectorAll('[data-role-toggle]').forEach(function (button) { button.disabled = busy || target.autoSelectRole; button.setAttribute('aria-pressed', String(target.selected.indexOf(button.dataset.roleToggle) >= 0)); });
    var autoToggle = document.getElementById('autoRoleToggle');
    if (autoToggle) { autoToggle.disabled = busy; autoToggle.setAttribute('aria-checked', String(target.autoSelectRole)); }
    if (unavailable && !busy) status(target, '当前角色或模型已停用，请在角色页修复配置');
  }
  function scrollBottom(target) {
    if (!alive(target)) return;
    var list = document.getElementById('messageList'); list.scrollTop = list.scrollHeight; document.getElementById('jumpLatest').classList.add('is-hidden');
  }
  function applyMessageDelta(messageId, text, target) {
    if (!alive(target)) return false;
    var row = document.querySelector('[data-message-id="' + String(messageId).replace(/"/g, '\\"') + '"]');
    if (!row) return false;
    var bubble = row.querySelector('.message-bubble'), typing = bubble && bubble.querySelector('.typing-bubble'); if (typing) typing.remove();
    var node = bubble && bubble.querySelector('.message-text');
    if (!node && bubble) { node = document.createElement('div'); node.className = 'message-text'; bubble.appendChild(node); }
    if (node) node.textContent = displayText(text);
    if (target.follow) requestAnimationFrame(function () { scrollBottom(target); });
    return Boolean(node);
  }
  function ensureResumeButton(messageId) {
    var row = document.querySelector('[data-message-id="' + String(messageId || '').replace(/"/g, '\\"') + '"]'), meta = row && row.querySelector('.message-meta');
    if (!meta || meta.querySelector('[data-tts-message]')) return;
    var button = document.createElement('button'); button.type = 'button'; button.className = 'icon-button'; button.dataset.ttsMessage = messageId; button.setAttribute('aria-label', '继续流式朗读'); button.innerHTML = ui.icon('play');
    button.addEventListener('click', ui.action(function () { return app.services.tts.resume(messageId); })); meta.appendChild(button);
  }
  function routingIndicator() {
    var indicator = document.createElement('div'); indicator.className = 'routing-indicator'; indicator.setAttribute('role', 'status'); indicator.setAttribute('aria-label', '正在自动选择回复角色');
    indicator.innerHTML = '<div class="typing-bubble" aria-hidden="true"><span></span><span></span><span></span></div>';
    return indicator;
  }
  async function loadEarlierMessages(target) {
    if (!alive(target)) return;
    var list = document.getElementById('messageList'), height = list.scrollHeight, top = list.scrollTop;
    target.follow = false; target.messageRenderLimit += MESSAGE_RENDER_STEP;
    await renderMessages(target, false);
    if (alive(target)) list.scrollTop = top + Math.max(0, list.scrollHeight - height);
  }
  async function renderMessages(target, forceBottom) {
    target = target || view; if (!target || !alive(target)) return;
    var paint = ++target.paint, messages = target.messageSnapshot || await store.messages(target.conversation.id); target.messageSnapshot = messages;
    var editable = await app.services.context.editable(messages, target.conversation.id, target.conversation.recentFullMessages || 10);
    var visibleStart = Math.max(0, messages.length - target.messageRenderLimit), visibleMessages = messages.slice(visibleStart);
    var nodes = [], cache = {}, createdUrls = [], lastDate = '';
    if (!messages.length) {
      var empty = document.createElement('div'); empty.className = 'chat-welcome';
      var participants = target.conversation.roleIds.map(function (id) { return target.roleMap[id]; }).filter(Boolean);
      empty.innerHTML = '<div class="chat-welcome-avatars">' + participants.slice(0, 3).map(function (role) { return ui.roleAvatar(role, 'large'); }).join('') + '</div><h2>聊点什么？</h2><p>' + u.escapeHtml(participants.length === 1 ? '从一个问题或想法开始。' : '点选本轮回答的角色，让不同视角一起参与。') + '</p><div class="starter-list"><button class="starter" type="button">介绍一下你自己</button><button class="starter" type="button">帮我梳理一个想法</button><button class="starter" type="button">我们一起制定一个计划</button></div>';
      empty.querySelectorAll('.starter').forEach(function (button) { button.addEventListener('click', function () { if (target.draft.text.trim()) { document.getElementById('messageInput').focus(); return; } target.draft.text = button.textContent; var input = document.getElementById('messageInput'); input.value = target.draft.text; input.dispatchEvent(new Event('input')); input.focus(); }); }); nodes.push(empty);
    }
    if (visibleStart > 0) {
      var historyControl = document.createElement('div'); historyControl.className = 'history-window-control';
      var loadEarlier = document.createElement('button'); loadEarlier.type = 'button'; loadEarlier.className = 'button ghost'; loadEarlier.innerHTML = ui.icon('clock-rotate-left') + '<span>加载更早消息 · 还有 ' + visibleStart + ' 条</span>';
      loadEarlier.addEventListener('click', ui.action(function () { return loadEarlierMessages(target); })); historyControl.appendChild(loadEarlier); nodes.push(historyControl);
    }
    for (var i = 0; i < visibleMessages.length; i += 1) {
      var message = visibleMessages[i];
      var date = new Date(message.createdAt).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
      if (date !== lastDate) { var separator = document.createElement('div'); separator.className = 'date-divider'; separator.textContent = date; nodes.push(separator); lastDate = date; }
      var signature = JSON.stringify(message) + String(Boolean(editable[message.id])) + ((message.status === "error" || message.status === "cancelled") ? String(currentBusy(target)) : ""), cached = target.messageCache[message.id], messageUrls = [];
      var node = cached && cached.signature === signature ? cached.node : await messageElement(message, target, messageUrls, Boolean(editable[message.id]));
      if (messageUrls.length) createdUrls = createdUrls.concat(messageUrls);
      cache[message.id] = cached && cached.signature === signature ? cached : { signature: signature, node: node, urls: messageUrls }; nodes.push(node);
    }
    if (target.routing) nodes.push(routingIndicator());
    if (!alive(target) || paint !== target.paint) { revoke(createdUrls); return; }
    var list = document.getElementById('messageList'), top = list.scrollTop, inner = document.getElementById('messageListInner');
    Object.keys(target.messageCache).forEach(function (id) { if (cache[id] !== target.messageCache[id]) revoke((target.messageCache[id].urls || []).slice()); });
    target.messageCache = cache; target.urls = Object.keys(cache).reduce(function (all, id) { return all.concat(cache[id].urls || []); }, []);
    var fragment = document.createDocumentFragment(); nodes.forEach(function (node) { fragment.appendChild(node); });
    inner.textContent = ''; inner.appendChild(fragment);
    ui.hydrateAvatars(inner);
    if (forceBottom || target.follow) requestAnimationFrame(function () { scrollBottom(target); }); else list.scrollTop = top;
  }
  async function messageElement(message, target, urls, editable) {
    var system = message.kind === 'system', user = message.kind === 'user', assistant = !system && !user, role = target.roleMap[message.roleId];
    var row = document.createElement('article'); row.className = 'message-row ' + (system ? 'system' : user ? 'user' : 'assistant'); row.dataset.messageId = message.id;
    if (assistant) {
      var avatar = await messageAvatar(role || { name: message.roleName || 'AI', avatarMediaId: '' }, 'message-avatar', target, 'role');
      if (target.conversation.kind === 'group' && role && role.id === moderatorRoleId(target.conversation)) avatar.classList.add('moderator-avatar-trigger');
      row.appendChild(avatar);
    }
    var block = document.createElement('div'); block.className = 'message-block';
    var name = document.createElement('div'); name.className = 'message-name'; name.textContent = system ? '系统' : user ? target.userProfile.name || '我' : role ? role.name : message.roleName || 'AI'; block.appendChild(name);
    var bubble = document.createElement('div'); bubble.className = 'message-bubble';
    for (var i = 0; i < (message.media || []).length; i += 1) {
      var media = message.media[i], src = '';
      try {
        if (media.mediaId) { var record = await app.data.media.get(media.mediaId); if (record) { src = URL.createObjectURL(record.blob); urls.push(src); } }
        else if (u.isAllowedImageUrl(media.url)) src = media.url;
      } catch (_) {}
      var mediaKind = media.kind || (/^video\//i.test(media.mime || '') ? 'video' : 'image');
      if (mediaKind === 'video') {
        var videoCard = document.createElement('div'); videoCard.className = 'message-video-card';
        if (media.previewDataUrl) { var preview = document.createElement('img'); preview.src = media.previewDataUrl; preview.alt = ''; videoCard.appendChild(preview); }
        var videoCopy = document.createElement('span'); videoCopy.innerHTML = ui.icon('video') + '<span><strong>' + u.escapeHtml(media.name || '视频') + '</strong><small>' + (media.size ? Math.ceil(media.size / 1024 / 1024) + ' MiB' : '视频附件') + '</small></span>'; videoCard.appendChild(videoCopy);
        bubble.appendChild(videoCard); continue;
      }
      if (!src) { var missing = document.createElement('p'); missing.className = 'helper'; missing.textContent = '图片不可用，文字记录仍保留'; bubble.appendChild(missing); continue; }
      var imageButton = document.createElement('button'); imageButton.type = 'button'; imageButton.className = 'message-image'; imageButton.setAttribute('aria-label', '查看完整图片');
      var image = document.createElement('img'); image.alt = media.alt || '对话图片'; image.referrerPolicy = 'no-referrer'; image.src = src;
      image.onload = function () { if (target.follow) scrollBottom(target); };
      image.onerror = function () { this.alt = '图片加载失败'; this.parentNode.setAttribute('aria-label', '图片加载失败'); };
      imageButton.appendChild(image);
      imageButton.addEventListener('click', function (event) { var selected = event.currentTarget.querySelector('img'); ui.openModal({ title: '查看图片', cancelText: null, submitText: '关闭', html: '<img class="image-preview" referrerpolicy="no-referrer" src="' + u.escapeHtml(selected.src) + '" alt="完整对话图片">', onSubmit: function () {} }); }); bubble.appendChild(imageButton);
    }
    if (message.status === 'pending') { var typing = document.createElement('div'); typing.className = 'typing-bubble'; typing.setAttribute('aria-label', '正在生成回复'); typing.innerHTML = '<span></span><span></span><span></span>'; bubble.appendChild(typing); }
    if (message.text) { var text = document.createElement('div'); text.className = 'message-text'; text.textContent = displayText(message.text); bubble.appendChild(text); }
    if (message.status === 'error' || message.status === 'cancelled') {
      var error = document.createElement('p'); error.className = 'message-error'; error.textContent = message.error || '生成失败'; bubble.appendChild(error);
      var retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button ghost'; retry.textContent = '重试这条回复'; retry.disabled = currentBusy(target);
      retry.addEventListener('click', function () { run(target, { retryId: message.id }); }); bubble.appendChild(retry);
    }
    block.appendChild(bubble);
    var meta = document.createElement('div'); meta.className = 'message-meta';
    var time = document.createElement('time'); time.textContent = u.formatTime(message.createdAt); meta.appendChild(time);
    if (message.contextTrimmed) { var note = document.createElement('span'); note.className = 'context-badge'; note.textContent = message.contextCompressed ? '含压缩上下文' : '仅最近 N 条'; note.title = message.contextCompressed ? '这次请求使用了压缩历史和最近完整消息' : '更早消息没有包含在这次请求中'; meta.appendChild(note); }
    if (assistant && message.streamFallback) { var fallback = document.createElement('span'); fallback.className = 'context-badge'; fallback.textContent = '兼容输出'; fallback.title = '服务或 WebView 没有提供可读取的响应流，本次使用完整响应'; meta.appendChild(fallback); }
    if (message.text) {
      var copy = document.createElement('button'); copy.type = 'button'; copy.className = 'icon-button'; copy.setAttribute('aria-label', '复制这条消息'); copy.innerHTML = ui.icon('copy'); copy.addEventListener('click', ui.action(async function () { await app.platform.hermit.copyText(message.text); ui.toast('已复制'); })); meta.appendChild(copy);
      if (assistant && (message.status === 'done' || app.services.tts.canResume(message.id))) { var speak = document.createElement('button'); speak.type = 'button'; speak.className = 'icon-button'; speak.dataset.ttsMessage = message.id; var ready = app.services.tts.hasReady(message.id), resumable = app.services.tts.canResume(message.id); speak.setAttribute('aria-label', resumable ? '继续流式朗读' : ready ? '播放已生成的朗读音频' : '朗读这条回复'); speak.innerHTML = ui.icon(resumable || ready ? 'play' : 'volume-high'); speak.addEventListener('click', ui.action(async function () { if (await app.services.tts.resume(message.id)) return; if (await app.services.tts.playReady(message.id)) return; return app.services.tts.speak(message.text, role); })); meta.appendChild(speak); }
    }
    if (editable && message.status === 'done') { var edit = document.createElement('button'); edit.type = 'button'; edit.className = 'icon-button'; edit.setAttribute('aria-label', '编辑这条消息'); edit.innerHTML = ui.icon('pencil'); edit.addEventListener('click', ui.action(function () { return editMessage(target, message); })); meta.appendChild(edit); }
    if (assistant && editable && message.status === 'done') { var regenerate = document.createElement('button'); regenerate.type = 'button'; regenerate.className = 'icon-button'; regenerate.dataset.regenerateMessage = message.id; regenerate.setAttribute('aria-label', '重新生成这条回复'); regenerate.innerHTML = ui.icon('rotate-right'); regenerate.addEventListener('click', ui.action(function () { return regenerateMessage(target, message); })); meta.appendChild(regenerate); }
    block.appendChild(meta); row.appendChild(block); if (user) row.appendChild(await messageAvatar(target.userProfile, 'message-avatar user-message-avatar', target, 'user')); return row;
  }
  async function messageAvatar(profile, className, target, owner) {
    profile = profile || {};
    var name = profile.name || (owner === 'user' ? '我' : '角色'), source = '';
    if (profile.avatarMediaId) {
      if (Object.prototype.hasOwnProperty.call(target.avatarSources, profile.avatarMediaId)) source = target.avatarSources[profile.avatarMediaId];
      else try { source = await app.data.media.toDataUrl(profile.avatarMediaId) || ''; target.avatarSources[profile.avatarMediaId] = source; } catch (_) { target.avatarSources[profile.avatarMediaId] = ''; }
    }
    var holder = document.createElement('div'); holder.innerHTML = ui.avatar(name, '', className);
    var avatar = holder.firstElementChild;
    if (source) { var image = document.createElement('img'); image.src = source; image.alt = ''; image.draggable = false; image.loading = 'lazy'; avatar.textContent = ''; avatar.appendChild(image); }
    if (owner === 'role' && !profile.id) return avatar;
    var button = document.createElement('button'); button.type = 'button'; button.className = 'message-avatar-trigger ' + (owner === 'user' ? 'user-message-avatar-trigger' : 'role-message-avatar-trigger');
    button.appendChild(avatar);
    if (owner === 'role') {
      button.dataset.editChatRole = profile.id; button.setAttribute('aria-label', '编辑角色' + name);
      button.addEventListener('click', ui.action(function (event) { event.preventDefault(); event.stopPropagation(); return editChatRole(profile.id, target); }));
    } else {
      button.dataset.editConversationProfile = 'user'; button.setAttribute('aria-label', '编辑本对话个人设定');
      button.addEventListener('click', ui.action(function (event) { event.preventDefault(); event.stopPropagation(); return editConversationProfile(target); }));
    }
    return button;
  }
  async function editConversationProfile(target) {
    if (!alive(target)) return;
    var conversation = await store.get('conversations', target.conversation.id);
    if (!conversation || !alive(target)) { ui.toast('这个对话已不存在'); return; }
    return app.features.conversations.openPersonalProfile(conversation, async function (next) {
      if (!alive(target)) return;
      target.conversation = next;
      target.userProfile = app.services.profiles.userForConversation(next, target.globalUserProfile);
      target.avatarSources = {};
      revoke(target.urls); target.urls = [];
      target.messageCache = {};
      await renderMessages(target, false);
      status(target, '个人设定已更新，将从下一次回复开始生效');
    });
  }
  async function editChatRole(roleId, target) {
    if (!alive(target)) return;
    var role = await store.get('roles', roleId);
    if (!role || !alive(target)) { ui.toast('这个角色已不存在'); return; }
    return app.features.roles.openEditor(role, async function (next) {
      if (!alive(target)) return;
      target.roleMap[next.id] = next;
      target.profiles = await store.list('llm-profiles');
      target.avatarSources = {};
      revoke(target.urls); target.urls = [];
      target.messageCache = {};
      var names = target.conversation.roleIds.map(function (id) { return target.roleMap[id]; }).filter(Boolean).map(function (item) { return item.name; });
      document.getElementById('pageSubtitle').textContent = names.join('、');
      var mention = document.querySelector('[data-role-toggle="' + String(next.id).replace(/"/g, '\\"') + '"]');
      if (mention) { mention.title = next.name; mention.innerHTML = ui.roleAvatar(next, 'tiny mention-avatar') + '<span class="mention-name">' + u.escapeHtml(shortRoleName(next.name)) + '</span>'; await ui.hydrateAvatars(mention); }
      await renderMessages(target, false); syncComposer(target); status(target, '角色设置已更新，将从下一次回复开始生效');
    });
  }
  async function send(target) {
    if (!alive(target) || target.io || target.speechStarting || target.speechId || currentBusy(target)) return;
    target.io = true; syncComposer(target);
    try { await flushDraft(target); target.follow = true; await run(target, { userMessageId: target.draft.messageId, text: target.draft.text, media: target.draft.media.slice(), roleIds: target.selected.slice(), continueOnly: target.conversation.kind === 'group' && !target.draft.text.trim() && !target.draft.media.length }); }
    catch (error) { showError(error); status(target, '发送未完成，已保存的内容仍然保留'); }
    finally { target.io = false; syncComposer(target); }
  }
  async function run(target, options) {
    if (!alive(target) || currentBusy(target)) return;
    target.job = session.run(target.conversation.id, options);
    syncComposer(target);
    try { await target.job; } catch (error) { showError(error); status(target, u.cleanError(error)); }
    finally { target.job = null; syncComposer(target); }
  }
  async function addMedia(target, media) {
    if (!alive(target)) { await store.releaseMedia([media]); return; }
    target.draft.media.push(media);
    await flushDraft(target); await renderDraft(target); syncComposer(target);
  }
  async function addFiles(target, files) {
    if (!alive(target) || target.io || currentBusy(target)) return;
    if (target.draft.media.length + files.length > 4) throw new Error('每条消息最多选择四张图片');
    target.io = true; syncComposer(target);
    try { for (var i = 0; i < files.length; i += 1) await addMedia(target, await app.services.images.compress(files[i])); }
    finally { target.io = false; if (alive(target)) { await renderDraft(target); syncComposer(target); } }
  }
  async function chooseMedia(target) {
    target.mediaCapabilities = await selectedMediaCapabilities(target);
    var items = [];
    if (target.mediaCapabilities.image) items.push({ id: 'image', name: '选择图片' });
    if (target.mediaCapabilities.video) items.push({ id: 'video', name: '选择视频' });
    if (!items.length) { ui.toast('本轮角色的模型没有可用的图片或视频输入能力'); return; }
    var choice = items.length === 1 ? items[0].id : await ui.choose({ title: '添加到消息', items: items });
    if (choice === 'image') return chooseImage(target);
    if (choice === 'video') return chooseVideo(target);
  }
  async function chooseImage(target) {
    if (!target.mediaCapabilities.image) throw new Error('本轮角色的模型没有确认图片输入能力');
    if (target.draft.media.length >= 4) { ui.toast('每条消息最多选择四张图片'); return; }
    if (!app.platform.hermit.available()) { document.getElementById('imagePicker').click(); return; }
    target.io = true; syncComposer(target);
    try {
      var selected = await app.platform.hermit.api().files.pickImage({ maxDimension: 1280, maxBytes: 420 * 1024 });
      if (!selected || selected.cancelled || !alive(target)) return;
      var parts = u.dataUrlToParts(selected.dataUrl);
      if (!parts || !u.isAllowedImageUrl(selected.dataUrl)) throw new Error('没有取得可用图片');
      var blob = u.base64ToBlob(parts.data, parts.mime), record = await app.data.media.put(blob, { name: selected.name || 'image.jpg', mime: parts.mime });
      await addMedia(target, { mediaId: record.id, mime: record.mime, size: blob.size, alt: '用户选择的图片' });
    } finally { target.io = false; syncComposer(target); }
  }
  async function addBrowserVideo(target, file) {
    if (!target.mediaCapabilities.video) throw new Error('本轮角色的模型或当前接入方式不能接收视频');
    if (!/^video\/(mp4|webm|quicktime)$/i.test(file.type || '')) throw new Error('请选择 MP4、WebM 或 MOV 视频');
    if (file.size > 64 * 1024 * 1024) throw new Error('视频超过 64 MiB，请先压缩或裁剪');
    var record = await app.data.media.put(file, { name: file.name || 'video', mime: file.type, kind: 'video' });
    await addMedia(target, { kind: 'video', mediaId: record.id, mime: record.mime, name: record.name, size: file.size });
  }
  async function chooseVideo(target) {
    if (!target.mediaCapabilities.video) throw new Error('本轮角色的模型或当前接入方式不能接收视频');
    if ((target.draft.media || []).some(function (item) { return (item.kind || '').toLowerCase() === 'video'; })) throw new Error('每条消息最多选择一段视频');
    if (!app.platform.hermit.available()) { document.getElementById('videoPicker').click(); return; }
    target.io = true; syncComposer(target);
    try {
      var selected = await app.platform.hermit.api().files.import({ accept: 'video/*' });
      if (!selected || selected.cancelled || !alive(target)) return;
      if (!/^video\//i.test(selected.mime || '')) throw new Error('所选文件不是视频');
      await addMedia(target, {
        kind: 'video', logicalFileId: selected.logicalFileId, mime: selected.mime,
        name: selected.name || 'video', size: Number(selected.size || 0), sha256: selected.sha256 || '',
        duration: Number(selected.durationMs || 0), width: Number(selected.width || 0), height: Number(selected.height || 0),
        previewDataUrl: selected.previewDataUrl || ''
      });
    } finally { target.io = false; syncComposer(target); }
  }
  async function renderDraft(target) {
    if (!alive(target)) return;
    var paint = ++revision, fragment = document.createDocumentFragment(), urls = [];
    for (var i = 0; i < target.draft.media.length; i += 1) {
      var media = target.draft.media[i], record = media.mediaId ? await app.data.media.get(media.mediaId) : null;
      var item = document.createElement('div'); item.className = 'attachment';
      if ((media.kind || '').toLowerCase() === 'video') {
        item.classList.add('video-attachment');
        if (media.previewDataUrl) { var thumb = document.createElement('img'); thumb.src = media.previewDataUrl; thumb.alt = ''; item.appendChild(thumb); }
        var label = document.createElement('span'); label.innerHTML = ui.icon('video') + '<small>' + u.escapeHtml(media.name || '视频') + '</small>'; item.appendChild(label);
      } else if (record) { var image = document.createElement('img'); image.src = URL.createObjectURL(record.blob); urls.push(image.src); image.alt = '待发送图片 ' + (i + 1); item.appendChild(image); }
      else item.textContent = '媒体丢失';
      var remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button'; remove.dataset.mediaKey = mediaKey(media); remove.setAttribute('aria-label', '移除待发送附件'); remove.innerHTML = ui.icon('xmark');
      remove.addEventListener('click', ui.action(async function (event) { if (currentBusy(target)) return; var key = event.currentTarget.dataset.mediaKey, removed = target.draft.media.filter(function (entry) { return mediaKey(entry) === key; }); target.draft.media = target.draft.media.filter(function (entry) { return mediaKey(entry) !== key; }); await flushDraft(target); await store.releaseMedia(removed); await renderDraft(target); syncComposer(target); })); item.appendChild(remove); fragment.appendChild(item);
    }
    if (!alive(target) || paint !== revision) { revoke(urls); return; }
    revoke(target.draftUrls); target.draftUrls = urls;
    var tray = document.getElementById('attachmentTray'); tray.textContent = ''; tray.appendChild(fragment); tray.classList.toggle('is-hidden', !target.draft.media.length);
  }
  async function applyMessageEdit(target, message, text) {
    await app.services.tts.invalidate(message.id);
    message.text = text; message.editedAt = Date.now();
    await store.putMessage(message);
    target.messageSnapshot = null; await session.refreshPreview(target.conversation.id); await renderMessages(target, false);
    ui.toast('消息已保存');
  }
  async function editMessage(target, original) {
    if (currentBusy(target)) { ui.toast('请先停止当前回复'); return; }
    var messages = await store.messages(target.conversation.id), index = messages.findIndex(function (item) { return item.id === original.id; });
    if (index < 0) throw new Error('消息不存在');
    var editable = await app.services.context.editable(messages, target.conversation.id, target.conversation.recentFullMessages || 10);
    if (!editable[original.id]) throw new Error('这条消息已经进入压缩历史，不能再修改');
    var system = original.kind === 'system';
    ui.openModal({ title: system ? '编辑场景开场白' : original.kind === 'user' ? '编辑我的消息' : '编辑角色回复', submitText: '保存', html: '<div class="form-grid"><label class="field"><span>消息内容</span><textarea name="text" maxlength="16000">' + u.escapeHtml(original.text || '') + '</textarea></label><p class="helper">这里只保存消息内容，不会自动重新生成或删除后续消息。' + (system ? '这条场景消息仍会按普通历史参与压缩。' : original.kind === 'user' ? '' : '角色回复可在保存后使用气泡下方的重新生成按钮。') + '</p></div>', onSubmit: async function (form) {
      var text = u.formValue(form, 'text');
      if (!text && !(original.media || []).length) throw new Error('消息内容不能为空');
      await applyMessageEdit(target, Object.assign({}, original), text); return true;
    } });
  }
  async function regenerateMessage(target, original) {
    if (currentBusy(target)) { ui.toast('请先停止当前回复'); return; }
    var messages = await store.messages(target.conversation.id), index = messages.findIndex(function (item) { return item.id === original.id; });
    if (index < 0) throw new Error('消息不存在');
    var editable = await app.services.context.editable(messages, target.conversation.id, target.conversation.recentFullMessages || 10);
    if (!editable[original.id]) throw new Error('这条回复已经进入压缩历史，不能再重新生成');
    if (index < messages.length - 1) {
      var confirmed = await ui.confirm({ title: '删除后续消息并重新生成？', message: '这条回复之后的所有消息，包括用户消息和任何角色的回复，都会从当前设备删除，然后由当前角色重新生成。此操作无法撤销。', confirmText: '删除并重新生成', danger: true });
      if (!confirmed) return;
      await store.deleteMessagesAfter(target.conversation.id, original.createdAt, false);
    }
    await app.services.tts.invalidateMany(messages.slice(index).map(function (message) { return message.id; }));
    var oldMediaIds = (original.media || []).map(function (item) { return item.mediaId; }).filter(Boolean);
    var next = Object.assign({}, original, { text: '', media: [], status: 'error', error: '准备重新生成', regeneratedAt: Date.now() });
    await store.putMessage(next);
    await store.releaseMedia(oldMediaIds);
    target.messageSnapshot = null; await session.refreshPreview(target.conversation.id); target.follow = true; await renderMessages(target, true);
    await run(target, { retryId: next.id });
  }
  async function editSummaries(target) {
    var summaries = await app.services.context.list(target.conversation.id);
    if (!summaries.length) { ui.toast('这个对话还没有生成压缩上下文'); return; }
    var html = '<div class="form-grid"><p class="helper">这是所有参与角色共同使用的对话摘要。修改后将从下一次回复开始生效。</p>' + summaries.map(function (summary, index) {
      return '<label class="field"><span>已压缩 ' + Number(summary.sourceMessageCount || 0) + ' 条 · 由 ' + u.escapeHtml(summary.compressedByRoleName || '角色') + ' 最近更新</span><textarea class="prompt-editor" name="summary' + index + '" required maxlength="8000">' + u.escapeHtml(summary.text) + '</textarea></label>';
    }).join('') + '</div>';
    ui.openModal({ title: '编辑压缩上下文', submitText: '保存压缩内容', html: html, onSubmit: async function (form) {
      for (var i = 0; i < summaries.length; i += 1) { var text = u.formValue(form, 'summary' + i); if (!text) throw new Error('压缩内容不能为空'); summaries[i].text = text; summaries[i].updatedAt = Date.now(); summaries[i].editedAt = Date.now(); await store.put('summaries', summaries[i].id, summaries[i]); }
      return true;
    }, onSuccess: function () { ui.toast('压缩上下文已更新'); } });
  }
  async function voiceSettings(target) {
    var services = (await store.list('asr-profiles')).filter(function (item) { return item.enabled !== false; });
    var ttsServices = (await store.list('tts-profiles')).filter(function (item) { return item.enabled !== false; });
    var systemAsrCapability = await app.services.asr.systemCapability(true);
    var selectedId = target.conversation.asrProfileId || target.settings.defaultAsrProfileId;
    function serviceItems() { return [{ id: '', name: '跟随通用设置' }].concat(services.map(function (item) { var system = (item.family || item.type) === 'system'; return { id: item.id, name: item.name + (system && !systemAsrCapability.available ? ' · 当前不可用' : ''), disabled: system && !systemAsrCapability.available }; })); }
    function modelItems(service) { return app.services.modelServices.models('asr', service).map(function (item) { return { id: item.id, name: item.name || item.id }; }); }
    function languageItems(service, modelId) {
      var system = (service.family || service.type) === 'system';
      var values = system ? systemAsrCapability.languages || [] : (app.services.modelServices.modelDefinition('asr', service, modelId).languages || service.languages || []);
      var seen = {}; return values.filter(function (value) { value = String(value || '').trim(); if (!value || seen[value]) return false; seen[value] = true; return true; }).map(function (value) { return { id: value, name: value }; });
    }
    var selected = services.find(function (item) { return item.id === selectedId; }) || services[0] || {};
    var streamDetails = target.conversation.roleIds.map(function (roleId) {
      var role = target.roleMap[roleId] || {}, serviceId = role.ttsProfileId || target.settings.defaultTtsProfileId;
      var service = ttsServices.find(function (item) { return item.id === serviceId; });
      var profile = service ? app.services.modelServices.resolveTts(service, role, target.settings) : {};
      return { role: role, capabilities: app.services.modelServices.ttsCapabilities(service, profile.model) };
    });
    var streamSupported = streamDetails.length > 0 && streamDetails.every(function (item) { return item.capabilities.audioStreaming; });
    var someStreamSupported = streamDetails.some(function (item) { return item.capabilities.audioStreaming; });
    var textStreamSupported = streamDetails.some(function (item) { return item.capabilities.textStreaming; });
    var streamingNames = streamDetails.filter(function (item) { return item.capabilities.audioStreaming; }).map(function (item) { return item.role.name; }).filter(Boolean);
    var unsupportedNames = streamDetails.filter(function (item) { return !item.capabilities.audioStreaming; }).map(function (item) { return item.role.name; }).filter(Boolean);
    var autoSpeak = target.conversation.autoSpeak == null ? Boolean(target.settings.autoSpeak) : Boolean(target.conversation.autoSpeak);
    var streamTitle = streamSupported ? '流式播放 · 自动启用' : someStreamSupported ? '按回复角色自动选择' : '完整音频播放';
    var streamHelp = someStreamSupported ? '支持流式音频的角色' + (streamingNames.length ? '（' + streamingNames.join('、') + '）' : '') + '会在约三秒音频到达后自动开始；' + (unsupportedNames.length ? '其余角色（' + unsupportedNames.join('、') + '）等待完整音频。' : '') + (textStreamSupported ? '支持增量文字的模型会在语言模型形成完整段落后立即持续提交。' : '当前模型按段提交完整文字，每段音频仍会边生成边播放。') : '当前角色的朗读模型不支持流式音频，将在完整音频生成后播放。';
    var form = ui.openModal({ title: '本对话语音与朗读', submitText: '保存设置', html: '<div class="form-grid"><section class="editor-section"><h3>回复朗读</h3><label class="switch-row"><span><strong>自动朗读</strong><small>开启后自动播放每轮最后一位角色的回复</small></span><input name="autoSpeak" type="checkbox"' + (autoSpeak ? ' checked' : '') + '></label><div class="capability-note" id="streamTtsPlaybackStatus"><strong>' + u.escapeHtml(streamTitle) + '</strong><small>' + u.escapeHtml(streamHelp) + '</small></div></section><section class="editor-section"><h3>语音输入</h3>' + ui.picker('asrProfileId', '语音输入服务', '') + '<div class="capability-note is-hidden" id="conversationAsrStatus"></div><div id="conversationAsrModelField">' + ui.picker('asrModel', '识别模型', '') + '</div><div id="conversationAsrLanguageField">' + ui.picker('asrLanguage', '识别语言', '', '只显示当前服务明确提供的语言') + '</div><p class="helper">没有公开模型或语言目录时会跟随服务默认值，不生成猜测选项。</p></section></div>', onSubmit: async function (sheet) {
      var next = await store.get('conversations', target.conversation.id); next.autoSpeak = u.checked(sheet, 'autoSpeak'); delete next.streamTtsPlayback; next.asrProfileId = u.formValue(sheet, 'asrProfileId'); next.asrModel = next.asrProfileId ? u.formValue(sheet, 'asrModel') : ''; next.asrLanguage = next.asrProfileId ? u.formValue(sheet, 'asrLanguage') : ''; next.updatedAt = Date.now(); await store.put('conversations', next.id, next); target.conversation = next; return next;
    }, onSuccess: async function () { target.asrCapability = await selectedAsrCapability(target); syncComposer(target); ui.toast('本对话语音设置已保存'); } });
    ui.bindPicker(form, 'asrProfileId', serviceItems(), target.conversation.asrProfileId || '', { allowEmpty: true });
    var modelPicker = ui.bindPicker(form, 'asrModel', modelItems(selected), target.conversation.asrModel || '', { allowEmpty: true });
    var languagePicker = ui.bindPicker(form, 'asrLanguage', [], target.conversation.asrLanguage || '', { allowEmpty: true });
    function syncAsr() {
      var inherited = !form.elements.namedItem('asrProfileId').value, id = form.elements.namedItem('asrProfileId').value || target.settings.defaultAsrProfileId;
      var service = services.find(function (item) { return item.id === id; }) || {}, system = (service.family || service.type) === 'system', models = modelItems(service);
      modelPicker.setItems(models, inherited ? '' : form.elements.namedItem('asrModel').value || (models[0] || {}).id || '');
      var modelId = form.elements.namedItem('asrModel').value || (models[0] || {}).id || '', languages = languageItems(service, modelId), requested = form.elements.namedItem('asrLanguage').value || service.language || '';
      languagePicker.setItems(languages, requested);
      form.querySelector('#conversationAsrModelField').classList.toggle('is-hidden', inherited || system || models.length < 2);
      form.querySelector('#conversationAsrLanguageField').classList.toggle('is-hidden', inherited || !languages.length);
      var note = form.querySelector('#conversationAsrStatus'); note.classList.toggle('is-hidden', !system || systemAsrCapability.available);
      if (system && !systemAsrCapability.available) note.innerHTML = '<strong>Android 系统语音识别不可用</strong><small>' + u.escapeHtml(systemAsrCapability.message || '当前设备没有向普通应用提供识别服务') + '</small>';
    }
    form.elements.namedItem('asrProfileId').addEventListener('change', function () { form.elements.namedItem('asrModel').value = ''; form.elements.namedItem('asrLanguage').value = ''; syncAsr(); }); form.elements.namedItem('asrModel').addEventListener('change', syncAsr); syncAsr();
    function syncReadout() { form.querySelector('#streamTtsPlaybackStatus').classList.toggle('is-disabled', !form.elements.namedItem('autoSpeak').checked); }
    form.elements.namedItem('autoSpeak').addEventListener('change', syncReadout); syncReadout();
  }
  async function manageChat(target) {
    var summaries = await app.services.context.list(target.conversation.id), conversation = await store.get('conversations', target.conversation.id);
    var form = ui.openModal({ title: conversation.title, submitText: '完成', cancelText: null, html: '<div class="menu-list"><button class="menu-item" type="button" data-chat-menu="edit">' + ui.icon('gear') + '<span>基础设定</span>' + ui.icon('chevron-right') + '</button><button class="menu-item" type="button" data-chat-menu="identity">' + ui.icon('gear') + '<span>个人设定</span>' + ui.icon('chevron-right') + '</button><button class="menu-item" type="button" data-chat-menu="scene">' + ui.icon('clapperboard') + '<span>场景设定</span>' + ui.icon('chevron-right') + '</button><button class="menu-item" type="button" data-chat-menu="voice">' + ui.icon('microphone') + '<span>本对话语音与朗读</span>' + ui.icon('chevron-right') + '</button><button class="menu-item" type="button" data-chat-menu="summary">' + ui.icon('compress') + '<span>压缩上下文' + (summaries.length ? ' · 已生成' : ' · 尚未生成') + '</span>' + ui.icon('chevron-right') + '</button><button class="menu-item" type="button" data-chat-menu="export">' + ui.icon('file-lines') + '<span>导出对话文字</span></button><button class="menu-item" type="button" data-chat-menu="pin">' + ui.icon('thumbtack') + '<span>' + (conversation.pinned ? '取消置顶' : '置顶对话') + '</span></button><button class="menu-item danger-text" type="button" data-chat-menu="delete">' + ui.icon('trash') + '<span>删除对话</span></button></div>', onSubmit: function () {} });
    form.querySelectorAll('[data-chat-menu]').forEach(function (button) { button.addEventListener('click', ui.action(async function () {
      var command = button.dataset.chatMenu; ui.closeModal();
      if (currentBusy(target) && (command === 'edit' || command === 'scene' || command === 'delete')) { ui.toast('请先停止本轮回复'); return; }
      if (command === 'edit') return app.features.conversations.openEditor(conversation);
      if (command === 'identity') return app.features.conversations.openPersonalProfile(conversation, function (next) { target.conversation = next; target.userProfile = app.services.profiles.userForConversation(next, target.globalUserProfile); target.avatarSources = {}; revoke(target.urls); target.urls = []; target.messageCache = {}; return renderMessages(target, false); });
      if (command === 'scene') return app.features.conversations.openSceneSettings(conversation, async function (result) { target.conversation = result.conversation || target.conversation; target.messageSnapshot = null; target.messageCache = {}; await renderMessages(target, true); });
      if (command === 'voice') return voiceSettings(target);
      if (command === 'summary') return editSummaries(target);
      if (command === 'export') return app.features.conversations.exportText(conversation.id);
      if (command === 'pin') { conversation.pinned = !conversation.pinned; await store.put('conversations', conversation.id, conversation); target.conversation = conversation; ui.toast(conversation.pinned ? '对话已置顶' : '已取消置顶'); }
      if (command === 'delete' && await ui.confirm({ title: '删除对话？', message: '消息、压缩内容、草稿和未被其他对话使用的图片将从当前设备删除。', confirmText: '删除对话', danger: true })) { await close(); await store.deleteConversation(conversation.id); await app.navigate('conversations'); ui.toast('对话已删除'); }
    })); });
  }
  async function transcribe(target, file) {
    if (!alive(target) || target.io) return;
    target.io = true; syncComposer(target); status(target, '正在识别音频…');
    try { var service = await store.get('asr-profiles', target.conversation.asrProfileId || target.settings.defaultAsrProfileId); var profile = app.services.modelServices.resolveAsr(service, target.conversation, target.settings); var text = await app.services.asr.transcribeFile(file, profile); appendTranscript(target, text); }
    catch (error) { showError(error); status(target, '识别失败，仍可输入文字'); }
    finally { target.io = false; syncComposer(target); }
  }
  function appendTranscript(target, text) {
    if (!alive(target)) return;
    var input = document.getElementById('messageInput');
    var combined = (input.value ? input.value + ' ' : '') + text;
    if (combined.length > input.maxLength) { ui.toast('识别结果超过输入上限，请先缩短草稿后重试', 4500); return; }
    input.value = combined; input.dispatchEvent(new Event('input')); status(target, '识别完成，请检查文字后发送');
  }
  async function handleSpeech(target) {
    if (!alive(target)) return;
    if (target.speechId) { await app.services.asr.stopSystem(target.speechId); status(target, '正在整理识别结果…'); return; }
    if (target.speechStarting || target.io || currentBusy(target)) return;
    target.speechStarting = true; syncComposer(target);
    try {
      var service = await store.get('asr-profiles', target.conversation.asrProfileId || target.settings.defaultAsrProfileId || 'system-asr');
      if (!service || service.enabled === false) throw new Error('请在模型页或本对话设置中选择可用的语音输入');
      var profile = app.services.modelServices.resolveAsr(service, target.conversation, target.settings);
      if (profile.type !== 'system') {
        target.speechStarting = false;
        if (!app.platform.hermit.available()) { document.getElementById('audioPicker').click(); return; }
        target.io = true; syncComposer(target); status(target, '请选择一段短音频…');
        var selected = await app.platform.hermit.api().files.pickInline({ accept: 'audio/*', maxBytes: 650 * 1024 });
        target.io = false;
        if (!selected || selected.cancelled || !alive(target)) { status(target, '已取消语音输入'); return; }
        var parts = u.dataUrlToParts(selected.dataUrl); if (!parts || !/^audio\//i.test(parts.mime)) throw new Error('所选文件不是有效音频');
        var file = u.base64ToBlob(parts.data, parts.mime); file.name = selected.name || 'audio.m4a'; await transcribe(target, file); return;
      }
      var ended = false;
      function finish(text) { ended = true; target.speechId = null; target.speechStarting = false; if (alive(target)) { var button = document.getElementById('micButton'); button.classList.remove('recording'); button.innerHTML = ui.icon('microphone'); button.setAttribute('aria-label', '语音输入'); if (text) status(target, text); syncComposer(target); } }
      status(target, '正在准备语音识别…');
      var subscription = await app.services.asr.startSystem(profile, {
        ready: function () { status(target, '请开始说话'); }, begin: function () { status(target, '正在聆听，点击语音按钮结束'); },
        partial: function (data) { if (data.alternatives && data.alternatives[0]) status(target, data.alternatives[0].text); },
        final: function (data) { if (data.alternatives && data.alternatives[0]) appendTranscript(target, data.alternatives[0].text); finish(); },
        error: function (data) { finish('识别失败：' + (data.message || data.code || '请稍后重试')); },
        end: function () { if (!ended) status(target, '正在整理识别结果…'); }
      });
      if (!alive(target)) { await app.services.asr.cancelSystem(); return; }
      if (!ended) { target.speechId = subscription; var button = document.getElementById('micButton'); button.classList.add('recording'); button.innerHTML = ui.icon('stop'); button.setAttribute('aria-label', '结束语音识别'); }
    } catch (error) { showError(error); status(target, '语音输入不可用，可继续输入文字或更换识别服务'); }
    finally { target.io = false; target.speechStarting = false; syncComposer(target); }
  }
  async function close() {
    var target = view; if (!target) return;
    await flushDraft(target);
    session.stop(target.conversation.id);
    target.closed = true; target.unsubscribe();
    if (target.speechId || target.speechStarting) await app.services.asr.cancelSystem().catch(function () {});
    await app.services.tts.stop().catch(function () {});
    if (target.job) await target.job.catch(function () {});
    view = null; app.state.activeConversationId = null;
    revoke(target.urls); revoke(target.draftUrls);
    document.getElementById('imagePicker').onchange = null; document.getElementById('videoPicker').onchange = null; document.getElementById('audioPicker').onchange = null;
  }
  document.addEventListener('visibilitychange', function () { if (document.hidden && view) flushDraft(view).catch(showError); });
  app.events.on('tts:error', function (event) { ui.toast(event.message, 5000); });
  app.events.on('tts:state', function (event) { if (view) { var button = document.getElementById('muteTtsButton'); if (button) { button.classList.toggle('voice-active', Boolean(event.speaking)); button.innerHTML = ui.icon(event.muted ? 'volume-xmark' : 'volume-high'); button.setAttribute('aria-label', event.muted ? '恢复自动朗读' : '静音自动朗读'); button.setAttribute('title', event.muted ? '恢复自动朗读' : '静音自动朗读'); } if (event.preparing) status(view, '正在准备完整朗读音频…'); else if (event.buffering) status(view, '正在生成朗读音频 · 已缓存约 ' + Math.floor(event.bufferedSeconds || 0) + ' 秒'); else if (event.paused) { status(view, '朗读已等待新音频，点击消息上的播放按钮继续'); ensureResumeButton(event.messageId); } else if (event.ready) { status(view, '朗读音频已准备，点击消息上的播放按钮播放'); renderMessages(view).catch(showError); } } });
  app.features = app.features || {};
  app.features.chat = { render: render, close: close, renderMessages: function () { if (view) view.messageSnapshot = null; return renderMessages(view); } };
})(window.chataxi);
