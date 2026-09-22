(function (app) {
  "use strict";

  // 界面语言。与 TTS/ASR 的语音语言（settings.language）完全无关。
  // preference: "system" | "zh-CN" | "en"（system = 跟随系统语言）
  // current:    "zh-CN" | "en"
  var PREFERENCES = ["system", "zh-CN", "en"];
  var ATTRIBUTES = ["aria-label", "title", "placeholder", "alt"];
  var IGNORE_SELECTOR = "script,style,code,pre,textarea,[data-i18n-ignore]";
  var preference = "system";
  var systemLanguage = "en";
  var current = "en";
  var active = false;
  var observer = null;
  var sourceText = new WeakMap();
  var sourceAttributes = new WeakMap();
  var listeners = [];

  function dictionary() { return app.data && app.data.i18nEn || {}; }
  function patterns() { return app.data && app.data.i18nEnPatterns || []; }
  function hasChinese(value) { return typeof value === "string" && /[\u4e00-\u9fff]/.test(value); }

  // 把 "$1" 换成第一捕获组，并顺手把捕获组自己再翻一次。
  // 这样 "推荐用于语言模型" 这类拼装句只需要一条 "推荐用于(.+)" 规则。
  function expand(template, match, depth) {
    return template.replace(/\$(\d)/g, function (token, index) {
      var group = match[Number(index)];
      return group == null ? "" : depth > 0 ? english(group, depth - 1) : group;
    });
  }

  function english(value, depth) {
    if (typeof depth !== "number" || isNaN(depth)) depth = 3;
    var table = dictionary();
    if (Object.prototype.hasOwnProperty.call(table, value)) return table[value];
    if (depth <= 0) return value;
    var rules = patterns();
    for (var index = 0; index < rules.length; index += 1) {
      var match = rules[index][0].exec(value);
      if (match) return expand(rules[index][1], match, depth - 1);
    }
    return value;
  }

  // 逐行翻译；保留首尾空白，避免破坏内联排版。
  function translate(value) {
    if (current !== "en" || !hasChinese(value)) return value;
    var match = /^(\s*)([\s\S]*?)(\s*)$/.exec(value);
    return match[1] + english(match[2], 3) + match[3];
  }

  // 数据字段（角色模板名称/职业/介绍等）按语言取值。
  function pick(zh, en) { return current === "en" && en ? en : zh; }
  function isEnglish() { return current === "en"; }
  function locale() { return current === "en" ? "en-US" : "zh-CN"; }

  function ignored(node) {
    var element = node.nodeType === 1 ? node : node.parentElement;
    return !!(element && element.closest && element.closest(IGNORE_SELECTOR));
  }
  // 能不能把这个值当成「原文」重新记下来。
  // 已经记过中文原文、现在却只有英文，说明这是翻译层自己刚写回去的译文：
  // 重新捕获会把英文当成原文，切回中文就再也还原不回来（如选择器的值标签）。
  // 反过来，原文本来没有中文时的任何更新都照记，不影响两种语言。
  function capturable(previous, value) { return !hasChinese(previous) || hasChinese(value); }
  function textNode(node, capture) {
    if (ignored(node)) return;
    if (!sourceText.has(node)) sourceText.set(node, node.data);
    else if (capture && capturable(sourceText.get(node), node.data)) sourceText.set(node, node.data);
    var next = translate(sourceText.get(node));
    if (node.data !== next) node.data = next;
  }
  function attribute(element, name, capture) {
    if (!element.hasAttribute || !element.hasAttribute(name)) return;
    var values = sourceAttributes.get(element);
    if (!values) { values = {}; sourceAttributes.set(element, values); }
    if (!(name in values)) values[name] = element.getAttribute(name);
    else if (capture && capturable(values[name], element.getAttribute(name))) values[name] = element.getAttribute(name);
    var next = translate(values[name]);
    if (element.getAttribute(name) !== next) element.setAttribute(name, next);
  }
  function tree(root, capture) {
    if (!root || !root.nodeType) return;
    if (root.nodeType === 3) { textNode(root, capture); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) ATTRIBUTES.forEach(function (name) { attribute(root, name, capture); });
    var walker = document.createTreeWalker(root, 5);
    while (walker.nextNode()) {
      var node = walker.currentNode;
      if (node.nodeType === 3) textNode(node, capture);
      else ATTRIBUTES.forEach(function (name) { attribute(node, name, capture); });
    }
  }

  function observe() {
    if (!observer) return;
    observer.disconnect();
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
  }

  function apply(capture) {
    if (!active || !document.documentElement) return;
    observer && observer.disconnect();
    document.documentElement.lang = current === "en" ? "en" : "zh-CN";
    tree(document.documentElement, Boolean(capture));
    observe();
  }

  function notify() { listeners.slice().forEach(function (listener) { try { listener(current, preference); } catch (_) {} }); }

  function onChange(listener) {
    if (typeof listener !== "function") return function () {};
    listeners.push(listener);
    return function () { listeners = listeners.filter(function (item) { return item !== listener; }); };
  }

  function setPreference(value, options) {
    preference = PREFERENCES.indexOf(value) >= 0 ? value : "system";
    var next = preference === "system" ? systemLanguage : preference;
    var changed = next !== current;
    current = next;
    apply(false);
    if (changed && !(options && options.silent)) notify();
    return current;
  }

  function systemChoice(language) { return String(language || "").toLowerCase() === "zh" ? "zh-CN" : "en"; }

  async function syncSystemLanguage() {
    var api = app.platform && app.platform.hermit && app.platform.hermit.api && app.platform.hermit.api();
    if (!api || !api.system || typeof api.system.language !== "function") return current;
    try {
      var value = await api.system.language({});
      systemLanguage = systemChoice(value && value.language);
      if (preference === "system") {
        var changed = systemLanguage !== current;
        current = systemLanguage;
        apply(false);
        if (changed) notify();
      }
    } catch (_) {}
    return current;
  }

  function start() {
    active = true;
    var navigatorLanguage = (navigator.languages && navigator.languages[0]) || navigator.language || "en";
    systemLanguage = systemChoice(String(navigatorLanguage).split("-")[0]);
    current = preference === "system" ? systemLanguage : preference;
    // 在页面解析完成的那一刻先应用一次，避免英文系统上看不到中文以外的变化。
    // MutationObserver 在极少数测试宿主里不存在；缺了它只是后续新节点不再同步，不影响首屏。
    observer = typeof MutationObserver === "function" ? new MutationObserver(function (records) {
      observer.disconnect();
      records.forEach(function (record) {
        if (record.type === "characterData") textNode(record.target, true);
        else if (record.type === "attributes") attribute(record.target, record.attributeName, true);
        else Array.prototype.forEach.call(record.addedNodes, function (node) { tree(node, true); });
      });
      observe();
    }) : null;
    apply(true);
    window.addEventListener("hermitready", function () { syncSystemLanguage(); });
    if (app.platform && app.platform.hermit && app.platform.hermit.available && app.platform.hermit.available()) syncSystemLanguage();
  }

  app.i18n = {
    t: translate,
    pick: pick,
    english: english,
    current: function () { return current; },
    preference: function () { return preference; },
    systemLanguage: function () { return systemLanguage; },
    isEnglish: isEnglish,
    locale: locale,
    setPreference: setPreference,
    syncSystemLanguage: syncSystemLanguage,
    apply: apply,
    onChange: onChange,
    preferences: PREFERENCES.slice()
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})(window.chataxi);
