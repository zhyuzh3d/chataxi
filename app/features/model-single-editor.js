(function (app) {
  "use strict";
  var u = app.utils, ui = app.components, store = app.data.store;
  var labels = { llm: "对话模型", tts: "朗读模型", asr: "语音输入模型" };

  function collection(kind) { return kind + "-profiles"; }
  function definition(kind, profile) { return app.services.modelServices.family(kind, profile.family || profile.type); }
  function providerItems(kind) {
    return app.services.modelServices.families(kind).filter(function (item) { return item.id !== "system"; }).map(function (item) {
      var source = app.services.modelRegistry.sourceMode({ family: item.id });
      return { id: item.id, name: item.name + " · " + (source === "official" ? "官方" : source === "local" ? "本地" : "聚合/自定义") };
    });
  }
  function field(name, label, value, attrs) {
    return '<label class="field"><span>' + u.escapeHtml(label) + '</span><input name="' + name + '" value="' + u.escapeHtml(value || "") + '" ' + (attrs || "") + '></label>';
  }
  function secretField(service, family) {
    var label = family.auth === "aws-sigv4" ? "Secret Access Key" : family.auth === "azure" ? "Speech Key" : "API Key", value = service.apiKey || "";
    return '<div class="field"><span data-main-secret-label>' + label + ' <em>' + (value ? '已保存在当前设备，可直接编辑' : family.keyOptional ? '选填' : '保存在当前设备') + '</em></span><div class="secret-editor"><input name="apiKey" type="password" autocomplete="new-password" spellcheck="false" value="' + u.escapeHtml(value) + '" placeholder="粘贴' + label + '"><span class="secret-mask" aria-hidden="true">' + u.escapeHtml(value ? u.maskSecret(value) : "") + '</span><button class="button secondary compact secret-paste" type="button" data-paste-key aria-label="从剪贴板粘贴' + label + '">' + ui.icon("paste") + '<span>粘贴</span></button><button class="icon-button secret-visibility" type="button" data-toggle-secret aria-label="显示' + label + '" aria-pressed="false">' + ui.icon("eye") + '</button></div></div>';
  }
  function auxiliarySecretField(name, label, value, optional) {
    return '<div class="field"><span>' + label + ' <em>' + (value ? '已保存在当前设备，可直接编辑' : optional ? '选填' : '保存在当前设备') + '</em></span><div class="secret-editor"><input name="' + name + '" type="password" autocomplete="new-password" spellcheck="false" value="' + u.escapeHtml(value || "") + '" placeholder="粘贴' + label + '"><span class="secret-mask" aria-hidden="true">' + u.escapeHtml(value ? u.maskSecret(value) : "") + '</span><button class="button secondary compact secret-paste" type="button" data-paste-secret="' + name + '" aria-label="从剪贴板粘贴' + label + '">' + ui.icon("paste") + '<span>粘贴</span></button><button class="icon-button secret-visibility" type="button" data-toggle-secret aria-label="显示' + label + '" aria-pressed="false">' + ui.icon("eye") + '</button></div></div>';
  }
  function customHeadersField(service) {
    var value = service.customHeaders || "", masked = u.maskedHeaderEntries(value).map(function (item) { return item.name + ": " + item.maskedValue; }).join("；");
    return '<div class="field"><span>自定义 Header <em>JSON，选填</em></span><div class="secret-editor"><input name="customHeaders" type="password" autocomplete="off" spellcheck="false" value="' + u.escapeHtml(value) + '" placeholder="{&quot;X-Client&quot;:&quot;chataxi&quot;}"><span class="secret-mask" aria-hidden="true">' + u.escapeHtml(masked || (value ? u.maskSecret(value) : "")) + '</span><button class="button secondary compact secret-paste" type="button" data-paste-headers aria-label="从剪贴板粘贴自定义 Header">' + ui.icon("paste") + '<span>粘贴</span></button><button class="icon-button secret-visibility" type="button" data-toggle-secret aria-label="显示自定义 Header" aria-pressed="false">' + ui.icon("eye") + '</button></div></div>';
  }
  function identity(profile) {
    return [profile.family, profile.endpoint, profile.apiStyle, profile.region, profile.workspaceId, profile.resourceEndpoint, profile.apiKey, profile.accessKeyId, profile.sessionToken, profile.customHeaders, profile.externalModelId, profile.modelFamilyId].join("\n");
  }
  function modelItems(kind, models, service) {
    var groupNames = { recommended: "推荐用于" + labels[kind], possible: "可能可用", unknown: "未知能力" };
    return app.services.modelServices.selectionGroups(kind, models, service).map(function (model) {
      var suffix = model.id === (model.name || model.id) ? "" : " · " + model.id;
      return { id: model.id, name: (model.name || model.id) + suffix, group: groupNames[model.selectionGroup], unknown: model.selectionGroup === "unknown" };
    });
  }
  function selectedDescriptor(models, id) {
    return (models || []).find(function (item) { return item.id === id; }) || null;
  }

  function open(kind, existing, onSaved) {
    var editing = Boolean(existing), initialFamily = existing ? existing.family || existing.type || "custom" : "openai";
    var initialDefinition = app.services.modelServices.family(kind, initialFamily);
    var service = existing || { id: u.id(kind), family: initialFamily, name: "", enabled: true, models: [], voices: [] };
    var sourceMode = app.services.modelRegistry.sourceMode(service), modelId = service.externalModelId || service.model || service.defaultModelId || "";
    var catalogModels = (service.catalogModels || service.models || []).slice(), catalogVoices = (service.voices || []).slice();
    var selected = modelId, testedIdentity = service.validationState === "verified" ? identity(Object.assign({}, service, { externalModelId: modelId })) : "", testPassed = service.validationState === "verified";
    var familyHtml = kind === "llm" ? '<div data-model-family>' + ui.picker("modelFamilyId", "模型系列", "", "聚合与本地模型会自动推荐；如识别错误可以修改") + '</div>' : '';
    var html = '<div class="form-grid single-model-editor">' + ui.picker("family", "服务商或运行环境", "") + '<p class="helper" id="providerDescription"></p>' + secretField(service, initialDefinition) +
      '<div data-extra="accessKeyId">' + auxiliarySecretField("accessKeyId", "Access Key ID", service.accessKeyId || "", false) + '</div>' +
      '<div data-extra="sessionToken">' + auxiliarySecretField("sessionToken", "Session Token", service.sessionToken || "", true) + '</div>' +
      '<div data-extra="region">' + field("region", "区域", service.region || "", 'maxlength="80"') + '</div>' +
      '<div data-extra="workspaceId">' + field("workspaceId", "业务空间 ID", service.workspaceId || "", 'maxlength="160"') + '</div>' +
      '<div data-extra="resourceEndpoint">' + field("resourceEndpoint", "资源 Endpoint", service.resourceEndpoint || "", 'type="url"') + '</div>' +
      '<button class="button secondary full" type="button" data-fetch-models>' + ui.icon("cloud-arrow-down") + '获取模型列表</button><p class="connection-status" id="catalogStatus" role="status"></p>' +
      '<div data-model-choice>' + ui.picker("externalModelId", "具体模型", "", "一个模型卡片只保存这里选择的一个模型") + '</div>' + familyHtml +
      '<button class="button secondary full" type="button" data-test-model>' + ui.icon("plug") + (editing ? '重新连接并测试' : '连接并测试') + '</button><p class="connection-status" id="connectionStatus" role="status"></p>' +
      '<div class="automation-note">' + ui.icon("wand-magic-sparkles") + '<span>目录只用于选择模型；角色的最大输出、采样、推理、音色与发音参数在角色设置中配置。</span></div>' +
      '<details class="advanced"><summary>更多设置</summary><div class="form-grid">' + field("name", "卡片名称", service.name || "", 'maxlength="80" placeholder="留空使用模型名称"') + field("endpoint", "完整请求地址", service.endpoint || initialDefinition.endpoint || "", 'type="url"') + '<div data-extra="apiStyle">' + ui.picker("apiStyle", "接口协议", "") + '</div>' + field("manualModelId", "手工模型 ID", "", 'placeholder="仅在目录不可读取时使用"') + customHeadersField(service) + '</div></details>' +
      '<label class="switch-row"><span><strong>启用模型</strong><small>停用后保留设置，但不会被角色或对话调用</small></span><input name="enabled" type="checkbox"' + (service.enabled !== false ? ' checked' : '') + '></label></div>';
    var form = ui.openModal({
      title: (editing ? "编辑" : "添加") + labels[kind], submitText: "保存设置", html: html,
      onSubmit: async function () {
        var draft = readDraft(), chosen = selectedDescriptor(catalogModels, draft.externalModelId);
        if (!chosen && draft.externalModelId) chosen = { id: draft.externalModelId, name: draft.externalModelId, capabilitySource: "unknown" };
        if (!chosen) throw new Error("请先获取目录并选择一个具体模型");
        var next = app.services.modelServices.toSingleProfile(kind, Object.assign({}, draft, { catalogModels: catalogModels, voices: catalogVoices }), chosen.id, draft.modelFamilyId);
        next.name = draft.name || chosen.name || chosen.id;
        next.voices = kind === "tts" ? catalogVoices : [];
        next.validationBaseline = service.validationBaseline || null;
        next.validationState = testPassed ? "verified" : form.dataset.modelValidation || next.validationState || "unverified";
        if ((kind === "llm" || kind === "tts") && next.validationState !== "verified") throw new Error("连接信息或模型已改变，请先连接并测试");
        delete next.directorySourceId;
        validateConnection(next); await app.services.profiles.validateEnabled(kind, next); await store.put(collection(kind), next.id, next); await store.saveModelDirectory(kind, next.id, catalogModels, catalogVoices);
        if (kind === "tts") await app.services.tts.invalidateAll();
        return next;
      },
      onSuccess: async function (next) { ui.toast("模型设置已保存"); if (onSaved) return onSaved(next); if (app.state.route === "models") await app.features.models.renderServices(kind); }
    });
    form.dataset.modelValidation = service.validationState || "unverified";
    ui.bindPicker(form, "family", providerItems(kind), initialFamily);
    var modelPicker = ui.bindPicker(form, "externalModelId", modelItems(kind, catalogModels, service), selected, { allowEmpty: true });
    var familyPicker = kind === "llm" ? ui.bindPicker(form, "modelFamilyId", app.services.modelRegistry.familyItems(kind), service.modelFamilyId || app.services.modelRegistry.suggestFamily(kind, selected, service), { allowEmpty: true }) : null;
    var apiStylePicker = ui.bindPicker(form, "apiStyle", app.services.catalog.apiStyles.map(function (item) { return { id: item.id, name: item.name }; }), service.apiStyle || initialDefinition.apiStyle || "", { allowEmpty: true });

    store.modelDirectory(service.directorySourceId || service.id).then(function (cached) {
      if (!form.isConnected || !cached.models.length || catalogModels.length > 1) return;
      catalogModels = cached.models; catalogVoices = cached.voices || catalogVoices;
      modelPicker.setItems(modelItems(kind, catalogModels, service), selected);
      form.querySelector("#catalogStatus").textContent = "已载入上次成功获取的模型目录；可以选择后重新测试。";
    }).catch(function () {});

    function value(name) { var field = form.elements.namedItem(name); return field ? String(field.value || "").trim() : ""; }
    function invalidateTest() {
      if (testedIdentity && identity(readDraft()) === testedIdentity) return;
      testedIdentity = ""; testPassed = false; service.validationState = "unverified"; service.validatedAt = 0; form.dataset.modelValidation = "unverified";
    }
    function readDraft() {
      var familyId = value("family"), family = app.services.modelServices.family(kind, familyId), manual = value("manualModelId");
      var chosenId = value("externalModelId") || manual;
      return Object.assign({}, service, {
        family: familyId, type: family.type || familyId, providerPresetId: familyId,
        sourceMode: app.services.modelRegistry.sourceMode({ family: familyId }),
        transportCodecId: kind === "llm" ? value("apiStyle") || family.apiStyle : family.protocol || family.type,
        apiStyle: kind === "llm" ? value("apiStyle") || family.apiStyle : undefined,
        endpoint: value("endpoint") || family.endpoint || "", apiKey: value("apiKey"), accessKeyId: value("accessKeyId"), sessionToken: value("sessionToken"),
        region: value("region"), workspaceId: value("workspaceId"), resourceEndpoint: value("resourceEndpoint"), customHeaders: value("customHeaders"),
        externalModelId: chosenId, modelFamilyId: kind === "llm" ? value("modelFamilyId") || app.services.modelRegistry.suggestFamily(kind, chosenId, { family: familyId }) : familyId,
        name: value("name"), enabled: u.checked(form, "enabled"), catalogState: service.catalogState || "", validationState: service.validationState || "unverified",
        connectionRevision: service.connectionRevision || "", updatedAt: Date.now(), createdAt: service.createdAt || Date.now()
      });
    }
    function validateConnection(draft) {
      var family = definition(kind, draft), missing = app.services.modelServices.requiredCredentialMessage(family, draft), endpoint = app.services.modelServices.computedEndpoint(kind, draft);
      if (missing) throw new Error(missing); if (!endpoint) throw new Error("请填写服务地址或区域"); u.validateEndpoint(endpoint); u.parseHeaders(draft.customHeaders);
    }
    function show(selector, visible) { var node = form.querySelector(selector); if (node) node.classList.toggle("is-hidden", !visible); }
    function syncProvider(reset) {
      var familyId = value("family"), family = app.services.modelServices.family(kind, familyId), mode = app.services.modelRegistry.sourceMode({ family: familyId });
      form.querySelector("#providerDescription").textContent = family.description || "";
      var mainSecretLabel = form.querySelector("[data-main-secret-label]"); if (mainSecretLabel && mainSecretLabel.firstChild) mainSecretLabel.firstChild.textContent = family.auth === "aws-sigv4" ? "Secret Access Key " : family.auth === "azure" ? "Speech Key " : "API Key ";
      show('[data-extra="accessKeyId"]', family.accessKeyField === true); show('[data-extra="sessionToken"]', family.sessionTokenField === true);
      show('[data-extra="region"]', family.regionField === true); show('[data-extra="workspaceId"]', family.workspaceField === true); show('[data-extra="resourceEndpoint"]', family.resourceEndpointField === true);
      show('[data-extra="apiStyle"]', kind === "llm" && family.editableProtocol === true); show('[data-model-family]', kind === "llm" && mode !== "official");
      if (reset) {
        service.credentialRef = "";
        form.elements.namedItem("endpoint").value = family.endpoint || ""; form.elements.namedItem("name").value = ""; form.elements.namedItem("apiKey").value = "";
        ["accessKeyId", "sessionToken", "region", "workspaceId", "resourceEndpoint", "manualModelId", "customHeaders"].forEach(function (name) { if (form.elements.namedItem(name)) form.elements.namedItem(name).value = ""; });
        form.querySelectorAll(".secret-mask").forEach(function (mask) { mask.textContent = ""; });
        apiStylePicker.setItems(app.services.catalog.apiStyles.map(function (item) { return { id: item.id, name: item.name }; }), family.apiStyle || "");
        catalogModels = []; catalogVoices = []; selected = ""; modelPicker.setItems([], ""); if (familyPicker) familyPicker.setItems(app.services.modelRegistry.familyItems(kind), app.services.modelRegistry.suggestFamily(kind, "", { family: familyId }));
        invalidateTest(); form.querySelector("#catalogStatus").textContent = ""; form.querySelector("#connectionStatus").textContent = "";
      }
    }
    function syncFamilySuggestion(force) {
      if (!familyPicker) return;
      var mode = app.services.modelRegistry.sourceMode({ family: value("family") });
      var suggestion = app.services.modelRegistry.suggestFamily(kind, value("externalModelId"), { family: value("family") });
      if (mode === "official" || force || !value("modelFamilyId")) familyPicker.setItems(app.services.modelRegistry.familyItems(kind), suggestion);
    }
    async function fetchModels() {
      var button = form.querySelector("[data-fetch-models]"), status = form.querySelector("#catalogStatus"), draft = readDraft(); validateConnection(draft); button.disabled = true; status.textContent = "正在读取当前账号可用的模型目录…";
      try {
        delete draft.singleModelVersion; delete draft.externalModelId; draft.models = []; draft.enabledModelIds = [];
        var result = await app.services.modelServices.discover(kind, draft, { persist: false });
        catalogModels = result.models || []; catalogVoices = result.voices || [];
        if (!catalogModels.length) throw new Error("服务已响应，但没有找到可用于当前分类的模型");
        var items = modelItems(kind, catalogModels, draft), preferred = selected && items.some(function (item) { return item.id === selected; }) ? selected : (items.find(function (item) { return item.group.indexOf("推荐") === 0; }) || items[0]).id;
        selected = preferred; modelPicker.setItems(items, preferred); syncFamilySuggestion(true);
        service.catalogState = result.catalogState; service.discoveryWarnings = result.warnings || [];
        await store.saveModelDirectory(kind, service.id, catalogModels, catalogVoices);
        invalidateTest(); status.textContent = "已获取 " + catalogModels.length + " 个候选" + (catalogVoices.length ? "、" + catalogVoices.length + " 个音色" : "") + "。请选择一个模型并测试。" + (result.warnings && result.warnings.length ? " " + result.warnings.join("；") : "");
      } finally { button.disabled = false; }
    }
    async function testModel() {
      var button = form.querySelector("[data-test-model]"), status = form.querySelector("#connectionStatus"), draft = readDraft(), chosen = selectedDescriptor(catalogModels, draft.externalModelId);
      if (!chosen && draft.externalModelId) chosen = { id: draft.externalModelId, name: draft.externalModelId, capabilitySource: "unknown" };
      if (!chosen) throw new Error("请先获取目录并选择一个模型"); validateConnection(draft);
      var classified = app.services.modelServices.selectionGroups(kind, [chosen], draft)[0];
      if (classified.selectionGroup === "unknown") {
        var proceed = await ui.confirm({ title: "测试未知能力模型？", message: "服务没有提供足够的类型信息。此次测试只验证它能否用于“" + labels[kind] + "”，其他能力仍保持未知。", confirmText: "继续测试" });
        if (!proceed) return;
      }
      var profile = app.services.modelServices.toSingleProfile(kind, Object.assign({}, draft, { catalogModels: catalogModels, voices: catalogVoices }), chosen.id, draft.modelFamilyId);
      profile.connectionRevision = String(Date.now()); button.disabled = true; status.textContent = "正在执行最小连接测试…";
      try {
        var baseline = { modelId: chosen.id };
        if (kind === "llm") await app.services.llm.test(profile, chosen.id);
        else if (kind === "tts") {
          var availableVoices = app.services.modelServices.voices(profile, chosen.id), voice = availableVoices[0];
          if (!definition(kind, profile).voiceOptional && !voice) throw new Error("所选模型没有可用音色，请刷新目录或检查账号权限");
          profile.defaultVoiceId = voice && voice.id || ""; profile.voice = profile.defaultVoiceId;
          var verified = await app.services.tts.testService(profile); baseline.voiceId = verified.voiceId || profile.defaultVoiceId;
        } else {
          profile.validationState = "catalog-only"; profile.catalogState = "fetched";
          status.textContent = "目录连接成功。保存后请使用模型卡片上的“录音测试”验证识别。";
          service = Object.assign(service, profile, { validationBaseline: baseline });
          await new Promise(function (resolve) { setTimeout(resolve, 0); });
          service.validationState = "catalog-only"; form.dataset.modelValidation = "catalog-only"; testedIdentity = identity(readDraft()); testPassed = true; return;
        }
        profile.validationState = "verified"; profile.validatedAt = Date.now(); profile.validationBaseline = baseline;
        service = Object.assign(service, profile);
        await new Promise(function (resolve) { setTimeout(resolve, 0); });
        service.validationState = "verified"; service.validatedAt = profile.validatedAt; form.dataset.modelValidation = "verified"; testedIdentity = identity(readDraft()); testPassed = true; status.textContent = "连接成功，当前模型的基础配置已经验证。";
      } finally { button.disabled = false; }
    }
    form.elements.namedItem("family").addEventListener("change", function () { syncProvider(true); });
    form.elements.namedItem("externalModelId").addEventListener("change", function () { selected = value("externalModelId"); syncFamilySuggestion(true); invalidateTest(); form.querySelector("#connectionStatus").textContent = "模型已改变，请重新测试。"; });
    if (familyPicker) form.elements.namedItem("modelFamilyId").addEventListener("change", function () { invalidateTest(); form.querySelector("#connectionStatus").textContent = "模型系列已改变，请重新测试。"; });
    form.querySelector("[data-fetch-models]").addEventListener("click", ui.action(fetchModels));
    form.querySelector("[data-test-model]").addEventListener("click", ui.action(testModel));
    async function pasteSecret(name, label) {
      var text = String(await app.platform.hermit.readClipboardText() || "").trim();
      if (!text) throw new Error("剪贴板里没有可粘贴的" + label);
      var input = form.elements.namedItem(name); input.value = text; input.dispatchEvent(new Event("input", { bubbles: true })); input.focus(); input.select(); ui.toast(label + "已粘贴");
    }
    form.querySelector("[data-paste-key]").addEventListener("click", ui.action(function () { return pasteSecret("apiKey", "API Key"); }));
    form.querySelectorAll("[data-paste-secret]").forEach(function (button) { button.addEventListener("click", ui.action(function () { return pasteSecret(button.dataset.pasteSecret, "密钥"); })); });
    form.querySelector("[data-paste-headers]").addEventListener("click", ui.action(function () { return pasteSecret("customHeaders", "自定义 Header"); }));
    form.querySelectorAll("[data-toggle-secret]").forEach(function (button) {
      button.addEventListener("click", function () {
        var editor = button.closest(".secret-editor"), input = editor.querySelector("input"), revealed = !editor.classList.contains("is-revealed");
        editor.classList.toggle("is-revealed", revealed); input.type = revealed ? "text" : "password"; button.setAttribute("aria-pressed", String(revealed)); button.setAttribute("aria-label", (revealed ? "隐藏" : "显示") + (input.name === "customHeaders" ? "自定义 Header" : "密钥")); button.innerHTML = ui.icon(revealed ? "eye-slash" : "eye");
      });
    });
    form.querySelectorAll(".secret-editor input").forEach(function (input) {
      input.addEventListener("focus", function () { input.select(); }, { once: true });
      input.addEventListener("paste", function (event) { var pasted = event.clipboardData && event.clipboardData.getData("text"); if (!pasted || !input.value) return; event.preventDefault(); input.value = pasted.trim(); input.dispatchEvent(new Event("input", { bubbles: true })); input.select(); });
      input.addEventListener("input", function () { var mask = input.parentNode.querySelector(".secret-mask"); if (mask) mask.textContent = input.value ? u.maskSecret(input.value) : ""; if (service.directorySourceId) service.credentialRef = ""; invalidateTest(); });
    });
    ["endpoint", "apiStyle", "region", "workspaceId", "resourceEndpoint", "accessKeyId", "sessionToken", "customHeaders"].forEach(function (name) { var node = form.elements.namedItem(name); if (node) { node.addEventListener("input", invalidateTest); node.addEventListener("change", invalidateTest); } });
    syncProvider(false); return form;
  }

  app.features = app.features || {};
  app.features.modelSingleEditor = { open: open };
})(window.chataxi);
