(function (app) {
  "use strict";

  function providerOf(profile) { return profile.provider || profile.family || ""; }
  function report(task, text) { if (task && typeof task.onMediaState === "function") task.onMediaState(text); }

  function supports(profile, kind) {
    var info = profile && profile.modelInfo || {};
    if (kind === "image") return info.imageInput === true;
    if (kind !== "video" || info.videoInput !== true) return false;
    return app.platform.hermit.available() && ["ark", "gemini", "kimi"].indexOf(providerOf(profile)) >= 0;
  }

  function header(headers, name) {
    var target = String(name || "").toLowerCase(), result = "";
    Object.keys(headers || {}).some(function (key) {
      if (key.toLowerCase() !== target) return false;
      result = headers[key]; return true;
    });
    return result;
  }

  function cacheKey(service, media) {
    var identity = service.connectionRevision || service.discoveredAt || "unverified";
    return [service.id, identity, media.sha256 || media.logicalFileId, "video"].join(":");
  }

  async function cached(service, media) {
    var result = await app.data.store.get("remote-media", cacheKey(service, media));
    if (!result || result.expiresAt && result.expiresAt < Date.now()) return null;
    return result;
  }

  async function saveCache(service, media, value) {
    var record = Object.assign({
      id: cacheKey(service, media),
      serviceId: service.id,
      connectionRevision: service.connectionRevision || "",
      sha256: media.sha256 || "",
      createdAt: Date.now(),
      expiresAt: Date.now() + 6 * 60 * 60 * 1000
    }, value);
    await app.data.store.put("remote-media", record.id, record);
    return record;
  }

  function assertLocalFile(media) {
    if (!media.logicalFileId) throw new Error("这段视频没有可上传的本地原文件，请重新选择");
    if (!app.platform.hermit.available()) throw new Error("视频上传需要在新版 HermitApp 中使用");
  }

  async function pollJson(url, headers, task, ready, failed) {
    var deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (task && task.cancelled) { var stopped = new Error("本轮已停止"); stopped.cancelled = true; throw stopped; }
      report(task, "视频已上传，正在等待模型服务处理…");
      var result = await app.platform.network.requestJson({ url: url, method: "GET", headers: headers, timeoutMs: 45000, task: task });
      if (ready(result.data)) return result.data;
      if (failed(result.data)) throw new Error("视频预处理失败：" + app.utils.cleanError(JSON.stringify(result.data)).slice(0, 240));
      await new Promise(function (resolve) { setTimeout(resolve, 1200); });
    }
    throw new Error("视频仍在服务端处理中，请稍后重试发送");
  }

  async function uploadArk(service, profile, media, task) {
    var endpoint = String(profile.endpoint || ""), base = endpoint.replace(/\/(?:responses|chat\/completions)\/?(?:\?.*)?$/, "");
    var headers = app.services.modelServices.authHeaders("llm", service);
    Object.assign(headers, app.utils.parseHeaders(service.customHeaders));
    var uploaded = await app.platform.network.requestJson({
      url: base + "/files",
      method: "POST",
      headers: headers,
      multipart: [
        { name: "purpose", text: "user_data" },
        { name: "preprocess_configs", text: JSON.stringify({ video: { fps: Number(service.videoFps || 1) } }) },
        { name: "file", logicalFileId: media.logicalFileId, filename: media.name || "video.mp4", contentType: media.mime || "video/mp4" }
      ],
      timeoutMs: 180000,
      task: task
    });
    var file = uploaded.data && (uploaded.data.data || uploaded.data.file || uploaded.data), id = file && file.id;
    if (!id) throw new Error("火山方舟没有返回视频文件 ID");
    if (file.status && file.status !== "active") {
      file = await pollJson(base + "/files/" + encodeURIComponent(id), headers, task, function (data) {
        var item = data.data || data.file || data; return item.status === "active";
      }, function (data) {
        var item = data.data || data.file || data; return item.status === "failed" || item.status === "error";
      });
      file = file.data || file.file || file;
    }
    return { fileId: id, status: file.status || "active", provider: "ark" };
  }

  async function uploadKimi(service, profile, media, task) {
    var base = String(profile.endpoint || "").replace(/\/chat\/completions\/?(?:\?.*)?$/, "");
    var headers = app.services.modelServices.authHeaders("llm", service);
    Object.assign(headers, app.utils.parseHeaders(service.customHeaders));
    var result = await app.platform.network.requestJson({
      url: base + "/files",
      method: "POST",
      headers: headers,
      multipart: [
        { name: "purpose", text: "video" },
        { name: "file", logicalFileId: media.logicalFileId, filename: media.name || "video.mp4", contentType: media.mime || "video/mp4" }
      ],
      timeoutMs: 180000,
      task: task
    });
    var file = result.data && (result.data.data || result.data.file || result.data), id = file && file.id;
    if (!id) throw new Error("Kimi 没有返回视频文件 ID");
    return { fileId: id, remoteUrl: "ms://" + id, status: file.status || "processed", provider: "kimi" };
  }

  async function uploadGemini(service, profile, media, task) {
    var headers = app.services.modelServices.authHeaders("llm", service);
    Object.assign(headers, app.utils.parseHeaders(service.customHeaders));
    var startHeaders = Object.assign({}, headers, {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(media.size || 0),
      "X-Goog-Upload-Header-Content-Type": media.mime || "video/mp4"
    });
    var started = await app.platform.network.request({
      url: "https://generativelanguage.googleapis.com/upload/v1beta/files",
      method: "POST",
      headers: startHeaders,
      bodyText: JSON.stringify({ file: { display_name: media.name || "video" } }),
      contentType: "application/json",
      timeoutMs: 60000,
      task: task
    });
    if (started.status < 200 || started.status >= 300) {
      var startText = await app.platform.network.readText(started);
      throw app.platform.network.httpError(started.status, app.utils.safeJsonParse(startText, null) || startText, startHeaders);
    }
    var uploadUrl = header(started.headers, "x-goog-upload-url");
    if (!uploadUrl) throw new Error("Gemini 没有返回可用的视频上传地址");
    var finalized = await app.platform.network.requestJson({
      url: uploadUrl,
      method: "POST",
      headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
      bodyLogicalFileId: media.logicalFileId,
      contentType: media.mime || "video/mp4",
      timeoutMs: 180000,
      task: task
    });
    var file = finalized.data.file || finalized.data, name = file.name, uri = file.uri;
    if (!name && !uri) throw new Error("Gemini 没有返回视频文件引用");
    if (name && (!file.state || file.state === "PROCESSING")) {
      file = await pollJson("https://generativelanguage.googleapis.com/v1beta/" + name.replace(/^\//, ""), headers, task, function (data) {
        var item = data.file || data; return !item.state || item.state === "ACTIVE";
      }, function (data) {
        var item = data.file || data; return item.state === "FAILED";
      });
      file = file.file || file; uri = file.uri || uri;
    }
    if (!uri) throw new Error("Gemini 视频处理完成但没有返回文件 URI");
    return { fileId: name || "", remoteUrl: uri, fileUri: uri, status: file.state || "ACTIVE", provider: "gemini" };
  }

  async function prepareVideo(service, profile, media, task) {
    assertLocalFile(media);
    var existing = await cached(service, media);
    if (existing) { report(task, "正在复用已处理的视频…"); return Object.assign({}, media, existing); }
    report(task, "正在上传视频到本轮角色的模型服务…");
    var provider = providerOf(profile), uploaded;
    if (provider === "ark") uploaded = await uploadArk(service, profile, media, task);
    else if (provider === "kimi") uploaded = await uploadKimi(service, profile, media, task);
    else if (provider === "gemini") uploaded = await uploadGemini(service, profile, media, task);
    else throw new Error("当前服务尚没有可验证的手机视频上传合同，请改用支持视频上传的 Gemini、Kimi 或火山方舟角色");
    var saved = await saveCache(service, media, uploaded);
    report(task, "视频处理完成，正在提交对话…");
    return Object.assign({}, media, saved);
  }

  async function hydrate(service, profile, media, settings, task) {
    var kind = media.kind || (/^video\//i.test(media.mime || "") ? "video" : "image");
    if (!supports(profile, kind)) {
      throw new Error(kind === "video" ? "所选角色的模型或当前接入方式不能接收视频" : "所选角色的模型没有确认图片输入能力");
    }
    if (kind === "video") return prepareVideo(service, profile, media, task);
    var dataUrl = media.dataUrl || (media.mediaId ? await app.data.media.toDataUrl(media.mediaId) : "");
    if (!dataUrl) throw new Error("这条消息的图片已不可用，请重新选择图片发送");
    return Object.assign({}, media, { kind: "image", dataUrl: dataUrl, detail: settings.imageDetail || "auto" });
  }

  app.services.mediaPrep = {
    supports: supports,
    hydrate: hydrate,
    prepareVideo: prepareVideo
  };
})(window.chataxi);
