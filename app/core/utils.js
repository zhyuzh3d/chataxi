(function (app) {
  "use strict";

  function id(prefix) {
    var random = "";
    if (window.crypto && window.crypto.getRandomValues) {
      var values = new Uint32Array(3);
      window.crypto.getRandomValues(values);
      random = Array.prototype.map.call(values, function (value) { return value.toString(36); }).join("");
    } else {
      random = Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
    return (prefix || "id") + "_" + random;
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatTime(timestamp) {
    var date = new Date(timestamp);
    var now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    }
    return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  }

  function debounce(fn, delay) {
    var timer = null;
    return function () {
      var args = arguments;
      var context = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(context, args); }, delay);
    };
  }

  function safeJsonParse(text, fallback) {
    try { return JSON.parse(text); } catch (_) { return fallback; }
  }

  function cleanError(error) {
    var raw = error && error.message ? error.message : String(error || "未知错误");
    return raw
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer ***")
      .replace(/(api[-_ ]?key[\"'=:\s]+)[A-Za-z0-9._~+\/-]{8,}/gi, "$1***")
      .replace(/sk[-_][A-Za-z0-9_-]{8,}/g, "***")
      .replace(/AIza[A-Za-z0-9_-]{12,}/g, "***")
      .replace(/(token|secret|password)([\"'=:\s]+)[A-Za-z0-9._~+\/-]{8,}/gi, "$1$2***")
      .slice(0, 500);
  }

  function maskSecret(value) {
    var text = String(value == null ? "" : value);
    var bearer = /^(Bearer\s+)(.+)$/i.exec(text);
    if (bearer) return bearer[1] + maskSecret(bearer[2]);
    if (!text) return "";
    if (text.length === 1) return "•";
    if (text.length <= 4) return text.slice(0, 1) + "••" + text.slice(-1);
    if (text.length <= 8) return text.slice(0, 2) + "••••••" + text.slice(-2);
    return text.slice(0, 4) + "••••••" + text.slice(-4);
  }

  function maskedHeaderEntries(value) {
    var parsed;
    try { parsed = parseHeaders(value); } catch (_) { return []; }
    return Object.keys(parsed).map(function (name) {
      return { name: name, maskedValue: maskSecret(parsed[name]), value: parsed[name] };
    });
  }

  function dataUrlToParts(dataUrl) {
    var match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl || "");
    return match ? { mime: match[1], data: match[2].replace(/\s/g, "") } : null;
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(reader.error || new Error("无法读取文件")); };
      reader.readAsDataURL(blob);
    });
  }

  function bytesToBase64(bytes) {
    var chunk = 0x8000;
    var binary = "";
    for (var index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, Math.min(index + chunk, bytes.length)));
    }
    return btoa(binary);
  }

  function base64ToBlob(value, mime) {
    var binary = atob(String(value || "").replace(/\s/g, ""));
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mime || "application/octet-stream" });
  }

  function isAllowedImageUrl(value) {
    if (!value || typeof value !== "string") return false;
    if (/^data:image\/(jpeg|png|webp|gif);base64,/i.test(value)) return true;
    try { return new URL(value).protocol === "https:"; } catch (_) { return false; }
  }

  function formValue(form, name) {
    var element = form.elements.namedItem(name);
    return element ? String(element.value || "").trim() : "";
  }

  function checked(form, name) {
    var element = form.elements.namedItem(name);
    return Boolean(element && element.checked);
  }

  function fileSafeName(name) {
    return String(name || "file").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "file";
  }

  function validateEndpoint(value) {
    var url;
    try { url = new URL(String(value || "").replace(/\{(?:model|voice)\}/g, "placeholder")); } catch (_) { throw new Error("请填写完整的 HTTP(S) 请求地址"); }
    if (["http:", "https:"].indexOf(url.protocol) < 0 || !url.hostname) throw new Error("请求地址只支持 HTTP 或 HTTPS");
    if (url.username || url.password || url.hash) throw new Error("地址不能包含用户名、密码或片段；请使用密钥字段");
    return String(value).trim();
  }
  function parseHeaders(value) {
    if (!value) return {};
    var parsed = typeof value === "string" ? safeJsonParse(value, null) : value;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("自定义 Header 必须是 JSON 对象");
    var output = {};
    Object.keys(parsed).forEach(function (name) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /^(host|content-length|connection|transfer-encoding|cookie|origin|referer|proxy-.*|sec-.*)$/i.test(name)) throw new Error("不能设置请求头：" + name);
      if (typeof parsed[name] !== "string" && typeof parsed[name] !== "number") throw new Error("请求头的值只能是文字或数字");
      if (/[\r\n]/.test(String(parsed[name]))) throw new Error("请求头不能包含换行符");
      output[name] = String(parsed[name]);
    });
    return output;
  }

  app.utils = {
    id: id,
    validateEndpoint: validateEndpoint,
    parseHeaders: parseHeaders,
    clone: clone,
    escapeHtml: escapeHtml,
    formatTime: formatTime,
    debounce: debounce,
    safeJsonParse: safeJsonParse,
    cleanError: cleanError,
    maskSecret: maskSecret,
    maskedHeaderEntries: maskedHeaderEntries,
    dataUrlToParts: dataUrlToParts,
    blobToDataUrl: blobToDataUrl,
    bytesToBase64: bytesToBase64,
    base64ToBlob: base64ToBlob,
    isAllowedImageUrl: isAllowedImageUrl,
    formValue: formValue,
    checked: checked,
    fileSafeName: fileSafeName
  };
})(window.chataxi);
