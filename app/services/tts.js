(function (app) {
  "use strict";
  var generation = 0, current = null, ready = {}, muted = false, lastState = { speaking: false };
  var MAX_READY_ITEMS = 8, MAX_READY_PCM_BYTES = 24 * 1024 * 1024;
  var audioContext = null, playbackUnlocked = false;
  var backgrounded = typeof document !== "undefined" && Boolean(document.hidden);
  var pausedPlayback = null, backgroundResume = null, lifecycleQueue = Promise.resolve();

  function emit(detail) { lastState = Object.assign({}, detail || { speaking: false }, { muted: muted }); app.events.emit("tts:state", lastState); }
  function setMuted(value) {
    muted = Boolean(value);
    if (current && current.audio) current.audio.muted = muted;
    if (current && current.audioGain) current.audioGain.gain.value = muted ? 0 : 1;
    if (current && current.playbackId && app.platform.hermit.available()) {
      var audioApi = app.platform.hermit.api().audio;
      if (typeof audioApi.setPlaybackVolume === "function") audioApi.setPlaybackVolume({ playbackId: current.playbackId, volume: muted ? 0 : 1 }).catch(function () {});
    }
    emit(lastState); return muted;
  }

  function unlockPlayback() {
    var AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return false;
    try {
      if (audioContext && playbackUnlocked && audioContext.state === "running") return true;
      if (!audioContext || audioContext.state === "closed") audioContext = new AudioContext();
      if (audioContext.state !== "running" && typeof audioContext.resume === "function") {
        var resumed = audioContext.resume(); if (resumed && typeof resumed.catch === "function") resumed.catch(function () {});
      }
      var source = audioContext.createBufferSource();
      source.buffer = audioContext.createBuffer(1, 1, 22050); source.connect(audioContext.destination); source.start(0);
      playbackUnlocked = true; return true;
    } catch (_) { return false; }
  }

  function decodeAudio(blob) {
    return blob.arrayBuffer().then(function (bytes) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        function done(value) { if (!settled) { settled = true; resolve(value); } }
        function fail(error) { if (!settled) { settled = true; reject(error || new Error("音频解码失败")); } }
        try {
          var result = audioContext.decodeAudioData(bytes.slice(0), done, fail);
          if (result && typeof result.then === "function") result.then(done, fail);
        } catch (error) { fail(error); }
      });
    });
  }

  function headers(profile) {
    var result = { "Content-Type": "application/json" };
    var eleven = profile.protocol === "elevenlabs" || profile.type === "elevenlabs";
    var doubao = profile.protocol === "doubao-speech-v3" || profile.type === "doubao";
    if (profile.apiKey) {
      if (eleven) result["xi-api-key"] = profile.apiKey;
      else if (doubao) result["X-Api-Key"] = profile.apiKey;
      else result.Authorization = "Bearer " + profile.apiKey;
    }
    if (doubao) {
      result.Accept = "text/event-stream";
      result["X-Api-Resource-Id"] = profile.model || "seed-tts-2.0";
      result["X-Api-Request-Id"] = requestId();
    }
    if (profile.protocol === "qwen-tts") result["X-DashScope-SSE"] = "enable";
    if (profile.protocol === "azure-speech") {
      result["Content-Type"] = "application/ssml+xml";
      result["X-Microsoft-OutputFormat"] = "raw-24khz-16bit-mono-pcm";
      if (profile.apiKey) result["Ocp-Apim-Subscription-Key"] = profile.apiKey;
      delete result.Authorization;
    }
    Object.assign(result, app.utils.parseHeaders(profile.customHeaders));
    return result;
  }

  function requestId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (letter) {
      var value = Math.floor(Math.random() * 16); return (letter === "x" ? value : value & 3 | 8).toString(16);
    });
  }

  function cleanText(text) { return String(text || "").replace(/```[\s\S]*?```/g, "").trim(); }
  function xml(value) { return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  async function profileFor(role) {
    var settings = await app.data.store.get("meta", "settings");
    var service = await app.data.store.get("tts-profiles", role && role.ttsProfileId || settings.defaultTtsProfileId || "system-tts");
    if (!service || service.enabled === false) throw new Error("朗读服务不存在或已停用，请在模型页选择可用服务");
    return { settings: settings, profile: app.services.modelServices.resolveTts(service, role || {}, settings), service: service };
  }

  function requestBody(profile, text, formatOverride) {
    var canonical = app.services.middleware.canonicalSpeech(profile, text);
    text = canonical.input;
    if (profile.protocol === "elevenlabs" || profile.type === "elevenlabs") {
      var elevenBody = { text: text, model_id: profile.model || "eleven_multilingual_v2" };
      return elevenBody;
    }
    if (profile.protocol === "doubao-speech-v3" || profile.type === "doubao") return {
      user: { uid: "chataxi" },
      req_params: {
        text: text,
        speaker: profile.voice,
        sample_rate: Number(profile.sampleRate || 24000),
        audio_params: {
          format: formatOverride || profile.format || "mp3",
          speech_rate: Math.max(-50, Math.min(100, Number(profile.speechRate || 0))),
          loudness_rate: Math.max(-50, Math.min(100, Number(profile.loudnessRate || 0))),
          bit_rate: 64000
        },
        additions: JSON.stringify({ post_process: { pitch: Math.max(-12, Math.min(12, Number(profile.pitchRate || 0))) }, disable_markdown_filter: true, enable_latex_tn: false })
      }
    };
    if (profile.protocol === "xai-tts") return {
      text: text, voice_id: profile.voice, language: profile.language || "auto",
      output_format: { codec: formatOverride === "pcm" ? "pcm_s16le" : formatOverride || profile.format || "mp3", sample_rate: Number(profile.sampleRate || 24000) },
      speed: Number(profile.rate || 1)
    };
    if (profile.protocol === "qwen-tts") return {
      model: profile.model,
      input: { text: text, voice: profile.voice, language_type: profile.language || "Auto" },
      parameters: { format: formatOverride || profile.format || "pcm", sample_rate: Number(profile.sampleRate || 24000) }
    };
    if (profile.protocol === "minimax-tts") return {
      model: profile.model, text: text, stream: formatOverride === "pcm",
      voice_setting: { voice_id: profile.voice, speed: Number(profile.rate || 1), vol: Math.max(0.1, 1 + Number(profile.loudnessRate || 0) / 100), pitch: Number(profile.pitchRate || 0) },
      audio_setting: { sample_rate: Number(profile.sampleRate || 24000), bitrate: 128000, format: formatOverride || profile.format || "mp3", channel: 1 }
    };
    if (profile.protocol === "gemini-tts") return {
      model: profile.model, input: text, stream: formatOverride === "pcm",
      response_format: { type: "audio" },
      generation_config: { speech_config: { voice_config: { prebuilt_voice_config: { voice_name: profile.voice } } } }
    };
    if (profile.protocol === "aws-polly") return {
      Engine: profile.model || "neural", LanguageCode: profile.language || undefined,
      OutputFormat: formatOverride || profile.format || "pcm", SampleRate: String(Number(profile.sampleRate || 24000)),
      Text: text, TextType: "text", VoiceId: profile.voice
    };
    if (profile.protocol === "fish-tts") return { text: text, reference_id: profile.voice || undefined, format: formatOverride || profile.format || "pcm", streaming: true };
    var body = { model: profile.model, input: text, voice: canonical.voiceId, response_format: formatOverride || canonical.responseFormat || "mp3" };
    if (profile.protocol === "vllm-omni") body.stream = true;
    if (profile.family === "siliconflow-tts") body.stream = true;
    if (canonical.instructions) body.instructions = canonical.instructions;
    return body;
  }

  function endpoint(profile, stream) {
    var value = String(stream ? profile.streamEndpoint || profile.endpoint : profile.endpoint || "");
    return value.replace(/\{voice\}/g, encodeURIComponent(profile.voice || ""));
  }

  function pcmStreamProfile(profile) {
    var eleven = profile.protocol === "elevenlabs" || profile.type === "elevenlabs";
    var doubao = profile.protocol === "doubao-speech-v3" || profile.type === "doubao";
    var openai = profile.protocol === "openai-speech" || profile.type === "openai";
    if (eleven) return { kind: "raw", format: "pcm_24000", sampleRate: 24000 };
    if (doubao) return { kind: "sse", format: "pcm", sampleRate: Number(profile.sampleRate || 24000) };
    if (openai) return { kind: "raw", format: "pcm", sampleRate: 24000 };
    if (profile.protocol === "xai-tts" || profile.protocol === "azure-speech" || profile.protocol === "aws-polly" || profile.protocol === "vllm-omni" || profile.protocol === "fish-tts") return { kind: "raw", format: "pcm", sampleRate: Number(profile.sampleRate || 24000) };
    if (profile.protocol === "qwen-tts" || profile.protocol === "minimax-tts" || profile.protocol === "gemini-tts") return { kind: "sse", format: "pcm", sampleRate: Number(profile.sampleRate || 24000) };
    return null;
  }

  function pcmStreamUrl(profile, config) {
    var value = endpoint(profile, true);
    if (profile.protocol === "elevenlabs" || profile.type === "elevenlabs") value += (value.indexOf("?") >= 0 ? "&" : "?") + "output_format=" + encodeURIComponent(config.format);
    return value;
  }

  function signedHeaders(profile, requestHeaders, method, url, bodyText, contentType) {
    if (profile.protocol !== "aws-polly") return requestHeaders;
    return Object.assign({}, requestHeaders, app.services.awsSigV4.sign({
      method: method, url: url, body: bodyText, contentType: contentType,
      region: profile.region, service: "polly", accessKeyId: profile.accessKeyId,
      secretAccessKey: profile.apiKey, sessionToken: profile.sessionToken || ""
    }));
  }

  function audioPayload(data, protocol) {
    if (!data || typeof data !== "object") return null;
    if (data.error || data.base_resp && Number(data.base_resp.status_code || 0) !== 0) {
      var detail = data.error && (data.error.message || data.error) || data.base_resp && (data.base_resp.status_msg || data.base_resp.status_code) || "语音服务返回业务错误";
      throw new Error(app.utils.cleanError(String(detail)));
    }
    if (protocol === "minimax-tts") return data.data && data.data.audio || data.audio || null;
    if (protocol === "qwen-tts") return data.output && data.output.audio && (data.output.audio.data || data.output.audio.audio) || data.audio && data.audio.data || null;
    if (protocol === "gemini-tts") {
      var parts = data.content && data.content.parts || data.outputs && data.outputs[0] && data.outputs[0].content || data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts || [];
      for (var i = 0; i < parts.length; i += 1) { var inline = parts[i].inlineData || parts[i].inline_data || parts[i].audio; if (inline && inline.data && /^audio\//i.test(inline.mimeType || inline.mime_type || "audio/pcm")) return inline.data; }
      return data.audio && (data.audio.data || data.audio) || null;
    }
    return data.data || data.audio || null;
  }

  async function readByteStream(options) {
    if (app.platform.network && app.platform.network.requestByteStream) return app.platform.network.requestByteStream(options);
    if (typeof fetch !== "function") throw streamUnavailable("当前环境没有可用的流式网络接口");
    var controller = typeof AbortController === "function" ? new AbortController() : null; if (options.task) options.task.controller = controller;
    var response = await fetch(options.url, { method: options.method, headers: options.headers, body: options.bodyText, signal: controller && controller.signal });
    if (response.status < 200 || response.status >= 300) throw responseError(response.status, await response.text());
    var reader = response.body && response.body.getReader && response.body.getReader(); if (!reader) throw streamUnavailable("当前 WebView 只能读取完整音频响应");
    while (true) { var part = await reader.read(); if (part.done) break; if (part.value && part.value.length) await options.onChunk(part.value); }
    return { status: response.status };
  }

  function streamUnavailable(message, cause) {
    var error = new Error(message); error.streamUnavailable = true; error.cause = cause; return error;
  }

  function base64Bytes(value) {
    var binary = atob(String(value || "").replace(/\s/g, "")), bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function streamPcm(text, profile, task, onAudio) {
    var config = pcmStreamProfile(profile);
    if (!config) throw streamUnavailable("当前环境没有可用的流式音频通道");
    var url = pcmStreamUrl(profile, config), body = requestBody(profile, text, config.format);
    var bodyText = profile.protocol === "azure-speech" ? '<speak version="1.0" xml:lang="' + xml(profile.language || "zh-CN") + '"><voice name="' + xml(profile.voice) + '">' + xml(text) + '</voice></speak>' : JSON.stringify(body);
    var contentType = profile.protocol === "azure-speech" ? "application/ssml+xml" : "application/json";
    var requestHeaders = signedHeaders(profile, headers(profile), "POST", url, bodyText, contentType), received = false;
    var decoder = config.kind === "sse" ? new TextDecoder("utf-8") : null, buffer = "";
    async function consume(line) {
      if (line.indexOf("data:") !== 0 && line.charAt(0) !== "{") return;
      var raw = line.indexOf("data:") === 0 ? line.slice(5).trim() : line.trim(); if (!raw || raw === "[DONE]") return;
      var event = app.utils.safeJsonParse(raw, null); if (!event) return;
      if (profile.protocol === "doubao-speech-v3") {
        var code = Number(event.code || 0);
        if (code !== 0 && code !== 20000000) throw new Error("豆包语音返回错误（" + code + "）" + (event.message ? "：" + app.utils.cleanError(event.message) : ""));
      }
      var payload = audioPayload(event, profile.protocol), bytes = null;
      if (payload) bytes = profile.protocol === "minimax-tts" ? hexBytes(payload) : base64Bytes(payload);
      if (bytes && bytes.length) { received = true; onAudio(bytes, config.sampleRate); }
    }
    try {
      await readByteStream({
        url: url, method: "POST", headers: requestHeaders, bodyText: bodyText, contentType: contentType, timeoutMs: 120000, task: task,
        onChunk: async function (bytes) {
          if (config.kind === "raw") { if (bytes.length) { received = true; onAudio(bytes, config.sampleRate); } return; }
          buffer += decoder.decode(bytes, { stream: true }); var lines = buffer.split(/\r?\n/); buffer = lines.pop() || "";
          for (var lineIndex = 0; lineIndex < lines.length; lineIndex += 1) await consume(lines[lineIndex]);
        }
      });
      if (decoder) { buffer += decoder.decode(); if (buffer) await consume(buffer); }
    } catch (error) {
      if (task && task.cancelled) { error.cancelled = true; throw error; }
      if (error.streamUnavailable) throw error;
      throw error;
    }
    if (!received) throw new Error("朗读服务没有返回流式音频数据");
    return true;
  }

  function hexBytes(value) {
    var text = String(value || "").replace(/\s/g, ""); if (!/^[0-9a-f]*$/i.test(text) || text.length % 2) throw new Error("语音服务返回了无效的十六进制音频");
    var bytes = new Uint8Array(text.length / 2); for (var i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16); return bytes;
  }

  async function disposeClip(clip) {
    if (!clip) return;
    if (clip.url) { URL.revokeObjectURL(clip.url); clip.url = ""; }
    if (clip.logicalFileId && app.platform.hermit.available()) await app.platform.hermit.api().files.delete({ logicalFileId: clip.logicalFileId }).catch(function () {});
    clip.logicalFileId = ""; clip.blob = null;
  }

  async function disposeReady(item) {
    if (!item) return;
    if (item.clip) await disposeClip(item.clip);
    item.pcmChunks = [];
  }

  async function pruneReady() {
    var ids = Object.keys(ready).sort(function (left, right) { return ready[left].createdAt - ready[right].createdAt; });
    var bytes = ids.reduce(function (sum, id) { return sum + Number(ready[id].pcmBytes || 0); }, 0);
    while (ids.length > MAX_READY_ITEMS || bytes > MAX_READY_PCM_BYTES) {
      var oldest = ids.shift(), item = ready[oldest];
      bytes -= Number(item && item.pcmBytes || 0); delete ready[oldest]; await disposeReady(item);
    }
  }

  async function rememberPcm(owner) {
    if (!owner || !owner.messageId || owner.cacheOverflow || !owner.pcmCache || !owner.pcmCache.length) return false;
    var previous = ready[owner.messageId];
    ready[owner.messageId] = {
      pcmChunks: owner.pcmCache,
      pcmBytes: owner.pcmCacheBytes,
      sampleRate: owner.pcmSampleRate || 24000,
      roleId: owner.role && owner.role.id || "",
      createdAt: Date.now()
    };
    if (previous) await disposeReady(previous);
    owner.pcmCache = [];
    await pruneReady();
    emit({ speaking: false, ready: true, messageId: owner.messageId });
    return true;
  }

  async function invalidate(messageId) {
    var item = ready[messageId]; if (!item) return false;
    delete ready[messageId]; await disposeReady(item); return true;
  }

  async function invalidateMany(messageIds) {
    var ids = Array.isArray(messageIds) ? messageIds : [];
    for (var index = 0; index < ids.length; index += 1) await invalidate(ids[index]);
  }

  async function invalidateRole(roleId) {
    var ids = Object.keys(ready).filter(function (id) { return ready[id].roleId === roleId; });
    await invalidateMany(ids);
  }

  async function invalidateAll() { await invalidateMany(Object.keys(ready)); }

  async function synthesize(text, profile, task, stream) {
    var url = endpoint(profile, stream), body = requestBody(profile, text), contentType = profile.protocol === "azure-speech" ? "application/ssml+xml" : "application/json";
    var bodyText = profile.protocol === "azure-speech" ? '<speak version="1.0" xml:lang="' + xml(profile.language || "zh-CN") + '"><voice name="' + xml(profile.voice) + '">' + xml(text) + '</voice></speak>' : JSON.stringify(body);
    var response = await app.platform.network.request({ url: url, method: "POST", headers: signedHeaders(profile, headers(profile), "POST", url, bodyText, contentType), bodyText: bodyText, contentType: contentType, timeoutMs: 90000, task: task });
    if (task.cancelled) { if (response.file && response.file.logicalFileId && app.platform.hermit.available()) await app.platform.hermit.api().files.delete({ logicalFileId: response.file.logicalFileId }).catch(function () {}); return null; }
    var sseProtocol = ["doubao-speech-v3", "qwen-tts", "minimax-tts", "gemini-tts"].indexOf(profile.protocol) >= 0;
    if (sseProtocol) {
      var sseText = await app.platform.network.readText(response);
      if (response.status < 200 || response.status >= 300) throw responseError(response.status, sseText);
      var audio = parseSpeechPayload(sseText, profile, profile.format || "mp3");
      if (!audio || !audio.size) throw new Error("朗读服务没有返回可播放音频");
      return { blob: audio, mime: audio.type, seconds: estimateSeconds(text) };
    }
    if (response.status < 200 || response.status >= 300) { var failedText = await app.platform.network.readText(response); throw responseError(response.status, failedText); }
    if (response.file && response.file.logicalFileId) return { logicalFileId: response.file.logicalFileId, seconds: estimateSeconds(text) };
    if (!response.bodyBase64) throw new Error("语音服务没有返回可播放音频");
    var mime = response.headers && (response.headers["content-type"] || response.headers["Content-Type"]) || "audio/mpeg";
    return { blob: app.utils.base64ToBlob(response.bodyBase64, mime), mime: mime, seconds: estimateSeconds(text) };
  }

  function responseError(status, bodyText) {
    var payload = app.utils.safeJsonParse(bodyText, null), detail = payload && (payload.error || payload.detail || payload.message || payload);
    var message = detail && typeof detail === "object" ? detail.message || detail.status || detail.code : detail;
    var category = status === 401 ? "朗读服务认证失败" : status === 403 ? "朗读服务权限不足" : status === 429 ? "朗读服务额度或频率限制" : "朗读服务请求失败";
    return new Error(category + "（" + status + "）" + (message ? "：" + app.utils.cleanError(String(message)) : ""));
  }

  function parseDoubaoSse(text, format) {
    var chunks = [], lines = String(text || "").split(/\r?\n/);
    lines.forEach(function (line) {
      if (line.indexOf("data:") !== 0) return;
      var event = app.utils.safeJsonParse(line.slice(5).trim(), null); if (!event) return;
      var code = Number(event.code || 0);
      if (code !== 0 && code !== 20000000) throw new Error("豆包语音返回错误（" + code + "）" + (event.message ? "：" + app.utils.cleanError(event.message) : ""));
      if (!event.data) return;
      chunks.push(base64Bytes(event.data));
    });
    return chunks.length ? new Blob(chunks, { type: format === "ogg_opus" ? "audio/ogg" : format === "pcm" ? "audio/pcm" : "audio/mpeg" }) : null;
  }

  function parseSpeechPayload(text, profile, format) {
    if (profile.protocol === "doubao-speech-v3") return parseDoubaoSse(text, format);
    var chunks = [], lines = String(text || "").split(/\r?\n/), protocol = profile.protocol;
    lines.forEach(function (line) {
      var raw = line.indexOf("data:") === 0 ? line.slice(5).trim() : line.trim(); if (!raw || raw === "[DONE]") return;
      var event = app.utils.safeJsonParse(raw, null); if (!event) return;
      var payload = audioPayload(event, protocol); if (!payload) return;
      chunks.push(protocol === "minimax-tts" ? hexBytes(payload) : base64Bytes(payload));
    });
    return chunks.length ? new Blob(chunks, { type: format === "wav" ? "audio/wav" : format === "pcm" ? "audio/pcm" : format.indexOf("ogg") >= 0 ? "audio/ogg" : "audio/mpeg" }) : null;
  }

  function estimateSeconds(text) {
    var value = String(text || ""), cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
    var other = value.replace(/[\u3400-\u9fff\s.,!?;:'"，。！？；：、“”‘’（）()\[\]{}<>《》—…-]/g, "").length;
    return Math.max(0.6, cjk / 4.2 + other / 12);
  }

  function attachPcmPlayer(owner, token, options) {
    owner.pcmQueue = []; owner.pcmSources = []; owner.pcmRemainder = null; owner.bufferedSeconds = 0; owner.started = false; owner.starved = false; owner.finished = false; owner.pcmActive = 0; owner.pcmNextTime = 0;
    owner.pcmCache = []; owner.pcmCacheBytes = 0; owner.pcmSampleRate = 0; owner.cacheOverflow = false;
    var resolveDone, rejectDone;
    owner.pcmDone = new Promise(function (resolve, reject) { resolveDone = resolve; rejectDone = reject; });
    owner.pcmDone.catch(function () {});
    owner.pcmResolve = resolveDone; owner.pcmReject = rejectDone;
    if (!audioContext || !playbackUnlocked) throw streamUnavailable("请先触摸页面以启用流式音频播放");
    owner.audioGain = audioContext.createGain(); owner.audioGain.gain.value = muted ? 0 : 1; owner.audioGain.connect(audioContext.destination);

    function settle(error) {
      if (!owner.pcmResolve && !owner.pcmReject) return;
      var resolve = owner.pcmResolve, reject = owner.pcmReject; owner.pcmResolve = null; owner.pcmReject = null;
      error ? reject(error) : resolve();
    }
    function maybeDone() {
      if (owner.cancelled) { settle(); return; }
      if (owner.finished && owner.pcmActive === 0 && !owner.pcmQueue.length) { owner.starved = false; settle(); return; }
      if (owner.started && !owner.finished && owner.pcmActive === 0 && !owner.pcmQueue.length) { owner.starved = true; emit({ speaking: false, paused: true, messageId: owner.messageId }); }
    }
    function schedule(entry) {
      var samples = entry.samples, buffer = audioContext.createBuffer(1, samples.length, entry.sampleRate), channel = buffer.getChannelData(0);
      channel.set(samples);
      var source = audioContext.createBufferSource(); source.buffer = buffer; source.connect(owner.audioGain);
      var when = Math.max(owner.pcmNextTime || 0, audioContext.currentTime + 0.035); owner.pcmNextTime = when + samples.length / entry.sampleRate; owner.pcmActive += 1; owner.pcmSources.push(source);
      source.onended = function () { owner.pcmSources = owner.pcmSources.filter(function (item) { return item !== source; }); owner.pcmActive = Math.max(0, owner.pcmActive - 1); maybeDone(); };
      source.start(when);
    }
    function startQueue() {
      if (backgrounded || owner.cancelled || token !== generation || owner.started && !owner.starved) return;
      owner.started = true; owner.starved = false; emit({ speaking: true, messageId: owner.messageId });
      while (owner.pcmQueue.length) schedule(owner.pcmQueue.shift());
    }
    function push(bytes, sampleRate) {
      if (owner.cancelled || token !== generation || !bytes || !bytes.length) return;
      var input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), merged;
      if (owner.pcmRemainder != null) { merged = new Uint8Array(input.length + 1); merged[0] = owner.pcmRemainder; merged.set(input, 1); input = merged; owner.pcmRemainder = null; }
      if (input.length % 2) { owner.pcmRemainder = input[input.length - 1]; input = input.slice(0, -1); }
      if (!input.length) return;
      if (options.cache !== false && !owner.cacheOverflow) {
        if (owner.pcmCacheBytes + input.byteLength <= MAX_READY_PCM_BYTES) {
          owner.pcmCache.push(input.slice()); owner.pcmCacheBytes += input.byteLength; owner.pcmSampleRate = sampleRate;
        } else { owner.pcmCache = []; owner.pcmCacheBytes = 0; owner.cacheOverflow = true; }
      }
      var view = new DataView(input.buffer, input.byteOffset, input.byteLength), samples = new Float32Array(input.byteLength / 2);
      for (var index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
      var entry = { samples: samples, sampleRate: sampleRate }, seconds = samples.length / sampleRate; owner.bufferedSeconds += seconds;
      if (owner.started && !owner.starved) schedule(entry); else owner.pcmQueue.push(entry);
      emit({ speaking: owner.started && !owner.starved, buffering: !owner.started, paused: owner.starved, messageId: owner.messageId, bufferedSeconds: owner.bufferedSeconds });
      if (options.autoPlay !== false && !owner.started && owner.bufferedSeconds >= Number(options.minBufferSeconds == null ? 3 : options.minBufferSeconds)) startQueue();
    }
    function finish() { owner.finished = true; owner.pcmRemainder = null; if (options.autoPlay !== false && !owner.started) startQueue(); maybeDone(); return owner.pcmDone; }
    function resumePcm() { if (!owner.starved || !owner.pcmQueue.length) return false; startQueue(); return true; }
    owner.pushPcm = push; owner.finishPcm = finish; owner.resume = resumePcm; owner.startPcm = startQueue; owner.failPcm = function (error) { settle(error); };
    return owner;
  }

  function playClip(clip, owner, token) {
    return new Promise(async function (resolve, reject) {
      function releaseClip() { return owner.preserveActiveClip ? Promise.resolve() : disposeClip(clip); }
      if (token !== generation || owner.cancelled) { await releaseClip(); resolve(); return; }
      owner.activeClip = clip; owner.playbackResolve = resolve;
      if (clip.logicalFileId && app.platform.hermit.available()) {
        var finished = false, offs = [];
        function done(error) { if (finished) return; finished = true; offs.splice(0).forEach(function (off) { off(); }); owner.playbackId = null; owner.activeClip = null; owner.playbackResolve = null; releaseClip().then(function () { error ? reject(error) : resolve(); }); }
        offs.push(app.platform.hermit.on("audio.playback.done", function (data) { if (!owner.playbackId || data.playbackId === owner.playbackId) done(); }));
        offs.push(app.platform.hermit.on("audio.playback.error", function (data) { if (!owner.playbackId || data.playbackId === owner.playbackId) done(new Error("音频播放失败")); }));
        try { var playback = await app.platform.hermit.api().audio.play({ logicalFileId: clip.logicalFileId, volume: muted ? 0 : 1 }); if (owner.cancelled || token !== generation) { await app.platform.hermit.api().audio.stopPlayback({ playbackId: playback.playbackId }).catch(function () {}); done(); return; } owner.playbackId = playback.playbackId; }
        catch (error) { done(error); }
        return;
      }
      if (clip.blob && playbackUnlocked && audioContext) {
        try {
          if (audioContext.state !== "running" && typeof audioContext.resume === "function") await audioContext.resume();
          var decoded = await decodeAudio(clip.blob);
          if (token !== generation || owner.cancelled) { await releaseClip(); resolve(); return; }
          var source = audioContext.createBufferSource(), gain = audioContext.createGain();
          source.buffer = decoded; gain.gain.value = muted ? 0 : 1; source.connect(gain); gain.connect(audioContext.destination);
          owner.audioSource = source; owner.audioGain = gain;
          source.onended = function () { owner.audioSource = null; owner.audioGain = null; owner.activeClip = null; owner.playbackResolve = null; releaseClip().then(resolve); };
          source.start(0); return;
        } catch (_) { owner.audioSource = null; owner.audioGain = null; }
      }
      if (!clip.url && clip.blob) clip.url = URL.createObjectURL(clip.blob);
      if (!clip.url || typeof Audio !== "function") { await disposeClip(clip); reject(new Error("当前环境不能播放语音")); return; }
      var audio = new Audio(clip.url); audio.muted = muted; owner.audio = audio;
      audio.onended = function () { owner.audio = null; owner.activeClip = null; owner.playbackResolve = null; releaseClip().then(resolve); };
      audio.onerror = function () { owner.audio = null; owner.activeClip = null; owner.playbackResolve = null; releaseClip().then(function () { reject(new Error("音频无法播放，请检查服务输出格式")); }); };
      try {
        await audio.play();
        if (token !== generation || owner.cancelled) { audio.pause(); owner.audio = null; await releaseClip(); resolve(); }
      } catch (error) { owner.audio = null; await releaseClip(); reject(/gesture|notallowed/i.test(String(error && (error.message || error))) ? new Error("当前 WebView 阻止了网页音频播放，请触摸页面后重试") : error); }
    });
  }

  async function stopOwner(owner) {
    if (!owner) return;
    owner.cancelled = true;
    if (owner.task) { owner.task.cancelled = true; if (owner.task.controller) owner.task.controller.abort(); }
    (owner.offs || []).forEach(function (off) { off(); }); owner.offs = [];
    if (owner.audio) { owner.audio.onended = null; owner.audio.onerror = null; owner.audio.pause(); owner.audio = null; }
    if (owner.audioSource) { owner.audioSource.onended = null; try { owner.audioSource.stop(0); } catch (_) {} owner.audioSource = null; }
    while (owner.pcmSources && owner.pcmSources.length) { var source = owner.pcmSources.shift(); source.onended = null; try { source.stop(0); } catch (_) {} }
    owner.pcmQueue = []; owner.pcmActive = 0; if (owner.pcmResolve) { owner.pcmResolve(); owner.pcmResolve = null; owner.pcmReject = null; }
    if (owner.socketTimer) { clearTimeout(owner.socketTimer); owner.socketTimer = null; }
    if (owner.socketSession) { await owner.socketSession.close("Cancelled").catch(function () {}); owner.socketSession = null; }
    if (owner.socket) { owner.socket.onopen = null; owner.socket.onmessage = null; owner.socket.onerror = null; owner.socket.onclose = null; try { owner.socket.close(); } catch (_) {} owner.socket = null; }
    if (owner.audioGain && typeof owner.audioGain.disconnect === "function") { try { owner.audioGain.disconnect(); } catch (_) {} }
    owner.audioGain = null;
    if (owner.playbackId && app.platform.hermit.available()) await app.platform.hermit.api().audio.stopPlayback({ playbackId: owner.playbackId }).catch(function () {});
    owner.playbackId = null;
    if (owner.activeClip && !owner.preserveActiveClip) await disposeClip(owner.activeClip); owner.activeClip = null;
    if (owner.playbackResolve) owner.playbackResolve(); owner.playbackResolve = null;
    while (owner.clips && owner.clips.length) await disposeClip(owner.clips.shift());
    if (owner.utteranceId && app.platform.hermit.available()) await app.platform.hermit.api().tts.stop().catch(function () {});
  }

  async function stop(options) {
    options = options || {};
    generation += 1;
    var owner = current; current = null;
    if (!options.background) { pausedPlayback = null; backgroundResume = null; }
    await stopOwner(owner);
    emit({ speaking: false });
  }

  async function speakSystem(text, profile, settings, owner, token) {
    if (!(await app.platform.hermit.awaitReady(1000))) throw new Error("系统朗读需要在 HermitApp 中使用");
    var api = app.platform.hermit.api(), catalog = await api.tts.voices();
    if (token !== generation) return;
    owner.offs = ["tts.done", "tts.error"].map(function (event) { return app.platform.hermit.on(event, function (data) {
      if (token !== generation || owner.utteranceId && data.utteranceId !== owner.utteranceId) return;
      if (event === "tts.error") app.events.emit("tts:error", { message: "系统朗读失败，请检查系统语音服务" });
      stop();
    }); });
    var languages = Array.isArray(catalog.languages) ? catalog.languages : [], voices = Array.isArray(catalog.voices) ? catalog.voices : [];
    var language = languages.indexOf(profile.language) >= 0 ? profile.language : undefined;
    var voiceId = voices.some(function (voice) { return voice.id === profile.voice; }) ? profile.voice : undefined;
    var result = await api.tts.speak({ text: text, language: language, voiceId: voiceId, rate: Number(profile.rate || 1), pitch: Number(profile.pitch || 1) });
    if (token !== generation) { await api.tts.stop(); return; }
    owner.utteranceId = result.utteranceId;
  }

  async function speak(text, role) {
    var clean = cleanText(text); if (!clean) return;
    if (backgrounded) {
      await stop(); backgroundResume = { kind: "speak", text: clean, role: role };
      emit({ speaking: false, suspended: true }); return;
    }
    await stop();
    var token = ++generation, owner = { cancelled: false, task: { cancelled: false }, clips: [], resumeRequest: { kind: "speak", text: clean, role: role } }; current = owner;
    var resolved = await profileFor(role);
    if (token !== generation) return;
    emit({ speaking: true });
    try {
      if (resolved.profile.type === "system") { await speakSystem(clean, resolved.profile, resolved.settings, owner, token); return; }
      var capabilities = app.services.modelServices.ttsCapabilities(resolved.service, resolved.profile.model);
      if (capabilities.audioStreaming && pcmStreamProfile(resolved.profile) && playbackUnlocked && audioContext) {
        try {
          owner.messageId = ""; attachPcmPlayer(owner, token, { autoPlay: true, minBufferSeconds: 3 });
          await streamPcm(clean, resolved.profile, owner.task, function (bytes, sampleRate) { owner.streamReceived = true; owner.pushPcm(bytes, sampleRate); });
          await owner.finishPcm(); if (token === generation) await stop(); return;
        } catch (streamError) {
          var recoverable = streamError.streamUnavailable || streamError.code === "E_NETWORK" && streamError.retryable === true;
          if (!recoverable || owner.started) throw streamError;
          await stopOwner(owner); token = ++generation; owner = { cancelled: false, task: { cancelled: false }, clips: [], resumeRequest: { kind: "speak", text: clean, role: role } }; current = owner; emit({ speaking: true });
        }
      }
      var clip = await synthesize(clean, resolved.profile, owner.task, false); if (!clip || token !== generation) return;
      await playClip(clip, owner, token); if (token === generation) await stop();
    } catch (error) { if (token === generation) { await stop(); throw error; } }
  }

  async function prepare(text, role, messageId) {
    var clean = cleanText(text); if (!clean || !messageId) return false;
    var resolved = await profileFor(role);
    if (resolved.profile.type === "system") return false;
    await stop(); var token = ++generation, owner = { cancelled: false, task: { cancelled: false }, clips: [], messageId: messageId }; current = owner;
    emit({ speaking: false, preparing: true, messageId: messageId });
    var clip;
    try { clip = await synthesize(clean, resolved.profile, owner.task, false); }
    catch (error) { if (current === owner) current = null; emit({ speaking: false, messageId: messageId }); throw error; }
    if (!clip || owner.cancelled || token !== generation) { await disposeClip(clip); return false; }
    if (ready[messageId]) await disposeReady(ready[messageId]);
    ready[messageId] = { clip: clip, role: role, createdAt: Date.now() };
    await pruneReady();
    current = null;
    emit({ speaking: false, ready: true, messageId: messageId }); return true;
  }

  async function testService(service) {
    var settings = await app.data.store.get("meta", "settings");
    var candidates = app.services.modelServices.models("tts", service), selected = candidates.find(function (item) { return item.id === service.defaultModelId; }) || candidates[0];
    var model = selected && selected.id || service.defaultModelId || service.model || "";
    var availableVoices = app.services.modelServices.voices(service, model);
    var voice = (availableVoices.find(function (item) { return item.id === service.defaultVoiceId; }) || availableVoices[0] || {}).id || service.defaultVoiceId || service.voice || "";
    var profile = app.services.modelServices.resolveTts(service, { ttsModel: model, ttsVoice: voice }, settings);
    if (!profile.model || profile.type !== "system" && !profile.voice && profile.protocol !== "fish-tts") throw new Error("服务缺少可测试的模型或音色");
    var task = { cancelled: false }, clip = await synthesize("你好", profile, task, false); await disposeClip(clip); return { modelId: model, voiceId: voice };
  }

  async function playReady(messageId) {
    var item = ready[messageId]; if (!item) return false;
    if (backgrounded) { backgroundResume = { kind: "ready", messageId: messageId }; emit({ speaking: false, suspended: true, messageId: messageId }); return true; }
    if (item.clip) delete ready[messageId];
    await stop();
    var token = ++generation, owner = { cancelled: false, task: { cancelled: false }, clips: [], messageId: messageId, resumeRequest: { kind: "ready", messageId: messageId, item: item } }; current = owner; emit({ speaking: true, messageId: messageId });
    try {
      if (item.pcmChunks && item.pcmChunks.length) {
        owner.messageId = messageId; attachPcmPlayer(owner, token, { autoPlay: true, minBufferSeconds: 0, cache: false });
        item.pcmChunks.forEach(function (chunk) { owner.pushPcm(chunk, item.sampleRate || 24000); });
        owner.finished = true; await owner.finishPcm();
      } else await playClip(item.clip, owner, token);
      if (token === generation) await stop(); return true;
    }
    catch (error) { if (token === generation) await stop(); throw error; }
  }

  function takeSpeechSegments(owner, flush) {
    var limit = Math.min(240, Math.max(80, Number(owner.maxCharacters || 240))), output = [];
    while (owner.textBuffer) {
      var paragraph = owner.textBuffer.search(/\n/), length = paragraph >= 0 ? paragraph + 1 : 0, match;
      if (!length) {
        var stops = /[。！？!?；;]/g;
        while ((match = stops.exec(owner.textBuffer))) { if (match.index + 1 >= 40) { length = match.index + 1; break; } }
      }
      if (!length && owner.textBuffer.length >= limit) {
        var windowText = owner.textBuffer.slice(0, limit), punctuation = Math.max(windowText.lastIndexOf("。"), windowText.lastIndexOf("！"), windowText.lastIndexOf("？"), windowText.lastIndexOf("!"), windowText.lastIndexOf("?"), windowText.lastIndexOf("；"), windowText.lastIndexOf(";"));
        length = punctuation >= Math.floor(limit * 0.55) ? punctuation + 1 : limit;
      }
      if (!length && flush) length = owner.textBuffer.length;
      if (!length) break;
      if (length < owner.textBuffer.length && /[\uD800-\uDBFF]/.test(owner.textBuffer.charAt(length - 1))) length -= 1;
      if (!length) break;
      var part = cleanText(owner.textBuffer.slice(0, length)); owner.textBuffer = owner.textBuffer.slice(length);
      if (part) output.push(part);
    }
    return output;
  }

  function createPcmTextOwner(profile, role, messageId, options, token) {
    var owner = attachPcmPlayer({ cancelled: false, task: { cancelled: false }, clips: [], textBuffer: "", receivedText: "", chain: Promise.resolve(), profile: profile, role: role, messageId: messageId, maxCharacters: app.services.modelServices.modelDefinition("tts", profile, profile.model).maxCharacters || 240 }, token, options);
    async function enqueue(text) {
      if (owner.cancelled || owner.failure || token !== generation) return;
      await streamPcm(text, profile, owner.task, function (bytes, sampleRate) { owner.streamReceived = true; owner.pushPcm(bytes, sampleRate); });
    }
    function append(delta) {
      if (owner.cancelled || !delta) return;
      owner.receivedText += delta; owner.textBuffer += delta;
      takeSpeechSegments(owner, false).forEach(function (part) { owner.chain = owner.chain.then(function () { return enqueue(part); }).catch(function (error) { owner.failure = owner.failure || error; }); });
    }
    async function finish(finalText) {
      if (owner.cancelled) return;
      var finalClean = cleanText(finalText);
      if (finalClean && finalClean.indexOf(owner.receivedText) === 0) append(finalClean.slice(owner.receivedText.length));
      takeSpeechSegments(owner, true).forEach(function (part) { owner.chain = owner.chain.then(function () { return enqueue(part); }).catch(function (error) { owner.failure = owner.failure || error; }); });
      await owner.chain;
      if (owner.failure) { owner.failure.streamReceived = Boolean(owner.streamReceived); owner.failPcm(owner.failure); var failure = owner.failure; await stop(); throw failure; }
      owner.finished = true; await owner.finishPcm(); await rememberPcm(owner);
      if (current === owner) { current = null; emit({ speaking: false, messageId: messageId }); }
    }
    owner.append = append; owner.finish = finish; return owner;
  }

  async function createElevenSocketOwner(profile, role, messageId, options, token) {
    var owner = attachPcmPlayer({ cancelled: false, task: { cancelled: false }, clips: [], textBuffer: "", receivedText: "", chain: Promise.resolve(), profile: profile, role: role, messageId: messageId, maxCharacters: app.services.modelServices.modelDefinition("tts", profile, profile.model).maxCharacters || 240 }, token, options);
    var v3 = /^eleven_v3(?:_|$)/.test(profile.model || ""), base;
    try { var parsed = new URL(profile.endpoint || "https://api.elevenlabs.io"); base = (parsed.protocol === "http:" ? "ws:" : "wss:") + "//" + parsed.host; } catch (_) { base = "wss://api.elevenlabs.io"; }
    var path = v3 ? "/v1/text-to-dialogue/stream-input" : "/v1/text-to-speech/" + encodeURIComponent(profile.voice || "") + "/stream-input";
    var socket = await app.platform.network.openWebSocket({ url: base + path + "?model_id=" + encodeURIComponent(profile.model || "") + "&output_format=pcm_24000" + (v3 ? "" : "&auto_mode=true"), timeoutMs: 60000, task: owner.task }); owner.socketSession = socket;
    var readyResolve, readyReject, doneResolve, doneReject, socketFinished = false, socketReady = false;
    var ready = new Promise(function (resolve, reject) { readyResolve = resolve; readyReject = reject; });
    var done = new Promise(function (resolve, reject) { doneResolve = resolve; doneReject = reject; });
    var timer = setTimeout(function () { var error = new Error("ElevenLabs 流式连接超时"); if (!socketReady) readyReject(error); if (!socketFinished) { socketFinished = true; owner.socketTimer = null; doneReject(error); socket.close("Timeout").catch(function () {}); } }, 90000); owner.socketTimer = timer;
    ready.catch(function () {}); done.catch(function () {});
    function finishSocket(error) { if (socketFinished) return; socketFinished = true; clearTimeout(timer); owner.socketTimer = null; error ? doneReject(error) : doneResolve(); }
    try {
      await socket.sendText(JSON.stringify(v3 ? { voices: [profile.voice], xi_api_key: profile.apiKey } : { text: " ", xi_api_key: profile.apiKey, generation_config: { chunk_length_schedule: [80, 120, 180, 240] } }));
      socketReady = true; readyResolve();
    } catch (error) { readyReject(error); finishSocket(error); }
    (async function readLoop() {
      while (!socketFinished && !owner.cancelled) {
        var event = await socket.next(30000);
        if (!event || event.type === "timeout") continue;
        if (event.type === "error") { finishSocket(streamUnavailable(event.text || "ElevenLabs 流式连接失败")); break; }
        if (event.type === "closed" || event.type === "closing") { var closed = owner.streamReceived ? null : streamUnavailable("ElevenLabs 流式连接在音频返回前关闭"); if (!socketReady) readyReject(closed || streamUnavailable("ElevenLabs 流式连接未建立")); finishSocket(closed); break; }
        if (event.type !== "text") continue;
        var data = app.utils.safeJsonParse(event.text, null); if (!data) continue;
        if (data.error || data.type === "error") { var detail = data.error && (data.error.message || data.error) || data.message || "ElevenLabs 流式合成失败"; finishSocket(new Error(app.utils.cleanError(String(detail)))); break; }
        if (data.audio) { var bytes = base64Bytes(data.audio); if (bytes.length) { owner.streamReceived = true; owner.pushPcm(bytes, 24000); } }
        if (data.isFinal || data.is_final || data.type === "final") { finishSocket(); break; }
      }
    })().catch(function (error) { if (!socketReady) readyReject(error); finishSocket(error); });
    async function sendPart(text) {
      await ready; if (owner.cancelled || token !== generation) return;
      await socket.sendText(JSON.stringify(v3 ? { inputs: [{ text: text, voice_id: profile.voice }] } : { text: text + " ", try_trigger_generation: true }));
    }
    function append(delta) {
      if (owner.cancelled || !delta) return;
      owner.receivedText += delta; owner.textBuffer += delta;
      takeSpeechSegments(owner, false).forEach(function (part) { owner.chain = owner.chain.then(function () { return sendPart(part); }).catch(function (error) { owner.failure = owner.failure || error; }); });
    }
    async function finish(finalText) {
      if (owner.cancelled) return;
      var finalClean = cleanText(finalText); if (finalClean && finalClean.indexOf(owner.receivedText) === 0) append(finalClean.slice(owner.receivedText.length));
      takeSpeechSegments(owner, true).forEach(function (part) { owner.chain = owner.chain.then(function () { return sendPart(part); }).catch(function (error) { owner.failure = owner.failure || error; }); });
      try {
        await owner.chain; if (owner.failure) throw owner.failure; await ready;
        if (v3) await socket.sendText(JSON.stringify({ close_socket: true }));
        else await socket.sendText(JSON.stringify({ text: "", flush: true }));
        await done; owner.finished = true; await owner.finishPcm(); await rememberPcm(owner);
        if (owner.socketSession) { await owner.socketSession.close("Completed").catch(function () {}); owner.socketSession = null; }
        if (current === owner) { current = null; emit({ speaking: false, messageId: messageId }); }
      } catch (error) {
        error.streamReceived = Boolean(owner.streamReceived); await stopOwner(owner); throw error;
      }
    }
    owner.append = append; owner.finish = finish; return owner;
  }

  async function createXaiSocketOwner(profile, role, messageId, options, token) {
    var owner = attachPcmPlayer({ cancelled: false, task: { cancelled: false }, clips: [], textBuffer: "", receivedText: "", chain: Promise.resolve(), profile: profile, role: role, messageId: messageId, maxCharacters: 15000 }, token, options);
    var parsed = new URL(profile.endpoint || "https://api.x.ai/v1/tts"); parsed.protocol = parsed.protocol === "http:" ? "ws:" : "wss:";
    parsed.searchParams.set("voice", profile.voice || "eve"); parsed.searchParams.set("language", profile.language || "auto"); parsed.searchParams.set("codec", "pcm"); parsed.searchParams.set("sample_rate", String(Number(profile.sampleRate || 24000))); parsed.searchParams.set("speed", String(Number(profile.rate || 1))); parsed.searchParams.set("optimize_streaming_latency", "1");
    var socketHeaders = Object.assign({}, app.utils.parseHeaders(profile.customHeaders)); if (profile.apiKey) socketHeaders.Authorization = "Bearer " + profile.apiKey;
    var socket = await app.platform.network.openWebSocket({ url: parsed.toString(), headers: socketHeaders, timeoutMs: 60000, task: owner.task }); owner.socketSession = socket;
    var doneResolve, doneReject, finished = false, done = new Promise(function (resolve, reject) { doneResolve = resolve; doneReject = reject; }); done.catch(function () {});
    var timer = setTimeout(function () { if (!finished) { finished = true; doneReject(new Error("xAI TTS 流式连接超时")); socket.close("Timeout").catch(function () {}); } }, 90000); owner.socketTimer = timer;
    function settle(error) { if (finished) return; finished = true; clearTimeout(timer); owner.socketTimer = null; error ? doneReject(error) : doneResolve(); }
    (async function readLoop() {
      while (!finished && !owner.cancelled) {
        var event = await socket.next(30000); if (!event || event.type === "timeout") continue;
        if (event.type === "error") { settle(streamUnavailable(event.text || "xAI TTS 流式连接失败")); break; }
        if (event.type === "closed" || event.type === "closing") { settle(owner.streamReceived ? null : streamUnavailable("xAI TTS 在音频返回前关闭")); break; }
        if (event.type !== "text") continue;
        var data = app.utils.safeJsonParse(event.text, null); if (!data) continue;
        if (data.type === "error" || data.error) { var detail = data.error && (data.error.message || data.error) || data.message || "xAI TTS 合成失败"; settle(new Error(app.utils.cleanError(String(detail)))); break; }
        if (data.type === "audio.delta" && data.delta) { var bytes = base64Bytes(data.delta); if (bytes.length) { owner.streamReceived = true; owner.pushPcm(bytes, Number(profile.sampleRate || 24000)); } }
        if (data.type === "audio.done") { settle(); break; }
      }
    })().catch(settle);
    async function sendPart(text) { if (!owner.cancelled && token === generation) await socket.sendText(JSON.stringify({ type: "text.delta", delta: text })); }
    function append(delta) { if (owner.cancelled || !delta) return; owner.receivedText += delta; owner.textBuffer += delta; takeSpeechSegments(owner, false).forEach(function (part) { owner.chain = owner.chain.then(function () { return sendPart(part); }).catch(function (error) { owner.failure = owner.failure || error; }); }); }
    async function finish(finalText) {
      if (owner.cancelled) return;
      var finalClean = cleanText(finalText); if (finalClean && finalClean.indexOf(owner.receivedText) === 0) append(finalClean.slice(owner.receivedText.length));
      takeSpeechSegments(owner, true).forEach(function (part) { owner.chain = owner.chain.then(function () { return sendPart(part); }).catch(function (error) { owner.failure = owner.failure || error; }); });
      try {
        await owner.chain; if (owner.failure) throw owner.failure; await socket.sendText(JSON.stringify({ type: "text.done" })); await done;
        owner.finished = true; await owner.finishPcm(); await rememberPcm(owner); await socket.close("Completed").catch(function () {}); owner.socketSession = null;
        if (current === owner) { current = null; emit({ speaking: false, messageId: messageId }); }
      } catch (error) { error.streamReceived = Boolean(owner.streamReceived); await stopOwner(owner); throw error; }
    }
    owner.append = append; owner.finish = finish; return owner;
  }

  async function createQwenSocketOwner(profile, role, messageId, options, token) {
    var owner = attachPcmPlayer({ cancelled: false, task: { cancelled: false }, clips: [], textBuffer: "", receivedText: "", chain: Promise.resolve(), profile: profile, role: role, messageId: messageId, maxCharacters: 240 }, token, options);
    var parsed = new URL(profile.endpoint || "https://dashscope.aliyuncs.com"); parsed.protocol = parsed.protocol === "http:" ? "ws:" : "wss:"; parsed.pathname = "/api-ws/v1/realtime"; parsed.search = ""; parsed.searchParams.set("model", profile.model);
    var socketHeaders = Object.assign({}, app.utils.parseHeaders(profile.customHeaders)); if (profile.apiKey) socketHeaders.Authorization = "Bearer " + profile.apiKey;
    var socket = await app.platform.network.openWebSocket({ url: parsed.toString(), headers: socketHeaders, timeoutMs: 60000, task: owner.task }); owner.socketSession = socket;
    var responseWaiters = [], sessionResolve, sessionReject, sessionDone = new Promise(function (resolve, reject) { sessionResolve = resolve; sessionReject = reject; }); sessionDone.catch(function () {});
    var socketFinished = false, timer = setTimeout(function () { if (!socketFinished) { socketFinished = true; sessionReject(new Error("Qwen TTS 流式连接超时")); while (responseWaiters.length) responseWaiters.shift().reject(new Error("Qwen TTS 流式连接超时")); socket.close("Timeout").catch(function () {}); } }, 120000); owner.socketTimer = timer;
    function fail(error) { if (socketFinished) return; socketFinished = true; clearTimeout(timer); owner.socketTimer = null; while (responseWaiters.length) responseWaiters.shift().reject(error); sessionReject(error); }
    function event(type, extra) { return Object.assign({ event_id: "event_" + Date.now() + "_" + Math.floor(Math.random() * 10000), type: type }, extra || {}); }
    (async function readLoop() {
      while (!socketFinished && !owner.cancelled) {
        var incoming = await socket.next(30000); if (!incoming || incoming.type === "timeout") continue;
        if (incoming.type === "error") { fail(streamUnavailable(incoming.text || "Qwen TTS 流式连接失败")); break; }
        if (incoming.type === "closed" || incoming.type === "closing") { if (!socketFinished) fail(owner.streamReceived ? new Error("Qwen TTS 会话未明确完成") : streamUnavailable("Qwen TTS 在音频返回前关闭")); break; }
        if (incoming.type !== "text") continue;
        var data = app.utils.safeJsonParse(incoming.text, null); if (!data) continue;
        if (data.type === "error") { var detail = data.error && (data.error.message || data.error) || data.message || "Qwen TTS 合成失败"; fail(new Error(app.utils.cleanError(String(detail)))); break; }
        if (data.type === "response.audio.delta" && data.delta) { var bytes = base64Bytes(data.delta); if (bytes.length) { owner.streamReceived = true; owner.pushPcm(bytes, 24000); } }
        if (data.type === "response.done" && responseWaiters.length) responseWaiters.shift().resolve();
        if (data.type === "session.finished") { socketFinished = true; clearTimeout(timer); owner.socketTimer = null; sessionResolve(); break; }
      }
    })().catch(fail);
    await socket.sendText(JSON.stringify(event("session.update", { session: { voice: profile.voice, language_type: profile.language || "Auto", response_format: "pcm", sample_rate: 24000, mode: "commit" } })));
    async function sendPart(text) {
      if (owner.cancelled || token !== generation) return;
      var waiter = {}, completed = new Promise(function (resolve, reject) { waiter.resolve = resolve; waiter.reject = reject; }); responseWaiters.push(waiter);
      await socket.sendText(JSON.stringify(event("input_text_buffer.append", { text: text })));
      await socket.sendText(JSON.stringify(event("input_text_buffer.commit")));
      await completed;
    }
    function append(delta) { if (owner.cancelled || !delta) return; owner.receivedText += delta; owner.textBuffer += delta; takeSpeechSegments(owner, false).forEach(function (part) { owner.chain = owner.chain.then(function () { return sendPart(part); }).catch(function (error) { owner.failure = owner.failure || error; }); }); }
    async function finish(finalText) {
      if (owner.cancelled) return;
      var finalClean = cleanText(finalText); if (finalClean && finalClean.indexOf(owner.receivedText) === 0) append(finalClean.slice(owner.receivedText.length));
      takeSpeechSegments(owner, true).forEach(function (part) { owner.chain = owner.chain.then(function () { return sendPart(part); }).catch(function (error) { owner.failure = owner.failure || error; }); });
      try {
        await owner.chain; if (owner.failure) throw owner.failure; await socket.sendText(JSON.stringify(event("session.finish"))); await sessionDone;
        owner.finished = true; await owner.finishPcm(); await rememberPcm(owner); await socket.close("Completed").catch(function () {}); owner.socketSession = null;
        if (current === owner) { current = null; emit({ speaking: false, messageId: messageId }); }
      } catch (error) { error.streamReceived = Boolean(owner.streamReceived); await stopOwner(owner); throw error; }
    }
    owner.append = append; owner.finish = finish; return owner;
  }

  async function createStream(role, messageId, options) {
    await stop();
    var resolved = await profileFor(role), capabilities = app.services.modelServices.ttsCapabilities(resolved.service, resolved.profile.model);
    if (resolved.profile.type === "system" || !capabilities.audioStreaming || !pcmStreamProfile(resolved.profile) || !playbackUnlocked || !audioContext) return null;
    var token = ++generation, owner;
    if ((resolved.profile.protocol === "elevenlabs" || resolved.profile.type === "elevenlabs") && capabilities.textStreaming) {
      try { owner = await createElevenSocketOwner(resolved.profile, role, messageId, options || {}, token); }
      catch (error) { if (!error.streamUnavailable) throw error; owner = createPcmTextOwner(resolved.profile, role, messageId, options || {}, token); }
    } else if (resolved.profile.protocol === "xai-tts" && capabilities.textStreaming) {
      try { owner = await createXaiSocketOwner(resolved.profile, role, messageId, options || {}, token); }
      catch (error) { if (!error.streamUnavailable) throw error; owner = createPcmTextOwner(resolved.profile, role, messageId, options || {}, token); }
    } else if (resolved.profile.protocol === "qwen-tts" && /-realtime(?:$|-)/.test(resolved.profile.model || "") && capabilities.textStreaming) {
      try { owner = await createQwenSocketOwner(resolved.profile, role, messageId, options || {}, token); }
      catch (error) { if (!error.streamUnavailable) throw error; owner = createPcmTextOwner(resolved.profile, role, messageId, options || {}, token); }
    } else owner = createPcmTextOwner(resolved.profile, role, messageId, options || {}, token);
    current = owner;
    emit({ speaking: false, buffering: true, messageId: messageId, bufferedSeconds: 0 }); return owner;
  }

  async function resume(messageId) {
    if (!current || current.messageId !== messageId || !current.starved || !(current.clips && current.clips.length || current.pcmQueue && current.pcmQueue.length)) return false;
    await current.resume(); return true;
  }

  function hasReady(messageId) { return Boolean(ready[messageId]); }
  function canResume(messageId) { return Boolean(current && current.messageId === messageId && current.starved && (current.clips && current.clips.length || current.pcmQueue && current.pcmQueue.length)); }

  async function pauseForBackground() {
    backgrounded = true;
    if (muted || pausedPlayback || backgroundResume) return false;
    var owner = current; if (!owner) return false;
    if (owner.audio) {
      owner.audio.pause(); pausedPlayback = { owner: owner, kind: "audio" };
      emit({ speaking: false, suspended: true, messageId: owner.messageId }); return true;
    }
    if (owner.audioGain && audioContext && typeof audioContext.suspend === "function") {
      await audioContext.suspend();
      if (current !== owner) return false;
      pausedPlayback = { owner: owner, kind: "context" };
      emit({ speaking: false, suspended: true, messageId: owner.messageId }); return true;
    }
    if (!owner.resumeRequest) return false;
    var request = owner.resumeRequest;
    if (request.kind === "ready" && request.item && request.item.clip && owner.activeClip === request.item.clip) owner.preserveActiveClip = true;
    await stop({ background: true });
    if (request.kind === "ready" && request.item) ready[request.messageId] = request.item;
    backgroundResume = request;
    emit({ speaking: false, suspended: true, messageId: request.messageId }); return true;
  }

  async function resumeAfterBackground() {
    backgrounded = false;
    var paused = pausedPlayback; pausedPlayback = null;
    if (paused && current === paused.owner) {
      if (paused.kind === "audio") await paused.owner.audio.play();
      else if (audioContext && typeof audioContext.resume === "function") await audioContext.resume();
      if (!paused.owner.started && paused.owner.startPcm && paused.owner.pcmQueue && paused.owner.pcmQueue.length) paused.owner.startPcm();
      if (paused.owner.audio || paused.owner.audioSource || paused.owner.started && !paused.owner.starved) emit({ speaking: true, messageId: paused.owner.messageId });
      return true;
    }
    if (audioContext && playbackUnlocked && audioContext.state === "suspended" && typeof audioContext.resume === "function") await audioContext.resume();
    var request = backgroundResume; backgroundResume = null;
    if (!request || muted) return false;
    var restarted = request.kind === "ready" ? playReady(request.messageId) : speak(request.text, request.role);
    restarted.catch(function (error) { app.events.emit("tts:error", { message: "继续朗读失败：" + app.utils.cleanError(error) }); });
    return true;
  }

  function queueLifecycle(hidden) {
    lifecycleQueue = lifecycleQueue.catch(function () {}).then(function () { return hidden ? pauseForBackground() : resumeAfterBackground(); }).catch(function (error) {
      app.events.emit("tts:error", { message: "朗读前后台切换失败：" + app.utils.cleanError(error) });
    });
  }

  if (typeof window.addEventListener === "function") {
    window.addEventListener("pointerdown", unlockPlayback, true);
    window.addEventListener("touchstart", unlockPlayback, true);
    window.addEventListener("keydown", unlockPlayback, true);
    window.addEventListener("pagehide", function () { queueLifecycle(true); });
    window.addEventListener("pageshow", function () { queueLifecycle(false); });
  }
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") document.addEventListener("visibilitychange", function () { queueLifecycle(Boolean(document.hidden)); });

  app.services.tts = { speak: speak, stop: stop, headers: headers, requestBody: requestBody, parseDoubaoSse: parseDoubaoSse, prepare: prepare, testService: testService, playReady: playReady, hasReady: hasReady, invalidate: invalidate, invalidateMany: invalidateMany, invalidateRole: invalidateRole, invalidateAll: invalidateAll, createStream: createStream, resume: resume, canResume: canResume, unlockPlayback: unlockPlayback, setMuted: setMuted, isMuted: function () { return muted; }, isPlaying: function () { return Boolean(lastState.speaking); }, pauseForBackground: pauseForBackground, resumeAfterBackground: resumeAfterBackground };
})(window.chataxi);
