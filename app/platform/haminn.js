(function (app) {
  "use strict";
  var ready = false;
  var waiters = [];

  function current() {
    return window.haminn && window.haminn.isReady ? window.haminn : null;
  }

  function markReady() {
    if (!current()) return;
    ready = true;
    waiters.splice(0).forEach(function (resolve) { resolve(true); });
    app.events.emit("platform:ready", true);
  }

  window.addEventListener("haminnready", markReady);
  if (current()) markReady();

  function awaitReady(timeoutMs) {
    if (ready || current()) { markReady(); return Promise.resolve(true); }
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (value) {
        if (done) return;
        done = true;
        resolve(value);
      };
      waiters.push(finish);
      setTimeout(function () {
        waiters = waiters.filter(function (item) { return item !== finish; });
        finish(Boolean(current()));
      }, typeof timeoutMs === "number" ? timeoutMs : 3500);
    });
  }

  async function call(path, params) {
    var available = await awaitReady(3500);
    if (!available) throw new Error("当前不在 HaminnApp 中，无法使用系统能力");
    var parts = path.split(".");
    var target = current();
    for (var index = 0; index < parts.length; index += 1) target = target[parts[index]];
    if (typeof target !== "function") throw new Error("HaminnApp 不支持此能力：" + path);
    var owner = parts.length > 1 ? current()[parts[0]] : current();
    return target.call(owner, params || {});
  }

  async function info() {
    if (!(await awaitReady(1200))) return { runtimeMode: "browser", bridgeMode: "none", appId: "browser-preview" };
    return current().runtime.info();
  }

  async function appInfo() {
    if (!(await awaitReady(1200))) return { localAvailable: false, liveAvailable: false };
    return current().app.info();
  }

  async function setRuntimeMode(runtimeMode) {
    return call("app.setRuntimeMode", { runtimeMode: runtimeMode });
  }

  async function capabilities() {
    if (!(await awaitReady(1200))) return [];
    var result = await current().runtime.capabilities();
    return result.capabilities || [];
  }

  function on(name, listener) {
    if (!current() || typeof current().on !== "function") return function () {};
    return current().on(name, listener);
  }

  async function copyText(text) {
    var api = current();
    if (api && api.clipboard && api.clipboard.write) await api.clipboard.write({ text: text });
    else if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      var field = document.createElement("textarea"); field.value = text; field.className = "copy-buffer"; document.body.appendChild(field); field.select();
      var copied = document.execCommand("copy"); field.remove();
      if (!copied) throw new Error("当前环境无法复制，请长按文字手动复制");
    }
  }
  async function readClipboardText() {
    var api = current();
    if (api && api.clipboard && api.clipboard.read) {
      var result = await api.clipboard.read();
      return typeof result === "string" ? result : String(result && result.text || "");
    }
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.readText();
    throw new Error("当前环境无法读取剪贴板，请直接粘贴到输入框");
  }
  app.platform = app.platform || {};
  app.platform.haminn = {
    copyText: copyText,
    readClipboardText: readClipboardText,
    awaitReady: awaitReady,
    available: function () { return Boolean(current()); },
    api: current,
    call: call,
    info: info,
    appInfo: appInfo,
    setRuntimeMode: setRuntimeMode,
    capabilities: capabilities,
    on: on
  };
})(window.chataxi);
