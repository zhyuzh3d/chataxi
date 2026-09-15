(function (app) {
  "use strict";
  var listeners = {};
  app.events = {
    on: function (name, listener) {
      listeners[name] = listeners[name] || [];
      listeners[name].push(listener);
      return function () {
        listeners[name] = (listeners[name] || []).filter(function (item) { return item !== listener; });
      };
    },
    emit: function (name, detail) {
      (listeners[name] || []).slice().forEach(function (listener) {
        try { listener(detail); } catch (error) { window.setTimeout(function () { throw error; }, 0); }
      });
    }
  };
})(window.chataxi);
