(function (app) {
  "use strict";
  // 全屏看图。气泡里的缩略图最高只有 213px，看不清细节 —— 点开铺满整屏，可以放大、平移。
  //
  // 只做五件事，别的都不做（收敛原则）：
  //   1. 单指平移 / 双指捏合缩放（以两指中点为锚，指哪放大哪）；
  //   2. 双击在「基线」与 2.5 倍之间切换；
  //   3. 点背景、点工具栏的关闭按钮、按 Esc 都关掉；
  //   4. **系统返回（含侧面滑动返回手势）也只关掉看图这一层**（业主 2026-09-27）；
  //   5. 打开时锁住页面滚动，关闭时**无条件还原**（不管是怎么关的）。
  //
  // 第 4 条靠历史栈实现：宿主对 happ 的返回处理是 `if (canGoBack()) goBack()`
  //（hermitapp 的 MainActivity.kt:373），也就是把返回交给 WebView 的历史。所以打开时压一条
  // **同 hash** 的记录 —— 同 hash 不触发 hashchange（路由不动），只会在返回时来一次 popstate，
  // 那就是"关闭看图"这一格。自己关掉时要把它收回，否则下一次返回会被它吃掉。
  //
  // 基线 = **高度充满**（业主 2026-09-27）：scale = 1 表示"图片高度正好等于屏幕高"，
  // 宽度按比例（CSS 的 height:100% + width:auto 做这件事，见 styles/app.css）。这样竖构图
  // 一打开就是铺满的；横构图 / 方图会横向溢出，溢出多少就能往两边平移多少 —— 所以下面
  // 的边界按"真实溢出量"算，而不是按"放大倍数 > 1 才算溢出"。双击回到的就是这个基线。
  //
  // 缩放上限 8 倍：再大也只是马赛克，而且手指稍微一动就会飞出画面。
  var MIN_SCALE = 1, MAX_SCALE = 8, DOUBLE_TAP_SCALE = 2.5, DOUBLE_TAP_MS = 320;
  var current = null;

  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

  function open(options) {
    var settings = options || {}, src = String(settings.src || "");
    if (!src) return Promise.resolve();
    if (current) current.close();
    var overlay = document.createElement("div");
    overlay.className = "image-viewer";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    // 底部工具栏（业主 2026-09-27 第二轮）：下载 / 设为背景 / 关闭。
    // **右上角那个单独的关闭按钮已经去掉, 底部的提示词也不再显示** —— 一切动作收在这一条磨砂
    // 工具栏里。所以这里只认两个回调: 调用方给不出能力的按钮直接隐藏（例如文字在 IndexedDB 里的
    // 旧图片导不出来）。下载与设为背景都不是这个组件该知道的事: 一个要走宿主文件库导出,
    // 一个要写对话记录, 都由调用方实现（chat.js）。
    overlay.innerHTML = '<div class="image-viewer-stage"><img alt="" referrerpolicy="no-referrer"></div>' +
      '<div class="image-viewer-toolbar" role="group" aria-label="图片操作">' +
      '<button type="button" class="image-viewer-action" data-viewer-action="download">' + app.components.icon("download") + '<span>下载</span></button>' +
      '<button type="button" class="image-viewer-action" data-viewer-action="background">' + app.components.icon("image") + '<span>设为背景</span></button>' +
      '<button type="button" class="image-viewer-action" data-viewer-action="close">' + app.components.icon("xmark") + '<span>关闭</span></button>' +
      '</div>';
    var stage = overlay.querySelector(".image-viewer-stage");
    var image = overlay.querySelector("img");
    var toolbar = overlay.querySelector(".image-viewer-toolbar");
    if (!settings.onDownload) toolbar.querySelector('[data-viewer-action="download"]').hidden = true;
    if (!settings.onSetBackground) toolbar.querySelector('[data-viewer-action="background"]').hidden = true;
    image.alt = String(settings.alt || "对话图片");
    image.src = src;

    var scale = MIN_SCALE, x = 0, y = 0, base = { width: 0, height: 0 };
    var pointers = {}, gesture = null, lastTap = 0, closed = false;
    var previousOverflow = document.body.style.overflow;

    function size() { return { width: image.offsetWidth || base.width, height: image.offsetHeight || base.height }; }
    // 舞台尺寸未知（老引擎 / 测试环境）时宁可不给平移范围，也不要算出 NaN 把图片推飞。
    function viewport() {
      var width = Number(stage.clientWidth) || Number(window.innerWidth) || 0;
      var height = Number(stage.clientHeight) || Number(window.innerHeight) || 0;
      return { width: width, height: height };
    }
    // 能不能平移，看的是"图片有没有比屏幕大"，而不是"有没有放大过"：高度充满的横构图一打开
    // 就已经横向溢出了，那时也该能拖。
    function canPan() {
      var box = size(), view = viewport();
      return (view.width > 0 && box.width * scale > view.width + 1) || (view.height > 0 && box.height * scale > view.height + 1);
    }
    function paint() {
      image.style.transform = "translate(" + x + "px," + y + "px) scale(" + scale + ")";
      stage.style.cursor = canPan() ? "grab" : "default";
    }
    // 平移边界：最多把图片推到刚好贴边，不能推出屏幕外（推出去就再也拉不回来）。
    // 用真实溢出量算，于是基线（scale = 1）下的横构图同样有左右可拉的范围，纵向则恒为 0。
    function bound() {
      var box = size(), view = viewport();
      var limitX = view.width > 0 ? Math.max(0, (box.width * scale - view.width) / 2) : 0;
      var limitY = view.height > 0 ? Math.max(0, (box.height * scale - view.height) / 2) : 0;
      x = clamp(x, -limitX, limitX); y = clamp(y, -limitY, limitY);
    }
    function reset() { scale = MIN_SCALE; x = 0; y = 0; bound(); paint(); }

    function zoomAt(next, anchorX, anchorY) {
      var target = clamp(next, MIN_SCALE, MAX_SCALE);
      if (target === scale) return;
      // 锚点不动：屏幕坐标 anchor 处的那一点在缩放前后落在同一个位置。
      var ratio = target / scale;
      x = anchorX - (anchorX - x) * ratio;
      y = anchorY - (anchorY - y) * ratio;
      scale = target;
      if (scale === MIN_SCALE) { x = 0; y = 0; }
      bound(); paint();
    }

    function local(event) { var box = stage.getBoundingClientRect(); return { x: event.clientX - box.left - box.width / 2, y: event.clientY - box.top - box.height / 2 }; }

    function down(event) {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      stage.setPointerCapture(event.pointerId);
      pointers[event.pointerId] = local(event);
      var ids = Object.keys(pointers);
      if (ids.length === 1) {
        gesture = { mode: "pan", startX: pointers[event.pointerId].x, startY: pointers[event.pointerId].y, originX: x, originY: y };
        if (canPan()) stage.style.cursor = "grabbing";
        var now = Date.now();
        if (now - lastTap < DOUBLE_TAP_MS) { lastTap = 0; zoomAt(scale > MIN_SCALE ? MIN_SCALE : DOUBLE_TAP_SCALE, pointers[event.pointerId].x, pointers[event.pointerId].y); gesture = null; }
        else lastTap = now;
      } else if (ids.length === 2) {
        var first = pointers[ids[0]], second = pointers[ids[1]];
        gesture = { mode: "pinch", distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)), scale: scale, midX: (first.x + second.x) / 2, midY: (first.y + second.y) / 2 };
        lastTap = 0;
      }
    }

    function move(event) {
      if (!pointers[event.pointerId] || !gesture) return;
      pointers[event.pointerId] = local(event);
      var ids = Object.keys(pointers);
      if (gesture.mode === "pan" && ids.length === 1) {
        // 不再用"放大过才给拖"当门槛：基线下的横构图本来就超出屏幕，边界由 bound() 按真实溢出量给。
        x = gesture.originX + pointers[event.pointerId].x - gesture.startX;
        y = gesture.originY + pointers[event.pointerId].y - gesture.startY;
        bound(); paint(); return;
      }
      if (gesture.mode === "pinch" && ids.length === 2) {
        var first = pointers[ids[0]], second = pointers[ids[1]];
        var distance = Math.max(1, Math.hypot(first.x - second.x, first.y - second.y));
        var midX = (first.x + second.x) / 2, midY = (first.y + second.y) / 2;
        zoomAt(gesture.scale * distance / gesture.distance, midX, midY);
        // 两指整体挪动时画面也跟着挪（捏合的同时拖拽是最自然的动作）。
        x = x + midX - gesture.midX; y = y + midY - gesture.midY;
        gesture.midX = midX; gesture.midY = midY; bound(); paint();
      }
    }

    function up(event) {
      delete pointers[event.pointerId];
      var ids = Object.keys(pointers);
      if (ids.length === 1) {
        // 双指松掉一根：立刻切回单指平移，否则画面会僵在捏合状态。
        gesture = { mode: "pan", startX: pointers[ids[0]].x, startY: pointers[ids[0]].y, originX: x, originY: y };
      } else if (!ids.length) { gesture = null; if (canPan()) stage.style.cursor = "grab"; }
    }

    function wheel(event) {
      event.preventDefault();
      var point = local(event);
      zoomAt(scale * (event.deltaY > 0 ? 0.85 : 1.18), point.x, point.y);
    }

    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", reset);
      window.removeEventListener("popstate", back);
      // 自己关掉（点关闭按钮 / 点背景 / Esc）时要把压进去的那一格收回来，
      // 否则下一次返回会被一个已经关掉的东西吃掉，用户得按两下才离开对话。
      if (pushed && history.state && history.state.chataxiImageViewer) history.back();
      document.body.style.overflow = previousOverflow;
      overlay.remove();
      current = null;
      resolve();
    }
    function keydown(event) { if (event.key === "Escape") close(); }
    // 系统返回（含侧滑）把历史栈退了一格，而那一格正是"看图"这一层；监听器已在 close() 里摘掉，
    // 所以自己调 history.back() 收格子时不会再进这里。
    function back() { close(); }

    // 工具栏动作只负责**转交**给调用方, 组件自己不碰对话与文件库。加一个在途闸: 导出会拉起系统
    // 的"保存到…"面板, 连点两下会叠出两层; 设为背景要写库, 重复提交也没有意义。
    // 失败由调用方处理（chat.js 那两个回调都过 ui.action, 会弹提示）, 这里只兜住未处理的拒绝。
    var acting = false;
    function runAction(handler) {
      if (!handler || acting) return;
      acting = true;
      Promise.resolve().then(handler).catch(function () {}).then(function () { acting = false; });
    }

    var resolve;
    var promise = new Promise(function (done) { resolve = done; });
    // 先压历史再挂监听：pushState 不会同步触发 popstate。历史 API 不可用（无 location 的测试
    // 环境）时静默退化成"返回不管用"，但看图本身照常。
    var pushed = false;
    try {
      history.pushState(Object.assign({}, history.state, { chataxiDepth: ((history.state && history.state.chataxiDepth) || 0) + 1, chataxiImageViewer: true }), "", location.hash);
      pushed = true;
      window.addEventListener("popstate", back);
    } catch (_) { pushed = false; }
    overlay.querySelector('[data-viewer-action="close"]').addEventListener("click", close);
    toolbar.querySelector('[data-viewer-action="download"]').addEventListener("click", function () { runAction(settings.onDownload); });
    toolbar.querySelector('[data-viewer-action="background"]').addEventListener("click", function () { runAction(settings.onSetBackground); });
    stage.addEventListener("pointerdown", down);
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerup", up);
    stage.addEventListener("pointercancel", up);
    // 双击由 pointerdown 的间隔自己判定；这里只挡掉浏览器原生的双击缩放。
    stage.addEventListener("dblclick", function (event) { event.preventDefault(); });
    stage.addEventListener("wheel", wheel, { passive: false });
    // 点背景关闭：只有点在图片之外才算，否则放大后想看四周就会误关。
    overlay.addEventListener("click", function (event) { if (event.target === stage) close(); });
    document.addEventListener("keydown", keydown);
    window.addEventListener("resize", reset);
    function measure() { base = { width: image.offsetWidth || image.naturalWidth, height: image.offsetHeight || image.naturalHeight }; bound(); paint(); }
    image.addEventListener("load", measure);
    document.body.appendChild(overlay);
    if (image.complete && image.naturalWidth) measure();
    document.body.style.overflow = "hidden";
    current = { close: close };
    paint();
    return promise;
  }

  function close() { if (current) current.close(); }

  app.components = app.components || {};
  app.components.imageViewer = { open: open, close: close };
})(window.chataxi);
