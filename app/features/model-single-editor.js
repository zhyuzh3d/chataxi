(function (app) {
  "use strict";
  var u = app.utils, ui = app.components, store = app.data.store;
  var labels = { llm: "对话模型", tts: "朗读模型", asr: "语音输入模型", image: "绘图模型" };
  // 新建卡片时预选的服务商：绘图只有 CHP 一家，其余沿用 openai。
  var defaultFamilies = { llm: "openai", tts: "openai", asr: "openai", image: "chp" };

  // CHP 插件的默认地址：插件装在 ComfyUI 里，所以主机就是跑 ComfyUI 的那台机器（A1X 掌机）。
  // 只写到「主机 : 端口」这一层 —— 换机器时用户只改 IP，端口与 /chp 路径都不用碰
  //（model-services.js 的 chpBase 会把 /chp 或 /hamdraw 后缀吃掉，写不写都对）。
  //
  // 默认值放在这里，而不是 catalog.js 的 imageFamilies.endpoint：那个字段代表「服务商预设」，
  // 填了它输入框清空就会自动变回默认值，validateConnection 的「请填写服务地址」守卫也就
  // 永远触发不了。默认值只放在卡片初值这一层，唯一权威、可清空、可校验。
  var CHP_DEFAULT_ENDPOINT = "http://192.168.124.31:8189";
  function defaultEndpoint(kind) { return kind === "image" ? CHP_DEFAULT_ENDPOINT : ""; }

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
    var label = family.protocol === "chp" ? "访问密码" : family.auth === "aws-sigv4" ? "Secret Access Key" : family.auth === "azure" ? "Speech Key" : "API Key", value = service.apiKey || "";
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
    var groupNames = kind === "image" ? { recommended: "插件提供的场景", possible: "可能可用", unknown: "未知能力" } : { recommended: "推荐用于" + labels[kind], possible: "可能可用", unknown: "未知能力" };
    return app.services.modelServices.selectionGroups(kind, models, service).map(function (model) {
      var suffix = model.id === (model.name || model.id) ? "" : " · " + model.id;
      return { id: model.id, name: (model.name || model.id) + suffix, group: groupNames[model.selectionGroup], unknown: model.selectionGroup === "unknown" };
    });
  }
  function selectedDescriptor(models, id) {
    return (models || []).find(function (item) { return item.id === id; }) || null;
  }

  function open(kind, existing, onSaved) {
    var editing = Boolean(existing), initialFamily = existing ? existing.family || existing.type || "custom" : defaultFamilies[kind] || "openai";
    var initialDefinition = app.services.modelServices.family(kind, initialFamily);
    var service = existing || { id: u.id(kind), family: initialFamily, name: "", enabled: true, models: [], voices: [] };
    var sourceMode = app.services.modelRegistry.sourceMode(service), modelId = service.externalModelId || service.model || service.defaultModelId || "";
    var catalogModels = (service.catalogModels || service.models || []).slice(), catalogVoices = (service.voices || []).slice();
    // 只有成功获取过模型目录（含上次成功缓存的目录）才允许保存；在此之前提交按钮就是「获取模型列表」。
    var catalogReady = catalogModels.length > 0;
    var selected = modelId, testedIdentity = service.validationState === "verified" ? identity(Object.assign({}, service, { externalModelId: modelId })) : "", testPassed = service.validationState === "verified";
    var familyHtml = kind === "llm" ? '<div data-model-family>' + ui.picker("modelFamilyId", "模型系列", "", "聚合与本地模型会自动推荐；如识别错误可以修改") + '</div>' : '';
    // CHP 跑在局域网里 ⇒ 地址必须放在主区域。塞进折叠的「更多设置」里的话，
    // 用户打开卡片只会看到一个「获取模型列表」按钮，不知道该去哪儿填地址。
    // 地址预填一个能直接用的默认值（见 CHP_DEFAULT_ENDPOINT），用户换机器时只改 IP。
    var endpointField = field("endpoint", kind === "image" ? "插件地址" : "完整请求地址", service.endpoint || initialDefinition.endpoint || defaultEndpoint(kind), kind === "image" ? 'type="url" placeholder="只改 IP 即可, 例如 http://192.168.1.50:8189"' : 'type="url"');
    var noteHtml = kind === "image"
      ? '<div class="automation-note">' + ui.icon("wand-magic-sparkles") + '<span>地址与密码只配这一处：有定妆照的角色按图重画, 没有就从零画一张, 走哪条不用你选。画幅锁定 9:16 竖幅, 下面挑的正是插件公布的那几档, 参考强度沿用插件自报的默认值。</span></div>'
      : '<div class="automation-note">' + ui.icon("wand-magic-sparkles") + '<span>目录只用于选择模型；角色的最大输出、采样、推理、音色与发音参数在角色设置中配置。</span></div>';
    var html = '<div class="form-grid single-model-editor">' + ui.picker("family", "服务商或运行环境", "") + '<p class="helper" id="providerDescription"></p>' + (kind === "image" ? endpointField : "") + secretField(service, initialDefinition) +
      '<div data-extra="accessKeyId">' + auxiliarySecretField("accessKeyId", "Access Key ID", service.accessKeyId || "", false) + '</div>' +
      '<div data-extra="sessionToken">' + auxiliarySecretField("sessionToken", "Session Token", service.sessionToken || "", true) + '</div>' +
      '<div data-extra="region">' + field("region", "区域", service.region || "", 'maxlength="80"') + '</div>' +
      '<div data-extra="workspaceId">' + field("workspaceId", "业务空间 ID", service.workspaceId || "", 'maxlength="160"') + '</div>' +
      '<div data-extra="resourceEndpoint">' + field("resourceEndpoint", "资源 Endpoint", service.resourceEndpoint || "", 'type="url"') + '</div>' +
      '<button class="button secondary full" type="button" data-fetch-models>' + ui.icon("cloud-arrow-down") + '获取模型列表</button><p class="connection-status visually-hidden" id="catalogStatus" role="status"></p>' +
      '<div data-model-choice>' + ui.picker("externalModelId", "具体模型", "", "一个模型卡片只保存这里选择的一个模型") + '</div>' +
      (kind === "image" ? '<div data-resolution-choice>' + ui.picker("resolution", "画幅", "", "锁定 9:16 竖幅;选项来自插件为这个场景公布的帧表,获取模型列表后可选") + '</div>' : '') + familyHtml +
      '<button class="button secondary full" type="button" data-test-model>' + ui.icon("plug") + (editing ? '重新连接并测试' : '连接并测试') + '</button><p class="connection-status visually-hidden" id="connectionStatus" role="status"></p>' +
      noteHtml +
      '<details class="advanced"><summary>更多设置</summary><div class="form-grid">' + field("name", "卡片名称", service.name || "", 'maxlength="80" placeholder="留空使用模型名称"') + (kind === "image" ? "" : endpointField) + '<div data-extra="apiStyle">' + ui.picker("apiStyle", "接口协议", "") + '</div>' + field("manualModelId", "手工模型 ID", "", 'placeholder="仅在目录不可读取时使用"') + customHeadersField(service) + '</div></details>' +
      '<label class="switch-row"><span><strong>启用模型</strong><small>停用后保留设置，但不会被角色或对话调用</small></span><input name="enabled" type="checkbox"' + (service.enabled !== false ? ' checked' : '') + '></label></div>';
    var form = ui.openModal({
      title: (editing ? "编辑" : "添加") + labels[kind], submitText: catalogReady ? "保存设置" : "获取模型列表", html: html,
      onSubmit: async function () {
        // 目录还没获取成功时，这个按钮就是「获取模型列表」：按它等同于上方的同名按钮，且不关闭弹窗。
        if (!catalogReady) { await fetchModels(); syncSubmitLater(); return false; }
        var draft = readDraft(), chosen = selectedDescriptor(catalogModels, draft.externalModelId);
        if (!chosen && draft.externalModelId) chosen = { id: draft.externalModelId, name: draft.externalModelId, capabilitySource: "unknown" };
        if (!chosen) throw new Error("请先获取目录并选择一个具体模型");
        var next = app.services.modelServices.toSingleProfile(kind, Object.assign({}, draft, { catalogModels: catalogModels, voices: catalogVoices }), chosen.id, draft.modelFamilyId);
        next.name = draft.name || chosen.name || chosen.id;
        next.voices = kind === "tts" ? catalogVoices : [];
        next.validationBaseline = service.validationBaseline || null;
        next.validationState = testPassed ? "verified" : form.dataset.modelValidation || next.validationState || "unverified";
        // 连接测试是可选的验证手段：目录已获取成功即可保存，未测试的卡片保存为 unverified。
        delete next.directorySourceId;
        validateConnection(next); await app.services.profiles.validateEnabled(kind, next); await store.put(collection(kind), next.id, next); await store.saveModelDirectory(kind, next.id, catalogModels, catalogVoices);
        if (kind === "tts") await app.services.tts.invalidateAll();
        return next;
      },
      onSuccess: async function (next) { ui.toast("模型设置已保存"); if (onSaved) return onSaved(next); if (app.state.route === "models") await app.features.models.renderServices(kind); }
    });
    form.dataset.modelValidation = service.validationState || "unverified";
    // 两条状态行现在只当"记录"：文字还写进去（自检读它、读屏念它），但 CSS 已把它们移出版面，
    // 给人看的是顶部 toast。见 ui.status。
    var catalogStatusNode = form.querySelector("#catalogStatus"), connectionStatusNode = form.querySelector("#connectionStatus");
    syncSubmit();
    ui.bindPicker(form, "family", providerItems(kind), initialFamily);
    var modelPicker = ui.bindPicker(form, "externalModelId", modelItems(kind, catalogModels, service), selected, { allowEmpty: true });
    /* 画幅:插件为**这个场景**公布的那几档,只取标着 9:16 的(见 draw.js 的 sizes)。
       它不是前端写死的一张清单 —— 插件加一档这里就多一项、插件降级这里当场少一项。
       新建卡片时目录还没读,清单是空的,提示行叫用户先去获取模型列表。 */
    var resolutionPicker = kind === "image"
      ? ui.bindPicker(form, "resolution", resolutionItems(), service.resolution || "", { allowEmpty: true, emptyLabel: "先获取模型列表" })
      : null;
    var familyPicker = kind === "llm" ? ui.bindPicker(form, "modelFamilyId", app.services.modelRegistry.familyItems(kind), service.modelFamilyId || app.services.modelRegistry.suggestFamily(kind, selected, service), { allowEmpty: true }) : null;
    var apiStylePicker = ui.bindPicker(form, "apiStyle", app.services.catalog.apiStyles.map(function (item) { return { id: item.id, name: item.name }; }), service.apiStyle || initialDefinition.apiStyle || "", { allowEmpty: true });

    store.modelDirectory(service.directorySourceId || service.id).then(function (cached) {
      if (!form.isConnected || !cached.models.length || catalogModels.length > 1) return;
      catalogModels = cached.models; catalogVoices = cached.voices || catalogVoices;
      catalogReady = true; syncSubmit();
      modelPicker.setItems(modelItems(kind, catalogModels, service), selected);
      syncResolution();
      ui.status(catalogStatusNode, "已载入上次成功获取的模型目录；可以直接保存。");
    }).catch(function () {});

    function value(name) { var field = form.elements.namedItem(name); return field ? String(field.value || "").trim() : ""; }

    /* 画幅的选项来自插件(见 draw.js 的 sizes):它读的是目录里那张卡的 `frames`,
       按 `ratio` 这个**标签**挑出 9:16 那一档 —— 不算比例、不搜方形、不打分。 */
    function resolutionItems() {
      return kind === "image"
        ? app.services.draw.sizes((catalogModels || [])[0]).map(function (item) { return { id: item, name: item }; })
        : [];
    }
    /* 目录换过之后重画选项。卡上选中的那条还在清单里就留着(**那是用户的选择**),
       不在(插件换过帧表了)就由 bindPicker 清空 —— 留着一个服务端会 400 的旧值,
       只是把这个错推到下一次出图时才暴露。 */
    function syncResolution() {
      if (resolutionPicker) resolutionPicker.setItems(resolutionItems());
    }
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
        /* 画幅是用户在这个弹窗里挑的那一档(空串 = 还没挑,由 draw.pickSize 退回插件表里的
           第一条)。它只对绘图卡片有意义 —— 别的 kind 表单里根本没有这一格。 */
        resolution: kind === "image" ? value("resolution") : service.resolution,
        name: value("name"), enabled: u.checked(form, "enabled"), catalogState: service.catalogState || "", validationState: service.validationState || "unverified",
        connectionRevision: service.connectionRevision || "", updatedAt: Date.now(), createdAt: service.createdAt || Date.now()
      });
    }
    function validateConnection(draft) {
      var family = definition(kind, draft), missing = app.services.modelServices.requiredCredentialMessage(family, draft), endpoint = app.services.modelServices.computedEndpoint(kind, draft);
      if (missing) throw new Error(missing); if (!endpoint) throw new Error("请填写服务地址或区域"); u.validateEndpoint(endpoint); u.parseHeaders(draft.customHeaders);
    }
    // 提交按钮承担两种角色：目录未获取时是「获取模型列表」，获取成功后才是「保存设置」。
    // openModal 在提交过程中会临时改写按钮文字并在收尾时还原，所以只在按钮可用时同步，
    // 提交那一轮结束之后再补一次（syncSubmitLater）。
    function syncSubmit() {
      var submit = form.querySelector("#modalSubmit");
      if (!submit || submit.disabled) return;
      var label = catalogReady ? "保存设置" : "获取模型列表";
      submit.textContent = label;
      submit.dataset.idleLabel = label;
      submit.dataset.mode = catalogReady ? "save" : "fetch";
    }
    function syncSubmitLater() {
      var attempt = 0;
      (function retry() {
        var submit = form.querySelector("#modalSubmit");
        if (!submit || form.isConnected === false) return;
        if (submit.disabled) { if (attempt++ < 40) setTimeout(retry, 16); return; }
        syncSubmit();
      })();
    }
    function show(selector, visible) { var node = form.querySelector(selector); if (node) node.classList.toggle("is-hidden", !visible); }
    function syncProvider(reset) {
      var familyId = value("family"), family = app.services.modelServices.family(kind, familyId), mode = app.services.modelRegistry.sourceMode({ family: familyId });
      form.querySelector("#providerDescription").textContent = family.description || "";
      var mainSecretLabel = form.querySelector("[data-main-secret-label]"); if (mainSecretLabel && mainSecretLabel.firstChild) mainSecretLabel.firstChild.textContent = family.protocol === "chp" ? "访问密码 " : family.auth === "aws-sigv4" ? "Secret Access Key " : family.auth === "azure" ? "Speech Key " : "API Key ";
      show('[data-extra="accessKeyId"]', family.accessKeyField === true); show('[data-extra="sessionToken"]', family.sessionTokenField === true);
      show('[data-extra="region"]', family.regionField === true); show('[data-extra="workspaceId"]', family.workspaceField === true); show('[data-extra="resourceEndpoint"]', family.resourceEndpointField === true);
      show('[data-extra="apiStyle"]', kind === "llm" && family.editableProtocol === true); show('[data-model-family]', kind === "llm" && mode !== "official");
      if (reset) {
        service.credentialRef = "";
        form.elements.namedItem("endpoint").value = family.endpoint || defaultEndpoint(kind); form.elements.namedItem("name").value = ""; form.elements.namedItem("apiKey").value = "";
        ["accessKeyId", "sessionToken", "region", "workspaceId", "resourceEndpoint", "manualModelId", "customHeaders"].forEach(function (name) { if (form.elements.namedItem(name)) form.elements.namedItem(name).value = ""; });
        form.querySelectorAll(".secret-mask").forEach(function (mask) { mask.textContent = ""; });
        apiStylePicker.setItems(app.services.catalog.apiStyles.map(function (item) { return { id: item.id, name: item.name }; }), family.apiStyle || "");
        catalogModels = []; catalogVoices = []; selected = ""; modelPicker.setItems([], ""); syncResolution(); if (familyPicker) familyPicker.setItems(app.services.modelRegistry.familyItems(kind), app.services.modelRegistry.suggestFamily(kind, "", { family: familyId }));
        invalidateTest(); ui.status(catalogStatusNode, ""); ui.status(connectionStatusNode, "");
        catalogReady = false; syncSubmit();
      }
    }
    function syncFamilySuggestion(force) {
      if (!familyPicker) return;
      var mode = app.services.modelRegistry.sourceMode({ family: value("family") });
      var suggestion = app.services.modelRegistry.suggestFamily(kind, value("externalModelId"), { family: value("family") });
      if (mode === "official" || force || !value("modelFamilyId")) familyPicker.setItems(app.services.modelRegistry.familyItems(kind), suggestion);
    }
    async function fetchModels() {
      var button = form.querySelector("[data-fetch-models]"), status = form.querySelector("#catalogStatus"), draft = readDraft(); validateConnection(draft); button.disabled = true; ui.status(status, "正在读取当前账号可用的模型目录…");
      try {
        delete draft.singleModelVersion; delete draft.externalModelId; draft.models = []; draft.enabledModelIds = [];
        var result = await app.services.modelServices.discover(kind, draft, { persist: false });
        catalogModels = result.models || []; catalogVoices = result.voices || [];
        if (!catalogModels.length) throw new Error("服务已响应，但没有找到可用于当前分类的模型");
        catalogReady = true; syncSubmit();
        var items = modelItems(kind, catalogModels, draft), preferred = selected && items.some(function (item) { return item.id === selected; }) ? selected : (items.find(function (item) { return item.group.indexOf("推荐") === 0; }) || items[0]).id;
        selected = preferred; modelPicker.setItems(items, preferred); syncFamilySuggestion(true); syncResolution();
        service.catalogState = result.catalogState; service.discoveryWarnings = result.warnings || [];
        await store.saveModelDirectory(kind, service.id, catalogModels, catalogVoices);
        invalidateTest(); ui.status(status, app.i18n.pick("已获取 " + catalogModels.length + " 个候选" + (catalogVoices.length ? "、" + catalogVoices.length + " 个音色" : "") + "。请选择一个模型。", "Fetched " + catalogModels.length + " candidates" + (catalogVoices.length ? " and " + catalogVoices.length + " voices" : "") + ". Pick one model.") + (result.warnings && result.warnings.length ? " " + result.warnings.join(app.i18n.pick("；", "; ")) : ""));
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
      profile.connectionRevision = String(Date.now()); button.disabled = true; ui.status(status, "正在执行最小连接测试…");
      try {
        var baseline = { modelId: chosen.id };
        if (kind === "llm") await app.services.llm.test(profile, chosen.id);
        else if (kind === "tts") {
          var availableVoices = app.services.modelServices.voices(profile, chosen.id), voice = availableVoices[0];
          if (!definition(kind, profile).voiceOptional && !voice) throw new Error("所选模型没有可用音色，请刷新目录或检查账号权限");
          profile.defaultVoiceId = voice && voice.id || ""; profile.voice = profile.defaultVoiceId;
          var verified = await app.services.tts.testService(profile); baseline.voiceId = verified.voiceId || profile.defaultVoiceId;
        } else if (kind === "image") {
          // 绘图场景的测试就是再读一次信息接口：它同时回答"地址通不通""密码对不对""场景在不在"
          // "插件为这个场景选好模型没有"。比另造一个测试请求更准，也不需要插件加接口。
          if (chosen.ready === false) throw new Error("插件的“" + (chosen.name || chosen.id) + "”场景还没有配好模型，请在 ComfyUI 的 CHP 插件配置节点里设置");
          await app.services.modelServices.discover("image", profile, { persist: false });
          profile.validationState = "verified"; profile.validatedAt = Date.now(); profile.validationBaseline = baseline;
          service = Object.assign(service, profile);
          await new Promise(function (resolve) { setTimeout(resolve, 0); });
          service.validationState = "verified"; service.validatedAt = profile.validatedAt; form.dataset.modelValidation = "verified"; testedIdentity = identity(readDraft()); testPassed = true; ui.status(status, "连接成功，插件确认提供这个绘图场景。"); return;
        } else {
          profile.validationState = "catalog-only"; profile.catalogState = "fetched";
          ui.status(status, "目录连接成功。保存后请使用模型卡片上的“录音测试”验证识别。");
          service = Object.assign(service, profile, { validationBaseline: baseline });
          await new Promise(function (resolve) { setTimeout(resolve, 0); });
          service.validationState = "catalog-only"; form.dataset.modelValidation = "catalog-only"; testedIdentity = identity(readDraft()); testPassed = true; return;
        }
        profile.validationState = "verified"; profile.validatedAt = Date.now(); profile.validationBaseline = baseline;
        service = Object.assign(service, profile);
        await new Promise(function (resolve) { setTimeout(resolve, 0); });
        service.validationState = "verified"; service.validatedAt = profile.validatedAt; form.dataset.modelValidation = "verified"; testedIdentity = identity(readDraft()); testPassed = true; ui.status(status, "连接成功，当前模型的基础配置已经验证。");
      } finally { button.disabled = false; }
    }
    form.elements.namedItem("family").addEventListener("change", function () { syncProvider(true); });
    form.elements.namedItem("externalModelId").addEventListener("change", function () { selected = value("externalModelId"); syncFamilySuggestion(true); invalidateTest(); ui.status(connectionStatusNode, "模型已改变，请重新测试。"); });
    if (familyPicker) form.elements.namedItem("modelFamilyId").addEventListener("change", function () { invalidateTest(); ui.status(connectionStatusNode, "模型系列已改变，请重新测试。"); });
    form.querySelector("[data-fetch-models]").addEventListener("click", ui.action(fetchModels));
    form.querySelector("[data-test-model]").addEventListener("click", ui.action(testModel));
    async function pasteSecret(name, label) {
      var text = String(await app.platform.haminn.readClipboardText() || "").trim();
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
