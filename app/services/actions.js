(function (app) {
  "use strict";

  // 位置动作（action）块：模型在正文之后附加的一段对用户不可见的指令。
  //
  // 为什么不用 Markdown 围栏：围栏会被流式渲染成可见的代码块，而且模型经常忘记收尾
  // 反引号，正文与动作就会粘连。这里用一个不可能出现在正常行文里的哨兵，
  // 流式阶段只要看见哨兵就把后面的内容整段遮住（见 visible），
  // 定稿阶段再切成「正文 + 动作」（见 split）。
  //
  // 格式：
  //   <<<chataxi-action
  //   {"type":"draw","prompt":"画面提示词","selfPortrait":false}
  //   >>>
  var SENTINEL = "<<<chataxi-action";
  var CLOSE = ">>>";
  // 解析用的宽松形式：允许模型写成 <<< chataxi-action: / <<<chataxi_action 之类。
  // 这里只在「已经看见完整哨兵」的分支使用，所以不影响逐字流式的判定。
  var OPEN = /<{3}\s*chataxi[\s_-]*action\s*:?[ \t]*\r?\n?/i;
  // prompt 上限：太长会把绘图模型带偏，也让占位文案撑破气泡。
  var PROMPT_LIMIT = 400;

  function compact(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  // 去掉裹在动作块外面的 ```json 围栏，以及正文末尾遗留的围栏开头。
  function stripFence(value) {
    return String(value || "").replace(/^\s*```[a-zA-Z]*\s*/, "").replace(/\s*```\s*$/, "").trim();
  }

  function stripTrailingFence(value) {
    return String(value || "").replace(/\n?\s*```[a-zA-Z]*\s*$/, "").replace(/\s+$/, "");
  }

  function parse(block) {
    var raw = stripFence(block);
    if (!raw) return null;
    var value = null;
    try { value = JSON.parse(raw); }
    catch (_) {
      // 模型偶尔在 JSON 前后多写一句话；退一步只取最外层的那个对象。
      var match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try { value = JSON.parse(match[0]); } catch (_) { return null; }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (compact(value.type).toLowerCase() !== "draw") return null;
    var prompt = compact(value.prompt);
    if (!prompt) return null;
    if (prompt.length > PROMPT_LIMIT) prompt = prompt.slice(0, PROMPT_LIMIT);
    return { type: "draw", prompt: prompt, selfPortrait: value.selfPortrait === true };
  }

  // 把模型原始输出切成 { text, action }。
  // text 一定是「可以直接显示与存库的正文」；action 解析不出来时为 null。
  function split(text) {
    var value = String(text == null ? "" : text);
    var match = OPEN.exec(value);
    if (!match) return { text: value.trim(), action: null, invalid: false };
    var head = stripTrailingFence(value.slice(0, match.index));
    var rest = value.slice(match.index + match[0].length);
    var close = rest.indexOf(CLOSE);
    var body = close >= 0 ? rest.slice(0, close) : rest;
    var action = parse(body);
    return { text: head, action: action, invalid: !action && Boolean(compact(body)) };
  }

  // 流式显示用：哨兵之后（含半个哨兵）一律不显示。
  function visible(text) {
    var value = String(text == null ? "" : text);
    var match = OPEN.exec(value);
    if (match) return stripTrailingFence(value.slice(0, match.index));
    return trimPartial(value);
  }

  // 末尾是哨兵的某个前缀（<<<chat…）时把它一并遮住，避免闪烁出半个哨兵。
  // 要求长度 ≥ 4 且前面是行首或空白：正常中文行文里不会出现这种片段。
  function trimPartial(value) {
    var lower = value.toLowerCase();
    var max = Math.min(SENTINEL.length - 1, lower.length);
    for (var length = max; length >= 4; length -= 1) {
      var tail = lower.slice(lower.length - length);
      if (SENTINEL.toLowerCase().indexOf(tail) !== 0) continue;
      var before = value.charAt(value.length - length - 1);
      if (before && !/\s/.test(before)) return value;
      return value.slice(0, value.length - length).replace(/\s+$/, "");
    }
    return value;
  }

  // 界面上要展示的一句话（就是提示词本身，不额外拼中文，免得再进一遍翻译表）。
  function describe(action) {
    return action && action.prompt ? action.prompt : "";
  }

  app.services.actions = {
    SENTINEL: SENTINEL,
    CLOSE: CLOSE,
    PROMPT_LIMIT: PROMPT_LIMIT,
    split: split,
    visible: visible,
    parse: parse,
    describe: describe
  };
})(window.chataxi);
