(function (app) {
  "use strict";
  var u = app.utils, ui = app.components, store = app.data.store, session = app.features.chatSession;
  var view = null;
  var revision = 0;
  var MESSAGE_RENDER_INITIAL = 120;
  var MESSAGE_RENDER_STEP = 100;
  function revoke(urls) { urls.splice(0).forEach(function (url) { URL.revokeObjectURL(url); }); }
  function alive(target) { return view === target && !target.closed; }

  // ── 消息列表里的缩略图：进视口才取地址、才加载（业主 2026-09-27 第五轮）────────────────
  // 之前是**渲染时就把每一张图的地址都取回来**：displayUrl 对每条 media 都要读一次库，
  // 整条渲染链又是串联的 ⇒ 进对话要等 O(N) 次读库才画出第一屏，紧接着所有 <img> 一起开抢。
  // 现在分两步：渲染时只摆一个 9:16 的占位盒（尺寸写死在 styles/app.css 的 [data-media-pending]），
  // 等它快进视口（上下各留 600px 余量）才解析地址、赋 src。可见的那两三张照旧立刻出来。
  var LAZY_ROOT_MARGIN = "600px 0px";
  // 按钮 → 这条 media。用 WeakMap 而不是把 media 挂在 DOM 上：节点被丢掉时引用跟着走，
  // 不需要额外清理（这也是下面观察器不 retain 按钮的原因）。
  var lazyMedia = new WeakMap();
  var lazyObserver = null;

  // 观察器是**单例**：一个对话里同时只可能有一份列表。
  // 注意没有 IntersectionObserver 时返回 null **且不缓存** —— 老引擎上必须先退化成"立刻加载"，
  // 否则图片永远不出来；而同一个进程里后来有了这个能力（测试环境就是这种情形）还得能建起来。
  function imageLazy() {
    if (lazyObserver || typeof IntersectionObserver !== "function") return lazyObserver;
    lazyObserver = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i += 1) {
        var target = entries[i].target;
        // 节点已经被下一次渲染换掉了 —— 顺手摘掉，别让观察器攥着一个下线的按钮不放。
        if (!target.isConnected) { lazyObserver.unobserve(target); continue; }
        if (entries[i].isIntersecting) loadThumb(target);
      }
    }, { rootMargin: LAZY_ROOT_MARGIN });
    return lazyObserver;
  }

  // 真正去取这一张。只做一次：第一次相交时观察器就把它摘掉了，重复调用会被 pending 挡住。
  function loadThumb(button) {
    if (lazyObserver) lazyObserver.unobserve(button);
    if (button.dataset.mediaPending !== "1") return;
    button.dataset.mediaPending = "2";
    var media = lazyMedia.get(button), image = button.querySelector("img");
    app.data.media.displayUrl(media).catch(function () { return ""; }).then(function (src) {
      // 地址是异步来的，回来时这一格可能已经下线了（用户退出对话、或列表重画）——安静收手。
      if (!button.isConnected || button.dataset.mediaPending !== "2") return;
      if (!src && media && media.url && u.isAllowedImageUrl(media.url)) src = media.url;
      if (!src) { unavailableThumb(button); return; }
      image.src = src;
    });
  }

  // 取不到地址（旧记录、文件已释放）时保持原来的样子：一行说明，而不是一个永远转不出来的灰块。
  // 这件事从"渲染时"挪到了"进视口时"，所以在列表里是随着滚动才出现的 —— 那是符合直觉的：
  // 没看到的那几张，用户本来也不知道它们坏没坏。
  function unavailableThumb(button) {
    var missing = document.createElement('p'); missing.className = 'helper'; missing.textContent = '图片不可用，文字记录仍保留';
    if (button.parentNode) button.parentNode.replaceChild(missing, button);
    button.removeAttribute('data-media-pending');
  }

  // 渲染完成后把这一批缩略图交给观察器。**放在 appendChild 之后**：让引擎按它们"现在在哪儿"
  // 一次算完，比一边建节点一边逐个 observe（每个都各自量一次）便宜得多。
  // 缓存命中的节点是同一个 DOM 节点，重复 observe 没有副作用；已经加载完的则不再带
  // data-media-pending，天然不会被选中。
  function watchThumbs(root) {
    var observer = imageLazy(), thumbs = root.querySelectorAll('.message-image[data-media-pending="1"]');
    for (var i = 0; i < thumbs.length; i += 1) {
      if (observer) observer.observe(thumbs[i]);
      else loadThumb(thumbs[i]);
    }
  }

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
    main.innerHTML = '<section class="chat-layout"><div class="message-viewport"><div class="message-list" id="messageList" aria-label="对话消息"><div class="message-list-inner" id="messageListInner"></div></div><div class="message-fade is-top" aria-hidden="true"></div><div class="message-fade is-bottom" aria-hidden="true"></div><button type="button" class="button secondary jump-latest is-hidden" id="jumpLatest">' + ui.icon('arrow-down') + '回到最新</button></div><div class="composer"><div class="composer-inner"><div class="attachment-tray is-hidden" id="attachmentTray"></div><div class="composer-box">' + (conversation.kind === 'group' ? '<div class="composer-recipients"><span class="recipient-at" aria-label="艾特一位角色">@</span><div class="mention-strip" role="group" aria-label="选择本轮回复角色">' + participants.map(function (role) { return '<button class="chip mention-chip" type="button" data-role-toggle="' + u.escapeHtml(role.id) + '" data-moderator="' + String(role.id === moderatorRoleId(conversation)) + '" aria-pressed="' + (target.selected.indexOf(role.id) >= 0) + '" title="' + u.escapeHtml(role.name) + '">' + ui.roleAvatar(role, 'tiny mention-avatar') + '<span class="mention-name">' + u.escapeHtml(shortRoleName(role.name)) + '</span></button>'; }).join('') + '</div><button class="auto-role-toggle" type="button" id="autoRoleToggle" role="switch" aria-checked="' + String(target.autoSelectRole) + '" aria-label="自动选择回复角色" title="自动选择回复角色">' + ui.icon('wand-magic-sparkles') + '</button></div>' : '') + '<textarea id="messageInput" rows="1" maxlength="16000" placeholder="把你的想法写在这里…" aria-label="消息内容"></textarea><div class="composer-toolbar"><div class="row composer-tools"><button class="icon-button" type="button" id="imageButton" aria-label="添加图片或视频" title="添加图片或视频">' + ui.icon('paperclip') + '</button><button class="icon-button" type="button" id="micButton" aria-label="语音输入" title="语音输入">' + ui.icon('microphone') + '</button><span class="composer-hint" id="composerHint"></span></div><button type="button" class="icon-button send-button" id="sendButton" aria-label="发送消息">' + ui.icon('arrow-up') + '</button></div></div><div class="composer-footer"><span id="composerStatus" role="status" aria-live="polite"></span><span id="draftStatus"></span></div></div></div></section>';
    ui.hydrateAvatars(main);
    // 打开这个对话 = 它就是"最近使用的对话", 全局背景随之换成它的（没有设置就清掉）。
    rememberConversation(id);
    applyAppBackground(conversation.background);
    var input = document.getElementById('messageInput'); input.value = target.draft.text || '';
    resizeInput(input);
    // 输入区浮在消息列表之上（列表铺满整屏）, 所以列表底部留白与下边那条渐隐带都要知道它的真实高度。
    // 高度是动态的（多行草稿、附件托盘、群聊角色条、朗读状态行都会让它变）, 所以量而不是写死:
    // ResizeObserver 盯住它, 再加一道窗口尺寸兜底, 结果写回 --chat-composer-h。
    var composer = main.querySelector('.composer'), layout = main.querySelector('.chat-layout');
    target.syncComposerInset = function () {
      if (!composer || !layout || !composer.offsetHeight) return;
      layout.style.setProperty('--chat-composer-h', composer.offsetHeight + 'px');
    };
    target.syncComposerInset();
    requestAnimationFrame(target.syncComposerInset);
    if (window.ResizeObserver) { target.composerObserver = new ResizeObserver(target.syncComposerInset); target.composerObserver.observe(composer); }
    window.addEventListener('resize', target.syncComposerInset);
    // 沉浸模式：把界面上所有控件收掉, 只留背景。隐的三块是顶栏 / 消息列表 / 输入区, 视觉与命中
    // 全在 CSS 的 .chat-chrome-hidden 里, 这里只负责"什么时候切"。
    //
    // **不对称的手势**（业主 2026-09-27 第二轮: "点按空白隐藏 UI 控件, 改为长按空白处隐藏,
    // 恢复显示只要点击不需长按"）:
    //   * 藏起来 = 长按 500ms。原来是一点就藏, 于是滚动时手指落下的那一下、想点气泡边缘却点空
    //     的那一下都会把界面收掉; 按住半秒才是"我真的要沉浸"。
    //   * 恢复 = 轻点。隐着的时候列表与输入区都不吃点击（pointer-events: none）, 所以恢复的那次
    //     点击必然落在 .chat-layout 上 —— 判据仍然只有一条, 不需要第二套定位逻辑。
    // 判"空白"用一支黑名单选择器: 气泡、头像、消息上的按钮、欢迎面板都长在列表里面,
    // 点它们不能顺手把界面藏起来。
    // **没有背景图时这一整套不存在**（业主 2026-09-27）: 那一条件在 setChromeHidden 里判,
    // 这里照常把"想藏"的意图递过去就行, 免得两处判据漂掉。
    target.chromeHidden = false;
    target.chromeRegions = [].slice.call(document.querySelectorAll('#appShell > .topbar, .message-viewport, .composer'));
    var LONG_PRESS_MS = 500, PRESS_SLOP = 12, pressTimer = 0, pressOrigin = null;
    function isBlank(node) { return !(node && node.nodeType === 1 && node.closest && node.closest('button, a, input, textarea, select, label, img, .avatar, .message-row, .chat-welcome')); }
    function cancelPress() { if (pressTimer) { clearTimeout(pressTimer); pressTimer = 0; } pressOrigin = null; }
    layout.addEventListener('pointerdown', function (event) {
      cancelPress();
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (!isBlank(event.target)) return;
      pressOrigin = { x: Number(event.clientX) || 0, y: Number(event.clientY) || 0 };
      pressTimer = setTimeout(function () { pressTimer = 0; pressOrigin = null; setChromeHidden(target, true); }, LONG_PRESS_MS);
    });
    // 手指挪动超过一丁点就当滚动/拖拽, 不再是长按 —— 否则滑动列表时界面会莫名其妙地消失。
    layout.addEventListener('pointermove', function (event) {
      if (!pressOrigin) return;
      if (Math.abs((Number(event.clientX) || 0) - pressOrigin.x) > PRESS_SLOP || Math.abs((Number(event.clientY) || 0) - pressOrigin.y) > PRESS_SLOP) cancelPress();
    });
    layout.addEventListener('pointerup', function () {
      var pending = Boolean(pressTimer);
      cancelPress();
      // 轻点只在"已经隐着"的时候有用（= 恢复）。长按已经把它藏好了, 那一次抬手不该再切回去。
      if (pending && target.chromeHidden) setChromeHidden(target, false);
    });
    layout.addEventListener('pointercancel', cancelPress);
    // 长按空白不该顺带弹出系统的文字选择 / 上下文菜单 —— 那个菜单会跟"控件收掉了"的画面叠在一起。
    // 只挡空白处: 消息气泡上的长按仍然留给系统的复制/选择。
    layout.addEventListener('contextmenu', function (event) { if (isBlank(event.target)) event.preventDefault(); });
    input.addEventListener('input', function () { target.draft.text = input.value; resizeInput(input); queueDraft(target); syncComposer(target); });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229 && !event.shiftKey && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (!currentBusy(target)) send(target); }
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
      if (event.phase === 'removed') {
        // 正文为空、只带绘图动作的那一轮：文本消息被撤掉，只留图片消息。
        // 直接从快照与缓存里摘掉它，别让用户看见一条空消息闪一下。
        if (target.messageSnapshot) target.messageSnapshot = target.messageSnapshot.filter(function (item) { return item.id !== event.messageId; });
        if (target.messageCache[event.messageId]) { revoke((target.messageCache[event.messageId].urls || []).slice()); delete target.messageCache[event.messageId]; }
        renderMessages(target).catch(showError); syncComposer(target); return;
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
      else if (event.phase === 'compressing') {
        // 后台压缩不改本轮状态：本轮正在回复时就当它不存在，只有空闲时才提示一句。
        if (!currentBusy(target)) status(target, '正在压缩历史上下文…');
        syncComposer(target); return;
      }
      else if (event.phase === 'compressed') {
        // 概要写成后压缩边界变了：重建消息，让冻结样式和编辑按钮立刻跟上。
        if (!currentBusy(target)) status(target, '历史上下文已压缩');
        target.messageCache = {};
        renderMessages(target, false).catch(showError); return;
      }
      else if (event.phase === 'compress-failed') { if (!currentBusy(target)) status(target, '历史上下文压缩失败：' + event.error); return; }
      else if (event.phase === 'generating') { target.routing = false; rememberMessage(target, event.message); status(target, session.active(id) ? session.active(id).label : '正在生成…'); }
      else if (event.phase === 'updated') rememberMessage(target, event.message);
      syncComposer(target); renderMessages(target).catch(showError);
    });
    await session.recover(id, history); await renderDraft(target); await renderMessages(target, true); syncComposer(target);
  }
  // 沉浸模式：隐去顶栏 / 消息列表 / 输入区, 只留背景。用 opacity + pointer-events 而不是
  // display: none —— 列表滚动位置与输入区真实高度（--chat-composer-h）都不用重算, 恢复时界面
  // 不会跳一下。关掉输入区之前先让它失焦: 键盘跟着一个看不见的输入框留在屏幕上是最糟的样子。
  function setChromeHidden(target, hidden) {
    if (!alive(target)) return;
    // 这套机制**只对"有背景图"的对话存在**（业主 2026-09-27: "如果对话界面没有背景图片, 点击空地
    // 就不要隐藏 UI 元素"）。没有背景图时可看的只有一块空色块, 点空地什么都不该发生。
    // 判据放在这里而不是监听器里, 是因为"恢复"与"清理"两条路径传的都是 false —— 无论有没有
    // 背景图, 它们都必须能成立, 否则离开对话时会把隐形状态带到下一页。
    var next = Boolean(hidden) && hasBackgroundImage();
    target.chromeHidden = next;
    if (target.chromeHidden) { var input = document.getElementById('messageInput'); if (input && input === document.activeElement) input.blur(); }
    document.getElementById('appShell').classList.toggle('chat-chrome-hidden', target.chromeHidden);
    (target.chromeRegions || []).forEach(function (region) {
      if (target.chromeHidden) region.setAttribute('aria-hidden', 'true'); else region.removeAttribute('aria-hidden');
    });
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
    document.getElementById('composerHint').textContent = busy ? '点击方块停止' : unavailable ? '角色配置需要修复' : target.conversation.kind === 'group' ? target.autoSelectRole ? (empty ? '空消息将发送“请你们自主回答。”' : '主持人将自动选择回复角色') : (empty ? '空消息将请 ' + (selectedRole ? selectedRole.name : '所选角色') + ' 继续' : '将由 ' + (selectedRole ? selectedRole.name : '所选角色') + ' 回复') : 'Enter 换行';
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
    var permissions = await app.services.context.permissions(messages, target.conversation.id);
    // 每条消息的编辑状态：edit 可编辑 / frozen 已压缩冻结 / none 还没完成，谈不上编辑。
    function messageState(message) {
      if (message.status !== 'done') return 'none';
      return permissions.editable[message.id] ? 'edit' : permissions.locked[message.id] ? 'frozen' : 'none';
    }
    var visibleStart = Math.max(0, messages.length - target.messageRenderLimit), visibleMessages = messages.slice(visibleStart);
    var nodes = [], cache = {}, createdUrls = [], lastDate = '';
    if (!messages.length) {
      var empty = document.createElement('div'); empty.className = 'chat-welcome';
      var participants = target.conversation.roleIds.map(function (id) { return target.roleMap[id]; }).filter(Boolean);
      // 对话还没有消息时的欢迎面板：头像本身可以点开标准角色编辑弹窗（与消息头像、角色页同一个编辑器）。
      empty.innerHTML = '<div class="chat-welcome-avatars">' + participants.slice(0, 3).map(function (role) { return '<button class="chat-welcome-avatar" type="button" data-edit-welcome-role="' + u.escapeHtml(role.id) + '" aria-label="编辑角色 ' + u.escapeHtml(role.name) + '">' + ui.roleAvatar(role, 'large') + '</button>'; }).join('') + '</div><h2>聊点什么？</h2><p>' + u.escapeHtml(participants.length === 1 ? '从一个问题或想法开始。' : '点选本轮回答的角色，让不同视角一起参与。') + '</p><div class="starter-list"><button class="starter" type="button">我想跟你说个有趣的事情</button><button class="starter" type="button">帮我梳理一个想法</button><button class="starter" type="button">我们一起制定一个计划</button></div>';
      empty.querySelectorAll('[data-edit-welcome-role]').forEach(function (button) { button.addEventListener('click', ui.action(function () { return editChatRole(button.dataset.editWelcomeRole, target); })); });
      empty.querySelectorAll('.starter').forEach(function (button) { button.addEventListener('click', function () { if (target.draft.text.trim()) { document.getElementById('messageInput').focus(); return; } target.draft.text = button.textContent; var input = document.getElementById('messageInput'); input.value = target.draft.text; input.dispatchEvent(new Event('input')); input.focus(); }); }); nodes.push(empty);
    }
    if (visibleStart > 0) {
      var historyControl = document.createElement('div'); historyControl.className = 'history-window-control';
      var loadEarlier = document.createElement('button'); loadEarlier.type = 'button'; loadEarlier.className = 'button ghost'; loadEarlier.innerHTML = ui.icon('clock-rotate-left') + '<span>加载更早消息 · 还有 ' + visibleStart + ' 条</span>';
      loadEarlier.addEventListener('click', ui.action(function () { return loadEarlierMessages(target); })); historyControl.appendChild(loadEarlier); nodes.push(historyControl);
    }
    for (var i = 0; i < visibleMessages.length; i += 1) {
      var message = visibleMessages[i];
      var date = new Date(message.createdAt).toLocaleDateString(app.i18n.locale(), { year: 'numeric', month: 'long', day: 'numeric' });
      if (date !== lastDate) { var separator = document.createElement('div'); separator.className = 'date-divider'; separator.textContent = date; nodes.push(separator); lastDate = date; }
      var signature = JSON.stringify(message) + messageState(message) + ((message.status === "error" || message.status === "cancelled") ? String(currentBusy(target)) : ""), cached = target.messageCache[message.id], messageUrls = [];
      var node = cached && cached.signature === signature ? cached.node : await messageElement(message, target, messageUrls, messageState(message));
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
    watchThumbs(inner);
    if (forceBottom || target.follow) requestAnimationFrame(function () { scrollBottom(target); }); else list.scrollTop = top;
  }
  async function messageElement(message, target, urls, state) {
    var system = message.kind === 'system', user = message.kind === 'user', assistant = !system && !user, role = target.roleMap[message.roleId];
    // frozen：这条消息已经被压缩进概要。原文照常显示，但整条淡化，表示它不再按原文参与上下文。
    var frozen = state === 'frozen';
    var row = document.createElement('article'); row.className = 'message-row ' + (system ? 'system' : user ? 'user' : 'assistant'); row.dataset.messageId = message.id;
    if (frozen) row.classList.add('is-frozen');
    if (assistant) {
      var avatar = await messageAvatar(role || { name: message.roleName || 'AI', avatarMediaId: '' }, 'message-avatar', target, 'role');
      if (target.conversation.kind === 'group' && role && role.id === moderatorRoleId(target.conversation)) avatar.classList.add('moderator-avatar-trigger');
      row.appendChild(avatar);
    }
    var block = document.createElement('div'); block.className = 'message-block';
    var name = document.createElement('div'); name.className = 'message-name'; name.textContent = system ? '系统' : user ? target.userProfile.name || '我' : role ? role.name : message.roleName || 'AI'; block.appendChild(name);
    var bubble = document.createElement('div'); bubble.className = 'message-bubble';
    // 画图中的占位：图片还没出来，先用一个方块占住位置（出图后原地替换，列表不会跳）。
    if (message.status === 'drawing') {
      var skeleton = document.createElement('div'); skeleton.className = 'message-draw';
      var skeletonText = document.createElement('span'); skeletonText.textContent = '正在绘制图片…';
      skeleton.appendChild(skeletonText); bubble.appendChild(skeleton);
    }
    for (var i = 0; i < (message.media || []).length; i += 1) {
      var media = message.media[i];
      var mediaKind = media.kind || (/^video\//i.test(media.mime || '') ? 'video' : 'image');
      if (mediaKind === 'video') {
        var videoCard = document.createElement('div'); videoCard.className = 'message-video-card';
        if (media.previewDataUrl) { var preview = document.createElement('img'); preview.src = media.previewDataUrl; preview.alt = ''; videoCard.appendChild(preview); }
        var videoCopy = document.createElement('span'); videoCopy.innerHTML = ui.icon('video') + '<span><strong>' + u.escapeHtml(media.name || '视频') + '</strong><small>' + (media.size ? Math.ceil(media.size / 1024 / 1024) + ' MiB' : '视频附件') + '</small></span>'; videoCard.appendChild(videoCopy);
        bubble.appendChild(videoCard); continue;
      }
      // 图片**不在这里取地址**（业主 2026-09-27 第五轮：进视口才加载）。
      // 原来这里是 `await app.data.media.displayUrl(media)`，它对每一条 media 都要读一次库，
      // 而且整条渲染链是串联的 ⇒ 进对话时要等 O(N) 次读库才画出第一屏，接着所有缩略图一起开抢。
      // 现在只摆一个 9:16 的占位盒（尺寸在 styles/app.css 的 [data-media-pending] 上），
      // 地址与 src 都留到它快进视口时再说（loadThumb）。
      var imageButton = document.createElement('button'); imageButton.type = 'button'; imageButton.className = 'message-image'; imageButton.setAttribute('aria-label', '查看完整图片');
      imageButton.dataset.mediaPending = '1';
      var image = document.createElement('img'); image.alt = media.alt || '对话图片'; image.referrerPolicy = 'no-referrer'; image.decoding = 'async';
      // 图到位就把占位尺寸摘掉，宽度交回给图片自身的比例（非 9:16 的用户照片仍然占满 213px 高）。
      image.onload = function () { this.parentNode.removeAttribute('data-media-pending'); if (target.follow) scrollBottom(target); };
      image.onerror = function () { this.alt = '图片加载失败'; this.parentNode.removeAttribute('data-media-pending'); this.parentNode.setAttribute('aria-label', '图片加载失败'); };
      imageButton.appendChild(image);
      // 闭包必须**按条**捕获 media: 这个 for 循环里 `media` 与 `i` 都是 var（函数作用域）, 直接在
      // 监听器里引用的话所有图片按钮都会拿到最后一条。原来的监听器只读 event.currentTarget,
      // 所以这个坑一直没露头; 现在要把 media 交给全屏看图的下载 / 设为背景, 就得用 IIFE 定住。
      imageButton.addEventListener('click', (function (entry) {
        return ui.action(function (event) { return openImageViewer(entry, event.currentTarget.querySelector('img')); });
      })(media));
      lazyMedia.set(imageButton, media);
      bubble.appendChild(imageButton);
    }
    // 绘图消息在图片下面回显提示词：用户能看出这张图是照哪句话画的。
    if (message.draw && message.draw.prompt && message.status !== 'drawing') {
      var caption = document.createElement('p'); caption.className = 'message-caption';
      if (message.draw.reference) { var reference = document.createElement('span'); reference.className = 'context-badge'; reference.textContent = '参考定妆照'; caption.appendChild(reference); }
      caption.appendChild(document.createTextNode(message.draw.prompt)); bubble.appendChild(caption);
    }
    if (message.status === 'pending') { var typing = document.createElement('div'); typing.className = 'typing-bubble'; typing.setAttribute('aria-label', '正在生成回复'); typing.innerHTML = '<span></span><span></span><span></span>'; bubble.appendChild(typing); }
    if (message.text) { var text = document.createElement('div'); text.className = 'message-text'; text.textContent = displayText(message.text); bubble.appendChild(text); }
    if (message.status === 'error' || message.status === 'cancelled') {
      var error = document.createElement('p'); error.className = 'message-error'; error.textContent = message.error || '生成失败'; bubble.appendChild(error);
      var retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button ghost'; retry.disabled = currentBusy(target);
      if (message.draw) {
        // 图片消息的重试是「重新绘制」：绘图要求已经存在消息里，不需要再问模型一遍。
        retry.textContent = '重新绘制这张图';
        // 会话 id 只能从 target 上取：这个函数的作用域里没有 id（:290 那个 id 属于 forEach 回调），
        // 写裸 id 会在点击时抛 ReferenceError，按钮看起来在、点下去却报「id is not defined」。
        retry.addEventListener('click', ui.action(function () { return session.retryDraw(target.conversation.id, message.id); }));
      } else {
        retry.textContent = '重试这条回复';
        retry.addEventListener('click', function () { run(target, { retryId: message.id }); });
      }
      bubble.appendChild(retry);
    }
    block.appendChild(bubble);
    var meta = document.createElement('div'); meta.className = 'message-meta';
    var time = document.createElement('time'); time.textContent = u.formatTime(message.createdAt); meta.appendChild(time);
    // 正在生成 / 正在绘图的这一条：气泡下面给一个「停止」（业主 2026-09-27：两条都要有）。
    // 两条路径各有各的开关，不能互相顶替：文本生成挂在这个对话的 tasks[id] 上（session.stop
    // 顺手把自动朗读也停掉），绘图是**分离的**任务、跟对话没关系（见 chat-session.js 文件头的
    // drawTasks 注释）⇒ session.cancelDraw。而且两者**可以同时在跑**：正文还在流式输出时，
    // 上一轮那张图已经在画了，一个按钮不该顺手把另一条也掐掉。
    //
    // 位置选 .message-meta（时间旁边）而不是气泡里：流式的增量走 applyMessageDelta，它会把新建的
    // .message-text 追加到气泡末尾 —— 按钮若在气泡里，正文会长到它下面去。
    // 这也正是"气泡下面"的样子：meta 就在气泡下方，和「重试」按钮同一层语义。
    // **不挂 ghost**（业主 2026-09-27：「气泡下面那个停止按钮不要有轮廓」）：那一行里另外几个
    // icon-button 都是无框的轻量动作，只有它一个带框会看着像另一个物种。.button 自带的
    // `border: 1px solid transparent` 仍然在，所以行高逐像素不变、消息完成时列表不跳。
    if (message.status === 'pending' || message.status === 'drawing') {
      var stop = document.createElement('button'); stop.type = 'button'; stop.className = 'button message-stop'; stop.dataset.stopGeneration = message.status;
      stop.setAttribute('aria-label', '停止生成'); stop.innerHTML = ui.icon('stop') + '<span>停止</span>';
      stop.addEventListener('click', ui.action(function () {
        if (message.status === 'drawing') {
          // 绘图可能刚好在这一帧之前画完了（drawTasks 已经摘掉）—— 那就说清楚，别让按钮变成哑巴。
          if (session.cancelDraw(target.conversation.id)) status(target, '正在停止绘制…');
          else status(target, '这次绘制已经停下，可以重新绘制这一条');
          return;
        }
        session.stop(target.conversation.id);
        status(target, '已停止后续回复；已发出的服务请求可能仍计费');
      }));
      meta.appendChild(stop);
    }
    if (message.contextTrimmed) { var note = document.createElement('span'); note.className = 'context-badge'; note.textContent = message.contextCompressed ? '含压缩上下文' : '仅最近 N 条'; note.title = message.contextCompressed ? '这次请求使用了压缩历史和最近完整消息' : '更早消息没有包含在这次请求中'; meta.appendChild(note); }
    if (frozen) { var frozenBadge = document.createElement('span'); frozenBadge.className = 'context-badge frozen-badge'; frozenBadge.innerHTML = ui.icon('compress') + '<span>已压缩</span>'; frozenBadge.title = '这条消息已经压缩进概要，不再按原文参与上下文，也不能单独修改'; meta.appendChild(frozenBadge); }
    if (assistant && message.streamFallback) { var fallback = document.createElement('span'); fallback.className = 'context-badge'; fallback.textContent = '兼容输出'; fallback.title = '服务或 WebView 没有提供可读取的响应流，本次使用完整响应'; meta.appendChild(fallback); }
    if (message.text) {
      var copy = document.createElement('button'); copy.type = 'button'; copy.className = 'icon-button'; copy.setAttribute('aria-label', '复制这条消息'); copy.innerHTML = ui.icon('copy'); copy.addEventListener('click', ui.action(async function () { await app.platform.hermit.copyText(message.text); ui.toast('已复制'); })); meta.appendChild(copy);
      if (assistant && (message.status === 'done' || app.services.tts.canResume(message.id))) { var speak = document.createElement('button'); speak.type = 'button'; speak.className = 'icon-button'; speak.dataset.ttsMessage = message.id; var ready = app.services.tts.hasReady(message.id), resumable = app.services.tts.canResume(message.id); speak.setAttribute('aria-label', resumable ? '继续流式朗读' : ready ? '播放已生成的朗读音频' : '朗读这条回复'); speak.innerHTML = ui.icon(resumable || ready ? 'play' : 'volume-high'); speak.addEventListener('click', ui.action(async function () { if (await app.services.tts.resume(message.id)) return; if (await app.services.tts.playReady(message.id)) return; return app.services.tts.speak(message.text, role); })); meta.appendChild(speak); }
    }
    // 铅笔与重新生成：已经压缩进概要的消息仍然保留按钮，但按钮呈禁用态，
    // 点一下只提示去「压缩概要」改延续上下文 —— 直接把旧消息改掉会让概要与原文对不上。
    // 注意不能用 disabled 属性：那会吃掉点击，提示也就弹不出来。
    if (state !== 'none') {
      // 图片消息的铅笔改的是**绘图提示词**（消息里那段文字就是提示词，定妆照注入的身份约束
      // 只存在于请求体上、不落在消息里，所以这里改不到它）。
      var edit = document.createElement('button'); edit.type = 'button'; edit.className = 'icon-button' + (frozen ? ' is-disabled' : ''); edit.setAttribute('aria-label', message.draw ? '修改绘图提示词' : '编辑这条消息'); edit.innerHTML = ui.icon('pencil');
      if (frozen) { edit.setAttribute('aria-disabled', 'true'); edit.title = '历史已被压缩，请修改压缩概要'; }
      edit.addEventListener('click', ui.action(function () { return frozen ? frozenHistoryNotice() : editMessage(target, message); })); meta.appendChild(edit);
    }
    if (assistant && state !== 'none') {
      // 图片消息的「重新生成」就是**重新发起绘图**（业主 2026-09-27）：提示词与当初那张卡片都
      // 存在消息里，不需要再问一次模型，也不该删掉后面的消息 —— 只是这一张重画。
      var redraw = Boolean(message.draw);
      var regenerate = document.createElement('button'); regenerate.type = 'button'; regenerate.className = 'icon-button' + (frozen ? ' is-disabled' : ''); regenerate.dataset.regenerateMessage = message.id; regenerate.setAttribute('aria-label', redraw ? '重新生成这张图' : '重新生成这条回复'); regenerate.innerHTML = ui.icon('rotate-right');
      if (frozen) { regenerate.setAttribute('aria-disabled', 'true'); regenerate.title = '历史已被压缩，请修改压缩概要'; }
      regenerate.addEventListener('click', ui.action(function () {
        if (frozen) return frozenHistoryNotice();
        return redraw ? session.retryDraw(target.conversation.id, message.id) : regenerateMessage(target, message);
      })); meta.appendChild(regenerate);
    }
    block.appendChild(meta); row.appendChild(block); if (user) row.appendChild(await messageAvatar(target.userProfile, 'message-avatar user-message-avatar', target, 'user')); return row;
  }
  // ── 全屏看图（业主 2026-09-27 第二轮；第六轮加了画廊侧栏）────────────────────────
  // 传的是**这条消息自己的 media 记录**: 下载要用它的宿主文件标识, 设为背景要用它的 mediaId。
  // 第六轮起还要给它一份"本对话所有生成图"的清单 —— 底部那个「画廊」按钮靠它铺满侧栏,
  // 未放大时上下滑动换图也靠它决定能翻到哪。
  //
  // **清单里每一项都自带两个动作回调**, 不是只有当前这张: 在看图里切到第二张再按「下载」,
  // 存下来的必须是第二张（组件只照着回调转交, 它自己不认识 media）。
  function entryOf(media, message) {
    var prompt = String(message.draw && message.draw.prompt || '');
    return {
      media: media,
      alt: prompt || String(media.alt || ''),
      src: '',   // 能白拿的时候由 galleryEntries 填（见 loadedSources）
      onDownload: ui.action(function () { return exportMediaImage(media); }),
      onSetBackground: ui.action(function () { return useMediaAsBackground(media); }),
      // 侧栏缩略图**进视口才要地址**（组件里那个观察器调它）。一个对话几十张图, 全部赋 src
      // 会让引擎一次解码几十张 1MP 的图（每张展开约 4MB）, 在 WebView 里够呛。
      source: function () { return app.data.media.displayUrl(media).catch(function () { return ''; }); }
    };
  }
  // 消息列表里**已经加载出来**的那些缩略图地址是白拿的: 直接搬过来, 省掉一次读库 + 一次文件往返。
  // 认节点靠懒加载那套的 lazyMedia 对照表（它是 WeakMap: 按钮 → media）。
  function loadedSources() {
    var map = {}, nodes = document.querySelectorAll('#messageList .message-image img');
    for (var i = 0; i < nodes.length; i += 1) {
      var button = nodes[i].parentNode, media = button && lazyMedia.get(button);
      if (media && nodes[i].src) map[mediaKey(media)] = nodes[i].src;
    }
    return map;
  }
  // 本对话所有生成图, 按时间顺序（messageSnapshot 本身就是排好序的）。**每条绘图消息只取第一张图**
  //（一条绘图消息就是一张）, 没有可用图片的整条跳过 —— 侧栏里不该出现点不开的空格。
  function galleryEntries(target) {
    var messages = target.messageSnapshot || [], known = loadedSources(), entries = [];
    for (var i = 0; i < messages.length; i += 1) {
      var message = messages[i];
      if (!message.draw || message.status === 'drawing') continue;
      var list = message.media || [];
      for (var j = 0; j < list.length; j += 1) {
        var item = list[j];
        if ((item.kind || (/^video\//i.test(item.mime || '') ? 'video' : 'image')) !== 'image') continue;
        var entry = entryOf(item, message);
        entry.src = known[mediaKey(item)] || '';
        entries.push(entry);
        break;
      }
    }
    return entries;
  }
  async function openImageViewer(media, image) {
    var target = view, gallery = target ? galleryEntries(target) : [], index = -1;
    for (var i = 0; i < gallery.length; i += 1) if (mediaKey(gallery[i].media) === mediaKey(media)) { index = i; break; }
    // 这张图不在清单里（旧记录、或调用方手上只有一条 media）⇒ 退化成"只有它一张": 画廊能力关掉,
    // 看图本身照常。为一个侧栏把整件事卡住是不划算的。
    if (index < 0) gallery = [];
    var src = String(image && image.src || '');
    // 正常路径下缩略图早就加载好了、src 现成; 这里只兜住"地址还没解析出来就被点开"的边角情况。
    if (!src) src = await app.data.media.displayUrl(media).catch(function () { return ''; });
    return app.components.imageViewer.open({
      src: src, alt: String(image && image.alt || ''),
      gallery: gallery, index: index,
      onDownload: ui.action(function () { return exportMediaImage(media); }),
      onSetBackground: ui.action(function () { return useMediaAsBackground(media); })
    });
  }
  // 生成图的字节在宿主文件库里, 页面手上只有 mediaId ⇒ 先把记录取回来拿 logicalFileId。
  // 旧记录（字节还在 IndexedDB 里）没有 logicalFileId, 那种就明说导不出来, 不要静默失败。
  async function mediaLogicalFileId(media) {
    if (!media) return '';
    if (media.logicalFileId) return String(media.logicalFileId);
    if (!media.mediaId) return '';
    var record = await app.data.media.get(media.mediaId).catch(function () { return null; });
    return record && record.logicalFileId ? String(record.logicalFileId) : '';
  }
  // 「下载」走宿主文件库的导出: files.export 让用户自己挑保存位置, 字节由宿主直接写, 不经过页面
  // （一张 1MP 的图 base64 之后远超"单条消息 256 KiB"的上限, 走页面必然失败）。
  async function exportMediaImage(media) {
    var logicalFileId = await mediaLogicalFileId(media);
    if (!logicalFileId) throw new Error('这张图片没有可导出的文件');
    var api = app.platform.hermit.available() ? app.platform.hermit.api() : null;
    if (!api || !api.files || typeof api.files.export !== 'function') throw new Error('当前环境不支持保存到设备');
    var result = await api.files.export({ logicalFileId: logicalFileId });
    if (result && result.cancelled) return;
    ui.toast('图片已保存到设备');
  }
  // 「设为背景」复用对话背景那条唯一路径（写进对话记录 → 重算全局背景）。
  //
  // **只记 mediaId, 不写 url**, 两条理由:
  //   1. 消息上的媒体记录本来就长这样（chat-session.js 与 chat.js 都只放 `{ mediaId, mime, alt }`）;
  //   2. applyAppBackground 一看到 url 就去算取景参数, 而没有取景参数时它按 1:1 假设推 ——
  //      一张 9:16 的图会被放大过头。只给 mediaId 时 size / position 两个变量都不写,
  //      直接落到 CSS 的 cover / center: 铺满、居中, 正是"设为背景"该有的样子。
  // 图片文件不会被误删: store.releaseMedia 按引用计数, 消息还引用着它就删不掉。
  async function useMediaAsBackground(media) {
    var target = view;
    if (!alive(target)) throw new Error('对话当前没有打开');
    if (!media || !media.mediaId) throw new Error('这张图片不能设为背景');
    // 「设为背景」改的是**对话设置**，而且一设就铺满整个界面 —— 在看图时误触一次，用户得再进对话
    // 设置里换回来。所以先确认（业主 2026-09-27 第三轮）。
    // 取消就什么都不做：看图这一层照旧开着，用户接着看他的图。
    // 这个确认框开在看图**上面**，靠的是 .image-viewer 压在弹窗之下（见 styles/app.css 的
    // z-index 阶梯），不是把弹窗抬到看图之上 —— 弹窗是系统层，它对任何内容层都该在上面。
    var confirmed = await ui.confirm({
      title: '设为对话背景？',
      message: '这张图片会成为当前对话的背景, 铺满整个界面。',
      confirmText: '设为背景'
    });
    if (!confirmed) return;
    await saveChatBackground(target.conversation.id, target, { kind: 'image', mediaId: media.mediaId, name: String(media.name || ''), size: Number(media.size || 0), layout: null }, null);
    ui.toast('已设为对话背景');
    app.components.imageViewer.close();
  }
  async function messageAvatar(profile, className, target, owner) {
    profile = profile || {};
    var name = profile.name || (owner === 'user' ? '我' : '角色'), source = '';
    if (profile.avatarMediaId) {
      if (Object.prototype.hasOwnProperty.call(target.avatarSources, profile.avatarMediaId)) source = target.avatarSources[profile.avatarMediaId];
      else try { source = await app.data.media.displayUrl(profile.avatarMediaId) || ''; target.avatarSources[profile.avatarMediaId] = source; } catch (_) { target.avatarSources[profile.avatarMediaId] = ''; }
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
      var media = target.draft.media[i], src = await app.data.media.displayUrl(media).catch(function () { return ''; });
      var item = document.createElement('div'); item.className = 'attachment';
      if ((media.kind || '').toLowerCase() === 'video') {
        item.classList.add('video-attachment');
        if (media.previewDataUrl) { var thumb = document.createElement('img'); thumb.src = media.previewDataUrl; thumb.alt = ''; item.appendChild(thumb); }
        var label = document.createElement('span'); label.innerHTML = ui.icon('video') + '<small>' + u.escapeHtml(media.name || '视频') + '</small>'; item.appendChild(label);
      } else if (src) { var image = document.createElement('img'); image.src = src; image.alt = '待发送图片 ' + (i + 1); item.appendChild(image); }
      else item.textContent = '媒体丢失';
      var remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button'; remove.dataset.mediaKey = mediaKey(media); remove.setAttribute('aria-label', '移除待发送附件'); remove.innerHTML = ui.icon('xmark');
      remove.addEventListener('click', ui.action(async function (event) { if (currentBusy(target)) return; var key = event.currentTarget.dataset.mediaKey, removed = target.draft.media.filter(function (entry) { return mediaKey(entry) === key; }); target.draft.media = target.draft.media.filter(function (entry) { return mediaKey(entry) !== key; }); await flushDraft(target); await store.releaseMedia(removed); await renderDraft(target); syncComposer(target); })); item.appendChild(remove); fragment.appendChild(item);
    }
    if (!alive(target) || paint !== revision) { revoke(urls); return; }
    revoke(target.draftUrls); target.draftUrls = urls;
    var tray = document.getElementById('attachmentTray'); tray.textContent = ''; tray.appendChild(fragment); tray.classList.toggle('is-hidden', !target.draft.media.length);
  }
  // 编辑绘图提示词时，**真实进上下文的动作块必须跟着一起改**（业主 2026-09-27：气泡里的提示词
  // 就是真实消息里动作块的内容，改的时候要一起保存）。气泡上显示的那行取自 `message.draw.prompt`
  // （= 实际发给绘图模型的参数，是事实），而模型历史里看到的是 `rawText` 里那段
  // `<<<chataxi-action …>>>`；两者是两份数据，不同步就会出现"界面上是 A、模型看到的还是 B"。
  //
  // 块在哪儿分两种情形：
  //   ① 正文为空的那一轮 —— 块就在这条绘图消息**自己的** rawText 里（runDraw 接住了原文）；
  //   ② 正文 + 块的那一轮 —— 块在**同轮的前一条** assistant 消息上（那一轮被拆成了两条消息）。
  // 同轮的判据是 `replyTo` 相同：runDraw 建绘图消息时透传的就是 anchor 的 replyTo，
  // 而不同轮的用户消息不同 ⇒ replyTo 必然不同，所以不会越过一轮去改到别人的块。
  // 旧记录没有 rawText ⇒ retarget 返回空串 ⇒ 不改、也不伪造。
  async function syncActionBlock(message, prompt) {
    var own = app.services.actions.retarget(message.rawText, prompt);
    if (own) message.rawText = own;
    var extra = [];
    if (!message.replyTo) return extra;
    var messages = await store.messages(message.conversationId);
    var index = messages.findIndex(function (item) { return item.id === message.id; });
    if (index <= 0) return extra;
    var previous = messages[index - 1];
    if (!previous || previous.kind !== 'assistant' || previous.replyTo !== message.replyTo) return extra;
    var fixed = app.services.actions.retarget(previous.rawText, prompt);
    if (!fixed) return extra;
    previous.rawText = fixed; previous.editedAt = Date.now();
    extra.push(previous);
    return extra;
  }
  async function applyMessageEdit(target, message, text) {
    await app.services.tts.invalidate(message.id);
    // 图片消息改的是绘图提示词：气泡下面回显的那段文字就是发给绘图模型的那一段。
    // 定妆照注入的身份约束句只加在请求体上（见 draw.js），不落在消息里，所以改不到它。
    message.editedAt = Date.now();
    if (message.draw) {
      message.draw.prompt = text;
      // 图片的 alt 文本也是这个提示词的副本，一起改 —— 留着旧值就是又一处不一致。
      var media = message.media || [];
      for (var i = 0; i < media.length; i += 1) if (media[i].alt) media[i].alt = text;
      var sameTurn = await syncActionBlock(message, text);
      await store.putMessage(message);
      for (var j = 0; j < sameTurn.length; j += 1) await store.putMessage(sameTurn[j]);
    } else {
      message.text = text;
      await store.putMessage(message);
    }
    target.messageSnapshot = null; await session.refreshPreview(target.conversation.id); await renderMessages(target, false);
    ui.toast(message.draw ? '绘图提示词已保存' : '消息已保存');
  }
  // 删除单条消息（业主 2026-09-27）：入口在编辑弹窗底部，先确认再删。只删这一条 ——
  // 后面消息的上下文因此出现断层，是用户的决定，不替他补、也不替他删别的。
  // store.removeMessage 会一并释放这条消息**未被其他地方引用**的媒体（recovery 边界见 store.js）。
  async function deleteMessage(target, original) {
    if (currentBusy(target)) { ui.toast('请先停止当前回复'); return; }
    await app.services.tts.invalidate(original.id);
    var removed = await store.removeMessage(original);
    if (!removed) throw new Error('这条消息已经不存在了');
    target.messageSnapshot = null;
    await session.refreshPreview(target.conversation.id);
    await renderMessages(target, false);
    ui.toast('消息已删除');
  }
  // 已压缩的历史消息不能再单独改写：统一提示到「压缩概要」这个唯一可改的入口。
  function frozenHistoryNotice() { ui.toast('历史已被压缩，请修改压缩概要', 4200); }
  async function editMessage(target, original) {
    if (currentBusy(target)) { ui.toast('请先停止当前回复'); return; }
    var messages = await store.messages(target.conversation.id), index = messages.findIndex(function (item) { return item.id === original.id; });
    if (index < 0) throw new Error('消息不存在');
    var editable = await app.services.context.editable(messages, target.conversation.id);
    if (!editable[original.id]) throw new Error('这条消息已经进入压缩历史，不能再修改');
    var system = original.kind === 'system';
    // 图片消息走到这里改的是提示词（业主 2026-09-27），不是正文 —— 它的 text 恒为空。
    var drawing = Boolean(original.draw);
    var value = drawing ? String(original.draw.prompt || '') : String(original.text || '');
    var label = drawing ? '绘图提示词' : '消息内容';
    var hint = drawing
      ? '这里改的就是发给绘图模型的提示词；定妆照那类参考图不在文字里，不在这里改。保存后用气泡下方的重新生成按钮重新画一张。'
      : '这里只保存消息内容，不会自动重新生成或删除后续消息。' + (system ? '这条场景消息仍会按普通历史参与压缩。' : original.kind === 'user' ? '' : '角色回复可在保存后使用气泡下方的重新生成按钮。');
    ui.openModal({
      title: drawing ? '编辑绘图提示词' : system ? '编辑场景开场白' : original.kind === 'user' ? '编辑我的消息' : '编辑角色回复',
      submitText: '保存',
      html: '<div class="form-grid"><label class="field"><span>' + label + '</span><textarea name="text" maxlength="16000">' + u.escapeHtml(value) + '</textarea></label>' +
        '<p class="helper">' + hint + '</p>' +
        // 删除放在编辑弹窗底部（业主 2026-09-27）。必须 type="button"：这是表单里的按钮，
        // 默认 type 是 submit，点一下会变成"保存并关闭"，删除就再也弹不出来了。
        // 删前一律确认 —— 它不可撤销。
        '<div class="message-delete"><button class="button danger" type="button" data-delete-message>删除这条消息</button><p class="helper">只删除这一条，从当前设备永久移除，无法撤销。</p></div></div>',
      onSubmit: async function (form) {
        var text = u.formValue(form, 'text');
        if (!text && !(original.media || []).length) throw new Error('消息内容不能为空');
        await applyMessageEdit(target, Object.assign({}, original), text); return true;
      }
    });
    document.querySelector('#modalForm [data-delete-message]').addEventListener('click', ui.action(async function () {
      var confirmed = await ui.confirm({ title: '删除这条消息？', message: '这一条消息会从当前设备永久删除，无法撤销。', confirmText: '删除消息', danger: true });
      if (!confirmed) return;
      ui.closeModal(true);
      await deleteMessage(target, original);
    }));
  }
  async function regenerateMessage(target, original) {
    if (currentBusy(target)) { ui.toast('请先停止当前回复'); return; }
    var messages = await store.messages(target.conversation.id), index = messages.findIndex(function (item) { return item.id === original.id; });
    if (index < 0) throw new Error('消息不存在');
    var editable = await app.services.context.editable(messages, target.conversation.id);
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
    if (!summaries.length) { ui.toast('这个对话还没有生成压缩概要'); return; }
    var html = '<div class="form-grid summary-edit"><p class="helper">压缩概要是被压缩历史唯一能改的地方：已经压缩进概要的消息不能再单独编辑，改这里就能调整延续上下文。保存后从下一次回复开始生效。</p>' + summaries.map(function (summary, index) {
      return '<label class="field"><span>已压缩 ' + Number(summary.sourceMessageCount || 0) + ' 条 · 由 ' + u.escapeHtml(summary.compressedByRoleName || '角色') + ' 最近更新</span><textarea class="prompt-editor" name="summary' + index + '" required maxlength="8000">' + u.escapeHtml(summary.text) + '</textarea></label>';
    }).join('') + '</div>';
    var form = ui.openModal({ title: '编辑压缩概要', submitText: '保存概要', html: html, onSubmit: async function (form) {
      // 逐条走 updateSummaryText：空内容会被明确拒绝，保存成功的概要从下一次上下文组装开始替换旧历史。
      for (var i = 0; i < summaries.length; i += 1) await app.services.context.updateSummaryText(target.conversation.id, u.formValue(form, 'summary' + i));
      return true;
    }, onSuccess: function () { ui.toast('压缩概要已更新'); target.messageCache = {}; renderMessages(target, false).catch(showError); } });
    // 概要可能很长：弹窗固定占 80% 高，输入框吃掉说明文字之外的全部高度（见 styles/app.css 的 .summary-sheet）。
    form.closest('.modal-sheet').classList.add('summary-sheet');
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
    var listSeparator = app.i18n.pick('、', ', ');
    var streamHelp = someStreamSupported ? app.i18n.pick(
      '支持流式音频的角色' + (streamingNames.length ? '（' + streamingNames.join(listSeparator) + '）' : '') + '会在约三秒音频到达后自动开始；' + (unsupportedNames.length ? '其余角色（' + unsupportedNames.join(listSeparator) + '）等待完整音频。' : '') + (textStreamSupported ? '支持增量文字的模型会在语言模型形成完整段落后立即持续提交。' : '当前模型按段提交完整文字，每段音频仍会边生成边播放。'),
      'Roles that support streaming audio' + (streamingNames.length ? ' (' + streamingNames.join(listSeparator) + ')' : '') + ' start automatically once about three seconds of audio have arrived; ' + (unsupportedNames.length ? 'other roles (' + unsupportedNames.join(listSeparator) + ') wait for the full audio. ' : '') + (textStreamSupported ? 'Models with incremental text submit continuously once a paragraph is complete.' : 'This model submits complete text paragraph by paragraph, and each audio segment still plays as it is generated.')
    ) : '当前角色的朗读模型不支持流式音频，将在完整音频生成后播放。';
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
    var form = ui.openModal({ title: conversation.title, submitText: '完成', cancelText: null, html: '<div class="menu-list"><button class="menu-item" type="button" data-chat-menu="settings">' + ui.icon('gear') + '<span>常规设定</span>' + ui.icon('chevron-right') + '</button><button class="menu-item" type="button" data-chat-menu="background">' + ui.icon('image') + '<span>对话背景</span>' + ui.icon('chevron-right') + '</button><button class="menu-item" type="button" data-chat-menu="voice">' + ui.icon('microphone') + '<span>本对话语音与朗读</span>' + ui.icon('chevron-right') + '</button><button class="menu-item" type="button" data-chat-menu="summary">' + ui.icon('compress') + '<span>压缩概要' + (summaries.length ? ' · 已生成' : ' · 尚未生成') + '</span>' + ui.icon('chevron-right') + '</button><button class="menu-item" type="button" data-chat-menu="export">' + ui.icon('file-lines') + '<span>导出对话文字</span></button><button class="menu-item" type="button" data-chat-menu="pin">' + ui.icon('thumbtack') + '<span>' + (conversation.pinned ? '取消置顶' : '置顶对话') + '</span></button><button class="menu-item danger-text" type="button" data-chat-menu="delete">' + ui.icon('trash') + '<span>删除对话</span></button></div>', onSubmit: function () {} });
    form.querySelectorAll('[data-chat-menu]').forEach(function (button) { button.addEventListener('click', ui.action(async function () {
      var command = button.dataset.chatMenu; ui.closeModal();
      if (currentBusy(target) && (command === 'settings' || command === 'delete')) { ui.toast('请先停止本轮回复'); return; }
      // 常规设定弹窗含基础设定、个人设定、场景设定三个子 tab，一次保存后刷新当前对话。
      if (command === 'settings') return app.features.conversations.openConversationSettings(conversation, { tab: 'basic', openAfterSave: false, onSaved: async function (next) {
        target.conversation = next;
        target.userProfile = app.services.profiles.userForConversation(next, target.globalUserProfile);
        target.avatarSources = {}; target.messageCache = {}; target.messageSnapshot = null;
        revoke(target.urls); target.urls = [];
        await renderMessages(target, true);
      } });
      if (command === 'background') return backgroundSettings(target.conversation.id, target);
      if (command === 'voice') return voiceSettings(target);
      if (command === 'summary') return editSummaries(target);
      if (command === 'export') return app.features.conversations.exportText(conversation.id);
      if (command === 'pin') { conversation.pinned = !conversation.pinned; await store.put('conversations', conversation.id, conversation); target.conversation = conversation; ui.toast(conversation.pinned ? '对话已置顶' : '已取消置顶'); }
      if (command === 'delete' && await ui.confirm({ title: '删除对话？', message: '消息、压缩内容、草稿和未被其他对话使用的图片将从当前设备删除。', confirmText: '删除对话', danger: true })) { await close(); await store.deleteConversation(conversation.id); await refreshAppBackground(); await app.navigate('conversations'); ui.toast('对话已删除'); }
    })); });
  }
  // 对话背景：只作用于当前对话。内置六个色板, 每个色板都备了明亮 / 深色两套渐变,
  // 按当前主题（app.resolvedTheme(), 显式设置或跟随系统）自动取一套。
  // 记录里只留色板 id, 换主题时同一个 id 会换成另一套渐变: 旧记录不用迁移,
  // 也不会出现"浅色主题配着深色背景"的错配。也可以从相册选一张, 或者恢复默认。
  var chatBackgrounds = [
    { id: 'night', name: '午夜',
      light: 'radial-gradient(circle at 24% 16%, rgba(255,255,255,.85), rgba(0,0,0,0) 58%), linear-gradient(160deg, #f4f6fd 0%, #e3e7f7 52%, #d2d6ef 100%)',
      dark: 'radial-gradient(circle at 22% 12%, rgba(122,142,255,.38), rgba(0,0,0,0) 46%), linear-gradient(160deg, #0d1226 0%, #1e2547 50%, #352a5c 100%)' },
    { id: 'dawn', name: '晨曦',
      light: 'radial-gradient(circle at 78% 8%, rgba(255,214,150,.55), rgba(0,0,0,0) 52%), linear-gradient(165deg, #fdf3e3 0%, #f7d9c4 46%, #e9b7a8 100%)',
      dark: 'radial-gradient(circle at 76% 88%, rgba(255,176,110,.38), rgba(0,0,0,0) 54%), linear-gradient(165deg, #101a2c 0%, #1d2a44 46%, #333a55 100%)' },
    { id: 'forest', name: '林中',
      light: 'radial-gradient(circle at 18% 14%, rgba(196,232,180,.48), rgba(0,0,0,0) 50%), linear-gradient(160deg, #e8f2e2 0%, #c6ddc0 48%, #9dc0a4 100%)',
      dark: 'radial-gradient(circle at 20% 14%, rgba(150,214,160,.30), rgba(0,0,0,0) 52%), linear-gradient(160deg, #0c1a13 0%, #14301f 50%, #1e4a2c 100%)' },
    { id: 'sea', name: '海雾',
      light: 'radial-gradient(circle at 72% 16%, rgba(200,232,245,.52), rgba(0,0,0,0) 54%), linear-gradient(160deg, #eaf4f8 0%, #c2ddec 48%, #9cc0d8 100%)',
      dark: 'radial-gradient(circle at 72% 14%, rgba(150,214,235,.33), rgba(0,0,0,0) 54%), linear-gradient(160deg, #0b1c29 0%, #143143 50%, #1d5063 100%)' },
    { id: 'sunset', name: '晚霞',
      light: 'radial-gradient(circle at 30% 82%, rgba(255,170,120,.5), rgba(0,0,0,0) 56%), linear-gradient(150deg, #ffe9d6 0%, #f7bea0 44%, #d98fb0 100%)',
      dark: 'radial-gradient(circle at 28% 86%, rgba(255,152,96,.46), rgba(0,0,0,0) 56%), linear-gradient(165deg, #1d1029 0%, #402043 48%, #7a3547 100%)' },
    { id: 'paper', name: '宣纸',
      light: 'radial-gradient(circle at 40% 20%, rgba(255,255,255,.9), rgba(0,0,0,0) 60%), linear-gradient(160deg, #faf6ec 0%, #f2ebdc 55%, #e8dfcc 100%)',
      dark: 'radial-gradient(circle at 38% 18%, rgba(180,196,225,.20), rgba(0,0,0,0) 58%), linear-gradient(160deg, #14161c 0%, #22252e 55%, #33363f 100%)' }
  ];

  // 取当前主题对应的那套渐变。主题只认 app.resolvedTheme() 一处（显式设置或跟随系统）,
  // 不在这里重新读 data-theme / 媒体查询, 免得两处判断走样。
  function presetCss(item) {
    if (!item) return '';
    var theme = app.resolvedTheme ? app.resolvedTheme() : 'light';
    return (theme === 'dark' ? item.dark : item.light) || item.light || '';
  }

  // 相册背景取图上限。旧实现用 files.pickInline({ maxBytes: 768 * 1024 })，
  // 而宿主把 pickInline 的 maxBytes 收敛进 1~900KiB 并直接报错，于是随便一张
  // 手机照片都会撞上「不能超过 768k」。现在改走 files.pickImage：宿主用系统相册
  // 选择器取图，自己归一化后存成宿主文件，只把 URL 交回来，原图再大也不报错。
  var BACKGROUND_MAX_BYTES = 10 * 1024 * 1024;

  // 相册背景在对话记录里只留宿主文件库的 URL（/__hermit/files/<id>）与取景参数，
  // 不存 base64 —— 一张真实照片的 base64 有十几 MB，而 store 单条记录的硬上限是
  // 63KB（store.js），塞进去必炸。
  function backgroundPreset(background) {
    if (!background || background.kind !== 'preset') return null;
    return chatBackgrounds.filter(function (item) { return item.id === background.id; })[0] || null;
  }
  function cssUrl(value) { return 'url("' + String(value || '').replace(/["\\\r\n]/g, '') + '")'; }
  function backgroundImageUrl(background) {
    return background && background.kind === 'image' && background.url ? String(background.url) : '';
  }
  // "有没有背景图" = 当前铺着的那份背景是一条**图片**记录（含旧版只剩 `mediaId` 的形式）。
  // 内置渐变**不算** —— 那一档没有照片可看, 把控件全收掉只剩一块空色块（业主 2026-09-27）。
  // 它是"切沉浸模式"的前置条件, 见 setChromeHidden。
  function hasBackgroundImage() { return Boolean(appliedBackground && appliedBackground.kind === 'image'); }
  // 旧版把相册图存在 chataxi 自己的媒体库（IndexedDB）里，记录里只有 mediaId。
  // 新记录不再写 mediaId，但旧对话仍然要显示得出来 —— displayUrl 会在读取时把那条旧记录
  // 顺手搬进宿主文件库（引用 id 不变）。
  async function legacyBackgroundUrl(background) {
    if (backgroundImageUrl(background) || !background || background.kind !== 'image' || !background.mediaId) return '';
    try { return await app.data.media.displayUrl(background.mediaId) || ''; } catch (_) { return ''; }
  }
  async function backgroundUrl(background) { return backgroundImageUrl(background) || await legacyBackgroundUrl(background); }
  async function backgroundStyle(background) {
    var url = await backgroundUrl(background);
    if (url) return cssUrl(url);
    var preset = backgroundPreset(background);
    return preset ? presetCss(preset) : '';
  }

  // 取景参数 → background-size / background-position。两个值都是百分比，与容器尺寸无关，
  // 所以在取景框里定好的构图能原样铺到整页上。
  // elementAspect 是要铺满的那块区域（.app-shell）的真实宽高比：取景框用的是"屏幕减去
  // 顶部状态栏"，比它略扁，所以缩放要顶到刚好覆盖，否则极端比例的图会在上下露空。
  function backgroundLayout(layout, elementAspect) {
    var zoom = Math.max(1, Math.min(4, Number(layout && layout.zoom) || 1));
    var image = Number(layout && layout.imageAspect) > 0 ? Number(layout.imageAspect) : 1;
    var frame = Number(layout && layout.frameAspect) > 0 ? Number(layout.frameAspect) : 1;
    var element = Number(elementAspect) > 0 ? Number(elementAspect) : frame;
    var ratio = image / frame;
    var panX = clampUnit(layout && layout.panX), panY = clampUnit(layout && layout.panY);
    // background-position 的百分比是（容器 − 图片）的比例：50% 居中，越小越靠左上。
    var position = percent(50 - panX * 50) + ' ' + percent(50 - panY * 50);
    if (ratio <= 1) return { size: percent(Math.max(zoom, ratio * frame / element) * 100) + ' auto', position: position };
    return { size: 'auto ' + percent(Math.max(zoom, element / (ratio * frame)) * 100), position: position };
  }

  function percent(value) { return Math.round(Number(value) * 10000) / 10000 + '%'; }
  function clampUnit(value) { var number = Number(value) || 0; return Math.max(-1, Math.min(1, number)); }
  // 背景铺的那块区域是"正常视口"（--viewport-full-height, 由 app.js 维护）, 不是当前的 .app-shell:
  // 键盘弹起时 .app-shell 会缩, 但背景图层钉在正常高度上。所以取景要按正常宽高比算 ——
  // 用 shell.clientHeight 会在键盘弹起时算出一个被压扁的比例, 背景一重算照片就跑了。
  function shellAspect() {
    var full = parseFloat(document.documentElement.style.getPropertyValue('--viewport-full-height')) || 0;
    var width = window.innerWidth || 0;
    if (width > 0 && full > 0) return width / full;
    var shell = document.getElementById('appShell');
    if (shell && shell.clientWidth > 0 && shell.clientHeight > 0) return shell.clientWidth / shell.clientHeight;
    return ui.screenAspect();
  }

  // 相册图也要占一格：不占的话，选完相册再开面板 6 个色块全是未选中态，
  // 用户看不出当前用的是哪张。没有相册背景时先藏着。
  function backgroundImageSwatch() {
    return '<button class="background-swatch" type="button" data-background-image="1" aria-pressed="false" title="相册图片" hidden><span>相册</span></button>';
  }

  function markBackgroundCurrent(form, background) {
    if (!form) return;
    form.querySelectorAll('[data-background-preset]').forEach(function (button) {
      var on = Boolean(background) && background.kind === 'preset' && background.id === button.dataset.backgroundPreset;
      button.classList.toggle('is-current', on); button.setAttribute('aria-pressed', String(on));
    });
    var image = form.querySelector('[data-background-image]');
    if (image) { var imageOn = Boolean(background) && background.kind === 'image'; image.classList.toggle('is-current', imageOn); image.setAttribute('aria-pressed', String(imageOn)); }
  }

  // 背景是"应用级"的一件事：铺满 .app-shell, 于是顶栏、底栏、卡片、弹窗统统透出它, 读作
  // "整个应用换了背景", 而不是"对话里贴了一块色纸"。
  // 玻璃开关挂 <html> 而不是 .app-shell —— 弹窗与 toast 是挂在 body 上的, 不在 .app-shell 里面,
  // 开关挂错地方它们就继承不到玻璃色 token, 会变成盖在背景上的一堆实心块。
  // 背景值本身不单独存：它就是"最近使用的对话"那个对话的背景, 见 refreshAppBackground。
  var appliedBackground = null;
  async function applyAppBackground(background) {
    appliedBackground = background || null;
    var shell = document.getElementById('appShell'), root = document.documentElement;
    var style = await backgroundStyle(background);
    root.classList.toggle('has-app-background', Boolean(style));
    if (!shell) return;
    if (!style) {
      shell.style.removeProperty('--chat-background');
      shell.style.removeProperty('--chat-background-size');
      shell.style.removeProperty('--chat-background-position');
      return;
    }
    shell.style.setProperty('--chat-background', style);
    // 内置渐变没有取景信息，交给 CSS 的默认值（cover / center）。
    var layout = backgroundImageUrl(background) ? backgroundLayout(background.layout, shellAspect()) : null;
    if (layout) { shell.style.setProperty('--chat-background-size', layout.size); shell.style.setProperty('--chat-background-position', layout.position); }
    else { shell.style.removeProperty('--chat-background-size'); shell.style.removeProperty('--chat-background-position'); }
  }

  // "最近使用的对话"记在 meta 里, 是全局背景的唯一来源。每次打开对话记一笔。
  var LAST_CONVERSATION_KEY = 'last-conversation';
  async function rememberConversation(id) {
    if (!id) return;
    try { await store.put('meta', LAST_CONVERSATION_KEY, { id: id }); } catch (_) {}
  }

  // 重读"最近使用的对话"并把它的背景铺上。启动、改完背景、删掉对话之后都走这里 ——
  // "全局背景 = 最近打开过的那个对话的背景"这条规则因此只有一个实现点。
  // 内部吞异常：它在首屏渲染之前跑, 背景出错不该让整个应用起不来。
  async function refreshAppBackground() {
    try {
      var remembered = await store.get('meta', LAST_CONVERSATION_KEY);
      var id = remembered && remembered.id ? remembered.id : '';
      var conversation = id ? await store.get('conversations', id) : null;
      await applyAppBackground(conversation ? conversation.background : null);
    } catch (_) {}
  }

  // 主题一变, 已经铺着的色板背景要换成另一套渐变: 系统主题走 prefers-color-scheme,
  // 显式设置走 <html data-theme>, 两条路都要盯。
  // 背景已经是应用级的, 不再只在对话页 —— 所以这里盯的是"当前铺着的那份背景", 不是 view。
  // 没有背景（appliedBackground 为空）时没什么可重画的, 直接不动。
  function repaintAppBackground() {
    if (appliedBackground) applyAppBackground(appliedBackground).catch(function () {});
  }
  var backgroundScheme = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (backgroundScheme) {
    if (backgroundScheme.addEventListener) backgroundScheme.addEventListener('change', repaintAppBackground);
    else if (backgroundScheme.addListener) backgroundScheme.addListener(repaintAppBackground);
  }
  if (window.MutationObserver) new MutationObserver(repaintAppBackground).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  function backgroundSwatch(item, background) {
    var current = background && background.kind === 'preset' && background.id === item.id;
    return '<button class="background-swatch' + (current ? ' is-current' : '') + '" type="button" data-background-preset="' + item.id + '" aria-pressed="' + String(Boolean(current)) + '" title="' + u.escapeHtml(item.name) + '"><span>' + u.escapeHtml(item.name) + '</span></button>';
  }

  // 宿主 CSP（default-src 'self' data: blob:）挡的是 HTML 里解析出来的 style 属性，
  // CSSOM 写入（element.style.foo = …）不受它约束 —— 六个色块的渐变只能在这里着色，
  // 写进 innerHTML 会被静默丢掉，六块全白就是这个原因。
  async function paintSwatches(form, background) {
    if (!form) return;
    chatBackgrounds.forEach(function (item) {
      var button = form.querySelector('[data-background-preset="' + item.id + '"]');
      if (button) button.style.backgroundImage = presetCss(item);
    });
    var image = form.querySelector('[data-background-image]');
    if (!image) return;
    var url = await backgroundUrl(background);
    image.hidden = !url;
    image.style.backgroundImage = url ? cssUrl(url) : '';
  }

  // conversationId 定位记录；target 只在"这个对话正开着"时给出（列表页没有它），
  // 有它才需要顺手重绘已经打开的那一页。
  async function saveChatBackground(conversationId, target, background, form) {
    var next = await store.get('conversations', conversationId);
    if (!next) return;
    var previous = next.background;
    next.background = background; next.updatedAt = Date.now();
    await store.put('conversations', conversationId, next);
    // 改的不一定是"最近使用的那个对话"（列表页也能进背景设定）, 所以不直接铺, 而是让全局背景
    // 按 meta 里的记录重算一次 —— 规则仍然只有一个实现点, 也不会把别的对话的背景顶上来。
    if (target) target.conversation = next;
    await refreshAppBackground();
    markBackgroundCurrent(form, background);
    await paintSwatches(form, background);
    // 换掉或清掉相册背景之后，旧的那张不该继续占着宿主文件库 / 媒体库。
    if (previous !== background) await releaseBackground(previous);
  }

  // 旧版记录只有 mediaId，新版只有 logicalFileId；两种都要能释放。
  async function releaseBackground(background) {
    if (!background) return;
    if (background.logicalFileId) await store.releaseMedia([{ logicalFileId: background.logicalFileId }]).catch(function () {});
    if (background.mediaId) await store.releaseMedia([{ mediaId: background.mediaId }]).catch(function () {});
  }

  // 相册取图。拿不到可持久 URL 的环境（桌面浏览器预览）直接放弃，避免把一个
  // 刷新即失效的 blob: 地址写进对话记录。
  async function pickBackgroundImage() {
    var picked = await ui.pickLocalImage({ maxDimension: 2048, maxBytes: 700 * 1024, emptyMessage: '没有取得可用背景图片' });
    if (!picked) return null;
    var url = String(picked.url || '');
    if (!url || url.indexOf('blob:') === 0 || url.indexOf('data:') === 0) {
      if (picked.release) await picked.release();
      ui.toast('当前环境不能保存相册背景，请在 HermitApp 中选择');
      return null;
    }
    if (Number(picked.size || 0) > BACKGROUND_MAX_BYTES) {
      if (picked.release) await picked.release();
      ui.toast('背景原图不能超过 10 MiB', 4500);
      return null;
    }
    return picked;
  }

  async function backgroundSettings(conversationId, target) {
    var conversation = await store.get('conversations', conversationId);
    if (!conversation) return;
    var background = conversation.background;
    var form = ui.openModal({
      title: '对话背景',
      submitText: '完成',
      cancelText: null,
      html: '<div class="background-sheet"><p class="helper">背景会铺满整个应用, 并跟随最近打开过的对话。</p><div class="background-grid">' + backgroundImageSwatch() + chatBackgrounds.map(function (item) { return backgroundSwatch(item, background); }).join('') + '</div><div class="menu-list"><button class="menu-item" type="button" data-background-command="pick">' + ui.icon('image') + '<span>从相册选一张</span>' + ui.icon('chevron-right') + '</button><button class="menu-item" type="button" data-background-command="reset">' + ui.icon('rotate-left') + '<span>恢复默认背景</span></button></div></div>',
      onSubmit: function () {}
    });
    await paintSwatches(form, background);
    form.querySelectorAll('[data-background-preset]').forEach(function (button) {
      button.addEventListener('click', ui.action(function () { return saveChatBackground(conversationId, target, { kind: 'preset', id: button.dataset.backgroundPreset }, form); }));
    });
    form.querySelector('[data-background-command="reset"]').addEventListener('click', ui.action(function () { return saveChatBackground(conversationId, target, null, form); }));
    form.querySelector('[data-background-command="pick"]').addEventListener('click', ui.action(async function () {
      var picked = await pickBackgroundImage();
      if (!picked) return;
      // 取景只记参数，原图留在宿主文件库里：不用重新编码出第二个文件，也不用把
      // 图片本身塞进对话记录。
      await ui.cropPicture(picked, {
        mode: 'framing',
        aspect: ui.screenAspect(),
        keepSource: true,
        maxSourceBytes: BACKGROUND_MAX_BYTES,
        labels: {
          title: '调整对话背景', submit: '使用这张背景',
          help: '拖动图片选择要显示的区域；双指捏合、滚轮或下方按钮可以缩放。',
          preview: '对话背景取景预览', zoomIn: '放大背景', zoomOut: '缩小背景',
          notImage: '背景只支持 JPEG、PNG 或 WebP 图片',
          tooLarge: '背景原图不能超过 10 MiB',
          unreadable: '背景图片无法读取',
          failed: '背景处理失败，请换一张图片'
        },
        onCropped: async function (layout) {
          try {
            await saveChatBackground(conversationId, target, { kind: 'image', url: picked.url, name: picked.name, size: picked.size, logicalFileId: picked.logicalFileId, layout: layout }, form);
            ui.toast('背景已更新');
          } catch (error) { if (picked.release) await picked.release(); throw error; }
        }
      });
    }));
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
    // 沉浸模式必须在这里收干净: 它挂在 #appShell 上, 而 #appShell 是跨页面活着的。
    // 要在 target.closed = true **之前**收（setChromeHidden 自己会先判活）, 否则从一个"隐着"的
    // 对话切到列表页, 下一页的顶栏与输入区全是隐形的 —— 界面看起来就是坏了。
    setChromeHidden(target, false);
    await flushDraft(target);
    // 只收这一轮的**文本与朗读**。绘图（action）不受对话控制: 它自己在后台跑完并把结果落库,
    // 下次打开这个对话照样看得见（业主 2026-09-27）。stop() 里已经不碰 drawTasks, 别在这里补一刀。
    session.stop(target.conversation.id);
    target.closed = true; target.unsubscribe();
    if (target.syncComposerInset) window.removeEventListener('resize', target.syncComposerInset);
    if (target.composerObserver) { target.composerObserver.disconnect(); target.composerObserver = null; }
    if (target.speechId || target.speechStarting) await app.services.asr.cancelSystem().catch(function () {});
    await app.services.tts.stop().catch(function () {});
    if (target.job) await target.job.catch(function () {});
    // 背景不清: 它现在是应用级的, 回到列表页也还铺着 —— "继承最近使用的对话"就是这个意思。
    view = null; app.state.activeConversationId = null;
    revoke(target.urls); revoke(target.draftUrls);
    document.getElementById('imagePicker').onchange = null; document.getElementById('videoPicker').onchange = null; document.getElementById('audioPicker').onchange = null;
  }
  document.addEventListener('visibilitychange', function () { if (document.hidden && view) flushDraft(view).catch(showError); });
  app.events.on('tts:error', function (event) { ui.toast(event.message, 5000); });
  app.events.on('tts:state', function (event) { if (view) { var button = document.getElementById('muteTtsButton'); if (button) { button.classList.toggle('voice-active', Boolean(event.speaking)); button.innerHTML = ui.icon(event.muted ? 'volume-xmark' : 'volume-high'); button.setAttribute('aria-label', event.muted ? '恢复自动朗读' : '静音自动朗读'); button.setAttribute('title', event.muted ? '恢复自动朗读' : '静音自动朗读'); } if (event.preparing) status(view, '正在准备完整朗读音频…'); else if (event.buffering) status(view, '正在生成朗读音频 · 已缓存约 ' + Math.floor(event.bufferedSeconds || 0) + ' 秒'); else if (event.paused) { status(view, '朗读已等待新音频，点击消息上的播放按钮继续'); ensureResumeButton(event.messageId); } else if (event.ready) { status(view, '朗读音频已准备，点击消息上的播放按钮播放'); renderMessages(view).catch(showError); } } });
  app.features = app.features || {};
  app.features.chat = { render: render, close: close, backgroundSettings: backgroundSettings, refreshAppBackground: refreshAppBackground, repaintAppBackground: repaintAppBackground, renderMessages: function () { if (view) view.messageSnapshot = null; return renderMessages(view); } };
})(window.chataxi);
