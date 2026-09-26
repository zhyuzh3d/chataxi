(function (app) {
  "use strict";
  var u = app.utils, ui = app.components, store = app.data.store;
  var tabNames = { interface: "界面", conversation: "对话", compression: "压缩", system: "系统" };

  function items(values, systemAvailable) { return values.map(function (item) { var system = (item.family || item.type) === "system"; return { id: item.id, name: item.name + (system && systemAvailable === false ? " · 当前不可用" : ""), disabled: system && systemAvailable === false }; }); }
  async function systemTtsAvailable() {
    if (!(await app.platform.hermit.awaitReady(1200))) return false;
    try { return Boolean((await app.platform.hermit.api().tts.availability()).operational); } catch (_) { return false; }
  }
  function toggle(name, label, text, checked) {
    return '<label class="switch-row"><span><strong>' + label + '</strong><small>' + text + '</small></span><input name="' + name + '" type="checkbox"' + (checked ? ' checked' : '') + '></label>';
  }
  function range(name, label, value, min, max, step, suffix) {
    // 后缀挂在 input 的 data-suffix 上, 由下面统一的 input 监听读出来 —— 原来这里写死
    // " 字", 加进混响强度那种 "%" 的滑竿就会把单位显示错。
    return '<label class="field range-field"><span>' + label + '<output data-output="' + name + '">' + u.escapeHtml(value) + suffix + '</output></span><input name="' + name + '" type="range" data-suffix="' + u.escapeHtml(suffix || "") + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + u.escapeHtml(value) + '"></label>';
  }
  function sizeText(bytes) {
    var value = Number(bytes || 0);
    if (value >= 1048576) return (value / 1048576).toFixed(1) + " MB";
    if (value >= 1024) return Math.round(value / 1024) + " KB";
    return value + " B";
  }

  async function clearSelectedData(form) {
    var selected = ["conversations", "roles", "models", "profile"].filter(function (name) { return u.checked(form, name); });
    if (!selected.length) throw new Error("请至少选择一类要清除的数据");
    if (selected.indexOf("conversations") >= 0) {
      var conversations = await store.list("conversations");
      for (var conversationIndex = 0; conversationIndex < conversations.length; conversationIndex += 1) await store.deleteConversation(conversations[conversationIndex].id);
      // 全局背景来自"最近使用的对话"，对话都没了它就该跟着撤掉，不能继续铺在整个应用上。
      await app.features.chat.refreshAppBackground();
    }
    if (selected.indexOf("roles") >= 0) {
      var roles = await store.list("roles"), roleMedia = [];
      for (var roleIndex = 0; roleIndex < roles.length; roleIndex += 1) { if (roles[roleIndex].avatarMediaId) roleMedia.push(roles[roleIndex].avatarMediaId); await store.remove("roles", roles[roleIndex].id); }
      await store.releaseMedia(roleMedia);
    }
    if (selected.indexOf("models") >= 0) {
      for (var collectionIndex = 0; collectionIndex < 3; collectionIndex += 1) {
        var collection = ["llm-profiles", "tts-profiles", "asr-profiles"][collectionIndex], profiles = await store.list(collection);
        for (var profileIndex = 0; profileIndex < profiles.length; profileIndex += 1) if ((profiles[profileIndex].family || profiles[profileIndex].type) !== "system") await store.remove(collection, profiles[profileIndex].id);
      }
      var currentSettings = await store.get("meta", "settings"); currentSettings.defaultTtsProfileId = "system-tts"; currentSettings.defaultAsrProfileId = "system-asr"; await store.put("meta", "settings", currentSettings);
    }
    if (selected.indexOf("profile") >= 0) {
      var currentProfile = await store.get("meta", "user-profile"), profileMedia = currentProfile && currentProfile.avatarMediaId ? [currentProfile.avatarMediaId] : [];
      await store.put("meta", "user-profile", { name: "我", introduction: "", avatarMediaId: "", createdAt: currentProfile && currentProfile.createdAt || Date.now(), updatedAt: Date.now() });
      await store.releaseMedia(profileMedia);
    }
    return selected;
  }

  function openClearData() {
    var form = ui.openModal({ title: "清除本机数据", submitText: "清除所选数据", danger: true, html: '<div class="form-grid"><p class="helper">所选数据会从当前 chataxi 实例永久删除，无法撤销。未选择的分类保持不变。</p>' +
      toggle("conversations", "全部对话数据", "删除全部对话、消息、摘要、草稿和对应附件", true) +
      toggle("roles", "全部角色数据", "删除角色档案、模型选择、发音设置和角色头像", true) +
      toggle("models", "全部模型配置", "删除第三方对话、朗读和语音输入服务及密钥；保留 Android 系统服务", true) +
      toggle("profile", "我的个人设定", "清除名称、头像和自我介绍，恢复默认名称“我”", true) + '</div>', onSubmit: clearSelectedData,
      onSuccess: async function () { ui.toast("所选本机数据已清除"); app.state.settingsTab = "system"; await render(); }
    });
    return form;
  }

  // 软件备份交给宿主：chataxi 只能备份自己，位置由系统文件选择器决定，
  // 打包内容（记录、附件、本地代码）和恢复入口都与应用库的单应用备份完全一致。
  async function backupApp(button) {
    button.disabled = true;
    try {
      if (!(await app.platform.hermit.awaitReady(1500))) throw new Error("当前不在 HermitApp 中，无法打包备份");
      var result = await app.platform.hermit.call("app.backup");
      if (result && result.cancelled) { ui.toast("已取消备份"); return; }
      // 「备份完成 · 文件名 · 大小」是拼装句：界面语言层靠 i18nEnPatterns 的整句规则翻译，
      // 而「备份完成」这段中文本身要能被字典单独覆盖（check-i18n 按字面量逐段审计）。
      ui.toast("备份完成" + " · " + String(result && result.fileName || "chataxi") + " · " + sizeText(result && result.bytes), 5000);
    } finally { button.disabled = false; }
  }

  async function render() {
    var tab = tabNames[app.state.settingsTab] ? app.state.settingsTab : "interface";
    var settings = await store.get("meta", "settings");
    var tts = (await store.list("tts-profiles")).filter(function (item) { return item.enabled !== false; });
    var asr = (await store.list("asr-profiles")).filter(function (item) { return item.enabled !== false; });
    var runtimeCapabilities = await Promise.all([systemTtsAvailable(), app.services.asr.systemCapability(false)]);
    var info = await app.platform.hermit.info(), appInfo = await app.platform.hermit.appInfo();
    if (app.state.route !== "settings") return;
    ui.pageHeader("设置", tabNames[tab]);
    var main = document.getElementById("mainContent"); main.className = "main";
    var modeText = ({ live: "线上实时运行", local: "本地运行", browser: "浏览器预览" })[info.runtimeMode] || info.runtimeMode || "未知";
    var modeValue = info.runtimeMode === "local" && appInfo.liveAvailable ? '<button class="runtime-mode-text" type="button" data-enable-live aria-label="本地运行，连续点击三次切换到线上实时运行">' + modeText + '</button>' : u.escapeHtml(modeText);
    var tabs = Object.keys(tabNames).map(function (key) { return '<button type="button" role="tab" data-settings-tab="' + key + '" aria-selected="' + (key === tab) + '">' + tabNames[key] + '</button>'; }).join("");
    main.innerHTML = '<section class="page settings-page"><div class="section-tabs settings-tabs" role="tablist" aria-label="设置分类">' + tabs + '</div><form id="generalForm" class="settings-stack">' +
      '<section class="form-grid settings-panel' + (tab === "interface" ? '' : ' is-hidden') + '" data-settings-panel="interface"><h2 class="section-title">界面</h2>' +
      ui.picker("theme", "界面主题", "") + ui.picker("uiLanguage", "界面语言", "", "跟随系统时，中文系统使用中文，其他系统使用英文。") + ui.picker("imageDetail", "发送图片清晰度", "") + '</section>' +
      '<section class="form-grid settings-panel' + (tab === "conversation" ? '' : ' is-hidden') + '" data-settings-panel="conversation"><h2 class="section-title">对话</h2>' +
      toggle("autoSpeak", "自动朗读新回复", "群聊完成后朗读最后一位角色的回复", settings.autoSpeak) +
      // 开关已并进滑竿（用户 2026-09-26: "混响和环境声不用开关, 默认滑竿 0 就是关, 不是 0 就是打开。
      // 所以可以去掉 Switch 开关控件, 只留强度滑竿了, 合并"）。所以这里不再有 toggle:
      // 滑竿标题直接就是功能名（合并了原来开关的标题), 拉到 0 = 关, 非 0 = 开。
      // 原来的说明句（"小房间混响…" / "隐约的远处人声和风声…"）收进下方一行 helper, 免得丢信息。
      // 量程（用户 2026-09-26: "环境噪声设定要变小, 范围 0~50; 房间回响 0~100" → 同日收尾改成
      // "把当前的两个实际范围值都映射成为滑竿的 0~100"）⇒ 两根滑竿现在都是 0~100。
      // 环境声那边只放大刻度、不动声音: 天花板当时仍是 0.08, 存档旧值在 store.seed 里一并 ×2,
      // 所以显示默认值也跟着从 30 换成等响的 60。0.7.24 起两根滑竿映射出的实际值各 ×2（天花板
      // 0.08 → 0.16）, 但那是映射层的事 —— 显示、存档、默认值这三样都不动, 这里不需要改。
      // 显示值必须按**各自的量程**钳一次, 否则升级上来的人会看到读数超出滑竿右端（滑块本身会被
      // 浏览器钳住）, 变成一个看起来像坏掉、又没人知道是这次改量程造成的界面。
      range("ttsReverbMix", "朗读房间混响", Number(settings.ttsReverbMix == null ? 35 : Math.min(100, settings.ttsReverbMix)), 0, 100, 5, "%") +
      range("ttsAmbienceMix", "背景环境声", Number(settings.ttsAmbienceMix == null ? 60 : Math.min(100, settings.ttsAmbienceMix)), 0, 100, 5, "%") +
      '<p class="helper">混响是小房间的贴耳效果, 让朗读声音像话筒就在嘴边; 环境声是远处断续的人声与风声, 时大时小, 每次不同。两根滑竿拉到 0 就是关闭, 对 Android 系统朗读无效。</p>' +
      ui.picker("defaultTtsProfileId", "默认朗读服务", "", "角色选择“跟随通用设置”时使用") + ui.picker("defaultAsrProfileId", "默认语音输入", "", "新对话默认使用；可在对话管理中覆盖") + '</section>' +
      '<section class="form-grid settings-panel' + (tab === "compression" ? '' : ' is-hidden') + '" data-settings-panel="compression"><div><h2 class="section-title">上下文自动压缩</h2><p class="helper section-helper">超过触发字数时，由主持人角色用自己的模型在后台压缩更早的消息，不打断本轮回复。</p></div>' +
      toggle("autoCompress", "自动压缩历史", "超过触发字数后在后台自动执行", settings.autoCompress) + range("compressionThresholdChars", "触发字数", Number(settings.compressionThresholdChars || 10000), 4000, 32000, 2000, " 字") + range("compressionRetainChars", "压缩保留字数", Number(settings.compressionRetainChars || 4000), 2000, 10000, 1000, " 字") + '<p class="helper">从最近一条往前累加，达到这个字数就不再往更早处压；至少保留 2 条。</p>' + range("compressionTargetChars", "压缩目标", Number(settings.compressionTargetChars || 1000), 500, 2000, 100, " 字") +
      '<label class="field"><span>压缩提示词</span><textarea class="prompt-editor" name="compressionPrompt" maxlength="8000">' + u.escapeHtml(settings.compressionPrompt || "") + '</textarea><small>压缩内容可以在具体对话中手工修订；已经压缩的原消息不再允许编辑。</small></label></section>' +
      '<div class="settings-save' + (tab === "system" ? ' is-hidden' : '') + '" data-settings-save><button class="button primary full" type="submit">保存设置</button><p class="save-status" id="settingsSaveStatus" role="status"></p></div></form>' +
      '<section class="settings-panel system-panel' + (tab === "system" ? '' : ' is-hidden') + '" data-settings-panel="system">' +
      '<button class="button primary full system-backup" type="button" data-backup-app>' + ui.icon("box-archive") + '备份软件和数据</button>' +
      '<p class="helper">把当前应用与全部数据打包到自选位置，备份不加密。</p>' +
      '<div class="system-hero"><img class="system-mark" src="./app/assets/icon.webp" alt=""><div><h2>chataxi <span class="badge">v' + u.escapeHtml(app.version) + '</span></h2><p>想聊就聊，自由自在</p></div></div><p class="system-copy">chataxi 是运行在 HermitApp 中的个人 AI 对话应用。你可以连接自己的模型服务，创建独立角色，并进行单聊或多人对话。</p><dl class="facts"><div><dt>作者</dt><dd>zhyuzh3d</dd></div><div><dt>数据保存</dt><dd>' + (store.backend() === "hermit" ? "Hermit 应用数据" : "当前浏览器") + '</dd></div><div><dt>运行方式</dt><dd>' + modeValue + '</dd></div><div><dt>Hermit Bridge</dt><dd>' + (app.platform.hermit.available() ? "已就绪" : "未连接") + '</dd></div></dl>' + (info.runtimeMode === "live" && appInfo.localAvailable ? '<button class="button secondary full runtime-switch" type="button" data-enable-local>' + ui.icon("gear") + '改为本地运行</button>' : '') + '<p class="helper">角色、对话和服务配置保存在当前设备。清除应用数据会删除本机记录；页面代码在请求模型服务时可以读取保存在当前 happ 数据空间中的密钥。</p><button class="button danger data-clear-button" type="button" data-clear-data>' + ui.icon("trash") + '清除数据</button></section></section>';

    var form = document.getElementById("generalForm");
    function selectTab(selected) { app.state.settingsTab = selected; main.querySelectorAll("[data-settings-tab]").forEach(function (item) { item.setAttribute("aria-selected", String(item.dataset.settingsTab === selected)); }); main.querySelectorAll("[data-settings-panel]").forEach(function (panel) { panel.classList.toggle("is-hidden", panel.dataset.settingsPanel !== selected); }); form.querySelector("[data-settings-save]").classList.toggle("is-hidden", selected === "system"); document.getElementById("pageSubtitle").textContent = tabNames[selected]; }
    main.querySelectorAll("[data-settings-tab]").forEach(function (button) { button.addEventListener("click", function () { selectTab(button.dataset.settingsTab); }); });
    ui.bindPicker(form, "defaultTtsProfileId", items(tts, runtimeCapabilities[0]), settings.defaultTtsProfileId);
    ui.bindPicker(form, "defaultAsrProfileId", items(asr, runtimeCapabilities[1].available), settings.defaultAsrProfileId);
    ui.bindPicker(form, "theme", [{ id: "system", name: "跟随系统" }, { id: "light", name: "浅色" }, { id: "dark", name: "深色" }], settings.theme || "system");
    ui.bindPicker(form, "uiLanguage", [{ id: "system", name: "跟随系统" }, { id: "zh-CN", name: "中文" }, { id: "en", name: "English" }], settings.uiLanguage || "system");
    // 界面语言选中即生效；持久化仍走下方「保存设置」，与其它设置项一致。
    form.elements.namedItem("uiLanguage").addEventListener("change", function (event) { app.i18n.setPreference(event.target.value); markDirty(); });
    ui.bindPicker(form, "imageDetail", [{ id: "auto", name: "自动" }, { id: "low", name: "低清" }, { id: "high", name: "高清" }], settings.imageDetail || "auto");
    form.querySelectorAll('input[type="range"]').forEach(function (slider) { slider.addEventListener("input", function () { var output = form.querySelector('[data-output="' + slider.name + '"]'); output.textContent = slider.value + (slider.dataset.suffix || ""); markDirty(); }); });
    // 原来这里还有一段"开关关掉时把强度滑竿置灰"的联动。开关控件已经去掉, 滑竿自己就是开关, 所以
    // 整段联动连同 `.range-field.is-disabled` 的用法一并撤掉 —— 留着只会把滑竿又置灰。
    function markDirty() { document.getElementById("settingsSaveStatus").textContent = "有未保存的更改"; }
    form.addEventListener("input", markDirty);
    form.addEventListener("submit", ui.action(async function (event) {
      event.preventDefault(); var button = form.querySelector('[type="submit"]'); if (button.disabled) return; button.disabled = true;
      try {
        var next = await store.get("meta", "settings");
        ["autoSpeak", "autoCompress"].forEach(function (key) { next[key] = u.checked(form, key); });
        // language（朗读/识别的语音语言兜底）已不再有界面控件，因此不能出现在保存列表里，
        // 否则表单里取不到该字段会把已保存的值清空。
        ["defaultTtsProfileId", "defaultAsrProfileId", "theme", "imageDetail", "uiLanguage", "compressionPrompt"].forEach(function (key) { next[key] = u.formValue(form, key); });
        ["compressionThresholdChars", "compressionRetainChars", "compressionTargetChars", "ttsReverbMix", "ttsAmbienceMix"].forEach(function (key) { next[key] = Number(u.formValue(form, key)); });
        if (!next.compressionPrompt) throw new Error("请填写压缩提示词");
        await store.put("meta", "settings", next); app.applyTheme(next.theme); document.getElementById("settingsSaveStatus").textContent = "设置已保存"; ui.toast("设置已保存");
      } finally { button.disabled = false; }
    }));
    var liveButton = main.querySelector("[data-enable-live]"), tapCount = 0, tapTimer = 0;
    if (liveButton) liveButton.addEventListener("click", ui.action(async function () { clearTimeout(tapTimer); tapCount += 1; tapTimer = setTimeout(function () { tapCount = 0; }, 1400); if (tapCount < 3) return; tapCount = 0; clearTimeout(tapTimer); liveButton.disabled = true; await app.platform.hermit.setRuntimeMode("live"); }));
    var localButton = main.querySelector("[data-enable-local]");
    if (localButton) localButton.addEventListener("click", ui.action(async function () { localButton.disabled = true; await app.platform.hermit.setRuntimeMode("local"); }));
    main.querySelector("[data-backup-app]").addEventListener("click", ui.action(function () { return backupApp(main.querySelector("[data-backup-app]")); }));
    main.querySelector("[data-clear-data]").addEventListener("click", openClearData);
  }

  app.features = app.features || {};
  app.features.settings = { render: render };
})(window.chataxi);
