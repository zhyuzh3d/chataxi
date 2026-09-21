(function (app) {
  "use strict";
  var utils = app.utils;
  var toastTimer = null;
  var modal = null;
  var subsheet = null;

  function icon(name) { return '<i class="fa-solid fa-' + utils.escapeHtml(name) + '" aria-hidden="true"></i>'; }
  function copyUrl(url, label) {
    var value = String(url || "");
    return '<button class="copy-url" type="button" data-copy-url="' + utils.escapeHtml(value) + '" aria-label="' + utils.escapeHtml(label || "复制链接地址") + '">' + icon("copy") + '<code>' + utils.escapeHtml(value) + '</code></button>';
  }
  function bindCopyUrls(root) {
    (root || document).querySelectorAll("[data-copy-url]:not([data-copy-url-bound])").forEach(function (button) {
      button.setAttribute("data-copy-url-bound", "true");
      button.addEventListener("click", action(async function () { await app.platform.hermit.copyText(button.dataset.copyUrl); toast("地址已复制"); }));
    });
  }
  function avatar(name, color, className, iconName, mediaId) {
    var cleanName = String(name || "").trim();
    var label = cleanName ? Array.from(cleanName)[0].toUpperCase() : icon("user");
    var media = String(mediaId || "");
    return '<span class="avatar ' + utils.escapeHtml(className || "") + '"' + (media ? ' data-avatar-media="' + utils.escapeHtml(media) + '"' : '') + ' aria-hidden="true">' + (cleanName ? utils.escapeHtml(label) : label) + '</span>';
  }
  function roleAvatar(role, className) { return avatar(role && role.name, "", className, "", role && role.avatarMediaId); }
  async function hydrateAvatars(root) {
    var nodes = (root || document).querySelectorAll("[data-avatar-media]:not([data-avatar-loaded])");
    await Promise.all(Array.prototype.map.call(nodes, async function (node) {
      node.setAttribute("data-avatar-loaded", "loading");
      try {
        var dataUrl = await app.data.media.toDataUrl(node.dataset.avatarMedia);
        if (dataUrl && node.isConnected) { var image = document.createElement("img"); image.src = dataUrl; image.alt = ""; node.textContent = ""; node.appendChild(image); node.setAttribute("data-avatar-loaded", "true"); }
        else node.removeAttribute("data-avatar-loaded");
      } catch (_) { node.removeAttribute("data-avatar-loaded"); }
    }));
  }
  async function pickLocalImage() {
    if (app.platform.hermit.available()) {
      var files = app.platform.hermit.api().files;
      var picked = await files.pickImage({ maxDimension: 2000, maxBytes: 700 * 1024 });
      if (!picked || picked.cancelled) return null;
      if (!picked.url) { if (picked.logicalFileId && files.delete) await files.delete({ logicalFileId: picked.logicalFileId }).catch(function () {}); throw new Error("没有取得可用头像图片"); }
      var released = false;
      return {
        url: picked.url, type: picked.mime || "", size: Number(picked.size || 0), name: picked.name || "avatar.jpg",
        release: function () {
          if (released) return Promise.resolve(); released = true;
          if (!picked.logicalFileId || !files.delete) return Promise.resolve();
          return files.delete({ logicalFileId: picked.logicalFileId }).catch(function () {});
        }
      };
    }
    return new Promise(function (resolve) { var input = document.createElement("input"); input.type = "file"; input.accept = "image/jpeg,image/png,image/webp"; input.addEventListener("change", function () { resolve(input.files && input.files[0] || null); }, { once: true }); input.click(); });
  }
  function cropGeometry(imageWidth, imageHeight, frameSize, zoom, offsetX, offsetY) {
    var width = Number(imageWidth), height = Number(imageHeight), size = Math.max(1, Number(frameSize || 320));
    if (!(width > 0) || !(height > 0)) throw new Error("头像图片尺寸无效");
    var safeZoom = Math.max(1, Math.min(4, Number(zoom || 1))), baseScale = size / Math.min(width, height);
    var renderedWidth = width * baseScale * safeZoom, renderedHeight = height * baseScale * safeZoom;
    var limitX = Math.max(0, (renderedWidth - size) / 2), limitY = Math.max(0, (renderedHeight - size) / 2);
    var x = Math.max(-limitX, Math.min(limitX, Number(offsetX || 0))), y = Math.max(-limitY, Math.min(limitY, Number(offsetY || 0)));
    var scale = baseScale * safeZoom, sourceSize = Math.min(width, height, size / scale);
    var sourceX = Math.max(0, Math.min(width - sourceSize, width / 2 - x / scale - sourceSize / 2));
    var sourceY = Math.max(0, Math.min(height - sourceSize, height / 2 - y / scale - sourceSize / 2));
    return { zoom: safeZoom, x: x, y: y, baseWidth: width * baseScale, baseHeight: height * baseScale, renderedWidth: renderedWidth, renderedHeight: renderedHeight, sourceX: sourceX, sourceY: sourceY, sourceSize: sourceSize };
  }
  async function cropAvatar(source, onCropped) {
    var blob = source instanceof Blob ? source : null, mime = blob ? blob.type || "" : source && source.type || "", size = blob ? blob.size : Number(source && source.size || 0);
    var managedUrl = !blob && source && source.url ? String(source.url) : "", sourceUrl = blob ? URL.createObjectURL(blob) : managedUrl;
    var released = false, cleanup = [];
    function release() {
      if (released) return; released = true; cleanup.forEach(function (fn) { fn(); });
      if (blob && sourceUrl) URL.revokeObjectURL(sourceUrl);
      if (!blob && source && typeof source.release === "function") Promise.resolve(source.release()).catch(function () {});
    }
    if (!sourceUrl || !/^image\/(jpeg|png|webp)$/i.test(mime)) { release(); throw new Error("头像只支持 JPEG、PNG 或 WebP 图片"); }
    if (size > 20 * 1024 * 1024) { release(); throw new Error("头像原图不能超过 20 MiB"); }
    var image;
    try { image = await new Promise(function (resolve, reject) { var value = new Image(); value.onload = function () { resolve(value); }; value.onerror = function () { reject(new Error("头像图片无法读取")); }; value.src = sourceUrl; }); }
    catch (error) { release(); throw error; }
    var state = { zoom: 1, x: 0, y: 0 }, pointers = {}, gesture = null;
    var form = openSubsheet({ title: "调整头像", submitText: "使用头像", html: '<p class="helper crop-help">拖动图片对准蓝色正方形；双指捏合、滚轮或下方按钮可以缩放。</p><div class="crop-stage" data-crop-stage><canvas id="cropCanvas" aria-label="头像裁切预览"></canvas><span class="crop-frame" aria-hidden="true"><i class="crop-handle crop-handle-tl"></i><i class="crop-handle crop-handle-tr"></i><i class="crop-handle crop-handle-bl"></i><i class="crop-handle crop-handle-br"></i></span></div><div class="crop-toolbar"><button class="icon-button" type="button" data-crop-zoom="-0.15" aria-label="缩小头像">' + icon("minus") + '</button><output data-crop-output aria-live="polite">100%</output><button class="icon-button" type="button" data-crop-zoom="0.15" aria-label="放大头像">' + icon("plus") + '</button></div>', onDismiss: release, onSubmit: async function () {
      var geometry = cropGeometry(image.naturalWidth, image.naturalHeight, stage.getBoundingClientRect().width || 320, state.zoom, state.x, state.y);
      var canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 320;
      canvas.getContext("2d").drawImage(image, geometry.sourceX, geometry.sourceY, geometry.sourceSize, geometry.sourceSize, 0, 0, 320, 320);
      var output = await new Promise(function (resolve) { canvas.toBlob(resolve, "image/jpeg", 0.88); }); if (!output) throw new Error("头像裁切失败，请换一张图片"); return output;
    }, onSuccess: async function (output) { release(); await onCropped(output); } });
    var stage = form.querySelector("[data-crop-stage]"), preview = form.querySelector("#cropCanvas");
    function stageSize() { var width = stage.getBoundingClientRect().width; return width > 0 ? width : Math.min(420, Math.max(240, (document.documentElement.clientWidth || 364) - 44)); }
    function paint() {
      var size = stageSize(), geometry = cropGeometry(image.naturalWidth, image.naturalHeight, size, state.zoom, state.x, state.y), ratio = Math.max(1, Number(window.devicePixelRatio || 1));
      state.zoom = geometry.zoom; state.x = geometry.x; state.y = geometry.y;
      preview.width = Math.round(size * ratio); preview.height = Math.round(size * ratio);
      var context = preview.getContext("2d"); context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, size, size);
      context.drawImage(image, (size - geometry.renderedWidth) / 2 + state.x, (size - geometry.renderedHeight) / 2 + state.y, geometry.renderedWidth, geometry.renderedHeight);
      form.querySelector("[data-crop-output]").textContent = Math.round(state.zoom * 100) + "%";
    }
    function pointerList() { return Object.keys(pointers).map(function (key) { return pointers[key]; }); }
    function startGesture() { var points = pointerList(); if (points.length >= 2) { var left = points[0], right = points[1], dx = right.x - left.x, dy = right.y - left.y; gesture = { type: "pinch", distance: Math.max(1, Math.sqrt(dx * dx + dy * dy)), centerX: (left.x + right.x) / 2, centerY: (left.y + right.y) / 2, zoom: state.zoom, x: state.x, y: state.y }; } else if (points.length === 1) gesture = { type: "drag", pointerId: points[0].id, startX: points[0].x, startY: points[0].y, x: state.x, y: state.y }; else gesture = null; }
    function moveGesture(activeId) { var points = pointerList(); if (gesture && gesture.type === "pinch" && points.length >= 2) { var left = points[0], right = points[1], dx = right.x - left.x, dy = right.y - left.y, centerX = (left.x + right.x) / 2, centerY = (left.y + right.y) / 2; state.zoom = gesture.zoom * Math.sqrt(dx * dx + dy * dy) / gesture.distance; state.x = gesture.x + centerX - gesture.centerX; state.y = gesture.y + centerY - gesture.centerY; paint(); } else if (gesture && gesture.type === "drag" && gesture.pointerId === activeId && pointers[activeId]) { state.x = gesture.x + pointers[activeId].x - gesture.startX; state.y = gesture.y + pointers[activeId].y - gesture.startY; paint(); } }
    if ("PointerEvent" in window) {
      stage.addEventListener("pointerdown", function (event) { pointers[event.pointerId] = { id: event.pointerId, x: event.clientX, y: event.clientY }; try { stage.setPointerCapture(event.pointerId); } catch (_) {} startGesture(); });
      stage.addEventListener("pointermove", function (event) { if (!pointers[event.pointerId]) return; pointers[event.pointerId].x = event.clientX; pointers[event.pointerId].y = event.clientY; moveGesture(event.pointerId); });
      stage.addEventListener("pointerup", endPointer); stage.addEventListener("pointercancel", endPointer);
    } else {
      function readTouches(event) { Array.prototype.forEach.call(event.touches || [], function (touch) { pointers["touch-" + touch.identifier] = { id: "touch-" + touch.identifier, x: touch.clientX, y: touch.clientY }; }); }
      function touchStart(event) { readTouches(event); startGesture(); event.preventDefault(); }
      function touchMove(event) { readTouches(event); moveGesture(pointerList()[0] && pointerList()[0].id); event.preventDefault(); }
      function touchEnd(event) { pointers = {}; readTouches(event); startGesture(); event.preventDefault(); }
      var mouseDown = false;
      function mouseMove(event) { if (!mouseDown) return; pointers.mouse.x = event.clientX; pointers.mouse.y = event.clientY; moveGesture("mouse"); }
      function mouseUp() { if (!mouseDown) return; mouseDown = false; pointers = {}; startGesture(); }
      stage.addEventListener("touchstart", touchStart, { passive: false }); stage.addEventListener("touchmove", touchMove, { passive: false }); stage.addEventListener("touchend", touchEnd, { passive: false }); stage.addEventListener("touchcancel", touchEnd, { passive: false });
      stage.addEventListener("mousedown", function (event) { mouseDown = true; pointers.mouse = { id: "mouse", x: event.clientX, y: event.clientY }; startGesture(); event.preventDefault(); }); document.addEventListener("mousemove", mouseMove); document.addEventListener("mouseup", mouseUp); cleanup.push(function () { document.removeEventListener("mousemove", mouseMove); document.removeEventListener("mouseup", mouseUp); });
    }
    function endPointer(event) { delete pointers[event.pointerId]; startGesture(); }
    stage.addEventListener("wheel", function (event) { event.preventDefault(); state.zoom += event.deltaY < 0 ? 0.12 : -0.12; paint(); }, { passive: false });
    form.querySelectorAll("[data-crop-zoom]").forEach(function (button) { button.addEventListener("click", function () { state.zoom += Number(button.dataset.cropZoom); paint(); }); });
    var repaint = function () { if (!released && stage.isConnected) paint(); }; window.addEventListener("resize", repaint); cleanup.push(function () { window.removeEventListener("resize", repaint); }); paint(); if (window.requestAnimationFrame) window.requestAnimationFrame(repaint);
  }
  function toast(message, duration) {
    var root = document.getElementById("toastRoot");
    clearTimeout(toastTimer);
    root.innerHTML = '<div class="toast" role="status">' + utils.escapeHtml(message) + '</div>';
    toastTimer = setTimeout(function () { root.innerHTML = ""; }, duration || 3200);
  }
  function action(fn) {
    return function () {
      var result;
      try { result = fn.apply(this, arguments); }
      catch (error) { toast(utils.cleanError(error), 5000); return; }
      return Promise.resolve(result).catch(function (error) { toast(utils.cleanError(error), 5000); });
    };
  }
  function closeSubsheet(force, submitted) {
    if (!subsheet || (subsheet.busy && force !== true)) return;
    var previous = subsheet; subsheet = null;
    document.removeEventListener("keydown", previous.keydown, true);
    previous.layer.remove();
    if (previous.focus && previous.focus.isConnected) previous.focus.focus();
    if (!modal) { document.getElementById("appShell").removeAttribute("aria-hidden"); document.body.classList.remove("modal-open"); }
    if (!submitted && previous.options.onDismiss) previous.options.onDismiss();
  }
  function closeModal(force, submitted) {
    if (subsheet) closeSubsheet(true);
    if (!modal || (modal.busy && force !== true)) return;
    var previous = modal;
    modal = null;
    document.getElementById("modalRoot").innerHTML = "";
    document.getElementById("appShell").removeAttribute("aria-hidden");
    document.body.classList.remove("modal-open");
    document.removeEventListener("keydown", previous.keydown, true);
    if (previous.focus && previous.focus.isConnected) previous.focus.focus();
    if (!submitted && previous.options.onDismiss) previous.options.onDismiss();
  }
  function openModal(options) {
    closeModal(true);
    var root = document.getElementById("modalRoot");
    var current = { options: options, focus: document.activeElement, busy: false };
    modal = current;
    root.innerHTML = '<div class="modal-backdrop"><section class="modal-sheet" role="dialog" aria-modal="true" aria-labelledby="modalTitle" tabindex="-1">' +
      '<div class="modal-handle" aria-hidden="true"></div><header class="modal-head"><h2 id="modalTitle">' + utils.escapeHtml(options.title) + '</h2><button class="icon-button" type="button" data-close-modal aria-label="关闭">' + icon("xmark") + '</button></header>' +
      '<form id="modalForm"><div class="modal-body">' + options.html + '</div><div class="modal-actions">' +
      (options.cancelText === null ? '' : '<button class="button secondary" type="button" data-close-modal>' + utils.escapeHtml(options.cancelText || "取消") + '</button>') +
      '<button class="button ' + (options.danger ? 'danger' : 'primary') + '" id="modalSubmit" type="submit">' + utils.escapeHtml(options.submitText || "保存") + '</button></div></form></section></div>';
    document.body.classList.add("modal-open");
    document.getElementById("appShell").setAttribute("aria-hidden", "true");
    var form = document.getElementById("modalForm");
    form.querySelectorAll("[name]").forEach(function (field) { if (!field.id) field.id = "field-" + field.name.replace(/[^a-zA-Z0-9_-]/g, "-"); });
    root.querySelectorAll("[data-close-modal]").forEach(function (button) { button.addEventListener("click", function () { closeModal(); }); });
    root.querySelector(".modal-backdrop").addEventListener("click", function (event) { if (event.target === event.currentTarget) closeModal(); });
    current.keydown = function (event) {
      if (subsheet) return;
      if (event.key === "Escape") { event.preventDefault(); closeModal(); }
      if (event.key !== "Tab") return;
      var focusable = Array.prototype.filter.call(root.querySelectorAll('button, input, select, textarea, summary, [tabindex="0"]'), function (item) { return !item.disabled && item.getClientRects().length; });
      if (!focusable.length) { event.preventDefault(); return; }
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || focusable.indexOf(document.activeElement) < 0)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || focusable.indexOf(document.activeElement) < 0)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", current.keydown, true);
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (current.busy) return;
      current.busy = true;
      var buttons = root.querySelectorAll(".modal-actions button, [data-close-modal]");
      buttons.forEach(function (button) { button.disabled = true; });
      var submit = form.querySelector('[type="submit"]');
      var label = submit.textContent; submit.textContent = "正在保存…";
      try {
        var value = await options.onSubmit(form);
        if (value !== false && modal === current) {
          closeModal(true, true);
          if (options.onSuccess) await options.onSuccess(value);
        }
      } catch (error) {
        if (modal !== current) { toast(utils.cleanError(error), 5000); return; }
        var existing = form.querySelector(".form-error");
        if (!existing) { existing = document.createElement("div"); existing.className = "error-box form-error"; existing.setAttribute("role", "alert"); existing.tabIndex = -1; form.querySelector(".modal-body").prepend(existing); }
        existing.textContent = utils.cleanError(error); existing.focus();
      } finally {
        current.busy = false; submit.textContent = label;
        buttons.forEach(function (button) { button.disabled = false; });
      }
    });
    // Focus the dialog heading without raising the mobile keyboard before the user chooses a field.
    root.querySelector(".modal-sheet").focus();
    return form;
  }
  function openSubsheet(options) {
    closeSubsheet(true);
    var root = document.getElementById("modalRoot"), layer = document.createElement("div");
    var current = { options: options, focus: document.activeElement, busy: false, layer: layer };
    subsheet = current;
    layer.className = "modal-backdrop subsheet-backdrop";
    layer.innerHTML = '<section class="modal-sheet subsheet" role="dialog" aria-modal="true" tabindex="-1"><div class="modal-handle" aria-hidden="true"></div><header class="modal-head"><h2>' + utils.escapeHtml(options.title) + '</h2><button class="icon-button" type="button" data-close-subsheet aria-label="关闭">' + icon("xmark") + '</button></header><form class="subsheet-form"><div class="modal-body">' + options.html + '</div><div class="modal-actions">' + (options.cancelText === null ? '' : '<button class="button secondary" type="button" data-close-subsheet>' + utils.escapeHtml(options.cancelText || "取消") + '</button>') + (options.submitText === null ? '' : '<button class="button ' + (options.danger ? 'danger' : 'primary') + '" type="submit">' + utils.escapeHtml(options.submitText || "完成") + '</button>') + '</div></form></section>';
    root.appendChild(layer); document.body.classList.add("modal-open"); document.getElementById("appShell").setAttribute("aria-hidden", "true");
    var form = layer.querySelector("form");
    form.querySelectorAll("[name]").forEach(function (field) { if (!field.id) field.id = "subfield-" + field.name.replace(/[^a-zA-Z0-9_-]/g, "-"); });
    layer.querySelectorAll("[data-close-subsheet]").forEach(function (button) { button.addEventListener("click", function () { closeSubsheet(); }); });
    layer.addEventListener("click", function (event) { if (event.target === layer) closeSubsheet(); });
    current.keydown = function (event) { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeSubsheet(); } };
    document.addEventListener("keydown", current.keydown, true);
    form.addEventListener("submit", async function (event) {
      event.preventDefault(); if (current.busy) return; current.busy = true;
      var buttons = layer.querySelectorAll("button"); buttons.forEach(function (button) { button.disabled = true; });
      try { var value = options.onSubmit ? await options.onSubmit(form) : true; if (value !== false && subsheet === current) { closeSubsheet(true, true); if (options.onSuccess) await options.onSuccess(value); } }
      catch (error) { if (subsheet !== current) { toast(utils.cleanError(error), 5000); return; } var box = form.querySelector(".form-error"); if (!box) { box = document.createElement("div"); box.className = "error-box form-error"; box.setAttribute("role", "alert"); form.querySelector(".modal-body").prepend(box); } box.textContent = utils.cleanError(error); }
      finally { current.busy = false; buttons.forEach(function (button) { button.disabled = false; }); }
    });
    layer.querySelector(".modal-sheet").focus(); return form;
  }
  function choose(options) {
    return new Promise(function (resolve) {
      var settled = false;
      function finish(value) { if (settled) return; settled = true; resolve(value); }
      var items = options.items || [];
      var html = '<div class="menu-list choice-sheet-list"></div>' + (options.refresh ? '<button class="button ghost full choice-refresh" type="button">' + icon("arrows-rotate") + utils.escapeHtml(options.refreshText || "刷新列表") + '</button>' : '');
      var form = openSubsheet({ title: options.title || "请选择", html: html, submitText: null, onDismiss: function () { finish(null); } });
      function paint() {
        var list = form.querySelector(".choice-sheet-list");
        var lastGroup = null;
        list.innerHTML = items.length ? items.map(function (item) {
          var heading = item.group && item.group !== lastGroup ? '<p class="choice-group-label">' + utils.escapeHtml(item.group) + '</p>' : '';
          if (item.group) lastGroup = item.group;
          return heading + '<button class="menu-item" type="button" data-choice="' + utils.escapeHtml(item.id) + '"' + (item.disabled ? ' disabled aria-disabled="true"' : '') + '><span>' + utils.escapeHtml(item.name || item.id) + '</span>' + (item.id === options.selected ? icon("check") : '') + '</button>';
        }).join("") : '<p class="helper choice-empty">暂无可选项</p>';
        list.querySelectorAll("[data-choice]").forEach(function (button) { button.addEventListener("click", function () { var value = button.dataset.choice; closeSubsheet(true, true); finish(value); }); });
      }
      paint();
      var refresh = form.querySelector(".choice-refresh");
      if (refresh) refresh.addEventListener("click", action(async function () { refresh.disabled = true; try { items = await options.refresh(); paint(); } finally { if (refresh.isConnected) refresh.disabled = false; } }));
    });
  }
  function picker(name, label, selectedLabel, help) {
    return '<label class="field picker-field"><span>' + utils.escapeHtml(label) + '</span><input type="hidden" name="' + utils.escapeHtml(name) + '"><button class="picker-button" type="button" data-picker="' + utils.escapeHtml(name) + '" data-picker-title="' + utils.escapeHtml(label) + '"><span data-picker-label>' + utils.escapeHtml(selectedLabel || "请选择") + '</span>' + icon("chevron-down") + '</button>' + (help ? '<small>' + utils.escapeHtml(help) + '</small>' : '') + '</label>';
  }
  function bindPicker(form, name, items, selected, options) {
    var input = form.elements.namedItem(name), button = form.querySelector('[data-picker="' + name + '"]'), currentItems = items || [];
    input.value = selected || "";
    function paint() { var item = currentItems.find(function (entry) { return entry.id === input.value; }); button.querySelector("[data-picker-label]").textContent = item ? item.name || item.id : options && options.emptyLabel || "请选择"; button.disabled = Boolean(options && options.disabled); }
    button.addEventListener("click", action(async function () {
      var refreshItems = options && options.refresh ? async function () { currentItems = await options.refresh(); return currentItems; } : null;
      var value = await choose({ title: button.dataset.pickerTitle, items: currentItems, selected: input.value, refresh: refreshItems, refreshText: options && options.refreshText });
      if (value == null) return; input.value = value; paint(); input.dispatchEvent(new Event("change", { bubbles: true }));
    }));
    paint();
    return { setItems: function (next, nextValue) { currentItems = next || []; if (nextValue !== undefined) input.value = nextValue; if (!currentItems.some(function (item) { return item.id === input.value; })) input.value = options && options.allowEmpty ? "" : (currentItems[0] || {}).id || ""; paint(); }, setDisabled: function (value) { options = Object.assign({}, options, { disabled: value }); paint(); }, setRefresh: function (refresh, label) { options = Object.assign({}, options, { refresh: refresh || null, refreshText: label || "刷新列表" }); }, value: function () { return input.value; } };
  }
  function confirm(options) {
    return new Promise(function (resolve) {
      var open = modal ? openSubsheet : openModal;
      open({ title: options.title || "请确认", html: '<p class="dialog-copy">' + utils.escapeHtml(options.message || "确定继续吗？") + '</p>', submitText: options.confirmText || "确定", danger: Boolean(options.danger), onDismiss: function () { resolve(false); }, onSubmit: function () { return true; }, onSuccess: function () { resolve(true); } });
    });
  }
  function empty(iconName, title, text, actionHtml) {
    return '<div class="empty-state"><div class="empty-state-inner"><div class="empty-icon">' + icon(iconName) + '</div><h2>' + utils.escapeHtml(title) + '</h2><p>' + utils.escapeHtml(text) + '</p>' + (actionHtml || "") + '</div></div>';
  }
  function pageHeader(title, subtitle, actions) {
    document.getElementById("pageTitle").textContent = title;
    document.getElementById("pageSubtitle").textContent = subtitle;
    document.getElementById("topbarActions").innerHTML = actions || "";
  }
  function search(placeholder) {
    return '<label class="search-field">' + icon("magnifying-glass") + '<input type="search" id="listSearch" aria-label="' + utils.escapeHtml(placeholder) + '" placeholder="' + utils.escapeHtml(placeholder) + '"></label>';
  }
  app.components = { icon: icon, copyUrl: copyUrl, bindCopyUrls: bindCopyUrls, avatar: avatar, roleAvatar: roleAvatar, hydrateAvatars: hydrateAvatars, pickLocalImage: pickLocalImage, cropAvatar: cropAvatar, cropGeometry: cropGeometry, toast: toast, action: action, openModal: openModal, closeModal: closeModal, openSubsheet: openSubsheet, closeSubsheet: closeSubsheet, choose: choose, picker: picker, bindPicker: bindPicker, confirm: confirm, empty: empty, pageHeader: pageHeader, search: search };
})(window.chataxi);
