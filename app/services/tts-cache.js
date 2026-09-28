(function (app) {
  "use strict";
  // 朗读音频缓存（用户 2026-09-26）
  //   "因为相同的文本、相同的模型、相同的音色每次生成的音频文件都是一样的, 所以我们如果缓存最近
  //    生成的 100 条 TTS 声音… 每次要进行朗读的任务前, 都检查一下 hash 是否存在, 如果存在则直接
  //    使用已有的音频文件, 不需要再次调用 TTS 接口"
  //
  // 键怎么取: 取的是**最终请求**（方法 + 地址 + 请求体）的摘要, 不是"文字 + 模型 + 音色"的字面拼接。
  //   理由: 影响波形的远不止那三样 —— 语速、音调、音量、语言、输出格式、参考音、instructions 都算。
  //   只哈希三样会有两个方向的错: 一是"同句同模型同音色、但改了语速"命中旧音频（听感是错的）;
  //   二是反过来, 同一条消息存进多条仅语速不同的副本, 100 条额度很快被同句占满。
  //   而请求体恰好就是这三样的函数, 又顺带覆盖了上面全部参数 —— 既不丢也不多。地址也进哈希:
  //   同一个模型名挂在不同供应商或自定义地址上, 出来的音频并不一样。
  //
  // 存两半（用户要求"缓存的音频文件存在数据库记录中, 包含文件路径"）:
  //   - 数据库记录: 集合 `tts-cache`, 键 = 摘要, 值里只有**文件句柄**与元数据（kind / mediaId 或
  //     logicalFileId / mime / seconds / chars / createdAt / usedAt）, 不存音频本体。
  //   - 音频本体: 走 `app.data.media` 的 **transient** 分支（IndexedDB 的 blob 记录）。
  //     0.7.26 起消息图片 / 头像 / 生成图都搬进了宿主文件库（为了进备份），音频缓存是**唯一例外**：
  //     混响链要 decodeAudioData 吃内存里的 Blob，宿主文件的对象地址喂不进去，而它本来就
  //     不在备份里 —— 所以按临时件存，不算备份资产。
  //     句柄就是记录里的 mediaId —— "记录里只有文件路径"这件事在 chataxi 里对应的是它。
  //   宿主把响应落成文件那种情况（旧 APK / 没有字节流能力）没有混响可言 —— 宿主播放器在 Web Audio
  //   总线之外出声, 而页面又 fetch 不到那个文件（happ 的 CSP 是 connect-src 'none'）。0.7.22 起
  //   合成一律走原生字节流把音频取回页面（见 tts.js 的 streamAudioBody）, 条目一律是媒体型。
  //   于是 kind:"file" 只剩下**历史遗留**一种来源, clipOf 直接把它当未命中, 让 take() 顺手 drop 掉
  //   （drop 会释放宿主文件）, 换一条带混响的重新合成。
  //
  // 上限 100 条（MAX_ENTRIES）, 超了就按 usedAt 淘汰最久未用的（LRU）。淘汰必须**同时**删记录与
  // 音频本体, 否则 IndexedDB 里的 blob 会只增不减。
  //
  // 一切都失败即放弃: 缓存是加速器, 不是依赖。任何一步出错都只是"这次没命中", 绝不能因为缓存
  // 坏了让朗读播不出声 —— 所以每个对外方法都把异常吞成 null / false。
  var COLLECTION = "tts-cache";
  var MAX_ENTRIES = 100;
  var MEDIA_PREFIX = "tts-cache:";

  function fnv1a(text, seed) {
    var hash = seed >>> 0;
    for (var index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return ("00000000" + hash.toString(16)).slice(-8);
  }

  // crypto.subtle 要安全上下文; chataxi 跑在 https 的 .apps.haminn.invalid 上, 通常有。
  // 拿不到就退回 64 位 FNV-1a —— 在"最多 100 条"的规模下碰撞概率可以忽略, 但毕竟是弱哈希,
  // 所以放在后面当兜底而不是首选。
  async function digest(text) {
    try {
      if (window.crypto && window.crypto.subtle && typeof window.crypto.subtle.digest === "function" && typeof TextEncoder === "function") {
        var buffer = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
        return Array.prototype.map.call(new Uint8Array(buffer), function (byte) { return ("0" + byte.toString(16)).slice(-2); }).join("");
      }
    } catch (_) {}
    return fnv1a(text, 0x811c9dc5) + fnv1a(text, 0x9e3779b9);
  }

  async function keyFor(request) {
    return digest([String(request && request.method || "POST").toUpperCase(), String(request && request.url || ""), String(request && request.bodyText || "")].join("\u0000"));
  }

  // 记录 -> 可播放的 clip。媒体条目要把本体取回来; 宿主文件条目只给句柄。
  // 拿到 clip 的调用方（tts.js 的 playClip）会自己 createObjectURL, 所以这里每次都给新对象 ——
  // 复用同一个对象的话, 第一次播完 disposeClip 会把 blob / url 清掉, 第二次就播不出来了。
  async function clipOf(record) {
    if (!record) return null;
    // 历史遗留的宿主文件条目: 那种音频只在 Web Audio 总线之外出声（没有混响）, 页面也取不回字节。
    // 当未命中处理 ⇒ take() 会 drop 它（连带释放宿主文件）并重新合成一条带混响的。
    if (record.kind === "file") return null;
    if (!record.mediaId) return null;
    var stored = await app.data.media.get(record.mediaId);
    if (!stored || !stored.blob) return null;
    return { blob: stored.blob, mime: record.mime || stored.mime || "audio/mpeg", seconds: Number(record.seconds || 0), cached: true };
  }

  async function drop(record) {
    if (!record || !record.hash) return false;
    await app.data.store.remove(COLLECTION, record.hash).catch(function () {});
    if (record.mediaId) await app.data.media.remove(record.mediaId).catch(function () {});
    if (record.kind === "file" && record.logicalFileId && app.platform.haminn.available()) {
      await app.platform.haminn.api().files.delete({ logicalFileId: record.logicalFileId }).catch(function () {});
    }
    return true;
  }

  // 命中就把 usedAt 推到当前, LRU 才有意义（否则"最近用过"永远是"最近生成过"）。
  async function take(hash) {
    if (!hash) return null;
    try {
      var record = await app.data.store.get(COLLECTION, hash);
      if (!record) return null;
      var clip = await clipOf(record);
      // 记录还在但音频本体没了（用户清过缓存、或媒体库被清）⇒ 当未命中处理, 顺手把死记录清掉,
      // 不然它会一直占着 100 条的额度。
      if (!clip) { await drop(record); return null; }
      record.usedAt = Date.now();
      await app.data.store.put(COLLECTION, hash, record).catch(function () {});
      return clip;
    } catch (_) { return null; }
  }

  async function prune() {
    var values = await app.data.store.list(COLLECTION);
    if (!values || values.length <= MAX_ENTRIES) return 0;
    values.sort(function (left, right) { return Number(left && (left.usedAt || left.createdAt) || 0) - Number(right && (right.usedAt || right.createdAt) || 0); });
    var removed = 0;
    for (var index = 0; index < values.length - MAX_ENTRIES; index += 1) { if (await drop(values[index])) removed += 1; }
    return removed;
  }

  async function store(hash, clip, meta) {
    if (!hash || !clip) return false;
    meta = meta || {};
    try {
      var record = { hash: hash, kind: "", mime: clip.mime || "audio/mpeg", seconds: Number(clip.seconds || 0), chars: Number(meta.chars || 0), profileId: meta.profileId || "", createdAt: Date.now(), usedAt: Date.now() };
      // 只有宿主文件句柄的 clip 一律不进缓存（返回 false）。那种音频只在 Web Audio 总线之外出声,
      // 没有混响, 页面也取不回它的字节; 存下来只会是一条永远命中不了的死记录, 还要拖着宿主文件不放。
      // 返回 false 之后 synthesize 不会设 cacheOwned, 播完 disposeClip 就把宿主文件删掉, 一点不留。
      if (clip.blob) {
        // 用确定的 id（tts-cache:<hash>）而不是随机 id: 同一段音频被重复写入时是覆盖而不是再占一份。
        // transient: true ⇒ 只写 IndexedDB、**不进宿主文件库**。缓存音频是本地临时件：混响链是
        // Web Audio 的 decodeAudioData，必须拿到内存里的 Blob，宿主文件的对象地址喂不进去；
        // 它本来也不在备份里，搬过去换不来任何备份收益（见 app/data/media.js 顶部说明）。
        var mediaRecord = await app.data.media.put(clip.blob, { id: MEDIA_PREFIX + hash, kind: "audio", mime: record.mime, name: "tts-" + hash.slice(0, 12), transient: true });
        record.kind = "media"; record.mediaId = mediaRecord.id;
      } else return false;
      await app.data.store.put(COLLECTION, hash, record);
      await prune();
      return true;
    } catch (_) { return false; }
  }

  async function clear() {
    try {
      var values = await app.data.store.list(COLLECTION);
      for (var index = 0; index < (values || []).length; index += 1) await drop(values[index]);
      return true;
    } catch (_) { return false; }
  }

  async function count() {
    try { return (await app.data.store.list(COLLECTION)).length; } catch (_) { return 0; }
  }

  app.services = app.services || {};
  app.services.ttsCache = { keyFor: keyFor, take: take, store: store, clear: clear, count: count, drop: drop, MAX_ENTRIES: MAX_ENTRIES, COLLECTION: COLLECTION };
})(window.chataxi);
