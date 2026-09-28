(function (app) {
  "use strict";

  var active = null;
  var systemCache = null;
  async function systemCapability(refresh) {
    if (!refresh && systemCache && Date.now() - systemCache.at < 30000) return systemCache.value;
    var value;
    if (!(await app.platform.haminn.awaitReady(1200))) {
      value = { available: false, state: "unavailable", languages: [], languageSelectionSupported: false, message: "系统语音识别只在 HaminnApp 中可用" };
    } else {
      var api = app.platform.haminn.api(), availability = await api.speech.availability(), catalog = { languages: [], languageSelectionSupported: false };
      if (availability.available && typeof api.speech.languages === "function") {
        try { catalog = await api.speech.languages(); }
        catch (error) { catalog = { languages: [], languageSelectionSupported: false, message: app.utils.cleanError(error) }; }
      }
      value = Object.assign({}, availability, catalog, { languages: Array.isArray(catalog.languages) ? catalog.languages : [] });
    }
    systemCache = { at: Date.now(), value: value }; return value;
  }
  function cleanup(session) {
    clearTimeout(session.timer);
    session.off.splice(0).forEach(function (off) { off(); });
    if (active === session) active = null;
  }
  async function startSystem(profile, callbacks) {
    if (active) throw new Error("语音识别正在进行");
    var session = { off: [], id: null, ended: false }; active = session;
    var api;
    try {
      if (!(await app.platform.haminn.awaitReady(1200))) throw new Error("系统语音识别只在 HaminnApp 中可用");
      if (active !== session) throw new Error("语音识别已取消");
      api = app.platform.haminn.api();
      var capability = await systemCapability(false);
      if (!capability.available) throw new Error(capability.message || "系统没有可用的语音识别服务，可在设置中配置短音频识别");
      if (active !== session) throw new Error("语音识别已取消");
    } catch (error) { cleanup(session); throw error; }
    function finish(kind, data) {
      if (active !== session) return;
      if (callbacks && callbacks[kind]) callbacks[kind](data || {});
      if (kind === "final" || kind === "error") { session.ended = true; cleanup(session); }
    }
    ["ready", "begin", "rms", "partial", "final", "error", "end"].forEach(function (kind) {
      session.off.push(app.platform.haminn.on("speech." + kind, function (data) {
        if (session.id && data.subscriptionId && data.subscriptionId !== session.id) return;
        finish(kind, data);
        if (kind === "end" && active === session) {
          clearTimeout(session.timer);
          session.timer = setTimeout(function () { finish("error", { message: "没有收到识别结果，请重试" }); api.speech.cancel().catch(function () {}); }, 12000);
        }
      }));
    });
    session.timer = setTimeout(function () { finish("error", { message: "识别超时，请重试" }); api.speech.cancel().catch(function () {}); }, 90000);
    try {
      var language = capability.languageSelectionSupported && capability.languages.indexOf(profile.language) >= 0 ? profile.language : "";
      var params = { partial: true, maxResults: 3, onDevice: Boolean(profile.onDevice), rmsEvents: Boolean(callbacks && callbacks.rms) };
      if (language) params.language = language;
      var result = await api.speech.start(params);
      session.id = result.subscriptionId;
      if (active !== session && !session.ended) await api.speech.cancel();
      return result.subscriptionId;
    } catch (error) { cleanup(session); throw error; }
  }
  async function stopSystem(subscriptionId) {
    if (!app.platform.haminn.available()) return;
    await app.platform.haminn.api().speech.stop({ subscriptionId: subscriptionId || undefined });
  }
  async function cancelSystem() {
    if (active) cleanup(active);
    if (app.platform.haminn.available()) await app.platform.haminn.api().speech.cancel();
  }

  function multipart(fields, file) {
    var boundary = "----chataxi" + app.utils.id("boundary").replace(/[^A-Za-z0-9]/g, "");
    var encoder = new TextEncoder();
    var chunks = [];
    Object.keys(fields).forEach(function (name) {
      if (fields[name] == null || fields[name] === "") return;
      chunks.push(encoder.encode("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n" + fields[name] + "\r\n"));
    });
    chunks.push(encoder.encode("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + app.utils.fileSafeName(file.name) + "\"\r\nContent-Type: " + (file.type || "application/octet-stream") + "\r\n\r\n"));
    chunks.push(file.bytes);
    chunks.push(encoder.encode("\r\n--" + boundary + "--\r\n"));
    var length = chunks.reduce(function (total, chunk) { return total + chunk.length; }, 0);
    var output = new Uint8Array(length);
    var offset = 0;
    chunks.forEach(function (chunk) { output.set(chunk, offset); offset += chunk.length; });
    return { bytes: output, contentType: "multipart/form-data; boundary=" + boundary };
  }

  async function transcribeFile(file, profile) {
    if (!profile || profile.enabled === false) throw new Error("语音识别配置不存在或已停用");
    if (!file) throw new Error("请选择或录制一段音频");
    var canonical = app.services.middleware.canonicalTranscription(profile, { kind: file.logicalFileId ? "logical_file" : "blob", value: file.logicalFileId || "", mimeType: file.mime || file.type || "audio/mp4" });
    var headers = app.services.modelServices.authHeaders("asr", profile), modelField = profile.protocol === "elevenlabs-scribe" || profile.type === "elevenlabs-asr" ? "model_id" : "model";
    var extra = app.utils.parseHeaders(profile.customHeaders);
    Object.keys(extra || {}).forEach(function (key) { headers[key] = String(extra[key]); });
    if (file.logicalFileId) {
      var nativeResult = await app.platform.network.request({
        url: profile.endpoint,
        method: "POST",
        headers: headers,
        multipart: [
          { name: modelField, text: profile.model || "" },
          { name: "language", text: canonical.language || "" },
          { name: "response_format", text: "json" },
          { name: "file", logicalFileId: file.logicalFileId, filename: file.name || "recording.m4a", contentType: file.mime || "audio/mp4" }
        ],
        timeoutMs: 120000
      });
      var nativeText = await app.platform.network.readText(nativeResult), nativeData = app.utils.safeJsonParse(nativeText, null);
      if (nativeResult.status < 200 || nativeResult.status >= 300) throw app.platform.network.httpError(nativeResult.status, nativeData || nativeText, headers);
      var nativeTranscript = nativeData && (nativeData.text || nativeData.transcript || (nativeData.result && nativeData.result.text));
      if (!nativeTranscript) throw new Error("语音识别服务没有返回文本");
      return String(nativeTranscript);
    }
    if (file.size > 650 * 1024) throw new Error("浏览器模式下音频不能超过 650 KiB，请缩短录音");
    var bytes = new Uint8Array(await file.arrayBuffer());
    var fields = { language: canonical.language, response_format: "json" }; fields[modelField] = profile.model;
    var body = multipart(fields, { name: file.name || "recording.m4a", type: file.type, bytes: bytes });
    if (body.bytes.length > 900 * 1024) throw new Error("音频请求超过 900 KiB");
    var result = await app.platform.network.request({
      url: profile.endpoint,
      method: "POST",
      headers: headers,
      bodyBytes: body.bytes,
      contentType: body.contentType,
      timeoutMs: 120000
    });
    var bodyText = await app.platform.network.readText(result);
    var data = app.utils.safeJsonParse(bodyText, null);
    if (result.status < 200 || result.status >= 300) throw new Error("语音识别请求失败（" + result.status + "）");
    var text = data && (data.text || data.transcript || (data.result && data.result.text));
    if (!text) throw new Error("语音识别服务没有返回文本");
    return String(text);
  }

  app.services.asr = { systemCapability: systemCapability, startSystem: startSystem, stopSystem: stopSystem, cancelSystem: cancelSystem, multipart: multipart, transcribeFile: transcribeFile };
})(window.chataxi);
