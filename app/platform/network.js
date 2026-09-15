(function (app) {
  "use strict";
  var utils = app.utils;

  function buildHeaders(options) {
    var headers = {};
    utils.parseHeaders(options.headers || {});
    Object.keys(options.headers || {}).forEach(function (name) {
      if (options.headers[name] != null && String(options.headers[name]).trim()) headers[name] = String(options.headers[name]);
    });
    return headers;
  }

  function stopped() {
    var error = new Error("本轮已停止"); error.cancelled = true; return error;
  }

  function assertOptions(options) {
    if (!options || !/^https?:\/\//i.test(options.url || "")) throw new Error("请求地址必须是完整的 HTTP(S) URL");
    utils.validateEndpoint(options.url);
    if (options.task && options.task.cancelled) throw stopped();
  }

  function nativeParams(options, headers) {
    var params = { url: options.url, method: String(options.method || "GET").toUpperCase(), headers: headers, timeoutMs: options.timeoutMs || 60000 };
    if (options.bodyBytes) {
      params.bodyBase64 = utils.bytesToBase64(options.bodyBytes);
      params.contentType = options.contentType || "application/octet-stream";
    } else if (typeof options.bodyText === "string") {
      params.bodyText = options.bodyText;
      params.contentType = options.contentType || headers["Content-Type"] || headers["content-type"] || "application/json";
    } else if (options.bodyLogicalFileId) {
      params.bodyLogicalFileId = options.bodyLogicalFileId;
      params.contentType = options.contentType || "application/octet-stream";
    } else if (Array.isArray(options.multipart)) {
      params.multipart = options.multipart;
    }
    return params;
  }

  async function request(options) {
    assertOptions(options);
    var method = String(options.method || "GET").toUpperCase();
    var headers = buildHeaders(options);
    if (app.platform.hermit.available() || await app.platform.hermit.awaitReady(800)) {
      if (options.task && options.task.cancelled) throw stopped();
      return app.platform.hermit.api().network.request(nativeParams(options, headers));
    }

    if (options.bodyLogicalFileId || options.multipart) throw new Error("大文件上传需要在支持 Hermit API 1.7 的 HermitApp 中使用");
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    if (options.task) options.task.controller = controller;
    if (options.bodyBytes && options.contentType) headers["Content-Type"] = options.contentType;
    var timer = controller ? setTimeout(function () { controller.abort(); }, options.timeoutMs || 60000) : null;
    try {
      var response = await fetch(options.url, {
        method: method,
        headers: headers,
        body: options.bodyBytes || options.bodyText,
        signal: controller ? controller.signal : undefined
      });
      var type = response.headers.get("content-type") || "application/octet-stream";
      var responseHeaders = {};
      response.headers.forEach(function (value, name) { responseHeaders[name] = value; });
      if (/json|text|xml|javascript/i.test(type)) {
        return { status: response.status, headers: responseHeaders, url: response.url, bodyText: await response.text() };
      }
      var bytes = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, headers: responseHeaders, url: response.url, bodyBase64: utils.bytesToBase64(bytes) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function requestJson(options) {
    if (typeof TextDecoder === "function" && (app.platform.hermit.available() || await app.platform.hermit.awaitReady(800))) {
      var decoder = new TextDecoder("utf-8"), bodyText = "", receivedBytes = 0;
      var streamed = await requestByteStream(Object.assign({}, options, {
        onChunk: async function (bytes) {
          receivedBytes += bytes.length;
          if (receivedBytes > 8 * 1024 * 1024) throw new Error("JSON 响应超过 8 MiB，无法安全读取");
          bodyText += decoder.decode(bytes, { stream: true });
        }
      }));
      bodyText += decoder.decode();
      var streamedPayload = utils.safeJsonParse(bodyText, null);
      if (!streamedPayload) throw new Error("服务返回的不是有效 JSON");
      return { data: streamedPayload, response: streamed };
    }
    var result = await request(options);
    var bodyText = await readText(result);
    var payload = utils.safeJsonParse(bodyText, null);
    if (result.status < 200 || result.status >= 300) throw httpError(result.status, payload || bodyText, options.headers);
    if (!payload) throw new Error("服务返回的不是有效 JSON");
    return { data: payload, response: result };
  }

  function redact(message, headers) {
    Object.keys(headers || {}).forEach(function (name) {
      if (!/authorization|key|token|secret/i.test(name)) return;
      var secret = String(headers[name] || "").replace(/^Bearer\s+/i, "");
      if (secret.length >= 4) message = String(message).split(secret).join("***");
    });
    return message;
  }

  function httpError(status, payload, headers) {
    var detail = payload && typeof payload === "object" ? (payload.error || payload.detail || payload.message || payload) : payload;
    var message = detail && typeof detail === "object"
      ? (detail.message || detail.status || detail.code || JSON.stringify(detail))
      : detail || "服务未返回可读错误说明，请检查地址、授权或稍后重试";
    var category = status === 401 ? "认证失败" : status === 403 ? "权限不足" : status === 408 ? "请求超时" : status === 429 ? "额度或频率限制" : status >= 500 ? "服务端错误" : "请求失败";
    var error = new Error(category + "（" + status + "）：" + utils.cleanError(redact(String(message), headers)).slice(0, 300));
    error.status = status; error.category = category; error.payload = payload; return error;
  }

  function streamUnavailable(message, cause) {
    var error = new Error(message); error.streamUnavailable = true; error.cause = cause; return error;
  }

  function base64Bytes(value) {
    var binary = atob(String(value || "").replace(/\s/g, "")), bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function nativeByteStream(options, headers) {
    var api = app.platform.hermit.api(), streamId = "", done = false, cancelled = false;
    var controller = {
      abort: function () {
        cancelled = true;
        if (streamId) api.network.closeStream({ streamId: streamId }).catch(function () {});
      }
    };
    if (options.task) options.task.controller = controller;
    var opened;
    try {
      opened = await api.network.openStream(nativeParams(options, headers));
      streamId = opened.streamId;
      var failedChunks = [], failedBytes = 0;
      while (!done) {
        if (cancelled || options.task && options.task.cancelled) throw stopped();
        var part = await api.network.readStream({ streamId: streamId, maxBytes: options.chunkBytes || 32 * 1024, timeoutMs: options.timeoutMs || 180000 });
        done = Boolean(part.done);
        if (!part.bytes) continue;
        var bytes = base64Bytes(part.chunkBase64);
        if (opened.status < 200 || opened.status >= 300) {
          failedBytes += bytes.length;
          if (failedBytes <= 512 * 1024) failedChunks.push(bytes);
          continue;
        }
        if (options.onChunk) await options.onChunk(bytes);
      }
      if (opened.status < 200 || opened.status >= 300) {
        var total = failedChunks.reduce(function (sum, item) { return sum + item.length; }, 0), merged = new Uint8Array(total), offset = 0;
        failedChunks.forEach(function (item) { merged.set(item, offset); offset += item.length; });
        var text = typeof TextDecoder === "function" ? new TextDecoder("utf-8").decode(merged) : "";
        throw httpError(opened.status, utils.safeJsonParse(text, null) || text, headers);
      }
      return { status: opened.status, headers: opened.headers || {}, url: opened.url, contentType: opened.contentType, native: true };
    } catch (error) {
      if (cancelled || options.task && options.task.cancelled) { error.cancelled = true; throw error; }
      if (error && error.code === "E_UNSUPPORTED" && !opened) {
        throw streamUnavailable("当前 HermitApp 尚未提供流式网络能力，请更新宿主", error);
      }
      throw error;
    } finally {
      if (streamId && !done) await api.network.closeStream({ streamId: streamId }).catch(function () {});
    }
  }

  async function browserByteStream(options, headers) {
    if (typeof fetch !== "function") throw streamUnavailable("当前 WebView 不支持网络流读取");
    if (options.bodyLogicalFileId || options.multipart) throw streamUnavailable("浏览器降级模式不能流式上传逻辑文件");
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    if (options.task) options.task.controller = controller;
    var response;
    try {
      response = await fetch(options.url, {
        method: String(options.method || "POST").toUpperCase(),
        headers: headers,
        body: options.bodyBytes || options.bodyText,
        signal: controller ? controller.signal : undefined
      });
    } catch (error) {
      if (options.task && options.task.cancelled) { error.cancelled = true; throw error; }
      throw streamUnavailable("当前服务无法通过 WebView 建立流式连接", error);
    }
    if (response.status < 200 || response.status >= 300) throw httpError(response.status, utils.safeJsonParse(await response.text(), null) || "服务未返回错误说明", headers);
    var reader = response.body && typeof response.body.getReader === "function" ? response.body.getReader() : null;
    if (!reader) throw streamUnavailable("当前 WebView 只能读取完整响应");
    while (true) {
      if (options.task && options.task.cancelled) { if (controller) controller.abort(); throw stopped(); }
      var part = await reader.read(); if (part.done) break;
      if (part.value && part.value.length && options.onChunk) await options.onChunk(part.value);
    }
    var responseHeaders = {}; response.headers.forEach(function (value, name) { responseHeaders[name] = value; });
    return { status: response.status, headers: responseHeaders, url: response.url, contentType: response.headers.get("content-type") || "application/octet-stream", native: false };
  }

  async function requestByteStream(options) {
    assertOptions(options);
    var headers = buildHeaders(options);
    if (app.platform.hermit.available() || await app.platform.hermit.awaitReady(800)) return nativeByteStream(options, headers);
    return browserByteStream(options, headers);
  }

  function socketUrl(value) {
    var parsed;
    try { parsed = new URL(String(value || "")); } catch (_) { throw new Error("WebSocket 地址必须是完整 URL"); }
    if (["ws:", "wss:"].indexOf(parsed.protocol) < 0 || parsed.username || parsed.password || parsed.hash) throw new Error("WebSocket 地址必须是无用户信息和片段的 WS(S) URL");
    return parsed.toString();
  }

  async function nativeSocket(options, headers) {
    var api = app.platform.hermit.api(), opened = await api.network.openSocket({ url: socketUrl(options.url), headers: headers, timeoutMs: options.timeoutMs || 60000 });
    var closed = false;
    var session = {
      native: true,
      socketId: opened.socketId,
      sendText: function (value) { if (closed) throw new Error("WebSocket 已关闭"); return api.network.sendSocket({ socketId: opened.socketId, text: String(value) }); },
      sendBytes: function (bytes) { if (closed) throw new Error("WebSocket 已关闭"); return api.network.sendSocket({ socketId: opened.socketId, dataBase64: utils.bytesToBase64(bytes) }); },
      next: async function (timeoutMs) {
        if (closed) return { type: "closed", code: 1000, text: "Client closed" };
        var event = await api.network.readSocket({ socketId: opened.socketId, timeoutMs: timeoutMs == null ? 30000 : timeoutMs });
        if (event.type === "binary" && event.dataBase64) event.bytes = base64Bytes(event.dataBase64);
        if (event.type === "closed" || event.type === "error") closed = true;
        return event;
      },
      close: async function (reason) { if (closed) return; closed = true; await api.network.closeSocket({ socketId: opened.socketId, reason: String(reason || "Client closed") }).catch(function () {}); }
    };
    if (options.task) options.task.controller = { abort: function () { session.close("Cancelled"); } };
    return session;
  }

  function browserSocket(options, headers) {
    if (typeof WebSocket !== "function") throw streamUnavailable("当前 WebView 不支持 WebSocket");
    if (Object.keys(headers).length) throw streamUnavailable("当前 WebView WebSocket 不能携带自定义鉴权 Header，请更新 HermitApp");
    return new Promise(function (resolve, reject) {
      var socket = new WebSocket(socketUrl(options.url)), queue = [], waiter = null, opened = false, closed = false;
      function deliver(event) { if (waiter) { var current = waiter; waiter = null; clearTimeout(current.timer); current.resolve(event); } else queue.push(event); }
      socket.onopen = function () {
        opened = true;
        var session = {
          native: false,
          sendText: function (value) { if (closed) throw new Error("WebSocket 已关闭"); socket.send(String(value)); return Promise.resolve({ accepted: true }); },
          sendBytes: function (bytes) { if (closed) throw new Error("WebSocket 已关闭"); socket.send(bytes); return Promise.resolve({ accepted: true }); },
          next: function (timeoutMs) {
            if (queue.length) return Promise.resolve(queue.shift());
            if (closed) return Promise.resolve({ type: "closed", code: 1000 });
            return new Promise(function (nextResolve) {
              var entry = { resolve: nextResolve, timer: null };
              entry.timer = setTimeout(function () { if (waiter === entry) waiter = null; nextResolve({ type: "timeout" }); }, timeoutMs == null ? 30000 : timeoutMs);
              waiter = entry;
            });
          },
          close: function (reason) { if (closed) return Promise.resolve(); closed = true; try { socket.close(1000, String(reason || "Client closed").slice(0, 120)); } catch (_) {} deliver({ type: "closed", code: 1000, text: String(reason || "") }); return Promise.resolve(); }
        };
        if (options.task) options.task.controller = { abort: function () { session.close("Cancelled"); } };
        resolve(session);
      };
      socket.onmessage = function (event) {
        if (typeof event.data === "string") deliver({ type: "text", text: event.data });
        else if (event.data instanceof ArrayBuffer) deliver({ type: "binary", bytes: new Uint8Array(event.data) });
        else if (event.data && typeof event.data.arrayBuffer === "function") event.data.arrayBuffer().then(function (bytes) { deliver({ type: "binary", bytes: new Uint8Array(bytes) }); });
      };
      socket.onerror = function () { var error = streamUnavailable("WebSocket 连接失败"); if (!opened) reject(error); else deliver({ type: "error", text: error.message }); };
      socket.onclose = function (event) { closed = true; var value = { type: "closed", code: event.code, text: event.reason || "" }; if (!opened) reject(streamUnavailable("WebSocket 在建立前关闭")); else deliver(value); };
    });
  }

  async function openWebSocket(options) {
    options = options || {}; var headers = buildHeaders(options);
    if (app.platform.hermit.available() || await app.platform.hermit.awaitReady(800)) {
      try { return await nativeSocket(options, headers); }
      catch (error) { if (!error || error.code !== "E_UNSUPPORTED") throw error; }
    }
    return browserSocket(options, headers);
  }

  async function requestSse(options) {
    if (typeof TextDecoder !== "function") throw streamUnavailable("当前 WebView 不支持 UTF-8 流解析");
    var decoder = new TextDecoder("utf-8"), buffer = "", eventName = "message", dataLines = [], received = false;
    async function dispatch() {
      if (!dataLines.length) { eventName = "message"; return; }
      received = true;
      var payload = { event: eventName, data: dataLines.join("\n") };
      dataLines = []; eventName = "message";
      if (options.onEvent) await options.onEvent(payload);
    }
    async function consume(line) {
      if (!line) { await dispatch(); return; }
      if (line.charAt(0) === ":") return;
      if (line.indexOf("event:") === 0) { eventName = line.slice(6).trim() || "message"; return; }
      if (line.indexOf("data:") === 0) { dataLines.push(line.slice(5).replace(/^ /, "")); return; }
      if (line.charAt(0) === "{") { dataLines.push(line); await dispatch(); }
    }
    var streamOptions = Object.assign({}, options, {
      headers: Object.assign({}, options.headers || {}, { Accept: "text/event-stream" }),
      onChunk: async function (bytes) {
        buffer += decoder.decode(bytes, { stream: true });
        var lines = buffer.split(/\r?\n/); buffer = lines.pop() || "";
        for (var index = 0; index < lines.length; index += 1) await consume(lines[index]);
      }
    });
    var result = await requestByteStream(streamOptions);
    buffer += decoder.decode();
    if (buffer) await consume(buffer);
    await dispatch();
    result.streamed = received;
    return result;
  }

  async function requestNdjson(options) {
    if (typeof TextDecoder !== "function") throw streamUnavailable("当前 WebView 不支持 UTF-8 流解析");
    var decoder = new TextDecoder("utf-8"), buffer = "", received = false;
    async function consume(line) {
      if (!line.trim()) return;
      var data = utils.safeJsonParse(line, null);
      if (!data) throw new Error("服务返回了无效的流式 JSON");
      received = true; if (options.onEvent) await options.onEvent({ event: "message", data: line, json: data });
    }
    var result = await requestByteStream(Object.assign({}, options, {
      onChunk: async function (bytes) {
        buffer += decoder.decode(bytes, { stream: true });
        var lines = buffer.split(/\r?\n/); buffer = lines.pop() || "";
        for (var index = 0; index < lines.length; index += 1) await consume(lines[index]);
      }
    }));
    buffer += decoder.decode(); if (buffer) await consume(buffer);
    result.streamed = received; return result;
  }

  async function readText(result) {
    var bodyText = result && result.bodyText || "";
    var logicalFileId = result && result.file && result.file.logicalFileId;
    if (!bodyText && logicalFileId && app.platform.hermit.available()) {
      try {
        var stored = await app.platform.hermit.api().files.readText({ logicalFileId: logicalFileId, maxBytes: 8 * 1024 * 1024 });
        bodyText = stored.text || "";
      } finally {
        try { await app.platform.hermit.api().files.delete({ logicalFileId: logicalFileId }); } catch (_) {}
      }
    }
    return bodyText;
  }

  app.platform.network = {
    request: request,
    readText: readText,
    requestJson: requestJson,
    requestByteStream: requestByteStream,
    openWebSocket: openWebSocket,
    requestSse: requestSse,
    requestNdjson: requestNdjson,
    httpError: httpError
  };
})(window.chataxi);
