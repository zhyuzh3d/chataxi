(function (app) {
  "use strict";
  async function compress(file) {
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(file.type)) throw new Error("只支持 JPEG、PNG、WebP 或 GIF 图片");
    if (file.size > 30 * 1024 * 1024) throw new Error("原图超过 30 MiB，请选择较小的图片");
    var sourceUrl = URL.createObjectURL(file);
    try {
      var image = await new Promise(function (resolve, reject) {
        var element = new Image();
        element.onload = function () { resolve(element); };
        element.onerror = function () { reject(new Error("图片无法读取")); };
        element.src = sourceUrl;
      });
      var longest = Math.max(image.naturalWidth, image.naturalHeight);
      var scale = Math.min(1, 1280 / Math.max(1, longest));
      var width = Math.max(1, Math.round(image.naturalWidth * scale));
      var height = Math.max(1, Math.round(image.naturalHeight * scale));
      var output = null;
      for (var attempt = 0; attempt < 5; attempt += 1) {
        var canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        var context = canvas.getContext("2d");
        context.fillStyle = "#ffffff"; context.fillRect(0, 0, width, height); context.drawImage(image, 0, 0, width, height);
        output = await new Promise(function (resolve) { canvas.toBlob(resolve, "image/jpeg", Math.max(0.56, 0.84 - attempt * 0.07)); });
        if (output && output.size <= 420 * 1024) break;
        width = Math.max(1, Math.round(width * 0.82)); height = Math.max(1, Math.round(height * 0.82));
      }
      if (!output || output.size > 520 * 1024) throw new Error("图片压缩后仍过大，请选择尺寸更小的图片");
      var record = await app.data.media.put(output, { name: file.name.replace(/\.[^.]+$/, "") + ".jpg", mime: "image/jpeg" });
      return { mediaId: record.id, mime: record.mime, name: record.name, size: output.size, alt: "用户选择的图片" };
    } finally { URL.revokeObjectURL(sourceUrl); }
  }

  app.services.images = { compress: compress };
})(window.chataxi);
