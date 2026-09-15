(function (app) {
  "use strict";
  var databasePromise = null;


  function database() {
    if (!window.indexedDB) return Promise.resolve(null);
    if (databasePromise) return databasePromise;
    databasePromise = new Promise(function (resolve, reject) {
      var request = indexedDB.open("chataxi-media-v1", 1);
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains("media")) request.result.createObjectStore("media", { keyPath: "id" });
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("媒体数据库不可用")); };
    });
    return databasePromise;
  }

  async function put(blob, metadata) {
    var record = {
      id: (metadata && metadata.id) || app.utils.id("media"),
      blob: blob,
      mime: blob.type || (metadata && metadata.mime) || "application/octet-stream",
      name: (metadata && metadata.name) || "media",
      kind: (metadata && metadata.kind) || (/^video\//.test(blob.type || "") ? "video" : "image"),
      width: Number(metadata && metadata.width || 0),
      height: Number(metadata && metadata.height || 0),
      duration: Number(metadata && metadata.duration || 0),
      createdAt: Date.now()
    };
    var db = await database();
    if (!db) throw new Error("当前环境不能持久保存媒体，请在 HermitApp 中打开；文字对话仍可使用");
    await new Promise(function (resolve, reject) {
      var tx = db.transaction("media", "readwrite");
      tx.objectStore("media").put(record);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = tx.onabort = function () { reject(tx.error || new Error("媒体保存失败")); };
    });
    return record;
  }

  async function get(id) {
    var db = await database();
    if (!db) return null;
    return new Promise(function (resolve, reject) {
      var request = db.transaction("media", "readonly").objectStore("media").get(id);
      request.onsuccess = function () { resolve(request.result || null); };
      request.onerror = function () { reject(request.error); };
    });
  }

  async function remove(id) {
    var db = await database();
    if (!db) return;
    await new Promise(function (resolve, reject) {
      var tx = db.transaction("media", "readwrite");
      tx.objectStore("media").delete(id);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = tx.onabort = function () { reject(tx.error || new Error("图片删除失败")); };
    });
  }

  async function toDataUrl(id) {
    var record = await get(id);
    return record ? app.utils.blobToDataUrl(record.blob) : null;
  }

  app.data.media = { put: put, get: get, remove: remove, toDataUrl: toDataUrl };
})(window.chataxi);
