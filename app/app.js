(function (app) {
  "use strict";
  var ui = app.components;
  var queue = Promise.resolve();
  var navigationId = 0;
  var stableViewportHeight = 0;
  var themePreference = "system";
  var darkScheme = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function resolvedTheme() {
    if (themePreference === "light" || themePreference === "dark") return themePreference;
    return darkScheme && darkScheme.matches ? "dark" : "light";
  }
  function reportTheme() {
    if (!app.platform || !app.platform.haminn) return;
    app.platform.haminn.call("appearance.reportTheme", { theme: resolvedTheme() }).catch(function () {});
  }

  function applyTheme(theme) {
    themePreference = theme === "light" || theme === "dark" ? theme : "system";
    if (themePreference !== "system") document.documentElement.setAttribute("data-theme", themePreference);
    else document.documentElement.removeAttribute('data-theme');
    reportTheme();
  }
  window.addEventListener("haminnready", reportTheme);
  if (darkScheme) {
    var systemThemeChanged = function () { if (themePreference === "system") reportTheme(); };
    if (darkScheme.addEventListener) darkScheme.addEventListener("change", systemThemeChanged);
    else if (darkScheme.addListener) darkScheme.addListener(systemThemeChanged);
  }
  // 背景图层钉住的"正常视口"（用户 2026-09-26: 不一定是键盘, 任何窗口变化下背景都要满屏、不能变小）。
  // .app-shell 的高度必须跟着可视区缩（否则输入框会被键盘盖住）, 但背景图层不能跟着缩 ——
  // 它上面的 background-size / background-position 都是百分比, 一缩就按新容器重算, 照片当场变小、
  // 横向也可能覆盖不住。所以图层高度读 --viewport-full-height, 少掉的那截由 .app-shell 裁掉。
  // 判定: 宽度变了 = 转屏 / 分屏 / 宿主窗口真的换了尺寸 ⇒ 重新起算;
  //       宽度没变而高度变小 = 键盘或系统栏 ⇒ 不跟; 高度变大 = 新的正常高度 ⇒ 跟上。
  // 正常高度一变, 铺背景用的宽高比就变了, 取景（百分比）得按新比例重算, 否则极端比例的照片会露边。
  var nominalWidth = 0, nominalHeight = 0;
  function syncBackgroundViewport(width, height) {
    var changed = false;
    if (width !== nominalWidth) { nominalWidth = width; nominalHeight = height; changed = true; }
    else if (height > nominalHeight) { nominalHeight = height; changed = true; }
    if (!changed && document.documentElement.style.getPropertyValue('--viewport-full-height')) return;
    document.documentElement.style.setProperty('--viewport-full-height', nominalHeight + 'px');
    if (app.features && app.features.chat && app.features.chat.repaintAppBackground) app.features.chat.repaintAppBackground();
  }
  function resizeViewport() {
    var viewport = window.visualViewport;
    if (viewport && viewport.scale !== 1) return;
    var height = viewport ? viewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--viewport-height', height + 'px');
    document.documentElement.style.setProperty('--viewport-top', (viewport ? viewport.offsetTop : 0) + 'px');
    syncBackgroundViewport(window.innerWidth, height);
    if (!acceptsKeyboard(document.activeElement)) {
      stableViewportHeight = Math.max(stableViewportHeight, height);
      document.documentElement.classList.remove('keyboard-open');
    } else if (stableViewportHeight && height < stableViewportHeight - 120) {
      document.documentElement.classList.add('keyboard-open');
    } else {
      document.documentElement.classList.remove('keyboard-open');
    }
  }
  function acceptsKeyboard(element) {
    if (!element || element.disabled || element.readOnly) return false;
    if (element.matches && element.matches('textarea, [contenteditable="true"]')) return true;
    if (!element.matches || !element.matches('input')) return false;
    return ['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].indexOf(String(element.type || 'text').toLowerCase()) < 0;
  }
  function scrollParent(element) {
    for (var parent = element && element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      var style = window.getComputedStyle(parent);
      if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) return parent;
    }
    return null;
  }
  function revealFocusedField(element) {
    if (!acceptsKeyboard(element) || element !== document.activeElement) return;
    resizeViewport();
    var viewport = window.visualViewport;
    var top = viewport ? viewport.offsetTop : 0;
    var bottom = top + (viewport ? viewport.height : window.innerHeight);
    var rect = element.getBoundingClientRect();
    var margin = 16;
    var delta = rect.bottom > bottom - margin ? rect.bottom - (bottom - margin) : rect.top < top + margin ? rect.top - (top + margin) : 0;
    var parent = scrollParent(element);
    if (delta && parent) parent.scrollTop += delta;
    else if (delta && element.scrollIntoView) element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function scheduleReveal(element) {
    [0, 120, 320].forEach(function (delay) { window.setTimeout(function () { revealFocusedField(element); }, delay); });
  }
  function focusChanged(event) {
    if (!acceptsKeyboard(event.target)) return;
    scheduleReveal(event.target);
  }
  function focusLeft() {
    window.setTimeout(function () {
      if (acceptsKeyboard(document.activeElement)) return;
      document.documentElement.classList.remove('keyboard-open');
      resizeViewport();
    }, 180);
  }
  function setHash(hash, replace) {
    if (location.hash === hash) return;
    var current = history.state && history.state.chataxiDepth || 0;
    history[replace ? 'replaceState' : 'pushState']({ chataxiDepth: replace ? current : current + 1 }, '', hash);
  }
  function transition(route, options) {
    options = options || {};
    var ticket = ++navigationId;
    var operation = queue.catch(function () {}).then(async function () {
      if (ticket !== navigationId) return;
      if (app.state.activeConversationId) await app.features.chat.close();
      if (ticket !== navigationId) return;
      ui.closeModal(true);
      var shell = document.getElementById('appShell'); shell.classList.remove('chat-open');
      document.getElementById('bottomNav').classList.remove('is-hidden');
      document.getElementById('backButton').classList.add('is-hidden');
      document.querySelector('#brandBlock .brand-mark').classList.remove('is-hidden');
      if (options.modelsTab) app.state.modelsTab = options.modelsTab;
      app.state.route = route;
      setHash(route === 'chat' ? '#/chat/' + encodeURIComponent(options.id) : '#/' + route, options.replace);
      document.querySelectorAll('#bottomNav [data-route]').forEach(function (button) { if (button.dataset.route === route) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
      if (route === 'chat') await app.features.chat.render(options.id);
      else await app.features[route].render();
      var main = document.getElementById('mainContent');
      if (route !== 'chat') main.scrollTop = 0;
      main.focus({ preventScroll: true });
    });
    queue = operation;
    return operation.catch(function (error) {
      ui.toast(app.utils.cleanError(error), 5000);
      if (ticket === navigationId && !app.state.activeConversationId) {
        var main = document.getElementById('mainContent'); main.className = 'main';
        main.innerHTML = ui.empty('triangle-exclamation', '暂时无法打开', app.utils.cleanError(error), '<button class="button primary" type="button" id="retryPage">重试</button>');
        document.getElementById('retryPage').addEventListener('click', function () { transition(route === 'chat' ? 'conversations' : route, { replace: true }); });
      }
    });
  }
  function navigate(route, options) { return transition(['conversations', 'roles', 'models', 'me', 'settings'].indexOf(route) >= 0 ? route : 'conversations', options); }
  function openChat(id) { return transition('chat', { id: id }); }
  function closeChat() {
    if (history.state && history.state.chataxiDepth > 0) history.back();
    else return navigate('conversations', { replace: true });
  }
  function routeFromHash() {
    var hash = location.hash || '#/conversations';
    if (hash.indexOf('#/chat/') === 0) {
      try { return transition('chat', { id: decodeURIComponent(hash.slice(7)), replace: true }); }
      catch (_) { return navigate('conversations', { replace: true }); }
    }
    return navigate(hash.slice(2), { replace: true });
  }
  async function init() {
    resizeViewport();
    window.addEventListener('resize', function () { resizeViewport(); if (acceptsKeyboard(document.activeElement)) scheduleReveal(document.activeElement); });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () { resizeViewport(); if (acceptsKeyboard(document.activeElement)) scheduleReveal(document.activeElement); });
      window.visualViewport.addEventListener('scroll', function () { resizeViewport(); if (acceptsKeyboard(document.activeElement)) revealFocusedField(document.activeElement); });
    }
    document.addEventListener('focusin', focusChanged);
    document.addEventListener('focusout', focusLeft);
    document.querySelectorAll('#bottomNav [data-route]').forEach(function (button) { button.addEventListener('click', function () { navigate(button.dataset.route); }); });
    document.getElementById('backButton').addEventListener('click', closeChat);
    window.addEventListener('hashchange', routeFromHash);
    try {
      await app.data.store.init();
      // 旧媒体（存在 IndexedDB 里的头像 / 个人头像 / 对话头像 / 历史图片）一次性搬进宿主文件库。
      // 这是"导出备份 → 换实例恢复后图片还在"的前提：宿主备份边界不含 IndexedDB。
      // 不 await —— 它是后台维护，不该挡首屏；单条被读到时的惰性搬迁在 media.get 里兜底。
      // 失败要说话：不能静默让人以为已经进了备份。
      app.data.media.migrate().then(function (result) {
        if (result && result.failed) ui.toast('有 ' + result.failed + ' 张旧图片没能搬进宿主文件库，它们暂时不会进入备份', 6000);
      }).catch(function () {});
      // 绘图卡片的画幅目录是"发现当时"的快照: 插件升级后不重读就还在用旧清单挑画幅
      // （详见 draw.js 的 refreshCatalogs）。不 await、失败静默 —— 它是自愈, 不该挡首屏,
      // 也不该把"插件没开"变成一条用户看不懂的报错。
      app.services.draw.refreshCatalogs().catch(function () {});
      var settings = await app.data.store.get('meta', 'settings');
      applyTheme(settings.theme);
      app.i18n.setPreference(settings.uiLanguage, { silent: true });
      // 全局背景要在首屏渲染之前铺上：晚了会先闪一帧没有背景的界面。
      // 来源是"最近使用的对话"（meta/last-conversation），所以不用等用户进对话。
      if (app.features.chat && app.features.chat.refreshAppBackground) await app.features.chat.refreshAppBackground();
      await routeFromHash();
      if (app.platform.haminn.available()) { try { await app.platform.haminn.api().app.ready(); } catch (_) {} }
    } catch (error) {
      document.getElementById('mainContent').innerHTML = ui.empty('triangle-exclamation', '暂时无法准备好 chataxi', app.utils.cleanError(error), '<button class="button primary" type="button" id="reloadApp">重新加载</button>');
      document.getElementById('reloadApp').addEventListener('click', function () { location.reload(); });
    }
  }
  // resolvedTheme 要对外: 对话背景的六个色板各备明亮 / 深色两套渐变, 得按同一个
  // 主题判断取用, 不能让 chat.js 自己再读一遍 data-theme 与 prefers-color-scheme。
  app.navigate = navigate; app.openChat = openChat; app.closeChat = closeChat; app.applyTheme = applyTheme; app.resolvedTheme = resolvedTheme;
  document.addEventListener('DOMContentLoaded', init);
})(window.chataxi);
