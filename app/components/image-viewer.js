(function (app) {
  "use strict";
  // 全屏看图。气泡里的缩略图最高只有 213px，看不清细节 —— 点开铺满整屏，可以放大、平移。
  //
  // 只做八件事，别的都不做（收敛原则）：
  //   1. 单指平移 / 双指捏合缩放（以两指中点为锚，指哪放大哪）；
  //   2. 双击在「基线」与 2.5 倍之间切换；
  //   3. **点画面一下 → 底部工具栏与左侧画廊侧栏的显隐切换**（业主 2026-09-27 第六轮）；
  //   4. **底部工具栏最左边是「画廊」**：点开从屏幕左侧推出一条圆角侧栏（左边两角是直角），
  //      列出这一组图片的缩略小图，点一张就换着看（业主 2026-09-27 第六轮）；
  //   5. **未放大时上下滑动 → 上一张 / 下一张**（同上）；
  //   6. 点工具栏的关闭按钮、按 Esc、系统返回（含侧面滑动返回手势）都关掉；
  //   7. 打开时锁住页面滚动，关闭时**无条件还原**（不管是怎么关的）；
  //   8. 换图时把下载 / 设为背景两个动作**跟着换成这一张的**（不然切到第二张再按「下载」，
  //      存下来的还是第一张）。
  //
  // **「点背景关闭」已经被第 3 条取代**：同一个"点一下"不可能既是关闭又是切控件，业主
  // 2026-09-27 第六轮明确要的是切控件。关闭仍有三个入口 —— 工具栏的关闭按钮 / Esc / 系统返回。
  //
  // 第 6 条里的系统返回靠历史栈实现：宿主对 happ 的返回处理是 `if (canGoBack()) goBack()`
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
  // 换图的门槛与判定：
  //   SWIPE_MIN —— 纵向划出这么多像素才算"要换一张"，以下当作手抖（松手回位）；
  //   AXIS_MIN  —— 划出这么多像素才定轴（横着划还是竖着划），免得手指刚落下就误判；
  //   TAP_SLOP  —— 位移在这以内视为"点了一下"，用来切控件显隐。
  var SWIPE_MIN = 56, AXIS_MIN = 10, TAP_SLOP = 6;
  var current = null;

  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

  // 侧栏的缩略图**不在这里取地址**：一个对话几十张图，全部赋 src 会让引擎一次解码几十张
  // 1MP 的图（每张展开约 4MB），在 WebView 里够呛。缩略图自己进视口时才去要地址（见 hydrate）。
  // 每一格带一个序号，点击与"当前是哪张"都靠它对上 gallery 的下标。
  function galleryMarkup(gallery) {
    if (gallery.length < 2) return "";
    var html = '<div class="image-viewer-gallery" role="group" aria-label="本对话的图片"><div class="image-viewer-gallery-list">';
    for (var i = 0; i < gallery.length; i += 1) {
      html += '<button type="button" class="image-viewer-thumb" data-gallery-index="' + i + '" aria-label="查看这张图片">' +
        '<img alt="" referrerpolicy="no-referrer" decoding="async"></button>';
    }
    return html + '</div></div>';
  }

  function open(options) {
    var settings = options || {};
    // 画廊 = 调用方给进来的同一组图片（本对话里所有生成图）。空 / 只有一张时这一整套能力都关掉：
    // 一个只装着自己那张图的侧栏没有意义，底部那个按钮也不该出现。
    var gallery = Array.isArray(settings.gallery) ? settings.gallery.slice() : [];
    var at = 0;
    if (gallery.length) {
      var asked = Number(settings.index);
      at = clamp(isFinite(asked) ? Math.round(asked) : 0, 0, gallery.length - 1);
    }
    // 没有画廊（或调用方没给下标）时，顶层那几个参数就是"唯一的那一张"。
    var entry = gallery.length ? gallery[at] : { src: settings.src, alt: settings.alt, onDownload: settings.onDownload, onSetBackground: settings.onSetBackground };
    var src = String(entry && entry.src || settings.src || "");
    if (!src) return Promise.resolve();
    if (current) current.close();
    var overlay = document.createElement("div");
    overlay.className = "image-viewer";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    // 底部工具栏（业主 2026-09-27 第二轮）：下载 / 设为背景 / 关闭；第六轮在**最左边**加了「画廊」。
    // **右上角那个单独的关闭按钮已经去掉, 底部的提示词也不再显示** —— 一切动作收在这一条磨砂
    // 工具栏里。所以这里只认两个回调: 调用方给不出能力的按钮直接隐藏（例如文字在 IndexedDB 里的
    // 旧图片导不出来）。下载与设为背景都不是这个组件该知道的事: 一个要走宿主文件库导出,
    // 一个要写对话记录, 都由调用方实现（chat.js）。
    overlay.innerHTML = '<div class="image-viewer-stage"><img alt="" referrerpolicy="no-referrer"></div>' +
      galleryMarkup(gallery) +
      '<div class="image-viewer-toolbar" role="group" aria-label="图片操作">' +
      '<button type="button" class="image-viewer-action" data-viewer-action="gallery" aria-expanded="false">' + app.components.icon("images") + '<span>画廊</span></button>' +
      '<button type="button" class="image-viewer-action" data-viewer-action="download">' + app.components.icon("download") + '<span>下载</span></button>' +
      '<button type="button" class="image-viewer-action" data-viewer-action="background">' + app.components.icon("image") + '<span>设为背景</span></button>' +
      '<button type="button" class="image-viewer-action" data-viewer-action="close">' + app.components.icon("xmark") + '<span>关闭</span></button>' +
      '</div>';
    var stage = overlay.querySelector(".image-viewer-stage");
    var image = overlay.querySelector("img");
    var toolbar = overlay.querySelector(".image-viewer-toolbar");
    var panel = overlay.querySelector(".image-viewer-gallery");
    var galleryButton = toolbar.querySelector('[data-viewer-action="gallery"]');
    var downloadButton = toolbar.querySelector('[data-viewer-action="download"]');
    var backgroundButton = toolbar.querySelector('[data-viewer-action="background"]');
    var thumbs = panel ? Array.prototype.slice.call(panel.querySelectorAll(".image-viewer-thumb")) : [];
    if (gallery.length < 2) galleryButton.hidden = true;
    image.alt = String(entry && entry.alt || settings.alt || "对话图片");
    image.src = src;

    var scale = MIN_SCALE, x = 0, y = 0, base = { width: 0, height: 0 };
    var pointers = {}, gesture = null, lastTap = 0, tapTimer = 0, uiHidden = false, switching = false, closed = false;
    var previousOverflow = document.body.style.overflow;
    // 当前这张图能做的两件事。**切图时必须一起换**（见 apply）—— 两个回调都是按那一张图闭包出来的。
    var actions = { download: entry && entry.onDownload || null, background: entry && entry.onSetBackground || null };

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
    // 能不能靠上下滑动换图：这一组至少两张，而且**纵向没有可平移的余地**。放大之后纵向能拖，
    // 那时上下滑动必须留给平移，不能抢着换图；没放大时（基线高度充满）纵向余量恒为 0，
    // 纵向滑动本来就没有别的用途 —— 正好拿来换图。舞台尺寸未知时判"可以"，因为那时也平移不了。
    function slideReady() {
      if (gallery.length < 2) return false;
      var box = size(), view = viewport();
      if (!(view.height > 0)) return true;
      return box.height * scale <= view.height + 1;
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

    // ── 画廊侧栏 ───────────────────────────────────────────────────────────────
    function mark() {
      for (var i = 0; i < thumbs.length; i += 1) {
        if (i === at) thumbs[i].classList.add("is-current"); else thumbs[i].classList.remove("is-current");
      }
    }
    function syncActions() {
      downloadButton.hidden = !actions.download;
      backgroundButton.hidden = !actions.background;
    }
    // 换一张：地址 / 替换文本 / 两个动作回调一起换，然后回到基线（新图从"高度充满"开始看，
    // 而不是继承上一张的缩放与偏移）。
    function apply(next) {
      var url = String(next && next.src || "");
      if (url && image.getAttribute("src") !== url) image.src = url;
      if (url) image.alt = String(next.alt || "对话图片");
      actions.download = next && next.onDownload || null;
      actions.background = next && next.onSetBackground || null;
      syncActions();
      reset();
      if (image.complete && image.naturalWidth) measure();
      mark();
    }
    // 切到第 index 张。地址还没取过（缩略图没进过视口 / 是旧记录）时就地要一次。
    // 取不到就**停在当前这张**：切一半留个破图比不切更糟。正在切时忽略重复请求（连点缩略图）。
    function show(index) {
      if (switching || index === at || index < 0 || index >= gallery.length) return Promise.resolve();
      switching = true;
      var want = gallery[index];
      return Promise.resolve(String(want.src || "") || (typeof want.source === "function" ? want.source() : ""))
        .catch(function () { return ""; })
        .then(function (value) {
          switching = false;
          var url = String(value || "");
          if (!url || closed) return;
          want.src = url; at = index;
          apply(want);
          if (typeof settings.onIndexChange === "function") settings.onIndexChange(index);
        });
    }
    // 缩略图的地址进视口才要（一次）。要不到就把这一格压暗，让"这张读不出来"看得见，
    // 而不是留一个永远转不出来的灰块、也不是把整组图一起拖慢。
    var thumbObserver = null;
    function hydrate(button, index) {
      if (!button || button.dataset.thumbState) return;
      button.dataset.thumbState = "loading";
      var want = gallery[index];
      Promise.resolve(String(want && want.src || "") || (want && typeof want.source === "function" ? want.source() : ""))
        .catch(function () { return ""; })
        .then(function (value) {
          if (!button.isConnected) return;
          var url = String(value || "");
          if (!url) { button.dataset.thumbState = "missing"; return; }
          want.src = url;
          button.querySelector("img").src = url;
          button.dataset.thumbState = "ready";
        });
    }
    if (panel) {
      if (typeof IntersectionObserver === "function") {
        thumbObserver = new IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i += 1) {
            var node = entries[i].target;
            if (!node.isConnected) { thumbObserver.unobserve(node); continue; }
            if (!entries[i].isIntersecting) continue;
            thumbObserver.unobserve(node);
            hydrate(node, Number(node.dataset.galleryIndex));
          }
          // 用**视口**当根（而不是侧栏自己）：侧栏关着时整条抽屉被 transform 推出屏幕，
          // 那些缩略图天然不相交、一张都不会去加载；推出来之后才逐格要地址。
        }, { rootMargin: "240px 0px" });
        for (var t = 0; t < thumbs.length; t += 1) thumbObserver.observe(thumbs[t]);
      } else {
        // 没有观察器（老引擎）就一次全取：宁可贵一点，也不要侧栏里一片空白。
        for (var k = 0; k < thumbs.length; k += 1) hydrate(thumbs[k], k);
      }
      // currentTarget 在事件回调里始终指向被点的那一格，所以这里不需要 IIFE 定住下标。
      for (var m = 0; m < thumbs.length; m += 1) thumbs[m].addEventListener("click", function (event) { show(Number(event.currentTarget.dataset.galleryIndex)); });
    }

    // ── 点一下画面：切换控件显隐 ────────────────────────────────────────────────
    function toggleUi() {
      uiHidden = !uiHidden;
      overlay.classList.toggle("is-ui-hidden", uiHidden);
    }
    // 延后一个双击窗口再切：立刻切的话，用户双击放大时界面会先闪一下（第一下点击就切了）。
    function later() { if (tapTimer) { clearTimeout(tapTimer); tapTimer = 0; } }
    function tap() {
      later();
      tapTimer = setTimeout(function () { tapTimer = 0; if (!closed) toggleUi(); }, DOUBLE_TAP_MS);
    }

    // ── 手势 ──────────────────────────────────────────────────────────────────
    function local(event) { var box = stage.getBoundingClientRect(); return { x: event.clientX - box.left - box.width / 2, y: event.clientY - box.top - box.height / 2 }; }

    function down(event) {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      stage.setPointerCapture(event.pointerId);
      pointers[event.pointerId] = local(event);
      var ids = Object.keys(pointers);
      if (ids.length === 1) {
        var point = pointers[event.pointerId];
        // moved / axis / swipe 三个状态都挂在 gesture 上：松手时靠它们判断这一下是"点"、
        // "横着拖"还是"竖着划"。
        gesture = { mode: "pan", startX: point.x, startY: point.y, originX: x, originY: y, moved: false, axis: "", swipe: 0 };
        if (canPan()) stage.style.cursor = "grabbing";
        var now = Date.now();
        if (now - lastTap < DOUBLE_TAP_MS) {
          lastTap = 0;
          later();
          zoomAt(scale > MIN_SCALE ? MIN_SCALE : DOUBLE_TAP_SCALE, point.x, point.y);
          gesture = null;
        } else lastTap = now;
      } else if (ids.length === 2) {
        var first = pointers[ids[0]], second = pointers[ids[1]];
        gesture = { mode: "pinch", distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)), scale: scale, midX: (first.x + second.x) / 2, midY: (first.y + second.y) / 2, moved: true, axis: "", swipe: 0 };
        lastTap = 0;
      }
    }

    function move(event) {
      if (!pointers[event.pointerId] || !gesture) return;
      pointers[event.pointerId] = local(event);
      var ids = Object.keys(pointers);
      if (gesture.mode === "pan" && ids.length === 1) {
        var point = pointers[event.pointerId];
        var dx = point.x - gesture.startX, dy = point.y - gesture.startY;
        // 定轴**只判一次**：竖着划且纵向没有可平移的余地 ⇒ 这一划不是平移，是换上一张 / 下一张。
        if (!gesture.axis && Math.abs(dx) + Math.abs(dy) > AXIS_MIN) {
          gesture.axis = (Math.abs(dy) > Math.abs(dx) * 1.2 && slideReady()) ? "y" : "x";
        }
        if (gesture.axis === "y") {
          gesture.swipe = dy;
          if (Math.abs(dy) > TAP_SLOP) gesture.moved = true;
          // 跟手一点点（四分之一的位移）：让人看得出来这一划被认成"换图"了，松手再按结果走。
          y = gesture.originY + dy * 0.25; paint();
          return;
        }
        if (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP) gesture.moved = true;
        // 不再用"放大过才给拖"当门槛：基线下的横构图本来就超出屏幕，边界由 bound() 按真实溢出量给。
        x = gesture.originX + dx;
        y = gesture.originY + dy;
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
      // 先抓住这一轮的手势对象：下面无论怎么改 gesture，`ending` 都还是这次按下的那个。
      var ending = gesture;
      delete pointers[event.pointerId];
      var ids = Object.keys(pointers);
      if (ids.length === 1) {
        // 双指松掉一根：立刻切回单指平移，否则画面会僵在捏合状态。
        // moved 置真：从多指变单指的这一下不该被当成"点了一下画面"。
        gesture = { mode: "pan", startX: pointers[ids[0]].x, startY: pointers[ids[0]].y, originX: x, originY: y, moved: true, axis: "", swipe: 0 };
        return;
      }
      if (ids.length) return;
      gesture = null;
      if (canPan()) stage.style.cursor = "grab";
      if (!ending || ending.mode !== "pan") return;
      if (ending.axis === "y") {
        var swipe = Number(ending.swipe) || 0;
        if (Math.abs(swipe) < SWIPE_MIN) { bound(); paint(); return; }
        // 手指往上划 = 往后翻（画面往上卷，下一张从下面进来），和相册一致。
        var next = swipe < 0 ? at + 1 : at - 1;
        if (next < 0 || next >= gallery.length) { bound(); paint(); return; }
        show(next).then(function () { bound(); paint(); });
        return;
      }
      if (!ending.moved) tap();
    }

    function wheel(event) {
      event.preventDefault();
      var point = local(event);
      zoomAt(scale * (event.deltaY > 0 ? 0.85 : 1.18), point.x, point.y);
    }

    function close() {
      if (closed) return;
      closed = true;
      later();
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", reset);
      window.removeEventListener("popstate", back);
      if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
      // 自己关掉（点关闭按钮 / Esc / 系统返回之外的路）时要把压进去的那一格收回来，
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
    toolbar.querySelector('[data-viewer-action="download"]').addEventListener("click", function () { runAction(actions.download); });
    toolbar.querySelector('[data-viewer-action="background"]').addEventListener("click", function () { runAction(actions.background); });
    galleryButton.addEventListener("click", function () {
      if (!panel) return;
      var open = panel.classList.toggle("is-open");
      galleryButton.setAttribute("aria-expanded", open ? "true" : "false");
      // 侧栏一推出来就把当前这张滚进视野：几十张的时候，不滚过去根本不知道自己现在看的是第几张。
      if (open && thumbs[at] && thumbs[at].scrollIntoView) {
        try { thumbs[at].scrollIntoView({ block: "nearest" }); } catch (_) {}
      }
    });
    stage.addEventListener("pointerdown", down);
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerup", up);
    stage.addEventListener("pointercancel", up);
    // 双击由 pointerdown 的间隔自己判定；这里只挡掉浏览器原生的双击缩放。
    stage.addEventListener("dblclick", function (event) { event.preventDefault(); });
    stage.addEventListener("wheel", wheel, { passive: false });
    document.addEventListener("keydown", keydown);
    window.addEventListener("resize", reset);
    function measure() { base = { width: image.offsetWidth || image.naturalWidth, height: image.offsetHeight || image.naturalHeight }; bound(); paint(); }
    image.addEventListener("load", measure);
    document.body.appendChild(overlay);
    if (image.complete && image.naturalWidth) measure();
    document.body.style.overflow = "hidden";
    current = { close: close };
    syncActions();
    mark();
    paint();
    return promise;
  }

  function close() { if (current) current.close(); }

  app.components = app.components || {};
  app.components.imageViewer = { open: open, close: close };
})(window.chataxi);
