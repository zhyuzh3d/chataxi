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
    if (!app.platform || !app.platform.hermit) return;
    app.platform.hermit.call("appearance.reportTheme", { theme: resolvedTheme() }).catch(function () {});
  }

  function applyTheme(theme) {
    themePreference = theme === "light" || theme === "dark" ? theme : "system";
    if (themePreference !== "system") document.documentElement.setAttribute("data-theme", themePreference);
    else document.documentElement.removeAttribute('data-theme');
    reportTheme();
  }
  window.addEventListener("hermitready", reportTheme);
  if (darkScheme) {
    var systemThemeChanged = function () { if (themePreference === "system") reportTheme(); };
    if (darkScheme.addEventListener) darkScheme.addEventListener("change", systemThemeChanged);
    else if (darkScheme.addListener) darkScheme.addListener(systemThemeChanged);
  }
  function resizeViewport() {
    var viewport = window.visualViewport;
    if (viewport && viewport.scale !== 1) return;
    var height = viewport ? viewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--viewport-height', height + 'px');
    document.documentElement.style.setProperty('--viewport-top', (viewport ? viewport.offsetTop : 0) + 'px');
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
      var settings = await app.data.store.get('meta', 'settings');
      applyTheme(settings.theme);
      app.i18n.setPreference(settings.uiLanguage, { silent: true });
      await routeFromHash();
      if (app.platform.hermit.available()) { try { await app.platform.hermit.api().app.ready(); } catch (_) {} }
    } catch (error) {
      document.getElementById('mainContent').innerHTML = ui.empty('triangle-exclamation', '暂时无法准备好 chataxi', app.utils.cleanError(error), '<button class="button primary" type="button" id="reloadApp">重新加载</button>');
      document.getElementById('reloadApp').addEventListener('click', function () { location.reload(); });
    }
  }
  app.navigate = navigate; app.openChat = openChat; app.closeChat = closeChat; app.applyTheme = applyTheme;
  document.addEventListener('DOMContentLoaded', init);
})(window.chataxi);
