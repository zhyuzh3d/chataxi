(function (app) {
  "use strict";
  var u = app.utils, ui = app.components, store = app.data.store;

  function modelId(kind, profile) { return profile && (profile.externalModelId || profile.model || profile.defaultModelId || (app.services.modelServices.models(kind, profile)[0] || {}).id) || ""; }
  function modelName(kind, profile) { var id = modelId(kind, profile), info = profile && app.services.modelServices.modelDefinition(kind, profile, id); return info && (info.name || info.id) || id; }
  function profileItems(kind, items, systemAvailable) {
    return (items || []).map(function (profile) {
      var system = (profile.family || profile.type) === "system", label = profile.name || modelName(kind, profile);
      if (!system && modelName(kind, profile) && label.indexOf(modelName(kind, profile)) < 0) label += " · " + modelName(kind, profile);
      return { id: profile.id, name: label + (system && systemAvailable === false ? " · 当前不可用" : ""), disabled: system && systemAvailable === false };
    });
  }
  function named(items) { return (items || []).map(function (item) { return { id: item.id, name: item.name || item.id }; }); }
  function defaultVoice(profile) { var voices = app.services.modelServices.voices(profile, modelId("tts", profile)); return (voices.find(function (item) { return item.id === profile.defaultVoiceId; }) || voices[0] || {}).id || ""; }
  function supports(model, name) { return (model.supportedParameters || []).indexOf(name) >= 0; }

  async function templateAvatarBlob(template) {
    var image = await new Promise(function (resolve, reject) { var value = new Image(); value.onload = function () { resolve(value); }; value.onerror = function () { reject(new Error("模板头像无法读取")); }; value.src = template.avatar; });
    var canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 320;
    canvas.getContext("2d").drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight, 0, 0, 320, 320);
    var output = await new Promise(function (resolve) { canvas.toBlob(resolve, "image/jpeg", 0.88); });
    if (!output) throw new Error("模板头像生成失败"); return output;
  }

  function interleaveTemplates(items) {
    var categories = ["male", "female", "other"], groups = {}, result = [], index = 0;
    categories.forEach(function (category) { groups[category] = []; });
    (items || []).forEach(function (item) {
      if (groups[item.category]) groups[item.category].push(item);
      else result.push(item);
    });
    while (categories.some(function (category) { return index < groups[category].length; })) {
      categories.forEach(function (category) { if (groups[category][index]) result.push(groups[category][index]); });
      index += 1;
    }
    return result;
  }

  function openTemplateGallery(onSelect) {
    var templates = app.data.roleTemplates && app.data.roleTemplates.items || [];
    if (!templates.length) throw new Error("角色模板尚未准备好");
    var allTemplates = interleaveTemplates(templates);
    var html = '<div class="section-tabs role-template-tabs" role="tablist" aria-label="角色模板分类"><button type="button" role="tab" data-template-tab="all" aria-selected="true">全部</button><button type="button" role="tab" data-template-tab="male" aria-selected="false">男性</button><button type="button" role="tab" data-template-tab="female" aria-selected="false">女性</button><button type="button" role="tab" data-template-tab="other" aria-selected="false">其他</button></div><p class="role-template-help">点击角色卡片直接应用</p><div class="role-template-grid">' + allTemplates.map(function (template) {
      var age = template.age == null ? "" : '<small>' + Number(template.age) + '岁</small>';
      return '<button class="role-template-card" type="button" data-role-template="' + u.escapeHtml(template.id) + '" data-template-category="' + u.escapeHtml(template.category) + '" aria-label="使用' + u.escapeHtml(template.name) + '模板"><img src="' + u.escapeHtml(template.avatar) + '" alt="" loading="lazy" decoding="async"><strong>' + u.escapeHtml(template.name) + '</strong><span class="role-template-profession">' + u.escapeHtml(template.profession) + '</span><span class="role-template-meta">' + age + '<small data-template-category-pill="' + u.escapeHtml(template.category) + '">' + u.escapeHtml(template.categoryLabel) + '</small></span></button>';
    }).join("") + '</div>';
    var gallery = ui.openSubsheet({ title: "选择角色模板", html: html, submitText: null });
    gallery.closest(".subsheet").classList.add("role-template-sheet");
    gallery.querySelectorAll("[data-template-tab]").forEach(function (button) {
      button.addEventListener("click", function () {
        gallery.querySelectorAll("[data-template-tab]").forEach(function (item) { item.setAttribute("aria-selected", String(item === button)); });
        gallery.querySelectorAll("[data-template-category]").forEach(function (card) { card.classList.toggle("is-hidden", button.dataset.templateTab !== "all" && card.dataset.templateCategory !== button.dataset.templateTab); });
      });
    });
    gallery.querySelectorAll("[data-role-template]").forEach(function (button) {
      button.addEventListener("click", ui.action(async function () {
        var template = allTemplates.find(function (item) { return item.id === button.dataset.roleTemplate; }); if (!template) throw new Error("角色模板不存在");
        gallery.querySelectorAll("button").forEach(function (item) { item.disabled = true; });
        try { await onSelect(template); ui.closeSubsheet(true, true); ui.toast("模板已套用，可继续修改"); }
        finally { if (gallery.isConnected) gallery.querySelectorAll("button").forEach(function (item) { item.disabled = false; }); }
      }));
    });
    return gallery;
  }

  async function repairElevenLabsVoiceNames(profile) {
    var voices = profile && profile.voices || [], missing = voices.some(function (item) { return typeof item === "string" || !String(item.name || "").trim() || item.name === item.id; });
    if (!profile || (profile.family || profile.type) !== "elevenlabs" || !profile.apiKey || !voices.length || !missing) return profile;
    try {
      var refreshed = u.clone(profile), result = await app.services.modelServices.discover("tts", refreshed, { persist: false });
      if (!(result.voices || []).some(function (item) { return item.name && item.name !== item.id; })) return profile;
      var selectedModel = modelId("tts", profile), selected = (result.models || []).find(function (item) { return item.id === selectedModel; });
      refreshed = app.services.modelServices.toSingleProfile("tts", refreshed, selectedModel, profile.modelFamilyId);
      refreshed.models = selected ? [selected] : profile.models; refreshed.voices = result.voices; refreshed.defaultVoiceId = profile.defaultVoiceId || defaultVoice(refreshed);
      await store.put("tts-profiles", refreshed.id, refreshed); return refreshed;
    } catch (_) { return profile; }
  }

  async function render() {
    var roles = (await store.list("roles")).sort(function (a, b) { return a.name.localeCompare(b.name, "zh-CN"); }), profiles = await store.list("llm-profiles");
    if (app.state.route !== "roles") return;
    ui.pageHeader("角色", roles.length + " 位角色", '<button class="button primary compact" type="button" data-add-role>' + ui.icon("plus") + '<span>新角色</span></button>');
    var main = document.getElementById("mainContent"); main.className = "main";
    main.innerHTML = '<section class="page">' + (roles.length ? ui.search("搜索角色名称或模型") + '<p class="count-label list-count">共 ' + roles.length + ' 个角色</p><div class="role-grid" id="roleList"></div>' : '<div class="compact-empty"><div class="empty-icon">' + ui.icon("user-group") + '</div><h2>创建第一位角色</h2><p>设定角色提示词、模型和声音后即可开始对话。</p><button class="button primary" type="button" data-add-role>' + ui.icon("plus") + '新角色</button></div>') + '</section>';
    function paint(query) {
      if (!roles.length) return;
      var items = roles.filter(function (role) { var profile = profiles.find(function (item) { return item.id === role.llmProfileId; }); return (role.name + " " + modelName("llm", profile) + " " + (profile ? profile.name : "")).toLowerCase().indexOf(query.toLowerCase()) >= 0; });
      document.getElementById("roleList").innerHTML = items.length ? items.map(function (role) {
        var status = app.services.profiles.roleStatus(role, profiles), profile = profiles.find(function (item) { return item.id === role.llmProfileId; });
        return '<article class="card role-card"><div class="role-card-head">' + ui.roleAvatar(role, "role-list-avatar") + '<div class="list-copy"><strong>' + u.escapeHtml(role.name) + '</strong><span>' + u.escapeHtml(profile ? (profile.name || "模型") + " · " + modelName("llm", profile) : "未绑定对话模型") + '</span></div><span class="badge ' + (status ? "warning" : "success") + '">' + (status ? u.escapeHtml(status) : "已上线") + '</span></div><div class="role-actions"><button class="button ghost" type="button" data-edit-role="' + u.escapeHtml(role.id) + '">' + ui.icon("gear") + '编辑角色</button><button class="button ' + (status ? "secondary" : "primary") + '" type="button" ' + (status ? 'data-edit-role' : 'data-chat-role') + '="' + u.escapeHtml(role.id) + '">' + ui.icon(status ? "gear" : "comment-dots") + (status ? "修复配置" : "开始对话") + '</button></div></article>';
      }).join("") : ui.empty("magnifying-glass", "没有找到角色", "换个关键词试试。", "");
      main.querySelectorAll("[data-edit-role]").forEach(function (button) { button.addEventListener("click", ui.action(async function () { await openEditor(await store.get("roles", button.dataset.editRole)); })); });
      main.querySelectorAll("[data-chat-role]").forEach(function (button) { button.addEventListener("click", ui.action(function () { return app.features.conversations.openEditor(null, button.dataset.chatRole); })); });
      ui.hydrateAvatars(main);
    }
    if (roles.length) { main.querySelector("#listSearch").addEventListener("input", function (event) { paint(event.target.value); }); paint(""); }
    document.querySelectorAll("[data-add-role]").forEach(function (button) { button.addEventListener("click", ui.action(function () { return openEditor(null); })); });
  }

  async function openEditor(existing, onSaved, options) {
    options = options || {};
    var llms = (await store.list("llm-profiles")).filter(function (item) { return item.enabled !== false || existing && item.id === existing.llmProfileId; });
    if (!llms.length && !existing) { await app.navigate("models", { modelsTab: "llm" }); app.features.models.openService("llm", null, function () { return app.navigate("roles").then(function () { return openEditor(null, onSaved); }); }); return; }
    var settings = await store.get("meta", "settings"), ttsProfiles = (await store.list("tts-profiles")).filter(function (item) { return item.enabled !== false || existing && item.id === existing.ttsProfileId; });
    ttsProfiles = await Promise.all(ttsProfiles.map(repairElevenLabsVoiceNames));
    var systemTtsAvailable = true;
    if (ttsProfiles.some(function (item) { return (item.family || item.type) === "system"; })) { systemTtsAvailable = false; if (await app.platform.hermit.awaitReady(1200)) { try { systemTtsAvailable = Boolean((await app.platform.hermit.api().tts.availability()).operational); } catch (_) {} } }
    var first = llms[0] || {}, editing = Boolean(existing);
    var role = existing || { id: u.id("role"), name: "", systemPrompt: "", llmProfileId: first.id || "", model: modelId("llm", first), temperature: null, temperatureOverride: false, maxOutputTokens: null, maxOutputOverride: false, topP: null, topPOverride: false, topK: null, topKOverride: false, reasoningEffort: "", allowImageGeneration: false, ttsProfileId: "", ttsModel: "", ttsVoice: "", voicePrompt: "", ttsSpeechRate: 0, ttsPitchRate: 0, ttsLoudnessRate: 0, avatarMediaId: "", enabled: true };
    var inheritedTts = ttsProfiles.find(function (item) { return item.id === settings.defaultTtsProfileId; });
    var html = '<div class="form-grid role-editor"><div class="section-tabs role-editor-tabs" role="tablist" aria-label="角色设定分类"><button type="button" role="tab" data-role-tab="profile" aria-selected="true">角色档案</button><button type="button" role="tab" data-role-tab="llm" aria-selected="false">语言模型</button><button type="button" role="tab" data-role-tab="tts" aria-selected="false">朗读发音</button></div>' +
      '<section class="editor-section role-editor-panel" data-role-panel="profile"><div class="avatar-editor"><button class="avatar-picker" type="button" data-choose-avatar aria-label="从图库选择角色头像"><span id="avatarPreview">' + ui.roleAvatar(role, "large") + '</span><span class="avatar-edit-badge">' + ui.icon("camera") + '</span></button><div class="avatar-copy"><strong data-role-avatar-name>' + u.escapeHtml(String(role.name || "").trim() || "未命名") + '</strong><small>点击头像更换</small><div class="avatar-actions">' + (role.avatarMediaId ? '<button class="button ghost" type="button" data-remove-avatar>移除头像</button>' : '') + '</div></div>' + (!editing ? '<button class="role-template-trigger" type="button" data-open-role-templates aria-label="选择角色模版"><img src="./app/assets/role-templates/template-mosaic.webp" alt=""><span>使用模版</span></button>' : '') + '</div><label class="field"><span>角色名称</span><input name="name" maxlength="40" value="' + u.escapeHtml(role.name) + '"></label><label class="field"><span>角色提示词</span><textarea class="prompt-editor" name="systemPrompt" maxlength="12000">' + u.escapeHtml(role.systemPrompt) + '</textarea></label><label class="switch-row"><span><strong>启用角色</strong><small>下线后保留历史，不接收新消息</small></span><input name="enabled" type="checkbox"' + (role.enabled !== false ? ' checked' : '') + '></label>' + (editing ? '<button class="button danger full" type="button" data-delete-role>' + ui.icon("trash") + '删除角色</button>' : '') + '</section>' +
      '<section class="editor-section role-editor-panel is-hidden" data-role-panel="llm">' + ui.picker("llmProfileId", "对话模型", "", "每个模型卡片只对应一个具体模型") + '<p class="helper" id="llmCapabilityHelp"></p><details class="advanced" open><summary>模型进阶设置</summary><div class="form-grid"><label class="switch-row" id="thinkingField"><span><strong>启用思考</strong><small>只在当前模型明确支持时发送</small></span><input name="thinkingEnabled" type="checkbox"' + (role.thinkingEnabled ? ' checked' : '') + '></label><label class="switch-row" id="temperatureOverrideField"><span><strong>自定义温度</strong><small>关闭时使用模型默认值</small></span><input name="temperatureOverride" type="checkbox"' + (role.temperatureOverride ? ' checked' : '') + '></label><label class="field range-field" id="temperatureField"><span>温度 <output data-output="temperature"></output></span><input name="temperature" type="range" min="0" max="2" step="0.1" value="' + Number(role.temperature == null ? 0.7 : role.temperature) + '"></label><label class="switch-row" id="maxOutputOverrideField"><span><strong>自定义最大输出</strong><small>关闭时使用模型默认值</small></span><input name="maxOutputOverride" type="checkbox"' + (role.maxOutputOverride ? ' checked' : '') + '></label><label class="field range-field" id="maxOutputField"><span>最大输出 <output data-output="maxOutputTokens"></output></span><input name="maxOutputTokens" type="range" min="256" max="32768" step="256" value="' + Number(role.maxOutputTokens || 4096) + '"></label><label class="switch-row" id="topPOverrideField"><span><strong>自定义 top_p</strong><small>只在当前模型与协议明确支持时发送</small></span><input name="topPOverride" type="checkbox"' + (role.topPOverride ? ' checked' : '') + '></label><label class="field range-field" id="topPField"><span>top_p <output data-output="topP"></output></span><input name="topP" type="range" min="0" max="1" step="0.05" value="' + Number(role.topP == null ? 1 : role.topP) + '"></label><label class="switch-row" id="topKOverrideField"><span><strong>自定义 top_k</strong><small>范围来自当前模型能力表</small></span><input name="topKOverride" type="checkbox"' + (role.topKOverride ? ' checked' : '') + '></label><label class="field range-field" id="topKField"><span>top_k <output data-output="topK"></output></span><input name="topK" type="range" min="1" max="100" step="1" value="' + Number(role.topK || 40) + '"></label><label class="field range-field" id="reasoningField"><span>推理强度 <output data-output="reasoningEffort"></output></span><input name="reasoningLevel" type="range" min="0" max="0" step="1" value="0"></label><label class="switch-row" id="imageGenerationField"><span><strong>允许图片生成</strong><small>只在模型与协议明确支持时发送</small></span><input name="allowImageGeneration" type="checkbox"' + (role.allowImageGeneration ? ' checked' : '') + '></label></div></details></section>' +
      '<section class="editor-section role-editor-panel is-hidden" data-role-panel="tts">' + ui.picker("ttsProfileId", "朗读模型", "", "选择具体模型后，再配置该模型实际可用的音色") + '<div id="ttsVoiceField">' + ui.picker("ttsVoice", "音色", "") + '</div><label class="field" id="voicePromptField"><span>音色提示词</span><textarea name="voicePrompt" maxlength="2000">' + u.escapeHtml(role.voicePrompt || "") + '</textarea></label><div class="form-grid"><label class="field range-field" id="ttsSpeechRateField"><span>语速 <output data-output="ttsSpeechRate"></output></span><input name="ttsSpeechRate" type="range" min="-50" max="100" step="1" value="' + Number(role.ttsSpeechRate || 0) + '"></label><label class="field range-field" id="ttsPitchRateField"><span>音调 <output data-output="ttsPitchRate"></output></span><input name="ttsPitchRate" type="range" min="-12" max="12" step="1" value="' + Number(role.ttsPitchRate || 0) + '"></label><label class="field range-field" id="ttsLoudnessRateField"><span>音量 <output data-output="ttsLoudnessRate"></output></span><input name="ttsLoudnessRate" type="range" min="-50" max="100" step="1" value="' + Number(role.ttsLoudnessRate || 0) + '"></label></div><p class="helper" id="voiceHelp"></p><button class="button secondary full" type="button" data-preview-tts>' + ui.icon("volume-high") + '试听</button></section></div>';
    var stagedAvatarId = "", stagedAvatarUrl = "", removeAvatar = false, submitted = false;
    var form = ui.openModal({ title: editing ? "编辑角色" : "创建角色", submitText: editing ? "保存更改" : "创建角色", html: html, onDismiss: function () { if (!submitted && stagedAvatarId) app.data.media.remove(stagedAvatarId).catch(function () {}); if (options.onDismiss) options.onDismiss(); }, onSubmit: async function (target) {
      var llm = selectedLlm(), llmId = modelId("llm", llm), llmDef = app.services.modelServices.modelDefinition("llm", llm, llmId), thinking = llmDef.thinkingMode === "forced" || u.checked(target, "thinkingEnabled"), state = { thinkingEnabled: thinking }, levels = app.services.modelServices.parameterAvailable(llmDef, "reasoning", state) ? llmDef.reasoning || [] : [];
      var ttsProfileId = u.formValue(target, "ttsProfileId"), tts = selectedTts(), ttsId = ttsProfileId ? modelId("tts", tts) : "", ttsDef = app.services.modelServices.modelDefinition("tts", tts, ttsId), voice = ttsProfileId ? u.formValue(target, "ttsVoice") || defaultVoice(tts) : "";
      var next = Object.assign({}, role, { name: u.formValue(target, "name"), systemPrompt: u.formValue(target, "systemPrompt"), avatarMediaId: removeAvatar ? "" : stagedAvatarId || role.avatarMediaId || "", llmProfileId: llm.id || "", model: llmId, temperatureOverride: app.services.modelServices.parameterAvailable(llmDef, "temperature", state) && u.checked(target, "temperatureOverride"), temperature: u.checked(target, "temperatureOverride") ? Number(u.formValue(target, "temperature")) : null, maxOutputOverride: maxSupported(llmDef) && u.checked(target, "maxOutputOverride"), maxOutputTokens: maxSupported(llmDef) && u.checked(target, "maxOutputOverride") ? Number(u.formValue(target, "maxOutputTokens")) : null, topPOverride: supports(llmDef, "top_p") && u.checked(target, "topPOverride"), topP: supports(llmDef, "top_p") && u.checked(target, "topPOverride") ? Number(u.formValue(target, "topP")) : null, topKOverride: topKSpec(llmDef) && u.checked(target, "topKOverride"), topK: topKSpec(llmDef) && u.checked(target, "topKOverride") ? Number(u.formValue(target, "topK")) : null, thinkingEnabled: llmDef.thinkingMode ? thinking : null, reasoningEffort: levels[Number(u.formValue(target, "reasoningLevel"))] || "", allowImageGeneration: llmDef.imageGeneration === true && u.checked(target, "allowImageGeneration"), ttsProfileId: ttsProfileId, ttsModel: ttsId, ttsVoice: voice, voicePrompt: ttsProfileId && ttsDef.voicePrompt ? u.formValue(target, "voicePrompt") : "", ttsSpeechRate: ttsProfileId && ttsDef.speechRate ? Number(u.formValue(target, "ttsSpeechRate")) : null, ttsPitchRate: ttsProfileId && ttsDef.pitchRate ? Number(u.formValue(target, "ttsPitchRate")) : null, ttsLoudnessRate: ttsProfileId && ttsDef.loudnessRate ? Number(u.formValue(target, "ttsLoudnessRate")) : null, enabled: u.checked(target, "enabled"), updatedAt: Date.now(), createdAt: role.createdAt || Date.now() });
      if (!next.name || !next.systemPrompt) throw new Error("请填写角色名称与提示词"); if (!next.llmProfileId || !next.model) throw new Error("请选择一个可用的对话模型"); if (ttsProfileId && (tts.family || tts.type) !== "system" && !app.services.modelServices.family("tts", tts.family || tts.type).voiceOptional && !next.ttsVoice) throw new Error("请为朗读模型选择音色"); if (next.enabled && app.services.profiles.roleStatus(next, await store.list("llm-profiles"))) throw new Error("请为启用的角色配置可用模型");
      await store.put("roles", next.id, next); await app.services.tts.invalidateRole(next.id); submitted = true; return next;
    }, onSuccess: async function (next) { if (existing && existing.avatarMediaId && existing.avatarMediaId !== next.avatarMediaId) await app.data.media.remove(existing.avatarMediaId).catch(function () {}); ui.toast(editing ? "角色已更新" : "角色已创建"); if (app.state.route === "roles") await render(); if (onSaved) return onSaved(next); } });

    function selectedLlm() { return llms.find(function (item) { return item.id === form.elements.namedItem("llmProfileId").value; }) || {}; }
    function selectedTts() { var id = form.elements.namedItem("ttsProfileId").value || settings.defaultTtsProfileId; return ttsProfiles.find(function (item) { return item.id === id; }) || {}; }
    function maxSupported(model) { return Boolean(model.maxOutputTokens || supports(model, "max_output_tokens") || supports(model, "max_completion_tokens")); }
    function topKSpec(model) { return model.parameterSpecs && model.parameterSpecs.topK && Number(model.parameterSpecs.topK.max) > Number(model.parameterSpecs.topK.min); }
    ui.bindPicker(form, "llmProfileId", profileItems("llm", llms), role.llmProfileId || first.id);
    ui.bindPicker(form, "ttsProfileId", [{ id: "", name: "跟随通用设置 · " + (inheritedTts ? inheritedTts.name : "未设置") }].concat(profileItems("tts", ttsProfiles, systemTtsAvailable)), role.ttsProfileId || "", { allowEmpty: true });
    var initialTts = selectedTts(), voicePicker = ui.bindPicker(form, "ttsVoice", named(app.services.modelServices.voices(initialTts, modelId("tts", initialTts))), role.ttsVoice || defaultVoice(initialTts), { allowEmpty: true });
    form.querySelectorAll("[data-role-tab]").forEach(function (button) { button.addEventListener("click", function () { var tab = button.dataset.roleTab; form.querySelectorAll("[data-role-tab]").forEach(function (item) { item.setAttribute("aria-selected", String(item === button)); }); form.querySelectorAll("[data-role-panel]").forEach(function (panel) { panel.classList.toggle("is-hidden", panel.dataset.rolePanel !== tab); }); }); });

    function toggle(id, visible) { form.querySelector(id).classList.toggle("is-hidden", !visible); }
    function syncLlm(reset) {
      var profile = selectedLlm(), id = modelId("llm", profile), model = app.services.modelServices.modelDefinition("llm", profile, id), thinkingInput = form.elements.namedItem("thinkingEnabled");
      if (reset) { form.elements.namedItem("temperatureOverride").checked = false; form.elements.namedItem("maxOutputOverride").checked = false; form.elements.namedItem("topPOverride").checked = false; form.elements.namedItem("topKOverride").checked = false; }
      thinkingInput.disabled = model.thinkingMode === "forced"; if (model.thinkingMode === "forced") thinkingInput.checked = true; if (!model.thinkingMode) thinkingInput.checked = false; toggle("#thinkingField", Boolean(model.thinkingMode));
      var state = { thinkingEnabled: model.thinkingMode === "forced" || thinkingInput.checked }, temp = app.services.modelServices.parameterAvailable(model, "temperature", state), max = maxSupported(model), topP = supports(model, "top_p"), topK = topKSpec(model);
      [["temperature", temp], ["maxOutput", max], ["topP", topP], ["topK", topK]].forEach(function (entry) { var override = form.elements.namedItem(entry[0] + "Override"); if (!entry[1]) override.checked = false; override.disabled = !entry[1]; toggle("#" + entry[0] + "OverrideField", entry[1]); toggle("#" + entry[0] + "Field", entry[1] && override.checked); form.elements.namedItem(entry[0] === "maxOutput" ? "maxOutputTokens" : entry[0]).disabled = !entry[1] || !override.checked; });
      var output = form.elements.namedItem("maxOutputTokens"); output.max = Number(model.maxOutputTokens || 32768); if (Number(output.value) > Number(output.max)) output.value = output.max;
      if (topK) { var spec = model.parameterSpecs.topK, input = form.elements.namedItem("topK"); input.min = spec.min; input.max = spec.max; input.step = spec.step || 1; }
      var levels = app.services.modelServices.parameterAvailable(model, "reasoning", state) ? model.reasoning || [] : [], reasoning = form.elements.namedItem("reasoningLevel"); reasoning.max = Math.max(0, levels.length - 1); reasoning.value = String(Math.max(0, levels.indexOf(role.reasoningEffort))); toggle("#reasoningField", Boolean(levels.length)); toggle("#imageGenerationField", model.imageGeneration === true); if (model.imageGeneration !== true) form.elements.namedItem("allowImageGeneration").checked = false;
      form.querySelector("#llmCapabilityHelp").textContent = model.capabilitySource === "unknown" ? "该模型只验证了基础连接；未知的可选参数不会显示或发送。" : "参数由当前模型能力与接口协议共同决定。"; syncOutputs();
    }
    function syncTts(reset) {
      var profile = selectedTts(), inherited = !form.elements.namedItem("ttsProfileId").value, system = (profile.family || profile.type) === "system", usable = !system || systemTtsAvailable, id = modelId("tts", profile), model = app.services.modelServices.modelDefinition("tts", profile, id), voices = app.services.modelServices.voices(profile, id);
      voicePicker.setItems(named(voices), reset ? role.ttsVoice || defaultVoice(profile) : undefined); toggle("#ttsVoiceField", !inherited && !system && voices.length > 0); toggle("#voicePromptField", !inherited && !system && model.voicePrompt === true); toggle("#ttsSpeechRateField", !inherited && !system && model.speechRate === true); toggle("#ttsPitchRateField", !inherited && !system && model.pitchRate === true); toggle("#ttsLoudnessRateField", !inherited && !system && model.loudnessRate === true);
      form.querySelector("#voiceHelp").textContent = !usable ? "当前设备没有可用的 Android 系统朗读引擎。" : inherited ? "模型、音色和发音参数跟随通用设置。" : system ? "系统朗读使用 Android 当前引擎。" : voices.length ? "这里只显示当前模型真实可用的音色。" : "当前模型没有已确认的可用音色。";
      var preview = form.querySelector("[data-preview-tts]"); preview.disabled = !usable || !profile.id || profile.enabled === false || (!system && !voices.length); preview.classList.toggle("is-hidden", !usable); syncOutputs();
    }
    function syncOutputs() { ["temperature", "topP"].forEach(function (name) { form.querySelector('[data-output="' + name + '"]').textContent = Number(form.elements.namedItem(name).value).toFixed(2).replace(/0$/, ""); }); form.querySelector('[data-output="maxOutputTokens"]').textContent = form.elements.namedItem("maxOutputTokens").value + " tokens"; form.querySelector('[data-output="topK"]').textContent = form.elements.namedItem("topK").value; var levels = app.services.modelServices.modelDefinition("llm", selectedLlm(), modelId("llm", selectedLlm())).reasoning || []; form.querySelector('[data-output="reasoningEffort"]').textContent = levels[Number(form.elements.namedItem("reasoningLevel").value)] || "自动"; ["ttsSpeechRate", "ttsPitchRate", "ttsLoudnessRate"].forEach(function (name) { form.querySelector('[data-output="' + name + '"]').textContent = form.elements.namedItem(name).value; }); }
    function syncAvatar() { var name = form.elements.namedItem("name").value.trim(), preview = form.querySelector("#avatarPreview"); form.querySelector("[data-role-avatar-name]").textContent = name || "未命名"; if (stagedAvatarUrl) preview.innerHTML = '<span class="avatar large"><img src="' + u.escapeHtml(stagedAvatarUrl) + '" alt=""></span>'; else { preview.innerHTML = ui.avatar(name, "", "large", "", removeAvatar ? "" : role.avatarMediaId); ui.hydrateAvatars(preview); } }
    form.elements.namedItem("llmProfileId").addEventListener("change", function () { syncLlm(true); }); form.elements.namedItem("ttsProfileId").addEventListener("change", function () { syncTts(true); }); form.elements.namedItem("ttsVoice").addEventListener("change", function () { syncTts(false); }); form.elements.namedItem("thinkingEnabled").addEventListener("change", function () { syncLlm(false); }); ["temperatureOverride", "maxOutputOverride", "topPOverride", "topKOverride"].forEach(function (name) { form.elements.namedItem(name).addEventListener("change", function () { syncLlm(false); }); }); form.querySelectorAll('input[type="range"]').forEach(function (input) { input.addEventListener("input", syncOutputs); }); form.elements.namedItem("name").addEventListener("input", syncAvatar);
    form.querySelector("[data-choose-avatar]").addEventListener("click", ui.action(async function () { var picked = await ui.pickLocalImage(); if (!picked) return; await ui.cropAvatar(picked, async function (output) { if (stagedAvatarId) await app.data.media.remove(stagedAvatarId).catch(function () {}); var record = await app.data.media.put(output, { name: "role-avatar.jpg", mime: "image/jpeg" }); stagedAvatarId = record.id; stagedAvatarUrl = await u.blobToDataUrl(output); removeAvatar = false; syncAvatar(); }); }));
    var templateTrigger = form.querySelector("[data-open-role-templates]"); if (templateTrigger) templateTrigger.addEventListener("click", ui.action(function () { return openTemplateGallery(async function (template) {
      var output = await app.features.roles.templateAvatarBlob(template), record = await app.data.media.put(output, { name: "role-template-avatar.jpg", mime: "image/jpeg" });
      if (stagedAvatarId) await app.data.media.remove(stagedAvatarId).catch(function () {});
      stagedAvatarId = record.id; stagedAvatarUrl = template.avatar; removeAvatar = false;
      form.elements.namedItem("name").value = template.name; form.elements.namedItem("systemPrompt").value = template.systemPrompt; syncAvatar();
    }); }));
    var removeAvatarButton = form.querySelector("[data-remove-avatar]"); if (removeAvatarButton) removeAvatarButton.addEventListener("click", ui.action(async function () { if (stagedAvatarId) await app.data.media.remove(stagedAvatarId).catch(function () {}); stagedAvatarId = ""; stagedAvatarUrl = ""; removeAvatar = true; removeAvatarButton.remove(); syncAvatar(); }));
    form.querySelector("[data-preview-tts]").addEventListener("click", ui.action(async function () { var profile = selectedTts(), id = modelId("tts", profile), voice = u.formValue(form, "ttsVoice") || defaultVoice(profile), model = app.services.modelServices.modelDefinition("tts", profile, id); await app.services.tts.speak("你好！欢迎使用朗读功能。", { ttsProfileId: profile.id, ttsModel: id, ttsVoice: voice, voicePrompt: model.voicePrompt ? u.formValue(form, "voicePrompt") : "", ttsSpeechRate: model.speechRate ? Number(u.formValue(form, "ttsSpeechRate")) : null, ttsPitchRate: model.pitchRate ? Number(u.formValue(form, "ttsPitchRate")) : null, ttsLoudnessRate: model.loudnessRate ? Number(u.formValue(form, "ttsLoudnessRate")) : null }); }));
    var remove = form.querySelector("[data-delete-role]"); if (remove) remove.addEventListener("click", ui.action(async function () { var refs = (await store.list("conversations")).filter(function (conversation) { return conversation.roleIds.indexOf(role.id) >= 0; }); if (refs.length) throw new Error("角色仍参与“" + refs[0].title + "”，请先编辑该对话"); if (await ui.confirm({ title: "删除“" + role.name + "”？", message: "角色提示词、模型设置与本地头像将从当前设备删除。", danger: true, confirmText: "删除角色" })) { await store.remove("roles", role.id); if (role.avatarMediaId) await app.data.media.remove(role.avatarMediaId).catch(function () {}); ui.closeModal(true, true); if (app.state.route === "roles") await render(); } }));
    syncLlm(false); syncTts(false); syncAvatar(); return form;
  }

  app.features.roles = { render: render, openEditor: openEditor, templateAvatarBlob: templateAvatarBlob };
})(window.chataxi);
