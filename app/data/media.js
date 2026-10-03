(function (app) {
  "use strict";
  // 媒体层（0.7.26 起：宿主文件库优先）
  //
  // 为什么必须改：宿主的备份边界**不含 IndexedDB**（haminnapp-product-technical-design.md:415
  // 明写"Web 存储须接受其备份边界"），而恢复会保留实例域内的 logicalFileId（:538，"使任意
  // JSON 中的附件引用仍成立"）⇒ 只有把字节放进宿主文件库、引用写成 logicalFileId，
  // 头像 / 个人头像 / 对话头像 / 对话背景 / 消息图片 / 生成图 / 定妆照才能在"导出备份 →
  // 换实例恢复"之后仍然在。对话背景本来就已经这么做了（chat.js 的 background.url +
  // logicalFileId），这里只是把它变成**全部用户媒体**的统一路径。
  //
  // 三种存放，对外 API 不变（put / get / remove / toDataUrl），另加 displayUrl 与 migrate：
  //   host   字节在宿主文件库；索引记录写在宿主集合 `media`（经 app.data.store，所以宿主
  //          后端与浏览器 localStorage 预览都能跑），记录里带 logicalFileId / url / size /
  //          sha256。显示时直接用 url（同源对象地址），**不用取字节**。
  //   blob   字节在 IndexedDB。两种来源：(a) 旧格式记录，读到就惰性搬进宿主文件库；
  //          (b) metadata.transient === true 的临时件 —— TTS 音频缓存走这条
  //          （混响链是 Web Audio 的 decodeAudioData，必须拿到内存里的 Blob，
  //          宿主文件的对象地址喂不进去，见 tts-cache.js:64-73），不进备份是预期行为。
  //   无宿主（浏览器预览）一切照旧走 IndexedDB。
  var DATABASE = "chataxi-media-v1";
  var INDEX = "media";
  var MIGRATION_KEY = "media-host-migration";
  var MIGRATION_VERSION = 1;
  // 单次 appendBytes 的硬上限是 256 KiB，Base64 每 3 字节涨到 4 字节 ⇒ 48 KiB 原始字节
  // 编码后正好 64 KiB，压在宿主给的 maxChunkBytes 之内。
  var CHUNK_CEILING = 48 * 1024;
  var databasePromise = null;
  var migrationPromise = null;
  var objectUrls = {};

  function hostFiles() {
    var api = app.platform.haminn.available() ? app.platform.haminn.api() : null;
    if (!api || !api.files) return null;
    var files = api.files;
    return typeof files.beginWrite === "function" && typeof files.appendBytes === "function" && typeof files.finishWrite === "function" ? files : null;
  }
  function hostReady() { return Boolean(hostFiles()); }
  function objectAddress(logicalFileId) { return "/__haminn/files/" + String(logicalFileId || ""); }

  function database() {
    if (!window.indexedDB) return Promise.resolve(null);
    if (databasePromise) return databasePromise;
    databasePromise = new Promise(function (resolve, reject) {
      var request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains("media")) request.result.createObjectStore("media", { keyPath: "id" });
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("媒体数据库不可用")); };
    });
    return databasePromise;
  }

  async function blobWrite(record) {
    var db = await database();
    if (!db) throw new Error("当前环境不能持久保存媒体，请在 HaminnApp 中打开；文字对话仍可使用");
    await new Promise(function (resolve, reject) {
      var tx = db.transaction("media", "readwrite");
      tx.objectStore("media").put(record);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = tx.onabort = function () { reject(tx.error || new Error("媒体保存失败")); };
    });
    return record;
  }

  async function blobRead(id) {
    var db = await database();
    if (!db) return null;
    return new Promise(function (resolve, reject) {
      var request = db.transaction("media", "readonly").objectStore("media").get(id);
      request.onsuccess = function () { resolve(request.result || null); };
      request.onerror = function () { reject(request.error); };
    });
  }

  async function blobDelete(id) {
    var db = await database();
    if (!db) return;
    await new Promise(function (resolve, reject) {
      var tx = db.transaction("media", "readwrite");
      tx.objectStore("media").delete(id);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = tx.onabort = function () { reject(tx.error || new Error("图片删除失败")); };
    });
  }

  async function blobList() {
    var db = await database();
    if (!db) return [];
    return new Promise(function (resolve, reject) {
      var request = db.transaction("media", "readonly").objectStore("media").getAll();
      request.onsuccess = function () { resolve(request.result || []); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function blobBytes(blob) {
    if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer().then(function (buffer) { return new Uint8Array(buffer); });
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(new Uint8Array(reader.result)); };
      reader.onerror = function () { reject(reader.error || new Error("无法读取文件")); };
      reader.readAsArrayBuffer(blob);
    });
  }

  // 写入宿主文件库：beginWrite → appendBytes ×N → finishWrite。中途任何一步失败都 abortWrite，
  // 不留下半个对象（宿主文档 docs/webapp-authoring.md:210-224 的协议要求）。
  async function uploadBlob(blob, name) {
    var files = hostFiles();
    if (!files) throw new Error("宿主文件库不可用，媒体没有保存");
    var started = await files.beginWrite({ name: name || "media", mime: blob.type || "application/octet-stream" });
    var writeId = started && started.writeId;
    if (!writeId) throw new Error("宿主没有返回写入句柄，媒体没有保存");
    var chunk = Math.max(1024, Math.min(CHUNK_CEILING, Number(started.maxChunkBytes) || CHUNK_CEILING));
    try {
      var offset = 0, total = Number(blob.size || 0);
      do {
        var bytes = await blobBytes(blob.slice(offset, Math.min(offset + chunk, total)));
        if (!bytes.length) break;
        await files.appendBytes({ writeId: writeId, chunkBase64: app.utils.bytesToBase64(bytes) });
        offset += bytes.length;
      } while (offset < total);
      return await files.finishWrite({ writeId: writeId });
    } catch (error) {
      if (typeof files.abortWrite === "function") await files.abortWrite({ writeId: writeId }).catch(function () {});
      throw error;
    }
  }

  function hostRecord(record, file) {
    var next = Object.assign({}, record, {
      store: "host",
      logicalFileId: String(file.logicalFileId || ""),
      url: String(file.url || ""),
      sha256: String(file.sha256 || "")
    });
    if (file.name) next.name = String(file.name);
    if (file.mime) next.mime = String(file.mime);
    if (Number(file.size) > 0) next.size = Number(file.size);
    if (!next.logicalFileId) throw new Error("宿主没有返回文件标识，媒体没有保存");
    if (!next.url) next.url = objectAddress(next.logicalFileId);
    return next;
  }

  async function deleteHostFile(record) {
    var files = hostFiles();
    if (!record || !record.logicalFileId) return;
    if (!files || typeof files.delete !== "function") throw new Error("宿主文件库当前不可用，原图没有删除");
    await files.delete({ logicalFileId: record.logicalFileId });
  }

  async function put(blob, metadata) {
    var options = metadata || {};
    var mime = blob.type || options.mime || "application/octet-stream";
    var record = {
      id: options.id || app.utils.id("media"),
      mime: mime,
      name: options.name || "media",
      kind: options.kind || (/^video\//.test(blob.type || "") ? "video" : "image"),
      size: Number(blob.size || 0),
      width: Number(options.width || 0),
      height: Number(options.height || 0),
      duration: Number(options.duration || 0),
      createdAt: Date.now()
    };
    if (options.transient === true || !hostReady()) {
      var stored = Object.assign({}, record, { store: "blob" });
      await blobWrite(Object.assign({}, stored, { blob: blob }));
      return stored;
    }
    var file = await uploadBlob(blob, record.name);
    var host = hostRecord(record, file);
    try { await app.data.store.put(INDEX, host.id, host); }
    catch (error) { await deleteHostFile(host).catch(function () {}); throw error; }
    return host;
  }

  // 旧 IndexedDB 记录 → 宿主文件库。id 不变，所以 role.avatarMediaId / message.media[].mediaId
  // 这类引用一个字都不用改；成功后才删掉 IndexedDB 副本。
  async function adopt(legacy) {
    if (!legacy || !legacy.blob) return null;
    var file = await uploadBlob(legacy.blob, legacy.name);
    var host = hostRecord({ id: legacy.id, mime: legacy.mime, name: legacy.name, kind: legacy.kind, size: legacy.size, width: legacy.width, height: legacy.height, duration: legacy.duration, createdAt: legacy.createdAt }, file);
    await app.data.store.put(INDEX, host.id, host);
    await blobDelete(legacy.id).catch(function () {});
    return host;
  }

  async function get(id) {
    if (!id) return null;
    var indexed = await app.data.store.get(INDEX, id).catch(function () { return null; });
    if (indexed) return indexed;
    var legacy = await blobRead(id);
    if (!legacy) return null;
    if (legacy.store === "blob" || !hostReady()) return legacy;
    try { return await adopt(legacy) || legacy; } catch (_) { return legacy; }
  }

  async function remove(id) {
    if (!id) return;
    var indexed = await app.data.store.get(INDEX, id).catch(function () { return null; });
    if (indexed) {
      await deleteHostFile(indexed);
      await app.data.store.remove(INDEX, id);
    }
    await blobDelete(id);
    releaseObjectUrl(id);
  }

  function releaseObjectUrl(id) {
    var url = objectUrls[id];
    if (!url) return;
    delete objectUrls[id];
    try { URL.revokeObjectURL(url); } catch (_) {}
  }

  // 显示用的地址：宿主记录直接用对象地址（同源、CSP 允许、恢复后仍成立）；
  // 临时/旧记录退化成缓存过的 objectURL。
  function urlOf(record) {
    if (!record) return "";
    if (record.url) return String(record.url);
    if (record.logicalFileId) return objectAddress(record.logicalFileId);
    if (record.blob) {
      if (!objectUrls[record.id]) {
        try { objectUrls[record.id] = URL.createObjectURL(record.blob); } catch (_) { return ""; }
      }
      return objectUrls[record.id];
    }
    return "";
  }

  async function displayUrl(value) {
    if (!value) return "";
    if (typeof value === "string") { var record = await get(value); return record ? urlOf(record) : ""; }
    if (value.mediaId) { var stored = await get(value.mediaId); var url = stored ? urlOf(stored) : ""; if (url) return url; }
    if (value.url) return String(value.url);
    if (value.logicalFileId) return objectAddress(value.logicalFileId);
    return "";
  }

  // 送进模型 / 存成 base64 时才需要真字节：同源 <img> 载入 → canvas → dataURL。
  // 不能 fetch —— happ 页面的 CSP 是 connect-src 'none'（LocalContentGateway.kt:104），
  // 同源图片走的是 img-src（被 default-src 'self' 覆盖），两条路互不干涉。
  function imageDataUrl(url, mime) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.onload = function () {
        try {
          var canvas = document.createElement("canvas");
          canvas.width = Math.max(1, image.naturalWidth); canvas.height = Math.max(1, image.naturalHeight);
          canvas.getContext("2d").drawImage(image, 0, 0);
          var type = /^image\/(png|jpeg|webp)$/i.test(String(mime || "")) ? String(mime).toLowerCase() : "image/jpeg";
          resolve(canvas.toDataURL(type, 0.92));
        } catch (error) { reject(error); }
      };
      image.onerror = function () { reject(new Error("图片无法读取")); };
      image.src = url;
    });
  }

  async function toDataUrl(id) {
    var record = await get(id);
    if (!record) return null;
    if (record.blob) return app.utils.blobToDataUrl(record.blob);
    var url = urlOf(record);
    return url ? imageDataUrl(url, record.mime) : null;
  }

  function migrate() {
    if (migrationPromise) return migrationPromise;
    migrationPromise = runMigration().catch(function (error) { migrationPromise = null; throw error; });
    return migrationPromise;
  }

  // 启动时的一次性全量搬迁：把"从没被打开过"的旧头像 / 旧图片也搬进宿主文件库，
  // 而不是等某一条被读到才搬。失败就保留原数据并如实报告（不置标记 ⇒ 下次启动重试）。
  async function runMigration() {
    if (!hostReady()) return { host: false, migrated: 0, failed: 0 };
    var flag = await app.data.store.get("meta", MIGRATION_KEY).catch(function () { return null; });
    if (flag && Number(flag.version) === MIGRATION_VERSION) return { host: true, migrated: 0, failed: 0, skipped: true };
    var records = await blobList().catch(function () { return []; });
    var migrated = 0, failed = 0;
    for (var index = 0; index < records.length; index += 1) {
      var legacy = records[index];
      if (!legacy || !legacy.id || legacy.store === "blob") continue;
      var existing = await app.data.store.get(INDEX, legacy.id).catch(function () { return null; });
      if (existing) { await blobDelete(legacy.id).catch(function () {}); migrated += 1; continue; }
      try { await adopt(legacy); migrated += 1; } catch (_) { failed += 1; }
    }
    if (!failed) await app.data.store.put("meta", MIGRATION_KEY, { version: MIGRATION_VERSION, migrated: migrated, updatedAt: Date.now() }).catch(function () {});
    return { host: true, migrated: migrated, failed: failed };
  }

  app.data.media = {
    put: put,
    get: get,
    remove: remove,
    toDataUrl: toDataUrl,
    displayUrl: displayUrl,
    migrate: migrate,
    hostReady: hostReady,
    objectAddress: objectAddress
  };
})(window.chataxi);
