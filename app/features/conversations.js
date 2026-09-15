(function (app) {
  "use strict";
  var u = app.utils, ui = app.components, store = app.data.store;
  var query = "";

  function orderedRoleIds(conversation, roleIds) {
    var ids = (roleIds || []).slice(), moderatorId = conversation && conversation.moderatorRoleId;
    if (moderatorId && ids.indexOf(moderatorId) > 0) ids = [moderatorId].concat(ids.filter(function (id) { return id !== moderatorId; }));
    return ids;
  }

  async function guidedStart() {
    var profiles = (await store.list("llm-profiles")).filter(function (item) { return !app.services.modelServices.serviceStatus("llm", item) && app.services.modelServices.models("llm", item).length; });
    if (!profiles.length) {
      await app.navigate("models", { modelsTab: "llm" });
      app.features.models.openService("llm", null, guidedStart);
      return;
    }
    var roles = await app.services.profiles.availableRoles();
    if (!roles.length) {
      await app.navigate("roles");
      await app.features.roles.openEditor(null, function (role) { return openEditor(null, role.id); });
      return;
    }
    await openEditor();
  }

  function openConnectionGuide() {
    function address(label, url) {
      return '<div class="guide-address-block"><strong>' + u.escapeHtml(label) + '</strong><div class="guide-address-row">' + ui.copyUrl(url, "复制" + label + "地址") + '</div></div>';
    }
    var form = ui.openSubsheet({
      title: "连接模型指引",
      submitText: null,
      cancelText: "知道了",
      html: '<div class="section-tabs connection-guide-tabs" role="tablist" aria-label="连接模型指引分类">' +
        '<button type="button" role="tab" data-guide-tab="beginner" aria-selected="true"><span>新手</span></button>' +
        '<button type="button" role="tab" data-guide-tab="professional" aria-selected="false"><span>专业</span></button>' +
        '<button type="button" role="tab" data-guide-tab="international" aria-selected="false"><span>国际</span></button>' +
        '<button type="button" role="tab" data-guide-tab="troubleshooting" aria-selected="false"><span>问题</span></button></div>' +
        '<div class="connection-guide-content">' +
        '<section class="connection-guide-panel" data-guide-panel="beginner" role="tabpanel"><h3>单一模型</h3><p>适合新手用户。直接前往大模型官方的<strong>开放平台</strong>注册并获取 API Key。API 通常需要付费，部分平台注册会赠送额度；合理使用时，10 元通常足够聊天数日。</p><div class="guide-address-list">' + address("DeepSeek 开放平台", "https://platform.deepseek.com/api_keys") + address("Kimi 开放平台", "https://platform.kimi.com/console/api-keys") + '</div><h3>多个模型</h3><p>国内的大模型聚合平台通常只需注册一个账号和一份 API Key，就能使用多个模型。推荐硅基流动。一些模型中转服务价格更低，也能提供国外模型；请自行确认其隐私、稳定性和计费规则。</p><div class="guide-address-list">' + address("硅基流动", "https://cloud.siliconflow.cn/me/account/ak") + '</div></section>' +
        '<section class="connection-guide-panel is-hidden" data-guide-panel="professional" role="tabpanel"><h3>电脑部署</h3><p>在电脑上安装并运行开源大模型，再通过局域网 IP 地址向 chataxi 提供兼容接口。推荐使用 <strong>Ollama 软件</strong>安装和管理本地模型。</p><p class="guide-note">电脑和手机需要处于可以互相访问的局域网；服务地址应使用电脑的局域网 IP，不能填写只指向设备自身的 localhost。</p></section>' +
        '<section class="connection-guide-panel is-hidden" data-guide-panel="international" role="tabpanel"><h3>国外模型</h3><p>境外网络环境下，可以连接 Grok、OpenAI、Gemini、Claude 等官方模型服务，也可以使用 OpenRouter、Requesty、302.AI 等聚合服务。</p><p class="guide-note">各服务的地区、付款方式和网络要求不同，请优先使用官方开放平台，并遵守服务商的使用规则。</p></section>' +
        '<section class="connection-guide-panel is-hidden" data-guide-panel="troubleshooting" role="tabpanel"><h3>连接遇到问题</h3><ol><li>回到 Hermit 应用。</li><li>打开“开发”Tab，并开启“智能体开发模式”。</li><li>把当前开发地址和密码复制给 Codex、WorkBuddy 等智能体软件。</li><li>要求智能体帮助解决 chataxi 模型服务连接问题。</li></ol><p class="guide-note">授权后，智能体可以通过 Hermit 的开发接口检查并修改 chataxi 代码，协助适配当前模型服务。</p></section>' +
        '</div>'
    });
    form.closest(".subsheet").classList.add("connection-guide-sheet");
    function selectTab(name) {
      form.querySelectorAll("[data-guide-tab]").forEach(function (button) { button.setAttribute("aria-selected", String(button.dataset.guideTab === name)); });
      form.querySelectorAll("[data-guide-panel]").forEach(function (panel) { panel.classList.toggle("is-hidden", panel.dataset.guidePanel !== name); });
    }
    form.querySelectorAll("[data-guide-tab]").forEach(function (button) { button.addEventListener("click", function () { selectTab(button.dataset.guideTab); }); });
    ui.bindCopyUrls(form);
  }

  async function render() {
    var conversations = (await store.list("conversations")).sort(function (a, b) { return Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt; });
    var roles = await store.list("roles"), llms = await store.list("llm-profiles"), drafts = await store.list("drafts");
    if (app.state.route !== "conversations") return;
    var roleMap = {}, draftMap = {};
    roles.forEach(function (role) { roleMap[role.id] = role; });
    drafts.forEach(function (draft) { if (draft.text || (draft.media || []).length) draftMap[draft.id] = draft; });
    var available = roles.filter(function (role) { return !app.services.profiles.roleStatus(role, llms); });
    var connected = llms.some(function (profile) { return !app.services.modelServices.serviceStatus("llm", profile) && app.services.modelServices.models("llm", profile).length; });
    ui.pageHeader("chataxi", "想聊就聊，自由自在", '<button class="button primary compact" type="button" data-create>' + ui.icon("plus") + '<span>新对话</span></button>');
    document.getElementById("pageTitle").insertAdjacentHTML("beforeend", '<small class="title-version">v' + u.escapeHtml(app.version) + '</small>');
    var main = document.getElementById("mainContent"); main.className = "main";
    if (!conversations.length) {
      main.innerHTML = '<section class="page"><div class="welcome-card"><div class="welcome-emblem" aria-hidden="true">' + ui.icon("comment-dots") + '</div><h2>开始第一次对话</h2><p>连接模型服务，创建角色，然后开始交流。</p><div class="setup-steps">' +
        [{ title: "连接模型", text: "使用你的 API 或局域网服务", done: connected, help: true }, { title: "创建角色", text: "设定身份、提示词与模型", done: available.length > 0 }, { title: "开始对话", text: "单聊深入，群聊集思广益", done: false }].map(function (step, i) {
          return '<div class="setup-step ' + (step.done ? "done" : "") + '"><span class="step-number">' + (step.done ? ui.icon("check") : String(i + 1).padStart(2, "0")) + '</span><div class="setup-step-copy"><strong>' + step.title + '</strong><span>' + step.text + '</span></div><div class="setup-step-actions">' + (step.help ? '<button class="setup-help-button" type="button" data-connection-guide aria-label="查看连接模型指引">' + ui.icon("question") + '</button>' : '') + '</div></div>';
        }).join("") + '</div><button class="button primary full" type="button" data-create><span>' + (available.length ? "开始第一次对话" : connected ? "继续 · 创建角色" : "开始 · 连接模型") + '</span>' + ui.icon("arrow-right") + '</button><p class="privacy-note">角色、服务和对话保存在当前设备</p></div></section>';
    } else {
      main.innerHTML = '<section class="page"><div class="list-toolbar">' + ui.search("搜索对话、角色或全部消息") + '<span class="count-label list-count" id="conversationCount">共 ' + conversations.length + ' 个对话</span></div><div class="list conversation-list" id="conversationList"></div></section>';
      var searchIndex = {}, searchIndexReady = false, searchIndexPromise = null, searchTimer = 0, searchRevision = 0;
      function ensureSearchIndex() {
        if (!searchIndexPromise) searchIndexPromise = (async function () {
          for (var i = 0; i < conversations.length; i += 1) {
            var messages = await store.messages(conversations[i].id);
            searchIndex[conversations[i].id] = messages.map(function (message) { return message.text || ""; }).join("\n").toLowerCase();
            if (i && i % 4 === 0) await new Promise(function (resolve) { setTimeout(resolve, 0); });
          }
          searchIndexReady = true;
        })();
        return searchIndexPromise;
      }
      var paint = function () {
        var items = conversations.filter(function (conversation) {
          var names = conversation.roleIds.map(function (id) { return roleMap[id] ? roleMap[id].name : ""; }).join(" ");
          var haystack = (conversation.title + " " + names + " " + (conversation.lastMessage || "")).toLowerCase();
          return haystack.indexOf(query.toLowerCase()) >= 0 || Boolean(query && searchIndexReady && (searchIndex[conversation.id] || "").indexOf(query.toLowerCase()) >= 0);
        });
        document.getElementById("conversationList").innerHTML = items.length ? items.map(function (conversation) {
          var participants = conversation.roleIds.map(function (id) { return roleMap[id]; }).filter(Boolean);
          var draft = draftMap[conversation.id];
          var preview = draft ? "草稿 · " + (draft.text || "[图片]") : conversation.lastMessage || "发出第一条消息吧";
          var unavailable = participants.some(function (role) { return app.services.profiles.roleStatus(role, llms); }) || participants.length !== conversation.roleIds.length;
          var participantText = (participants.length > 1 ? "群聊" : "单聊") + "\u00a0|\u00a0" + participants.map(function (role) { return role.name; }).join(" · ");
          return '<article class="card conversation-card"><button class="card-button conversation-open" type="button" data-open="' + u.escapeHtml(conversation.id) + '"><div class="avatar-stack">' + participants.slice(0, 2).map(function (role) { return ui.roleAvatar(role); }).join("") + '</div><div class="list-copy"><div class="conversation-title"><strong><span class="conversation-title-text">' + (conversation.pinned ? ui.icon("thumbtack") : '') + '<span>' + u.escapeHtml(conversation.title) + '</span></span></strong><time>' + u.escapeHtml(u.formatTime(conversation.updatedAt)) + '</time></div><p class="preview ' + (draft ? 'draft-preview' : '') + '">' + u.escapeHtml(preview) + '</p><div class="meta"><span>' + u.escapeHtml(participantText) + '</span>' + (unavailable ? '<span class="badge warning">需要修复配置</span>' : '') + '</div></div></button><div class="conversation-action-rail" role="group" aria-label="' + u.escapeHtml(conversation.title) + ' 对话操作"><button class="conversation-action-cell conversation-action-open" type="button" data-open="' + u.escapeHtml(conversation.id) + '" aria-label="进入 ' + u.escapeHtml(conversation.title) + '">' + ui.icon("comment") + '</button><button class="conversation-action-cell" type="button" data-manage="' + u.escapeHtml(conversation.id) + '" aria-label="管理 ' + u.escapeHtml(conversation.title) + '">' + ui.icon("gear") + '</button></div></article>';
        }).join("") : ui.empty("magnifying-glass", "没有找到对话", "换个关键词试试。", '');
        main.querySelectorAll("[data-open]").forEach(function (button) { button.addEventListener("click", ui.action(function () { return app.openChat(button.dataset.open); })); });
        main.querySelectorAll("[data-manage]").forEach(function (button) { button.addEventListener("click", ui.action(function () { return manage(button.dataset.manage); })); });
        ui.hydrateAvatars(main);
      };
      var input = document.getElementById("listSearch"), count = document.getElementById("conversationCount"); input.value = query;
      input.addEventListener("input", function () {
        query = input.value; clearTimeout(searchTimer); var revision = ++searchRevision;
        if (!query) { count.textContent = "共 " + conversations.length + " 个对话"; paint(); return; }
        count.textContent = searchIndexReady ? "正在筛选…" : "正在搜索全部消息…";
        paint();
        searchTimer = setTimeout(function () { ensureSearchIndex().then(function () { if (revision !== searchRevision || app.state.route !== "conversations") return; paint(); var matches = document.querySelectorAll("#conversationList .conversation-card").length; count.textContent = "共 " + matches + " 个结果"; }).catch(function (error) { count.textContent = "搜索失败"; ui.toast(u.cleanError(error)); }); }, 160);
      });
      paint(); if (query) input.dispatchEvent(new Event("input"));
    }
    document.querySelectorAll("[data-create]").forEach(function (button) { button.addEventListener("click", ui.action(guidedStart)); });
    var guideButton = document.querySelector("[data-connection-guide]");
    if (guideButton) guideButton.addEventListener("click", openConnectionGuide);
  }

  async function openEditor(conversation, roleId, draftState) {
    var roles = await app.services.profiles.availableRoles();
    if (!roles.length) { if (conversation) { ui.toast("请先在角色页恢复一个可用角色，再编辑此对话"); return app.navigate("roles"); } return guidedStart(); }
    var editing = Boolean(conversation);
    var initial = draftState ? draftState.roleIds : conversation ? orderedRoleIds(conversation, conversation.roleIds) : roleId ? [roleId] : roles.length === 1 ? [roles[0].id] : [];
    var selectionOrder = initial.slice();
    var recentValue = Number(draftState ? draftState.recentFullMessages : conversation && conversation.recentFullMessages || 10), titleValue = draftState ? draftState.title : conversation ? conversation.title : "";
    var form = ui.openModal({ title: editing ? "基础设定" : "新对话", submitText: editing ? "保存更改" : "开始对话", html: '<div class="form-grid"><label class="field"><span>对话标题</span><input name="title" maxlength="80" value="' + u.escapeHtml(titleValue) + '" placeholder="可留空，使用角色名称"></label><fieldset><legend>参与角色</legend><div class="stack">' + roles.map(function (role, index) { var inputId = "conversation-role-" + index; return '<div class="role-choice" data-role-choice="' + u.escapeHtml(role.id) + '"><button class="role-choice-avatar" type="button" data-edit-participant="' + u.escapeHtml(role.id) + '" aria-label="编辑角色 ' + u.escapeHtml(role.name) + '">' + ui.roleAvatar(role) + '</button><label class="list-copy" for="' + inputId + '"><strong class="role-choice-name"><span>' + u.escapeHtml(role.name) + '</span><small class="moderator-badge is-hidden" data-moderator-badge="' + u.escapeHtml(role.id) + '">主持</small></strong><span>' + u.escapeHtml(role.model || "待选择模型") + '</span></label><input id="' + inputId + '" type="checkbox" name="roleIds" value="' + u.escapeHtml(role.id) + '" aria-label="选择角色 ' + u.escapeHtml(role.name) + '"' + (initial.indexOf(role.id) >= 0 ? ' checked' : '') + '></div>'; }).join('') + '</div></fieldset><p class="helper" id="selectionSummary" role="status"></p><label class="field range-field"><span>固定携带最近消息 <output data-output="recentFullMessages">' + recentValue + ' 条</output></span><input name="recentFullMessages" type="range" min="5" max="50" step="1" value="' + recentValue + '"><small>只影响本对话；更早内容由角色自动压缩。</small></label></div>',
      onSubmit: async function (target) {
        var selected = selectionOrder.filter(function (id) { var input = target.querySelector('[name="roleIds"][value="' + String(id).replace(/"/g, '\\"') + '"]'); return input && input.checked; });
        if (!selected.length) throw new Error("请至少选择一位角色");
        var selectedKind = selected.length === 1 ? "single" : "group";
        var names = selected.map(function (id) { return roles.find(function (role) { return role.id === id; }); }).filter(Boolean).map(function (role) { return role.name; });
        var recentFullMessages = Number(u.formValue(target, "recentFullMessages"));
        if (recentFullMessages < 5 || recentFullMessages > 50) throw new Error("最近完整消息数量需在 5 到 50 之间");
        var rememberedRoleId = conversation && (conversation.activeRoleIds || []).find(function (roleId) { return selected.indexOf(roleId) >= 0; });
        var next = Object.assign({}, conversation || { userName: "", userIntroduction: "", userAvatarMediaId: "", autoSelectRole: false }, { id: conversation ? conversation.id : u.id("conversation"), title: u.formValue(target, "title") || (selectedKind === "single" ? "与" + names[0] + "的对话" : names.join("、") + "的群聊").slice(0, 80), kind: selectedKind, roleIds: selected, moderatorRoleId: selected[0], activeRoleIds: [rememberedRoleId || selected[0]], autoSelectRole: selectedKind === "group" && Boolean(conversation && conversation.autoSelectRole), recentFullMessages: recentFullMessages, createdAt: conversation ? conversation.createdAt : Date.now(), updatedAt: Date.now() });
        await store.put("conversations", next.id, next); return next;
      }, onSuccess: function (next) { ui.toast(editing ? "对话已更新" : "对话已创建"); return app.openChat(next.id); }
    });
    function sync() {
      var checked = Array.prototype.map.call(form.querySelectorAll('[name="roleIds"]:checked'), function (item) { return item.value; });
      selectionOrder = selectionOrder.filter(function (id) { return checked.indexOf(id) >= 0; });
      checked.forEach(function (id) { if (selectionOrder.indexOf(id) < 0) selectionOrder.push(id); });
      var count = selectionOrder.length, moderatorId = selectionOrder[0] || "";
      form.querySelectorAll('[data-moderator-badge]').forEach(function (badge) { badge.classList.toggle('is-hidden', badge.dataset.moderatorBadge !== moderatorId); });
      form.querySelector("#selectionSummary").textContent = count === 1 ? "已选择 1 位角色 · 主持人：" + (roles.find(function (role) { return role.id === moderatorId; }) || {}).name + " · 自动作为单聊" : count > 1 ? "已选择 " + count + " 位角色 · 主持人：" + (roles.find(function (role) { return role.id === moderatorId; }) || {}).name + " · 自动作为群聊" : "请选择至少一位角色；第一个选中的角色将成为主持人";
      form.querySelector('[type="submit"]').disabled = count < 1;
    }
    form.querySelectorAll('[name="roleIds"]').forEach(function (box) { box.addEventListener("change", sync); });
    form.querySelectorAll("[data-edit-participant]").forEach(function (button) { button.addEventListener("click", ui.action(async function () {
      var draft = { title: u.formValue(form, "title"), roleIds: selectionOrder.slice(), moderatorRoleId: selectionOrder[0] || "", recentFullMessages: Number(u.formValue(form, "recentFullMessages")) };
      var selectedRole = await store.get("roles", button.dataset.editParticipant); if (!selectedRole) throw new Error("角色不存在");
      ui.closeModal(true, true);
      var reopened = false, reopen = async function () { if (reopened) return; reopened = true; await openEditor(conversation ? await store.get("conversations", conversation.id) : null, roleId, draft); };
      await app.features.roles.openEditor(selectedRole, reopen, { onDismiss: reopen });
    })); });
    form.elements.namedItem("recentFullMessages").addEventListener("input", function (event) { form.querySelector('[data-output="recentFullMessages"]').textContent = event.target.value + " 条"; });
    sync(); ui.hydrateAvatars(form);
  }

  async function exportText(id) {
    var conversation = await store.get("conversations", id), messages = await store.messages(id);
    var globalProfile = await store.get("meta", "user-profile"), userProfile = app.services.profiles.userForConversation(conversation, globalProfile);
    var text = conversation.title + "\n\n" + messages.map(function (message) { return (message.kind === "user" ? userProfile.name : message.roleName || "AI") + " · " + new Date(message.createdAt).toLocaleString("zh-CN") + "\n" + (message.text || "") + ((message.media || []).length ? "\n[" + message.media.length + " 张图片，未包含在文字导出中]" : "") + (message.status !== "done" ? "\n[" + (message.error || "未完成") + "]" : ""); }).join("\n\n");
    ui.openModal({ title: "导出对话文字", submitText: "复制全部文字", html: '<p class="helper">包含本对话的文字与图片数量，不包含连接、密钥和图片文件。</p><label class="field"><span>对话文字</span><textarea class="export-text" readonly>' + u.escapeHtml(text) + '</textarea></label>', onSubmit: async function () { await app.platform.hermit.copyText(text); ui.toast("已复制"); } });
  }

  async function openPersonalProfile(conversation, onSaved) {
    conversation = await store.get("conversations", conversation.id); if (!conversation) throw new Error("对话不存在");
    var globalProfile = await store.get("meta", "user-profile") || { name: "我", introduction: "", avatarMediaId: "" };
    var effective = app.services.profiles.userForConversation(conversation, globalProfile);
    var html = '<div class="form-grid conversation-profile-editor"><p class="helper">这里只保存本对话的个人设定。每个空字段分别跟随“我的”，不会把两段内容拼接。</p><div class="avatar-editor"><button class="avatar-picker round" type="button" data-choose-conversation-avatar aria-label="从图库选择本对话头像"><span id="conversationAvatarPreview">' + ui.avatar(effective.name, "", "large user-profile-avatar", "", effective.avatarMediaId) + '</span><span class="avatar-edit-badge" aria-hidden="true">' + ui.icon("camera") + '</span></button><div class="avatar-copy"><strong>本对话头像 <em>选填</em></strong><small>' + (conversation.userAvatarMediaId ? '当前使用本对话头像' : '当前跟随“我的”头像') + '</small><div class="avatar-actions">' + (conversation.userAvatarMediaId ? '<button class="button ghost" type="button" data-follow-user-avatar>跟随“我的”头像</button>' : '') + '</div></div></div><label class="field"><span>本对话名称 <em>选填</em></span><input name="userName" maxlength="40" value="' + u.escapeHtml(conversation.userName || "") + '" placeholder="留空则使用“我的”：' + u.escapeHtml(globalProfile.name || "我") + '"><small>发送给模型和消息气泡显示时，优先使用本字段。</small></label><label class="field"><span>本对话自我介绍 <em>选填</em></span><textarea class="prompt-editor" name="userIntroduction" maxlength="8000" placeholder="留空则使用“我的”页面中的自我介绍">' + u.escapeHtml(conversation.userIntroduction || "") + '</textarea><small>发送给模型时，优先使用本字段；留空只回落到通用介绍。</small></label><div class="identity-preview"><strong>“我的”个人设定</strong><p>名称：' + u.escapeHtml(globalProfile.name || "我") + '</p><p>介绍：' + u.escapeHtml(globalProfile.introduction || "尚未设置") + '</p></div></div>';
    var stagedBlob = null, stagedDataUrl = "", followGlobalAvatar = false;
    var form = ui.openModal({ title: "本对话个人设定", submitText: "保存个人设定", html: html, onSubmit: async function (target) {
      var next = await store.get("conversations", conversation.id); if (!next) throw new Error("对话不存在");
      var oldAvatarMediaId = String(next.userAvatarMediaId || ""), created = null;
      try {
        var avatarMediaId = followGlobalAvatar ? "" : oldAvatarMediaId;
        if (stagedBlob) { created = await app.data.media.put(stagedBlob, { name: "conversation-user-avatar.jpg", mime: "image/jpeg" }); avatarMediaId = created.id; }
        next.userName = u.formValue(target, "userName");
        next.userIntroduction = u.formValue(target, "userIntroduction");
        next.userAvatarMediaId = avatarMediaId;
        next.updatedAt = Date.now();
        await store.put("conversations", next.id, next);
        if (oldAvatarMediaId && oldAvatarMediaId !== avatarMediaId) await store.releaseMedia([oldAvatarMediaId]).catch(function () {});
        conversation = next; stagedBlob = null; stagedDataUrl = ""; followGlobalAvatar = false; return next;
      } catch (error) { if (created) await app.data.media.remove(created.id).catch(function () {}); throw error; }
    }, onSuccess: async function (next) { ui.toast("本对话个人设定已保存"); if (onSaved) await onSaved(next); } });
    ui.hydrateAvatars(form);
    function preview() {
      var next = Object.assign({}, conversation, { userName: u.formValue(form, "userName"), userAvatarMediaId: followGlobalAvatar ? "" : conversation.userAvatarMediaId || "" });
      var resolved = app.services.profiles.userForConversation(next, globalProfile), target = form.querySelector("#conversationAvatarPreview");
      if (stagedDataUrl) target.innerHTML = '<span class="avatar large user-profile-avatar" aria-hidden="true"><img src="' + u.escapeHtml(stagedDataUrl) + '" alt=""></span>';
      else { target.innerHTML = ui.avatar(resolved.name, "", "large user-profile-avatar", "", resolved.avatarMediaId); ui.hydrateAvatars(target); }
      var copy = form.querySelector(".avatar-copy small"); if (copy) copy.textContent = stagedDataUrl ? "将使用新选择的本对话头像" : resolved.avatarMediaId && !followGlobalAvatar && conversation.userAvatarMediaId ? "当前使用本对话头像" : "当前跟随“我的”头像";
    }
    function bindFollow(button) { button.addEventListener("click", function () { stagedBlob = null; stagedDataUrl = ""; followGlobalAvatar = true; button.remove(); preview(); }); }
    var follow = form.querySelector("[data-follow-user-avatar]"); if (follow) bindFollow(follow);
    form.querySelector("[data-choose-conversation-avatar]").addEventListener("click", ui.action(async function () {
      var picked = await ui.pickLocalImage(); if (!picked) return;
      await ui.cropAvatar(picked, async function (output) {
        stagedBlob = output; stagedDataUrl = await u.blobToDataUrl(output); followGlobalAvatar = false; preview();
        var actions = form.querySelector(".avatar-actions");
        if (!actions.querySelector("[data-follow-user-avatar]")) { var button = document.createElement("button"); button.type = "button"; button.className = "button ghost"; button.dataset.followUserAvatar = ""; button.textContent = "跟随“我的”头像"; actions.appendChild(button); bindFollow(button); }
      });
    }));
    form.elements.namedItem("userName").addEventListener("input", preview);
    return form;
  }

  async function manage(id) {
    var conversation = await store.get("conversations", id);
    if (!conversation) return;
    var form = ui.openModal({ title: conversation.title, submitText: "完成", cancelText: null, html: '<div class="menu-list"><button class="menu-item" type="button" data-menu="edit">' + ui.icon('gear') + '<span>基础设定</span>' + ui.icon('chevron-right') + '</button><button class="menu-item" type="button" data-menu="identity">' + ui.icon('gear') + '<span>个人设定</span>' + ui.icon('chevron-right') + '</button><button class="menu-item" type="button" data-menu="pin">' + ui.icon('thumbtack') + '<span>' + (conversation.pinned ? '取消置顶' : '置顶对话') + '</span></button><button class="menu-item" type="button" data-menu="export">' + ui.icon('file-lines') + '<span>导出对话文字</span></button><button class="menu-item danger-text" type="button" data-menu="delete">' + ui.icon('trash') + '<span>删除对话</span></button></div>', onSubmit: function () {} });
    form.querySelectorAll('[data-menu]').forEach(function (button) { button.addEventListener('click', ui.action(async function () {
      var command = button.dataset.menu;
      if (app.features.chatSession.active(id) && (command === "edit" || command === "delete")) { ui.toast("请先停止本轮回复，再修改或删除对话"); return; }
      ui.closeModal();
      if (command === 'edit') return openEditor(conversation);
      if (command === 'identity') return openPersonalProfile(conversation, function (next) { conversation = next; });
      if (command === 'export') return exportText(id);
      if (command === 'pin') { conversation.pinned = !conversation.pinned; await store.put("conversations", id, conversation); ui.toast(conversation.pinned ? '对话已置顶' : '已取消置顶'); if (app.state.route === 'conversations') await render(); }
      if (command === 'delete' && await ui.confirm({ title: '删除对话？', message: '“' + conversation.title + '”的消息、草稿和未被其他对话使用的图片将从本机删除，无法撤销。', confirmText: '删除对话', danger: true })) {
        if (app.state.activeConversationId === id) await app.features.chat.close();
        await store.deleteConversation(id); await app.navigate('conversations'); ui.toast('对话已删除');
      }
    })); });
  }
  app.features = app.features || {};
  app.features.conversations = { render: render, openEditor: openEditor, openPersonalProfile: openPersonalProfile, guidedStart: guidedStart, manage: manage, exportText: exportText };
})(window.chataxi);
