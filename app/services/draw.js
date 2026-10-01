(function (app) {
  "use strict";
  // 绘图客户端 —— 只实现 CHP 这一种合同（CHP 插件那套 `chp/2`）。
  // 协议细节与 hamdraw/app/services/providers.js 的 chpGenerate 同源：提交 → 轮询 → 取图，
  // 这里的差别只有三处：chataxi 只要一张图、一个参考图，所以把参数收敛到插件自报的默认值；
  // 画幅锁定插件帧表里标着 9:16 的那一档（见 pickSize）；而且**一次提交走两条场景中的哪一条
  // 由手上有没有参考图决定**（见 sceneFor）—— 有定妆照走 render、没有走 generate。
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

  // 画幅偏好（业主 2026-09-27）：9:16 竖幅、约 1MP —— 就是插件帧表里 `ratio` 标着 9:16 的那一档
  // （参考实现是 768×1344）。chp/2 把画幅变成**手写的表**，`ratio` 是作者定的**标签、不由数字反推**，
  // 所以这里按标签取，不算比例、不搜方形、不打分：客户端**只选不算**，表里没有就报错（见 pickSize）。

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

  // 绘图卡片上的画幅目录是"发现当时"的快照 —— discoverImage 只在测试连接时读一次 /chp/info。
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
    if (code === "no_model") return new Error("插件还没有为这个绘制场景配好模型，请在 ComfyUI 的 CHP 插件配置节点里设置");
    if (code === "unsupported_category") return new Error("插件不认识这个绘制场景，请升级插件");
    // 步数不在这里的码表里：chataxi 一个 step 都不发（见 generate），所以永远收不到那个码。
    // 真出现其它码时下面那条 message 会把插件自己的话原样带出来。
    if (code === "unsupported_size") return new Error("插件不接受这张卡片的画幅，请在模型页重新获取一次目录");
    if (code === "bad_image") return new Error("交给绘图模型的参考图不是合法的 PNG / JPEG");
    if (code === "bad_mask") return new Error("这个绘制场景需要蒙版，chataxi 目前不提供蒙版");
    // 定妆照是竖构图、画幅也是 9:16 时不会走到这里；真走到就是这张定妆照的宽高比差得太远，
    // 硬缩过去会把人压变形，而**变形在成图上完全看不出来** —— 所以要在这里说清是照片的锅。
    if (code === "stretched_reference") return new Error("这张定妆照的宽高比和画幅差得太远，按画幅缩放会把人压变形；请换一张竖构图的定妆照");
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

  // 插件为这个场景公布的、**比例标签就是 9:16** 的分辨率，按帧表顺序去重。
  //
  // 读的是 `ratio` 这个**标签**，不是把两个数字相除：`768 × 1344` 的真实比是 4:7，
  // 那也叫 9:16（作者定的类目名，和相机的画幅档位一个道理），所以按数字反推必错。
  // 非 9:16 的一律跳过 —— chataxi 是竖屏构图，拿一条横的回去只会把参考图压变形，
  // 而插件的 `stretched_reference` 拦的正是这件事。
  function sizes(model) {
    var frames = model && Array.isArray(model.frames) ? model.frames : [], out = [];
    frames.forEach(function (frame) {
      if (String(frame && frame.ratio || "") !== "9:16") return;
      (frame.resolution || []).forEach(function (value) {
        var text = String(value || "").trim();
        if (text && out.indexOf(text) < 0) out.push(text);
      });
    });
    return out;
  }

  // 这一次真正要发出去的那条画幅。
  //
  // 卡上选中的那条优先（**那是用户的选择**），但它必须还在插件**当前**公布的清单里 ——
  // 插件换过帧表之后，卡上存的旧值发出去只会换来一个 `unsupported_size`，错的却像是
  // chataxi 自己算的。所以不在清单里就退回第一条（2026-09-30 起 9:16 一档有多条，
  // 第一条 `768x1344` 仍是默认）。
  //
  // 无论走哪条路，返回的都是表里那个**字面量**，不是一对数字：客户端不重新格式化它，
  // 服务端也不接受它算出来的东西（校验是成员检查，见 chp/2 的 frames 一节）。
  function pickSize(model, preferred) {
    var list = sizes(model);
    if (!list.length) return null;
    var wanted = String(preferred || "").trim();
    return list.indexOf(wanted) >= 0 ? wanted : list[0];
  }

  // 这一次走哪条场景 —— 由**手上有没有参考图**决定（业主 2026-10-01），不由卡片决定：
  //   有定妆照 ⇒ render（txt-ref-2-img：给定一张图重新生成）
  //   没有     ⇒ generate（txt-2-img：纯文字生成）
  // 插件还没分出 generate 那一类时退回 render —— 那是它在 chp/2 之前就明确支持的那条路
  // （不带参考图就是纯文生图）。**有参考图时绝不退回 generate**：那条规则不收图，发过去
  // 只会换来一个 bad_image，而错看起来像是"这张定妆照有问题"。
  // 卡片上根本没有 scenes（旧版本存的目录）时返回 null，调用方拿卡片自己当场景 —— 与从前一致。
  function sceneFor(model, hasReference) {
    var scenes = model && model.scenes;
    if (!scenes) return null;
    if (hasReference) return scenes.render || null;
    return scenes.generate || scenes.render || null;
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
    if (!model || !model.id) throw new Error("这张绘图卡片还没有保存具体场景，请在模型页重新获取一次目录");
    var services = app.services.modelServices;
    if (!services.computedEndpoint("image", profile)) throw new Error("绘图模型没有地址，请在模型页补上插件地址");
    var prompt = String(options.prompt || "").trim();
    if (!prompt) throw new Error("这一轮没有给出绘图提示词");
    var reference = String(options.referenceDataUrl || "");
    // 有参考图时在开头钉一句身份约束（原文在 draw-prompt.js 的 REFERENCE_PREFIX）。
    // 只加在**发给插件的那一份**上：消息里存的、正文回显的仍是模型自己写的提示词。
    var prefix = app.services.drawPrompt && app.services.drawPrompt.referencePrefix;
    if (reference && prefix) prompt = prefix + "\n" + prompt;
    var headers = services.authHeaders("image", profile);
    Object.assign(headers, app.utils.parseHeaders(profile.customHeaders));

    // 走哪条场景由**手上有没有参考图**定（见 sceneFor）。category、画幅表、默认值三样都跟着
    // 这条场景走：卡片只是容器，不把两条场景的数拼起来。
    var scene = sceneFor(model, Boolean(reference)) || model;
    if (reference && scene.takesReference === false) throw new Error("插件公布的“" + String(scene.category || scene.id || "") + "”场景不接受参考图，请升级 CHP 插件的场景表");
    var defaults = scene.defaults || {}, resolution = pickSize(scene, profile.resolution);
    if (!resolution) throw new Error("还没有读到插件的默认画幅，请先在模型页测试一次连接");
    // 画幅是插件帧表里标着 9:16 的那一档，**卡上选中的那条优先**（见 pickSize），原样发回去；
    // 参考强度照这条场景自报的默认值发，不开放给用户配置（画幅在卡片上显示、改在模型页改）。
    // **步数一个字都不发**：它不在规范里（那是插件自己的 step 扩展键），而"不发"正是
    // "用你的默认值"这件事在 chp/2 里的写法 —— 在这里再抄一份数字，就成了第二个会和插件
    // 对不上的枚举。参考强度是连续量，越界会被夹到边界，所以本地先夹一次。
    var body = {
      category: String(scene.category || model.id),
      prompt: prompt,
      seed: Number.isFinite(options.seed) ? Number(options.seed) : Math.floor(Math.random() * 9007199254740991),
      resolution: resolution
    };
    // 参考强度只跟参考图一起发：它是"要多像这张参考图"，没有图的时候它没有意义。
    // generate 那条场景的 defaults 本来就是空的，于是它一个字节都不发。
    if (reference && Number.isFinite(Number(defaults.ref_strength))) body.ref_strength = Math.max(0.05, Math.min(0.95, Number(defaults.ref_strength)));
    if (reference) body.image_base64 = reference;

    var report = function (text) { if (options.onProgress) options.onProgress(text); };
    // 等多久由**这一次那条场景**自己报的典型耗时算：两条场景差得很远（按图重画那条最慢），
    // 拿卡片上那一份去等会在快的那条上白白多等一倍，在慢的那条上又可能不够。
    var budget = Math.min(TIMEOUT_CEILING, Math.max(60000, Number(scene.typicalSeconds || model.typicalSeconds || 45) * 4000));
    var deadline = Date.now() + budget;
    report("正在把绘图任务交给插件…");
    var jobId = "";
    try {
      // 请求地址一律从文档的 endpoints 里读（规范 §1.3 的规则），文档没给才退到推荐路径。
      var submitted = await app.platform.network.requestJson({
        url: services.chpUrl(profile, "jobs", "/chp/jobs"), method: "POST",
        headers: Object.assign({}, headers, { "Content-Type": "application/json" }),
        bodyText: JSON.stringify(body), timeoutMs: 60000, task: task
      });
      jobId = submitted.data && submitted.data.job && submitted.data.job.id;
    } catch (error) { if (error && error.cancelled) throw error; throw readable(error); }
    if (!jobId) throw new Error("绘图插件没有返回任务编号，请确认插件版本与地址");
    var progressUrl = services.chpJobUrl(profile, "progress", "/chp/jobs/{job_id}/progress", jobId);
    var cancelUrl = services.chpJobUrl(profile, "cancel", "/chp/jobs/{job_id}/cancel", jobId);

    var state = "";
    try {
      while (Date.now() < deadline) {
        if (task.cancelled) throw stopped();
        await new Promise(function (resolve) { setTimeout(resolve, POLL_INTERVAL); });
        if (task.cancelled) throw stopped();
        var polled = await app.platform.network.requestJson({ url: progressUrl, method: "GET", headers: headers, timeoutMs: 20000, task: task });
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
        app.platform.network.requestJson({ url: cancelUrl, method: "POST", headers: headers, timeoutMs: 15000 }).catch(function () {});
        throw error;
      }
      if (error && error.payload !== undefined) throw readable(error);
      throw error;
    }
    if (state !== "completed") {
      // 超时也要尽力取消，别把插件队列占着。
      app.platform.network.requestJson({ url: cancelUrl, method: "POST", headers: headers, timeoutMs: 15000 }).catch(function () {});
      throw new Error("等插件出图超过 " + Math.round(budget / 60000) + " 分钟仍未完成，任务可能还在插件队列里");
    }

    report("正在取回图片…");
    var finished;
    try {
      finished = await app.platform.network.requestJson({ url: services.chpJobUrl(profile, "job", "/chp/jobs/{job_id}", jobId), method: "GET", headers: headers, timeoutMs: 30000, task: task });
    } catch (error) { if (error && error.cancelled) throw error; throw readable(error); }
    var job = finished.data && finished.data.job;
    if (!job || job.state !== "completed") throw new Error("绘图任务结束时状态是 " + String(job && job.state || "未知"));
    var output = (job.outputs || [])[0];
    if (!output || !output.url) throw new Error("绘图任务完成了，但插件没有给出图片");
    // outputs[].url 由服务端给出：绝对 URL 直接用，以 / 开头的按信息接口的同源路径补全，
    // 两条都由 chpAbsolute 一处决定（不给客户端留第二次自己拼路径的机会）。
    var bytes = await readBytes({ url: services.chpAbsolute(profile, output.url), method: "GET", headers: headers, timeoutMs: 90000 }, task);
    if (!bytes.blob.size) throw new Error("插件返回了空图片");
    return { blob: bytes.blob, mime: bytes.mime || output.media_type || "image/png", job: job };
  }

  app.services = app.services || {};
  app.services.draw = {
    available: available,
    resolveCard: resolveCard,
    refreshCatalogs: refreshCatalogs,
    generate: generate,
    sceneFor: sceneFor,
    pickSize: pickSize,
    sizes: sizes,
    portraitReference: portraitReference,
    downscale: downscale,
    newTask: newTask,
    readable: readable,
    REFERENCE_BUDGET: REFERENCE_BUDGET,
    REFERENCE_MAX_EDGE: REFERENCE_MAX_EDGE
  };
})(window.chataxi);
