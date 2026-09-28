(function (app) {
  "use strict";
  var u = app.utils, ui = app.components, store = app.data.store;
  var names = { llm: "对话模型", tts: "朗读模型", asr: "语音输入", image: "绘图模型" };
  var icons = { llm: "brain", tts: "volume-high", asr: "microphone", image: "image" }, testing = {};
  var systemRuntimeCache = {};

  function field(name, label, value, attrs) { return '<label class="field"><span>' + label + '</span><input name="' + name + '" value="' + u.escapeHtml(value || '') + '" ' + (attrs || '') + '></label>'; }
  function familyOf(kind, service) { return app.services.modelServices.family(kind, service.family || service.type); }
  function collection(kind) { return kind + "-profiles"; }
  async function systemRuntime(kind, refresh) {
    if (kind === "asr") return app.services.asr.systemCapability(refresh);
    if (kind !== "tts") return null;
    if (!refresh && systemRuntimeCache.tts && Date.now() - systemRuntimeCache.tts.at < 30000) return systemRuntimeCache.tts.value;
    var value;
    if (!(await app.platform.haminn.awaitReady(1200))) value = { available: false, operational: false, voices: [], languages: [], message: "Android 系统朗读只在 HaminnApp 中可用" };
    else {
      var api = app.platform.haminn.api(), availability = await api.tts.availability(), catalog = { voices: [], languages: [] };
      if (availability.operational) { try { catalog = await api.tts.voices(); } catch (_) {} }
      value = Object.assign({}, availability, catalog, { voices: Array.isArray(catalog.voices) ? catalog.voices : [], languages: Array.isArray(catalog.languages) ? catalog.languages : [] });
    }
    systemRuntimeCache.tts = { at: Date.now(), value: value }; return value;
  }

  async function render() {
    var kind = app.state.modelsTab || "llm"; if (!names[kind]) kind = app.state.modelsTab = "llm";
    ui.pageHeader("模型", "服务与模型能力"); var main = document.getElementById("mainContent"); main.className = "main";
    main.innerHTML = '<section class="page models-page"><div class="section-tabs" role="tablist" aria-label="模型服务分类">' + Object.keys(names).map(function (key) { return '<button type="button" role="tab" id="models-tab-' + key + '" aria-controls="modelsContent" data-model-tab="' + key + '" aria-selected="' + (key === kind) + '"><span>' + names[key] + '</span></button>'; }).join("") + '</div><div id="modelsContent" role="tabpanel" aria-labelledby="models-tab-' + kind + '"></div></section>';
    main.querySelectorAll("[data-model-tab]").forEach(function (button) { button.addEventListener("click", ui.action(async function () { app.state.modelsTab = button.dataset.modelTab; await render(); })); }); await renderServices(kind);
  }

  async function renderServices(kind) {
    var services = await store.list(collection(kind)); if (app.state.route !== "models" || app.state.modelsTab !== kind) return;
    var runtime = (kind === "tts" || kind === "asr") && services.some(function (service) { return familyOf(kind, service).id === "system"; }) ? await systemRuntime(kind, true) : null;
    if (app.state.route !== "models" || app.state.modelsTab !== kind) return;
    var content = document.getElementById("modelsContent"), note = kind === "llm" ? "每张卡片对应一个模型；运行参数在角色中设置。" : kind === "tts" ? "每张卡片对应一个朗读模型；音色与发音参数在角色中设置。" : kind === "image" ? "每张卡片对应插件里的一项绘图能力；角色对话时按这里的配置出图。" : "每张卡片对应一个识别模型；只显示真实可用的测试与设置。";
    content.innerHTML = '<div class="section-toolbar"><button class="button primary compact" type="button" data-add-service>' + ui.icon("plus") + '添加模型</button><p>' + note + '</p></div><div class="list model-service-list">' + services.map(function (service) {
      var definition = familyOf(kind, service), system = definition.id === "system", enabled = app.services.modelServices.models(kind, service), all = app.services.modelServices.allModels(kind, service), missing = app.services.modelServices.serviceStatus(kind, service);
      var systemUsable = !system || (kind === "tts" ? Boolean(runtime && runtime.operational) : Boolean(runtime && runtime.available));
      var status = service.enabled === false ? "已停用" : system ? (systemUsable ? "系统可用" : "不可用") : missing || (service.validationState === "verified" ? "已验证" : service.catalogState === "fetched" ? "已获取目录" : "已配置");
      var defaultModel = enabled.find(function (item) { return item.id === service.defaultModelId; }) || enabled[0], defaultVoice = kind === "tts" ? app.services.modelServices.voices(service, defaultModel && defaultModel.id).find(function (item) { return item.id === service.defaultVoiceId; }) : null;
      var detail = kind === "llm" ? (defaultModel ? defaultModel.name || defaultModel.id : "未选择模型") + (service.modelFamilyId && service.modelFamilyId !== "unknown" ? " · " + service.modelFamilyId : "") : kind === "tts" ? (system ? (systemUsable ? (runtime.voices.length ? runtime.voices.length + " 个系统音色" : "跟随系统默认音色") : runtime && runtime.message || "系统朗读不可用") : (defaultModel ? defaultModel.name || defaultModel.id : "未选择模型") + " · " + app.services.modelServices.voices(service).length + " 个可用音色") : system ? (systemUsable ? (runtime.streamingAvailable ? "连续识别可用" : "一次性识别可用") + (runtime.languages.length ? " · " + runtime.languages.length + " 种系统语言" : " · 跟随系统语言") : runtime && runtime.message || "系统语音识别不可用") : (defaultModel ? defaultModel.name || defaultModel.id : "未选择模型");
      var broken = Boolean(system && !systemUsable), endpoint = system ? "" : app.services.modelServices.computedEndpoint(kind, service), id = u.escapeHtml(service.id), busy = Boolean(testing[service.id]);
      // 连接测试只是可选的验证步骤：按钮移到地址一行的右端，对话模型卡片上叫「测试」。
      var testIcon = kind === "tts" ? "play" : kind === "asr" ? "microphone" : "plug";
      var testLabel = kind === "tts" ? "试听" : kind === "asr" ? "录音测试" : "测试";
      var testButton = broken ? "" : '<button class="button secondary compact test-service-button" type="button" data-test-service="' + id + '"' + (busy || service.enabled === false ? ' disabled' : '') + '>' + ui.icon(testIcon) + (busy ? "测试中…" : testLabel) + '</button>';
      var testRow = endpoint ? '<div class="service-endpoint">' + ui.copyUrl(endpoint, "复制服务地址") + testButton + '</div>' : (testButton ? '<div class="service-test">' + testButton + '</div>' : '');
      // 复制 / 编辑 / 删除 并排在同一行，每颗按钮都带图标和文字，横向间距由 .service-manage 提供。
      var manage = broken ? '<p class="service-unavailable">' + u.escapeHtml(runtime && runtime.message || (kind === "tts" ? "当前系统没有可用的朗读引擎" : "当前系统没有可用的语音识别服务")) + '</p>' : (!system ? '<button class="button ghost" type="button" data-clone-service="' + id + '">' + ui.icon("copy") + '<span>复制</span></button>' : '') + '<button class="button ghost" type="button" data-edit-service="' + id + '">' + ui.icon("gear") + '<span>编辑</span></button>' + (!system ? '<button class="button ghost danger-text" type="button" data-remove-service="' + id + '" aria-label="删除模型">' + ui.icon("trash") + '<span>删除</span></button>' : '');
      return '<article class="card model-service-card"><div class="service-summary"><span class="service-icon">' + ui.icon(icons[kind]) + '</span><div class="list-copy"><strong>' + u.escapeHtml(service.name || definition.name) + '</strong><span>' + u.escapeHtml(definition.name + " · " + detail) + '</span></div><span class="badge ' + (missing || service.enabled === false || broken ? "warning" : "success") + '">' + u.escapeHtml(status) + '</span></div>' + testRow + '<div class="service-manage">' + manage + '</div></article>';
    }).join("") + '</div>';
    ui.bindCopyUrls(content);
    content.querySelector("[data-add-service]").addEventListener("click", function () { openService(kind); });
    content.querySelectorAll("[data-edit-service]").forEach(function (button) { button.addEventListener("click", ui.action(async function () { var service = await store.get(collection(kind), button.dataset.editService); if (kind === "tts" && familyOf(kind, service).id === "system") return openSystemTts(service); if (kind === "asr" && familyOf(kind, service).id === "system") return openSystemAsr(service); return openService(kind, service); })); });
    content.querySelectorAll("[data-clone-service]").forEach(function (button) { button.addEventListener("click", ui.action(async function () { var source = await store.get(collection(kind), button.dataset.cloneService), clone = Object.assign({}, source, { id: u.id(kind), directorySourceId: source.id, name: "", externalModelId: "", model: "", defaultModelId: "", models: [], enabledModelIds: [], validationState: "unverified", validatedAt: 0, createdAt: Date.now(), updatedAt: Date.now() }); return openService(kind, clone); })); });
    content.querySelectorAll("[data-remove-service]").forEach(function (button) { button.addEventListener("click", ui.action(async function () { var service = await store.get(collection(kind), button.dataset.removeService); if (await ui.confirm({ title: "删除“" + service.name + "”？", message: kind === "llm" ? "角色正在使用时不能删除此模型。" : kind === "image" ? "删除后对话里的绘图动作会失效，直到重新配置一张可用的绘图模型卡片。" : "相关设置会回落到 Android 系统模型。", confirmText: "删除模型", danger: true })) { await app.services.profiles.remove(kind, service.id); ui.toast("模型已删除"); await renderServices(kind); } })); });
    content.querySelectorAll("[data-test-service]").forEach(function (button) { button.addEventListener("click", ui.action(async function () { var id = button.dataset.testService, service = await store.get(collection(kind), id); if (kind === "asr") return openAsrTest(service); testing[id] = true; await renderServices(kind); try { if (kind === "llm") { var available = app.services.modelServices.models(kind, service), selected = available.find(function (item) { return item.id === service.defaultModelId; }) || available[0]; if (!selected) throw new Error("服务没有已启用模型，请先编辑并连接服务"); await app.services.llm.test(service, selected.id); } else if (kind === "image") { var capability = app.services.modelServices.allModels("image", service)[0]; if (!capability) throw new Error("卡片没有已保存的绘图能力，请先编辑并获取目录"); if (capability.ready === false) throw new Error("插件的“" + (capability.name || capability.id) + "”能力还没有选好模型，请在 ComfyUI 的 HamDraw 配置节点里设置"); await app.services.modelServices.discover("image", service, { persist: false }); } else await app.services.tts.speak("你好！欢迎使用朗读功能。", { ttsProfileId: id }); ui.toast(kind === "llm" ? "默认模型连接成功" : kind === "image" ? "插件连接成功，绘图能力可用" : "已使用默认模型与音色开始试听"); } finally { delete testing[id]; await renderServices(kind); } })); });
  }

  function languageItems(values) {
    var ids = (values || []).filter(Boolean), seen = {};
    return ids.filter(function (id) { if (seen[id]) return false; seen[id] = true; return true; }).map(function (id) { return { id: id, name: id }; });
  }

  async function openSystemTts(service) {
    if (!(await app.platform.haminn.awaitReady(1500))) throw new Error("系统朗读设置只在 HaminnApp 中可用");
    var api = app.platform.haminn.api(), availability = await api.tts.availability(), preferences = await api.tts.preferences(), result = await api.tts.voices();
    if (!availability.operational) throw new Error(availability.message || "Android 系统朗读当前不可用");
    var voices = (result.voices || []).map(function (voice) { return { id: voice.id, name: (voice.locale ? voice.locale + " · " : "") + voice.id, locale: voice.locale || "", networkRequired: Boolean(voice.networkRequired), quality: voice.quality, latency: voice.latency, features: voice.features || [] }; });
    var languages = languageItems(result.languages || voices.map(function (voice) { return voice.locale; })), languageIds = languages.map(function (item) { return item.id; });
    var language = [service.language, preferences.language, (result.languages || [])[0]].find(function (value) { return languageIds.indexOf(value) >= 0; }) || "";
    var voiceIds = voices.map(function (voice) { return voice.id; }), defaultVoice = [service.defaultVoiceId, service.voice, result.selectedVoice, result.currentVoice].find(function (value) { return voiceIds.indexOf(value) >= 0; }) || "";
    var directoryNote = languages.length || voices.length ? "语言和音色来自当前系统 TTS 引擎；只显示引擎实际提供的选项。" : "当前引擎可以朗读，但没有公开可选语言或音色，将跟随系统默认设置。";
    var html = '<div class="form-grid system-service-editor"><div class="capability-note"><strong>Android 系统朗读可用</strong><small>' + u.escapeHtml(directoryNote) + '</small></div>' + (languages.length ? '<div data-system-tts-language>' + ui.picker("language", "默认语言", "") + '</div>' : '<input type="hidden" name="language" value="">') + (voices.length ? '<div data-system-tts-voice>' + ui.picker("defaultVoiceId", "默认音色", "", "用于服务试听和跟随通用设置的角色") + '</div>' : '<input type="hidden" name="defaultVoiceId" value="">') + '<label class="field range-field"><span>语速 <output data-output="rate">' + Number(service.rate || preferences.rate || 1).toFixed(1) + '</output></span><input name="rate" type="range" min="0.5" max="2" step="0.1" value="' + Number(service.rate || preferences.rate || 1) + '"></label><label class="field range-field"><span>音调 <output data-output="pitch">' + Number(service.pitch || preferences.pitch || 1).toFixed(1) + '</output></span><input name="pitch" type="range" min="0.5" max="2" step="0.1" value="' + Number(service.pitch || preferences.pitch || 1) + '"></label><button class="button secondary full" type="button" data-preview-system-tts>' + ui.icon("play") + '试听默认组合</button></div>';
    var form = ui.openModal({ title: "编辑 Android 系统朗读", submitText: "保存设置", html: html, onSubmit: async function (target) {
      var next = Object.assign({}, service, { family: "system", type: "system", enabled: true, models: ["system"], defaultModelId: "system", voices: voices, language: u.formValue(target, "language"), defaultVoiceId: u.formValue(target, "defaultVoiceId"), voice: u.formValue(target, "defaultVoiceId"), rate: Number(u.formValue(target, "rate")), pitch: Number(u.formValue(target, "pitch")), updatedAt: Date.now() });
      await store.put("tts-profiles", next.id, next); await app.services.tts.invalidateAll(); return next;
    }, onSuccess: async function () { ui.toast("系统朗读默认设置已保存"); if (app.state.route === "models") await renderServices("tts"); } });
    var languagePicker = languages.length ? ui.bindPicker(form, "language", languages, language) : null;
    var voicePicker = voices.length ? ui.bindPicker(form, "defaultVoiceId", [], defaultVoice, { allowEmpty: true }) : null;
    function syncVoices(reset) {
      if (!voicePicker) return;
      var selectedLanguage = u.formValue(form, "language"), filtered = voices.filter(function (voice) { return !selectedLanguage || !voice.locale || voice.locale.toLowerCase() === selectedLanguage.toLowerCase() || voice.locale.toLowerCase().indexOf(selectedLanguage.slice(0, 2).toLowerCase()) === 0; });
      if (!filtered.length) filtered = voices.slice();
      var requested = reset ? defaultVoice : u.formValue(form, "defaultVoiceId");
      voicePicker.setItems(filtered, requested);
    }
    if (languagePicker) form.elements.namedItem("language").addEventListener("change", function () { defaultVoice = ""; syncVoices(false); });
    form.querySelectorAll('input[type="range"]').forEach(function (input) { input.addEventListener("input", function () { form.querySelector('[data-output="' + input.name + '"]').textContent = Number(input.value).toFixed(1); }); });
    form.querySelector("[data-preview-system-tts]").disabled = !availability.operational;
    form.querySelector("[data-preview-system-tts]").addEventListener("click", ui.action(async function () { await api.tts.stop().catch(function () {}); await api.tts.speak({ text: "你好！欢迎使用朗读功能。", language: u.formValue(form, "language") || undefined, voiceId: u.formValue(form, "defaultVoiceId") || undefined, rate: Number(u.formValue(form, "rate")), pitch: Number(u.formValue(form, "pitch")) }); ui.toast("已开始试听"); }));
    syncVoices(true); return form;
  }

  async function openSystemAsr(service) {
    if (!(await app.platform.haminn.awaitReady(1500))) throw new Error("系统语音输入设置只在 HaminnApp 中可用");
    var availability = await systemRuntime("asr", true); if (!availability.available) throw new Error(availability.message || "Android 系统语音识别当前不可用");
    var api = app.platform.haminn.api(), preferences = await api.speech.preferences(), languages = languageItems(availability.languages), languageIds = languages.map(function (item) { return item.id; });
    var language = [service.language, preferences.language, availability.preferredLanguage].find(function (value) { return languageIds.indexOf(value) >= 0; }) || "";
    var languageControl = languages.length ? ui.picker("language", "默认识别语言", "", "由当前系统识别服务提供") : '<input type="hidden" name="language" value=""><p class="helper">当前识别服务没有公开语言目录，将跟随系统默认识别语言。</p>';
    var html = '<div class="form-grid system-service-editor"><div class="capability-note"><strong>Android 系统语音识别可用</strong><small>' + u.escapeHtml(availability.streamingAvailable ? "支持实时识别、部分结果和录音电平。" : "设备只提供系统单次识别界面。") + '</small></div>' + languageControl + (availability.onDeviceAvailable ? '<label class="switch-row"><span><strong>优先设备端识别</strong><small>当前设备确认提供设备端识别</small></span><input name="onDevice" type="checkbox"' + (service.onDevice ? ' checked' : '') + '></label>' : '') + '<button class="button secondary full" type="button" data-preview-asr>' + ui.icon("microphone") + '录音测试</button></div>';
    var form = ui.openModal({ title: "编辑 Android 系统语音输入", submitText: "保存设置", html: html, onSubmit: async function (target) { var next = Object.assign({}, service, { family: "system", type: "system", enabled: true, models: ["system"], defaultModelId: "system", language: u.formValue(target, "language"), onDevice: availability.onDeviceAvailable && u.checked(target, "onDevice"), updatedAt: Date.now() }); await store.put("asr-profiles", next.id, next); return next; }, onSuccess: async function () { ui.toast("系统语音输入设置已保存"); if (app.state.route === "models") await renderServices("asr"); } });
    if (languages.length) ui.bindPicker(form, "language", languages, language);
    form.querySelector("[data-preview-asr]").addEventListener("click", function () { var draft = Object.assign({}, service, { family: "system", type: "system", language: u.formValue(form, "language"), onDevice: availability.onDeviceAvailable && u.checked(form, "onDevice") }); openAsrTest(draft); });
    return form;
  }

  async function openAsrTest(service) {
    var settings = await store.get("meta", "settings"), profile = app.services.modelServices.resolveAsr(service, {}, settings), system = (service.family || service.type) === "system", availability = null;
    if (system) { if (!(await app.platform.haminn.awaitReady(1500))) throw new Error("系统语音识别只在 HaminnApp 中可用"); availability = await app.platform.haminn.api().speech.availability(); if (!availability.available) throw new Error(availability.message || "系统没有可用的语音识别服务"); }
    var bars = Array.apply(null, { length: 30 }).map(function (_, index) { return '<i style="--wave-index:' + index + '"></i>'; }).join("");
    var recording = false, subscriptionId = "", recordingId = "", logicalFileId = "", offs = [], closed = false;
    var form = ui.openSubsheet({ title: (service.name || "语音输入") + " · 录音测试", submitText: null, cancelText: "完成", html: '<div class="asr-test"><div class="asr-waveform" data-asr-waveform aria-label="实时录音波形">' + bars + '</div><p class="asr-test-status" data-asr-status>' + (system ? "点击开始，说完后再点停止。" : "点击开始录音；停止后会把录音提交给当前识别服务。") + '</p><div class="asr-transcript" data-asr-transcript aria-live="polite"><span>识别文字会显示在这里</span></div><button class="button primary full" type="button" data-asr-record>' + ui.icon("microphone") + '<span>开始录音</span></button></div>', onDismiss: function () { closed = true; cleanup(); } });
    var button = form.querySelector("[data-asr-record]"), status = form.querySelector("[data-asr-status]"), transcript = form.querySelector("[data-asr-transcript]"), wave = form.querySelector("[data-asr-waveform]"), waveBars = wave.querySelectorAll("i");
    function setLevel(value) { var level = Math.max(0, Math.min(1, Number(value || 0))); wave.classList.toggle("is-active", recording); waveBars.forEach(function (bar, index) { var distance = Math.abs(index - (waveBars.length - 1) / 2) / waveBars.length, shaped = recording ? Math.max(.06, Math.min(1, level * 1.75 + Math.sin(index * 1.9 + Date.now() / 140) * .07 - distance * .25)) : .05; bar.style.transform = "scaleY(" + shaped.toFixed(3) + ")"; }); }
    function setRecording(value) { recording = value; button.classList.toggle("recording", value); button.querySelector("span").textContent = value ? "停止并识别" : "开始录音"; setLevel(0); }
    function showText(value, partial) { transcript.innerHTML = '<p' + (partial ? ' class="is-partial"' : '') + '>' + u.escapeHtml(value || "没有识别到文字") + '</p>'; }
    function cleanup() { offs.splice(0).forEach(function (off) { off(); }); if (system && recording) app.services.asr.cancelSystem().catch(function () {}); if (!system && recordingId && app.platform.haminn.available()) app.platform.haminn.api().audio.cancelRecording({ recordingId: recordingId }).catch(function () {}); if (logicalFileId && app.platform.haminn.available()) app.platform.haminn.api().files.delete({ logicalFileId: logicalFileId }).catch(function () {}); recording = false; }
    async function finishThirdParty() {
      var api = app.platform.haminn.api(), file = await api.audio.stopRecording({ recordingId: recordingId, name: "chataxi-asr-test.m4a" }); recordingId = ""; logicalFileId = file.logicalFileId; setRecording(false); button.disabled = true; status.textContent = "正在提交录音并识别…";
      try { var text = await app.services.asr.transcribeFile(file, profile); if (closed) return; showText(text, false); status.textContent = "识别完成，可以再次测试。"; }
      catch (error) { if (!closed) status.textContent = u.cleanError(error); throw error; }
      finally { if (logicalFileId) await api.files.delete({ logicalFileId: logicalFileId }).catch(function () {}); logicalFileId = ""; if (!closed) button.disabled = false; }
    }
    async function startThirdParty() {
      if (!(await app.platform.haminn.awaitReady(1500))) throw new Error("第三方录音测试需要在 HaminnApp 中使用");
      var api = app.platform.haminn.api();
      offs.push(app.platform.haminn.on("audio.recording.level", function (data) { if (!recordingId || data.recordingId !== recordingId) return; setLevel(data.level); }));
      offs.push(app.platform.haminn.on("audio.recording.limit", function (data) { if (!recordingId || data.recordingId !== recordingId) return; finishThirdParty().catch(function (error) { status.textContent = u.cleanError(error); button.disabled = false; }); }));
      var started = await api.audio.startRecording({ maxDurationMs: 30000 }); recordingId = started.recordingId; setRecording(true); status.textContent = "正在录音，最长 30 秒。";
    }
    async function startSystem() {
      if (!availability.streamingAvailable && availability.oneShotAvailable) {
        button.disabled = true; status.textContent = "请在系统语音输入界面完成录音。";
        try { var once = await app.platform.haminn.api().speech.recognizeOnce({ language: profile.language, maxResults: 3, preferOffline: Boolean(profile.onDevice) }); if (!once.cancelled) showText(((once.alternatives || [])[0] || {}).text || "", false); status.textContent = once.cancelled ? "已取消识别。" : "识别完成，可以再次测试。"; } finally { button.disabled = false; }
        return;
      }
      setRecording(true); status.textContent = "正在听，请开始说话。";
      try { subscriptionId = await app.services.asr.startSystem(profile, {
        ready: function () { status.textContent = "麦克风已就绪，请开始说话。"; },
        begin: function () { status.textContent = "正在识别…"; },
        rms: function (data) { setLevel(Math.max(0, Math.min(1, (Number(data.rmsDb || -20) + 20) / 24))); },
        partial: function (data) { showText(((data.alternatives || [])[0] || {}).text || data.text || "", true); },
        final: function (data) { setRecording(false); subscriptionId = ""; showText(((data.alternatives || [])[0] || {}).text || data.text || "", false); status.textContent = "识别完成，可以再次测试。"; },
        error: function (data) { setRecording(false); subscriptionId = ""; status.textContent = data.message || "识别失败，请重试。"; }
      }); } catch (error) { setRecording(false); status.textContent = u.cleanError(error); throw error; }
    }
    button.addEventListener("click", ui.action(async function () { if (recording) { if (system) { await app.services.asr.stopSystem(subscriptionId); status.textContent = "正在整理识别结果…"; } else await finishThirdParty(); return; } if (system) await startSystem(); else await startThirdParty(); }));
    setLevel(0); return form;
  }

  function openService(kind, existing, onSaved) {
    return app.features.modelSingleEditor.open(kind, existing, onSaved);
  }

  app.features = app.features || {}; app.features.models = { render: render, renderServices: renderServices, openService: openService };
})(window.chataxi);
