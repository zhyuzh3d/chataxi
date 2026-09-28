(function (app) {
  "use strict";
  // 绘图客户端 —— 只实现 CVP 这一种合同（hamdraw 的 ComfyUI 插件那套 `cvp/1`）。
  // 协议细节与 hamdraw/app/services/providers.js 的 cvpGenerate 同源：提交 → 轮询 → 取图，
  // 这里的差别只有一处：chataxi 只要一张图、一个参考图，所以把参数收敛到插件自报的默认值。
  //
  // 三条硬规矩（对应 plans/chataxi-v0.7.26-… 的三条不变量）：
  //   I1 只认调用方给的**私有 task**。app/platform/network.js 的 request() / requestByteStream()
  //      都会做 `options.task.controller = controller`；把对话主 task 传进来，绘图请求就会覆写
  //      LLM 流的中断句柄 —— 用户点"停止"时被 abort 的是绘图，正文继续跑。这正是最隐蔽的
  //      "打断数据流"。所以这里从不构造主 task，也不读写它的 onDelta / onMediaState。
  //   I2 不碰 app.services.tts.*，也不产生可朗读文本（绘图消息 text 恒为空）。
  //   I3 不直接改 DOM：进度、结果、错误都通过回调交给 chat-session。
  var POLL_INTERVAL = 700;
  var TIMEOUT_CEILING = 240000;
  var MAX_IMAGE_BYTES = 24 * 1024 * 1024;
  var REFERENCE_MAX_EDGE = 1024;
  // 参考图不能超过宿主**一条消息**的预算：协议 v1 写明消息大于 256 KiB 会被就地拒掉（回
  // E_QUOTA 并带上实测大小）。定妆照走的是 image_base64，它和提示词装在同一个请求体里，
  // 所以这里自己先量一遍真串长 —— 定妆照小一点无所谓，整条请求被拒就是"画不出来"。
  var REFERENCE_BUDGET = 240 * 1024;

  // 画幅偏好（业主 2026-09-27）：9:16 竖幅、约 1MP —— 就是插件「原生档」的 768×1344。
  // 规范的 size 仍是**枚举**语义：插件按能力的 size_domain（对齐步长 + 像素预算）判，
  // 不落在它公布的 values.size 里照样是 unsupported_size，所以不能硬发 [768, 1344]，
  // 只能在**这张能力自己公布的** sizes 里挑最接近的一张。
  // 打分先看"高宽比离 16:9 有多远"（形状优先），同样近再比"长边离 1344 有多远"。
  // 插件 2.3.0 的 render 公布了 [768, 1344]，这一行不改就命中；哪天公布更近的，这里自动跟着换。
  var PREFERRED_SIZE = [768, 1344];

  function newTask(label) { return { cancelled: false, controller: null, label: label || "正在绘制图片…" }; }
  function stopped() { var error = new Error("本轮已停止"); error.cancelled = true; return error; }

  // 第一张启用的、已经验证过目录的绘图卡片。没有就返回 null ——
  // 那就意味着"这一轮不注入绘图指令、不执行绘图动作"，而不是报错。
  async function available() {
    var profiles = await app.data.store.list("image-profiles");
    for (var index = 0; index < profiles.length; index += 1) {
      var profile = profiles[index];
      if (!profile || profile.enabled === false) continue;
      var modelId = profile.externalModelId || profile.model || profile.defaultModelId || "";
      if (!modelId) continue;
      if (!app.services.modelServices.computedEndpoint("image", profile)) continue;
      return { profile: profile, model: app.services.modelServices.modelDefinition("image", profile, modelId), modelId: modelId };
    }
    return null;
  }

  // 绘图卡片上的画幅目录是"发现当时"的快照 —— discoverImage 只在测试连接时读一次 /cvp/info。
  // 插件升级之后那张快照会继续拿旧清单挑画幅, 表现就是"插件明明公布了 768×1344, 画出来还是
  // 1024×1024"。所以启动时静默重读一次: **自动自愈, 而不是让用户去按"重新连接并测试"**。
  // 失败一律静默 —— 插件没开、手机没网都不是用户此刻需要知道的事, 下一次启动还会再试一次。
  async function refreshCatalogs() {
    var profiles = await app.data.store.list("image-profiles").catch(function () { return []; });
    for (var index = 0; index < profiles.length; index += 1) {
      var profile = profiles[index];
      if (!profile || profile.enabled === false) continue;
      if (!app.services.modelServices.computedEndpoint("image", profile)) continue;
      try { await app.services.modelServices.discover("image", profile, { persist: true }); } catch (_) {}
    }
  }

  // 按消息里记下的卡片重建"这一次要用的绘图能力"（业主 2026-09-27：重新生成要照当初那张画）。
  // 记下的卡片还在就用它 —— 即使它已经不是当前默认的那张；卡片被删了、或者那一项能力在保存的
  // 目录里没有了，才退到当前可用的第一张。旧消息（改动之前画的）没有记录，直接走 available()。
  async function resolveCard(profileId, modelId) {
    var wanted = String(profileId || "");
    if (!wanted) return available();
    var profile = null;
    try { profile = await app.data.store.get("image-profiles", wanted); } catch (_) { profile = null; }
    if (!profile) return available();
    var definition = app.services.modelServices.modelDefinition("image", profile, String(modelId || profile.externalModelId || profile.model || profile.defaultModelId || ""));
    if (definition && definition.id) return { profile: profile, model: definition, modelId: definition.id };
    return available();
  }

  // 插件给的人话优先；它没给（httpError 只拿到 error 码）时按规范第 6 节的码表翻译。
  function readable(error) {
    var payload = error && error.payload, code = payload && (payload.error || payload.code), message = payload && payload.message;
    if (code === "unauthorized") return new Error("绘图插件的访问密码不正确，请在模型页核对密码");
    if (code === "no_model") return new Error("插件还没有为这个绘制能力配好模型，请在 ComfyUI 的 HamDraw 配置节点里设置");
    if (code === "unsupported_capability") return new Error("插件不认识这个绘制能力，请升级插件");
    if (code === "unsupported_size" || code === "unsupported_steps") return new Error("插件不接受这张卡片的画幅或步数，请在模型页重新获取一次目录");
    if (code === "bad_image") return new Error("交给绘图模型的参考图不是合法的 PNG / JPEG");
    if (code === "bad_mask") return new Error("这个绘制能力需要蒙版，chataxi 目前不提供蒙版");
    if (code === "invalid_workflow") return new Error("插件的工作流执行失败（多半是节点或模型缺失）" + (message ? "：" + message : ""));
    if (code === "busy") return new Error("绘图插件队列已满，稍后再试");
    if (code === "not_found") return new Error("绘图任务在插件上已经不存在了（服务端可能重启过）");
    if (message) return new Error(String(message));
    return error;
  }

  // 参考图只有一处来源：角色的**定妆照**（role.portraitMediaId）。模型不决定参考图，它只决定
  // "要不要画这个角色自己"（action.selfPortrait）——是就由这里把定妆照顶上去。
  // 重编码成"长边 ≤ 1024 的 JPEG"再送：base64 要内联进请求体，原图（768px 起，可能几 MB）
  // 直接塞进去既慢又没必要。**不改用户原图**，只改这一次传输用的副本。
  // 注意：这只是**传输上限**，不是"参考图编码边长"。真正决定送进编码器多大的是插件的
  // families.qwen_image_21.reference_edge（设备侧设置，业主规格 512；插件再按画幅比例算成
  // 384×672 的框）。这里放宽到 1024 反而让插件从更细的源图缩下去，比在浏览器里先缩一次更清楚。
  // 把图重新编码到"长边 ≤ maxEdge 且串长 ≤ 预算"。量的是 toDataURL 的真实输出, 不是估算 ——
  // 每次超预算就把画幅 ×0.85、质量 −0.08, 六次之内必然收敛（起点长边已经 ≤1024, 第六次只剩
  // 三分之一）。这张图本来就要被插件按 reference_edge 的预算再缩一次, 所以传输这一步让一点
  // 尺寸不损失任何看得见的细节, 而整条请求被拒就是"画不出来"。
  function encodeWithin(image, maxEdge, budget) {
    var edge = Number(maxEdge) || REFERENCE_MAX_EDGE;
    var longest = Math.max(image.naturalWidth, image.naturalHeight);
    var scale = Math.min(1, edge / Math.max(1, longest)), quality = 0.9, output = "";
    var canvas = document.createElement("canvas"), context = canvas.getContext("2d");
    for (var attempt = 0; attempt < 6; attempt += 1) {
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      output = canvas.toDataURL("image/jpeg", quality);
      if (output.length <= budget) break;
      scale *= 0.85; quality = Math.max(0.6, quality - 0.08);
    }
    return output;
  }

  function downscale(dataUrl, maxEdge) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.onload = function () {
        try { resolve(encodeWithin(image, maxEdge, REFERENCE_BUDGET)); }
        catch (error) { reject(error); }
      };
      image.onerror = function () { reject(new Error("定妆照无法读取")); };
      image.src = dataUrl;
    });
  }

  async function portraitReference(mediaId) {
    if (!mediaId) return "";
    var dataUrl = await app.data.media.toDataUrl(mediaId);
    return dataUrl ? downscale(dataUrl, REFERENCE_MAX_EDGE) : "";
  }

  // 在能力公布的 sizes 里挑最接近"9:16 竖幅、长边 1344"的一张。能力没公布 sizes 时退到
  // 它自己的 defaults.size（样板实现早期版本就是这样）。
  function pickSize(model, fallback) {
    var declared = model && Array.isArray(model.sizes) ? model.sizes : null;
    var list = (declared && declared.length ? declared : (Array.isArray(fallback) ? [fallback] : [])).filter(function (item) {
      return Array.isArray(item) && Number(item[0]) > 0 && Number(item[1]) > 0;
    });
    if (!list.length) return null;
    var wanted = PREFERRED_SIZE[1] / PREFERRED_SIZE[0], wantedEdge = Math.max(PREFERRED_SIZE[0], PREFERRED_SIZE[1]);
    var best = null, bestScore = Infinity;
    list.forEach(function (item) {
      var width = Number(item[0]), height = Number(item[1]);
      var score = Math.abs(height / width - wanted) * 10000 + Math.abs(Math.max(width, height) - wantedEdge);
      if (score < bestScore) { bestScore = score; best = [width, height]; }
    });
    return best;
  }

  function readBytes(result, task) {
    var parts = [], total = 0, onChunk = function (bytes) {
      total += bytes.length;
      if (total > MAX_IMAGE_BYTES) { var error = new Error("生成的图片超过 24 MiB，已放弃读取"); error.cancelled = true; throw error; }
      parts.push(bytes);
    };
    return app.platform.network.requestByteStream(Object.assign({}, result, { task: task, onChunk: onChunk })).then(function (response) {
      return { blob: new Blob(parts, { type: (response && response.contentType) || result.mime || "image/png" }), mime: (response && response.contentType) || "image/png" };
    });
  }

  // options: { profile, modelId, prompt, referenceDataUrl, seed, task, onProgress }
  // 返回：{ blob, mime, job }。异常一律是可读中文；"本轮已停止"带 cancelled 标记。
  async function generate(options) {
    var profile = options.profile, task = options.task || newTask();
    var model = app.services.modelServices.modelDefinition("image", profile, options.modelId);
    if (!model || !model.id) throw new Error("这张绘图卡片还没有保存具体能力，请在模型页重新获取一次目录");
    var base = app.services.modelServices.cvpBase(app.services.modelServices.computedEndpoint("image", profile));
    if (!base) throw new Error("绘图模型没有地址，请在模型页补上插件地址");
    var prompt = String(options.prompt || "").trim();
    if (!prompt) throw new Error("这一轮没有给出绘图提示词");
    // 有参考图时在开头钉一句身份约束（原文在 draw-prompt.js 的 REFERENCE_PREFIX）。
    // 只加在**发给插件的那一份**上：消息里存的、正文回显的仍是模型自己写的提示词。
    var prefix = app.services.drawPrompt && app.services.drawPrompt.referencePrefix;
    if (options.referenceDataUrl && prefix) prompt = prefix + "\n" + prompt;
    var headers = app.services.modelServices.authHeaders("image", profile);
    Object.assign(headers, app.utils.parseHeaders(profile.customHeaders));

    var defaults = model.defaults || {}, ignores = model.ignores || [];
    var size = pickSize(model, defaults.size), steps = Number(defaults.steps);
    if (!size || !steps) throw new Error("还没有读到插件的默认画幅与步数，请先在模型页测试一次连接");
    // 画幅只在能力公布的枚举里挑（见 PREFERRED_SIZE），步数与参考强度一律照插件自报的默认值发，
    // 不开放给用户配置（画幅 / 步数在卡片上都不显示）。
    // 越界的两条统一规则来自规范第 4 节：枚举值（size / steps）越界要报错，所以这里原样发；
    // 连续量（ref_strength）越界会被夹到边界，所以本地先夹一次，免得依赖服务端的宽容度。
    var body = {
      capability: model.id,
      prompt: prompt,
      seed: Number.isFinite(options.seed) ? Number(options.seed) : Math.floor(Math.random() * 9007199254740991),
      size: [size[0], size[1]],
      steps: steps
    };
    if (ignores.indexOf("ref_strength") < 0 && Number.isFinite(Number(defaults.ref_strength))) body.ref_strength = Math.max(0.05, Math.min(0.95, Number(defaults.ref_strength)));
    if (options.referenceDataUrl) body.image_base64 = options.referenceDataUrl;

    var api = base + "/cvp", report = function (text) { if (options.onProgress) options.onProgress(text); };
    var deadline = Date.now() + Math.min(TIMEOUT_CEILING, Math.max(60000, Number(model.typicalSeconds || 45) * 4000));
    report("正在把绘图任务交给插件…");
    var jobId = "";
    try {
      var submitted = await app.platform.network.requestJson({
        url: api + "/jobs", method: "POST",
        headers: Object.assign({}, headers, { "Content-Type": "application/json" }),
        bodyText: JSON.stringify(body), timeoutMs: 60000, task: task
      });
      jobId = submitted.data && submitted.data.job && submitted.data.job.id;
    } catch (error) { if (error && error.cancelled) throw error; throw readable(error); }
    if (!jobId) throw new Error("绘图插件没有返回任务编号，请确认插件版本与地址");

    var state = "";
    try {
      while (Date.now() < deadline) {
        if (task.cancelled) throw stopped();
        await new Promise(function (resolve) { setTimeout(resolve, POLL_INTERVAL); });
        if (task.cancelled) throw stopped();
        var polled = await app.platform.network.requestJson({ url: api + "/jobs/" + encodeURIComponent(jobId) + "/progress", method: "GET", headers: headers, timeoutMs: 20000, task: task });
        var frame = polled.data && polled.data.job;
        if (!frame) continue;
        state = String(frame.state || "");
        if (state === "completed") break;
        if (state === "failed") throw new Error("绘图失败：" + String(frame.error || "插件没有说明原因"));
        if (state === "cancelled") throw new Error("绘图任务已被插件取消");
        // 规范明写 progress 可以是 null，而且经常就是 null —— 所以不假装有百分比。
        // queue_position 任何实现都算得出来，是唯一可靠的数字。
        var ahead = Number(frame.queue_position);
        report(Number.isFinite(ahead) && ahead > 0 ? "前面还有 " + ahead + " 个绘图任务…" : "插件正在绘制…");
      }
    } catch (error) {
      // 用户按了「停止」: 本地立刻收手, 但插件那边的任务还在占着队列和显卡 —— 尽力通知它取消。
      // 不 await: 用户要的是"现在就停", 通知失败（插件没开、网断了）也不改变本次结果。
      // 超时那一条路（下面 state !== "completed"）本来就在做同一件事, 两处不能合并 —— 这里是
      // 主动放弃, 那里是等不到结果。
      if (error && error.cancelled) {
        app.platform.network.requestJson({ url: api + "/jobs/" + encodeURIComponent(jobId) + "/cancel", method: "POST", headers: headers, timeoutMs: 15000 }).catch(function () {});
        throw error;
      }
      if (error && error.payload !== undefined) throw readable(error);
      throw error;
    }
    if (state !== "completed") {
      // 超时也要尽力取消，别把插件队列占着。
      app.platform.network.requestJson({ url: api + "/jobs/" + encodeURIComponent(jobId) + "/cancel", method: "POST", headers: headers, timeoutMs: 15000 }).catch(function () {});
      throw new Error("等插件出图超过 " + Math.round((Math.min(TIMEOUT_CEILING, Math.max(60000, Number(model.typicalSeconds || 45) * 4000))) / 60000) + " 分钟仍未完成，任务可能还在插件队列里");
    }

    report("正在取回图片…");
    var finished;
    try {
      finished = await app.platform.network.requestJson({ url: api + "/jobs/" + encodeURIComponent(jobId), method: "GET", headers: headers, timeoutMs: 30000, task: task });
    } catch (error) { if (error && error.cancelled) throw error; throw readable(error); }
    var job = finished.data && finished.data.job;
    if (!job || job.state !== "completed") throw new Error("绘图任务结束时状态是 " + String(job && job.state || "未知"));
    var output = (job.outputs || [])[0];
    if (!output || !output.url) throw new Error("绘图任务完成了，但插件没有给出图片");
    // 规范说 outputs[].url 是绝对路径，但样板实现历史上给过相对路径；两种都接住。
    var imageUrl = /^https?:/i.test(output.url) ? output.url : base + output.url;
    var bytes = await readBytes({ url: imageUrl, method: "GET", headers: headers, timeoutMs: 90000 }, task);
    if (!bytes.blob.size) throw new Error("插件返回了空图片");
    return { blob: bytes.blob, mime: bytes.mime || output.media_type || "image/png", job: job };
  }

  app.services = app.services || {};
  app.services.draw = {
    available: available,
    resolveCard: resolveCard,
    refreshCatalogs: refreshCatalogs,
    generate: generate,
    pickSize: pickSize,
    portraitReference: portraitReference,
    downscale: downscale,
    newTask: newTask,
    readable: readable,
    PREFERRED_SIZE: PREFERRED_SIZE,
    REFERENCE_BUDGET: REFERENCE_BUDGET,
    REFERENCE_MAX_EDGE: REFERENCE_MAX_EDGE
  };
})(window.chataxi);
