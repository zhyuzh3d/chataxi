(function (app) {
  "use strict";
  var generation = 0, current = null, ready = {}, muted = false, lastState = { speaking: false };
  var MAX_READY_ITEMS = 8, MAX_READY_PCM_BYTES = 24 * 1024 * 1024;
  var audioContext = null, playbackUnlocked = false;
  var bus = null, currentSettings = null, ambienceLevel = 0;
  var backgrounded = typeof document !== "undefined" && Boolean(document.hidden);
  var pausedPlayback = null, backgroundResume = null, lifecycleQueue = Promise.resolve();

  function emit(detail) { lastState = Object.assign({}, detail || { speaking: false }, { muted: muted }); app.events.emit("tts:state", lastState); }
  function setMuted(value) {
    muted = Boolean(value);
    if (current && current.audio) current.audio.muted = muted;
    if (current && current.audioGain) current.audioGain.gain.value = muted ? 0 : 1;
    // 环境声是独立声源, 不在 audioGain 下游, 必须单独跟着静音 —— 否则"静音"之后
    // 背景里还在响, 那是最容易被当成漏音的状态。
    if (bus && bus.ambience) {
      var now = bus.context.currentTime;
      bus.ambience.gain.cancelScheduledValues(now);
      bus.ambience.gain.setTargetAtTime(muted ? 0 : ambienceLevel, now, 0.2);
    }
    if (current && current.playbackId && app.platform.haminn.available()) {
      var audioApi = app.platform.haminn.api().audio;
      if (typeof audioApi.setPlaybackVolume === "function") audioApi.setPlaybackVolume({ playbackId: current.playbackId, volume: muted ? 0 : 1 }).catch(function () {});
    }
    emit(lastState); return muted;
  }

  function unlockPlayback() {
    var AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return false;
    try {
      if (audioContext && playbackUnlocked && audioContext.state === "running") return true;
      if (!audioContext || audioContext.state === "closed") audioContext = new AudioContext();
      if (audioContext.state !== "running" && typeof audioContext.resume === "function") {
        var resumed = audioContext.resume(); if (resumed && typeof resumed.catch === "function") resumed.catch(function () {});
      }
      var source = audioContext.createBufferSource();
      source.buffer = audioContext.createBuffer(1, 1, 22050); source.connect(audioContext.destination); source.start(0);
      ensureBus(); playbackUnlocked = true; return true;
    } catch (_) { return false; }
  }

  // ==========================================================================
  // 朗读音效: 房间混响 + 隐约环境声（用户 2026-09-26）
  //   "播放 tts 的时候增加统一的房间混响效果" / "能再增加一点点随机的环境声效
  //    （隐隐约约的人声嘈杂声风声之类）就更好了" / "要确保声音连续不间断不破坏"
  //
  // "连续、不破坏"是硬约束, 靠三件事保证, 不是靠听感差不多:
  //   1. 全进程只有**一份**总线（ensureBus）。会出声的地方都汇进它的 input, 而不是
  //      每句话各建一套混响。ConvolverNode 是线性时不变节点, 所以"把流式 PCM 按到达
  //      切成几十段、逐段喂同一个混响器"与"整段喂同一个混响器"逐样本等价 —— 段与段
  //      之间不会多出接缝。这是数学结论, 不是近似。
  //   2. 停播只断开上游（owner.audioGain.disconnect）。混响器仍留在总线里, 已经进入
  //      它内部的尾音会自然放完, 不会被"啪"地掐掉。
  //   3. 末端挂限幅器。干湿相加会把峰值抬高几 dB, 不拦就削波 —— 削波才是真的破坏声音。
  //
  // 挂不上的两条路（硬限制, 设置页已注明）: Android 系统朗读（tts.speak）与宿主原生
  // 播放（audio.play）由 App 自己发声, WebView 取不到它们的音频流。
  // ==========================================================================
  // 房间是**小房间**, 而且要"麦克风贴耳", 不是大厅（用户 2026-09-26: "混响改小房间" →
  // "营造那种麦克风贴耳的声音、真实感氛围"）。房间大小全写在脉冲响应上:
  //   尾巴短(0.6s) + 衰减陡(5.0) + 早期反射挤在 1~23ms —— 小房间的反射路径短, 回声来得又早又密。
  //   之前那组 1.8s / 3.0 就是大厅味: 长尾 + 更稀疏的晚期混响。
  var REVERB_SECONDS = 0.6, REVERB_DECAY = 5.0, WET_MAX = 4.2;
  // 混响强度滑竿 0~100（用户 2026-09-26: "房间回响 0~100"）。
  // ★ 这里记下一次真实回归, 因为它是被业主听出来的（"感觉现在混响效果几乎没有了啊"）。
  //   0.7.18 把量程从 0~50 放大到 0~100 时只改了滑竿量程, WET_MAX 仍是 1.05 ⇒ 同一个数字对应的
  //   湿度**减半**。当时的注释还写着"35/100*1.05 = 0.368, 与旧的 35/50*1.05 逐位相同"——那是算错的:
  //   35/50*1.05 = 0.735, 不是 0.368。业主的滑竿从旧量程起就停在满档 50, 于是升级后湿声从 1.05
  //   掉到 0.525, 整整 −6dB。同一批还叠了两处同向的改动（都在 ensureBus 里）: 湿声新增 240Hz 低切
  //   —— 尾巴最有"房间感"的那段厚度被削掉; 干声新增 +2.2dB presence —— 反过来把湿声盖住。
  //   修法是**把 WET_MAX 提到 2.1, 让同一个数字回到原来的湿度**:
  //     50/100*2.1 = 1.05 = 0.7.18 之前的满档 ⇒ 业主现存的那个 50 直接复原, 不用迁移任何存档值;
  //     35/100*2.1 = 0.735 = 旧默认 ⇒ REVERB_MIX_DEFAULT 保持 35 也是逐位正确的;
  //     100/100*2.1 = 2.1 = 旧满档的两倍 ⇒ 想更湿还有地方去。
  //   为什么不是"在存档里把旧值 ×2": 重锚量程只改一处常量, 听感收益完全一样, 但它的前提是
  //   "存档里存的都是旧量程的值"—— 这个前提对混响并不成立（0.7.18 之后写进去的值就在新量程上）,
  //   猜错就会把一个已经调好的数字再改一次。所以混响只动常量, 不动存档。
  // ★ 0.7.24 再把 WET_MAX 翻倍到 4.2（用户 2026-09-26: "把这两个滑竿对应的值增加到 2 倍映射"）。
  //   注意"×2"指的是**映射出的湿度翻倍**, 不是量程翻倍: 滑竿读数、存档值、默认值都一个不动,
  //   同一根滑竿在同一位置现在给出两倍的湿声 ⇒ 50 从 1.05 变成 2.1, 满档从 2.1 变成 4.2。
  //   连同下面环境声那一侧的 ×2（0.08 → 0.16）一起, 这是业主听完 0.7.23 之后的口径调整:
  //   0.7.23 先证明"混响能出声了", 这两条再把两根滑竿的可闻区间拉开。
  var REVERB_MIX_MAX = 100, REVERB_MIX_DEFAULT = 35;
  // 环境声强度滑竿 0~100。历史: 用户 2026-09-26 先说"环境噪声设定要变小" ⇒ 量程收到 0~50 的同时
  // 天花板从 0.14 压到 0.08（同档位轻约 43%）。同一天收尾又说"把当前的两个实际范围值都映射成为
  // 滑竿的 0~100…现在环境音范围正好" ⇒ 量程改回 0~100。两句合起来只有一个解: **放大刻度, 不动声音**。
  // 于是天花板保持 0.08（用户觉得正好的那个范围一个不差）, 默认值从 30 换成等响的 60, 而存档里的
  // 旧数值必须一并放大一倍（见 store.seed 的迁移）。
  // 这一迁移是可证明等响的, 不是估的: 改之前的响度 = AMBIENCE_MAX * min(50, v)/50; 迁移后
  // v' = min(100, 2v) ⇒ 响度 = AMBIENCE_MAX * min(100, 2v)/100 = AMBIENCE_MAX * min(50, v)/50,
  // 对任意 v ≥ 0 恒等 —— 连"0.7.18 之前写在 0~100 量程上的旧值"也顺带正确归位。
  // 混响那边**没有**做对应迁移, 因为它的量程回归不是靠搬数值修的（见上面 WET_MAX 那段）。
  // ★ 0.7.24 天花板 0.08 → 0.16（与混响同一次: "把这两个滑竿对应的值增加到 2 倍映射"）。
  //   这一侧是真的没有迁移问题: 量程早就归位到 0~100 了, 只把上限抬一倍 ⇒ 同一读数的响度翻倍。
  var AMBIENCE_MIX_MAX = 100, AMBIENCE_MAX = 0.16, AMBIENCE_MIX_DEFAULT = 60, AMBIENCE_FADE = 0.6;

  // 脉冲响应: 指数衰减噪声 + 几个离散早期反射。
  // 只有"一坨混响"听起来是糊掉的一团; 开头那几声离散回声才是"房间"这个感觉的来源 ——
  // 它们落得多早、多密, 直接决定听感上是小房间还是大厅（见上面一组常量）。
  // 头两条 0.9ms / 3.4ms 是"贴耳"的关键: 它们落在人耳的**融合区**（约 5ms 以内）, 不会被听成
  // 回声, 而是和直达声合成同一个音色 —— 近距离录音时桌面、手、头部的反射必定就在这一档到达,
  // 所以"几毫秒内必有反射"本身就是"话筒在嘴边"的线索。3.4ms 那条取反极性, 免得和 2.6ms
  // 那条同相叠加, 在某个频点上顶出一个突出的梳状峰。
  function buildImpulse(ctx, seconds, decay) {
    var rate = ctx.sampleRate, len = Math.max(1, Math.floor(rate * seconds));
    var buffer = ctx.createBuffer(1, len, rate), data = buffer.getChannelData(0), seed = 0x2f6e2b1;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; }
    for (var index = 0; index < len; index += 1) data[index] = rnd() * Math.pow(1 - index / len, decay);
    [[0.0009, -0.22], [0.0026, 0.58], [0.0034, -0.34], [0.0061, -0.45], [0.0104, 0.37], [0.0158, -0.28], [0.0231, 0.22]].forEach(function (pair) {
      var at = Math.floor(pair[0] * rate); if (at < len) data[at] += pair[1];
    });
    return buffer;
  }

  // 环境声底噪: 粉红噪声 + "疏密交替"包络。
  //
  // 用户 2026-09-26: "环境杂音现在太均匀了, 我希望是那种断续没规律的随机的, 偶尔大一点, 又均匀
  // 小一会 1~3 秒, 然后又大一会半秒几声"。这句描述本身就是包络的**时间结构**, 照抄成两段交替,
  // 而不是另外发明一种"随机" —— 那样只会又随机又均匀:
  //   平缓段 1.8~5.0s（偶尔再长一截）—— 电平低、几乎不变, 就是"均匀小一会", 也是"不紧凑"
  //   突发段 1~4 个音节 —— 每个音节的响度单独抽且偏小声, 音节之间有 60~260ms 空档,
  //                        合起来是"偶尔嚓-小声嚓-小小声-嚓擦", 三成只响一声
  // 段长、峰值、音节数、音节间距每轮各自掷骰子, 叠加两层不同种子, 整条包络听不出周期。
  //
  // 原来那版"太均匀"的根因不在段长, 而在**底噪把谷填死了**: 输出是
  // pink * (0.30 + 0.70 * envelope), envelope 归零时仍剩 30% 电平 —— 等于没有谷, 滑竿一拉
  // 就是一条恒定嘶声。现在底毯降到 0.06, 包络的起伏才真的传到音量上, "断续"才听得见。
  //
  // 头部用循环点之后的那一小段做等功率交叉淡化, 循环处不产生"咔"; 尾部一定不能淡出
  // —— 那会在循环点挖出一个音量凹陷。
  function buildAmbience(ctx, seconds, seed) {
    var rate = ctx.sampleRate, fade = Math.floor(rate * 0.6);
    var len = Math.max(fade * 2, Math.floor(rate * seconds));
    var buffer = ctx.createBuffer(1, len, rate), data = buffer.getChannelData(0);
    var extra = new Float32Array(fade);
    var state = seed, b0 = 0, b1 = 0, b2 = 0;
    function rnd() { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; }
    var envelope = new Float32Array(len + fade), cursor = 0;
    while (cursor < envelope.length) {
      // 平缓段: 电平在 0.10~0.30 之间极缓慢漂移, 长度 1.8~5.0s, 另有四分之一的概率再多安静 2~6s。
      // （用户 2026-09-26 先要"均匀小一会 1~3 秒", 同日又补"不紧凑连续" ⇒ 常规仍落在 1~3s 一带,
      // 但经常拉长到五六秒, 让它明显不密。）
      // 首尾各留 50ms / 40ms 上下坡 —— 台阶作用在噪声上就是一个可闻的点击, 而**尾部回零**这一条
      // 是被实测逼出来的: 只给突发段做起坡时, 平缓段结束时仍停在自己的漂移值(实测最高 0.30)
      // 再猛地接到 0, 包络上就是 0.16~0.24 的单样本跳变。
      var calm = Math.max(1, Math.floor(rate * (1.8 + rnd() * 3.2) * (rnd() < 0.25 ? 1 + rnd() * 1.4 : 1)));
      var calmBase = 0.10 + rnd() * 0.20, calmSway = 0.5 + rnd() * 1.5;
      for (var ci = 0; ci < calm && cursor < envelope.length; ci += 1, cursor += 1) {
        // 起伏深度给到 0.30~1.00（上一版只有 0.65~1.00）。"不紧凑连续"的另一半在这里: 底床如果
        // 只是轻轻抖一下, 听感就是一条一直在响的嘶声; 让它真的涨落四倍, 才有"远处一阵一阵"的意思。
        var drift = 0.30 + 0.70 * Math.sin(cursor / rate * 6.283 / calmSway);
        var rise = Math.min(1, ci / (rate * 0.05));
        var fall = Math.max(0, Math.min(1, (calm - 1 - ci) / (rate * 0.04)));
        envelope[cursor] = calmBase * drift * rise * fall;
      }
      if (cursor >= envelope.length) break;
      // 突发段 = 一个"短句", 由 1~4 个**各自掷骰子**的音节组成。
      // 用户 2026-09-26: "应该是偶尔嚓-小声嚓-小小声-嚓擦…总之大小声没规律而且不紧凑连续"。
      // 和上一版比, 这里改了两件事, 两件都是那句原话直接点出来的:
      //   ① 每个音节的响度单独抽, 且分布**偏向小声**（rnd()^1.6 ⇒ 中位约 0.43、偶发 1.0）——
      //      于是段内出现"嚓 / 小声嚓 / 小小声"这一串强弱。上一版一个突发段共用一个峰值,
      //      段内是平的, 听起来才单调。
      //   ② 音节之间插 60~260ms 空档, 且音节自己收回到 0。相邻音节首尾相接就是"擦擦擦";
      //      有间隔、每声各自收尾, 才是"嚓 嚓"。
      // 另外三成的突发段只响一声 —— 那就是"偶尔嚓"。
      var syllables = rnd() < 0.3 ? 1 : 1 + Math.floor(rnd() * 4);
      for (var s = 0; s < syllables && cursor < envelope.length; s += 1) {
        if (s) {
          var hold = Math.max(1, Math.floor(rate * (0.06 + rnd() * 0.20)));
          for (var h = 0; h < hold && cursor < envelope.length; h += 1, cursor += 1) envelope[cursor] = 0;
        }
        // 35~90ms: "嚓"是短促的一声, 再长就拖成"嘶"了。
        var tone = Math.max(1, Math.floor(rate * (0.035 + rnd() * 0.055)));
        var peak = 0.15 + Math.pow(rnd(), 1.6) * 0.85;
        for (var k = 0; k < tone && cursor < envelope.length; k += 1, cursor += 1) {
          var arch = Math.sin(Math.PI * (k / tone));
          var edge = Math.min(1, k / (rate * 0.006)) * Math.max(0, Math.min(1, (tone - 1 - k) / (rate * 0.012)));
          envelope[cursor] = peak * Math.pow(arch, 0.7) * edge;
        }
      }
    }
    for (var index = 0; index < len + fade; index += 1) {
      var white = rnd() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.0990460; b1 = 0.96300 * b1 + white * 0.2965164; b2 = 0.57000 * b2 + white * 1.0526913;
      var value = (b0 + b1 + b2 + white * 0.1848) * 0.25 * (0.06 + 0.94 * envelope[index]);
      if (index < len) data[index] = value; else extra[index - len] = value;
    }
    // 只改头部: data[0] 变成循环点之后那一段, 于是 data[len-1] -> data[0] 是原信号的
    // 自然延续。尾部一定不能淡出 —— 那会在循环点挖出一个音量凹陷。
    for (var c = 0; c < fade; c += 1) { var t = c / fade; data[c] = data[c] * t + extra[c] * (1 - t); }
    return buffer;
  }

  // 唯一的音频总线。任何一步失败就整体放弃并返回 null, 由调用方退回直连 destination
  // —— 宁可不加混响, 也不能留一条半残的链路把声音弄坏。
  function ensureBus() {
    if (!audioContext || audioContext.state === "closed") return null;
    if (bus && bus.context === audioContext) return bus;
    bus = null;
    try {
      var ctx = audioContext, shared = { context: ctx };
      shared.input = ctx.createGain();
      shared.dry = ctx.createGain(); shared.dry.gain.value = 1;
      // "贴耳"的另一半落在干声上: 一个很轻的 3.4kHz 峰 +2.2dB。近距离拾音的临场感就在这一带。
      // 幅度必须小 —— 干声来自各家 TTS 模型, 通用均衡器一过火立刻变成齿音刺耳。
      shared.dryTone = ctx.createBiquadFilter();
      shared.dryTone.type = "peaking"; shared.dryTone.frequency.value = 3400; shared.dryTone.Q.value = 0.7; shared.dryTone.gain.value = 2.2;
      // 混响的低频最容易糊成一片轰鸣, 单独切掉 120Hz 以下。这里原本是 240Hz, 理由是"近讲时房间声
      // 本来就薄" —— 那个理由站不住: 它把尾巴里最有"房间"感的低中频一起拿掉了, 剩下的高频尾音又
      // 被干声自己的 presence 盖住, 听感上就退化成"混响几乎没有了"。120Hz 只切真正的隆隆声
      // （房间轰鸣在 100Hz 以下）, 厚度留给湿声。
      shared.tone = ctx.createBiquadFilter();
      shared.tone.type = "highpass"; shared.tone.frequency.value = 120; shared.tone.Q.value = 0.7;
      shared.convolver = ctx.createConvolver();
      shared.convolver.buffer = buildImpulse(ctx, REVERB_SECONDS, REVERB_DECAY);
      shared.wet = ctx.createGain(); shared.wet.gain.value = 0;
      // 限幅器: 阈值压在 -1dB 附近, 只在真要削波时才动作。Chrome 的实现会引入约 6ms
      // 前瞻延迟 —— 恒定量, 段段一致, 不影响连续。
      shared.limiter = ctx.createDynamicsCompressor();
      shared.limiter.threshold.value = -1;
      shared.limiter.knee.value = 0;
      shared.limiter.ratio.value = 20;
      shared.limiter.attack.value = 0.002;
      shared.limiter.release.value = 0.22;
      shared.master = ctx.createGain(); shared.master.gain.value = 1;
      shared.ambience = ctx.createGain(); shared.ambience.gain.value = 0;
      shared.ambTone = ctx.createBiquadFilter();
      shared.ambTone.type = "lowpass"; shared.ambTone.frequency.value = 3400; shared.ambTone.Q.value = 0.6;

      shared.input.connect(shared.dry); shared.dry.connect(shared.dryTone); shared.dryTone.connect(shared.limiter);
      shared.input.connect(shared.convolver); shared.convolver.connect(shared.tone);
      shared.tone.connect(shared.wet); shared.wet.connect(shared.limiter);
      shared.limiter.connect(shared.master); shared.master.connect(ctx.destination);
      // 环境声汇进 input: 它和人声共享同一条混响, 听起来才像在同一个房间里。
      shared.ambTone.connect(shared.ambience); shared.ambience.connect(shared.input);
      bus = shared; return bus;
    } catch (_) { bus = null; return null; }
  }

  function outputTarget() { var shared = ensureBus(); return shared ? shared.input : audioContext.destination; }

  // 环境声两层, 循环长度取互质的 16.9s / 19.7s ⇒ 叠起来的最小重复周期约 55 分钟,
  // 听不出循环。单层 20s 在安静环境下是能听出重复的。
  // 惰性建立: 关着环境声的人不必付这两段底噪的生成成本。
  function ensureAmbience(shared) {
    if (shared.ambVoice) return;
    var ctx = shared.context;
    var voice = ctx.createBufferSource(); voice.buffer = buildAmbience(ctx, 16.9, 0x51ed270b); voice.loop = true;
    var wind = ctx.createBufferSource(); wind.buffer = buildAmbience(ctx, 19.7, 0x1f83d9ab); wind.loop = true;
    shared.ambVoiceFilter = ctx.createBiquadFilter(); shared.ambVoiceFilter.type = "bandpass";
    shared.ambWindFilter = ctx.createBiquadFilter(); shared.ambWindFilter.type = "bandpass";
    shared.ambVoiceGain = ctx.createGain(); shared.ambWindGain = ctx.createGain();
    voice.connect(shared.ambVoiceFilter); shared.ambVoiceFilter.connect(shared.ambVoiceGain);
    wind.connect(shared.ambWindFilter); shared.ambWindFilter.connect(shared.ambWindGain);
    shared.ambVoiceGain.connect(shared.ambTone); shared.ambWindGain.connect(shared.ambTone);
    voice.start(0); wind.start(0);
    shared.ambVoice = voice; shared.ambWind = wind;
  }

  // 滑竿读数 -> 百分比。开关已经并进滑竿（用户 2026-09-26: "混响和环境声不用开关, 默认滑竿 0 就是关,
  // 不是 0 就是打开"）, 所以 0 这个值本身承载了"关"的语义, 读的时候必须钳到合法区间:
  // 旧存档可能大于新上限, 手改过的值也可能是负数或字符串。
  function mixPercent(raw, fallback, max) {
    if (raw == null || raw === "") return Number(fallback) || 0;
    var value = Number(raw);
    if (!isFinite(value)) return Number(fallback) || 0;
    return Math.max(0, Math.min(max, value));
  }

  // 每次朗读都重新掷一次: 人声带中心频率、风带中心频率、两层配比、整体音量。
  // 用 setTargetAtTime 而不是直接赋值 —— 参数突变本身就是一个可闻的爆点。
  function startAmbience() {
    var settings = currentSettings || {};
    // 滑竿归零就是关（不再有独立的开关控件）。
    var ambMix = mixPercent(settings.ttsAmbienceMix, AMBIENCE_MIX_DEFAULT, AMBIENCE_MIX_MAX);
    if (!(ambMix > 0)) { stopAmbience(); return; }
    var shared = ensureBus(); if (!shared) return;
    try { ensureAmbience(shared); } catch (_) { return; }
    if (!shared.ambVoice) return;
    var now = shared.context.currentTime;
    shared.ambVoiceFilter.Q.value = 0.6; shared.ambWindFilter.Q.value = 0.4;
    shared.ambVoiceFilter.frequency.setTargetAtTime(1000 + Math.random() * 500, now, 0.5);
    shared.ambWindFilter.frequency.setTargetAtTime(260 + Math.random() * 180, now, 0.5);
    shared.ambVoiceGain.gain.setTargetAtTime(0.75 + Math.random() * 0.5, now, 0.5);
    shared.ambWindGain.gain.setTargetAtTime(0.6 + Math.random() * 0.5, now, 0.5);
    // 强度滑竿在这里起作用, 分母是滑竿的量程（0~100）。乘完再叠一个 ±25% 的随机,
    // 所以"每次略有不同"这件事在滑竿拉满时依然成立。
    ambienceLevel = AMBIENCE_MAX * (ambMix / AMBIENCE_MIX_MAX) * (0.75 + Math.random() * 0.5);
    shared.ambience.gain.cancelScheduledValues(now);
    shared.ambience.gain.setTargetAtTime(muted ? 0 : ambienceLevel, now, AMBIENCE_FADE);
  }

  function stopAmbience() {
    ambienceLevel = 0;
    if (!bus || !bus.ambience) return;
    var now = bus.context.currentTime;
    bus.ambience.gain.cancelScheduledValues(now);
    bus.ambience.gain.setTargetAtTime(0, now, AMBIENCE_FADE / 2);
  }

  // 把设置里的混响强度换算成湿声增益。ttsReverbMix 是 0~100 的滑竿值。
  // 开关并进滑竿（用户 2026-09-26: "混响…不用开关, 默认滑竿 0 就是关, 不是 0 就是打开"）⇒ 归零即关。
  // reverbEnabled 仍保留按次覆盖的能力: Android 系统朗读拿不到混响, 得能单独把它压掉。
  function applyAudioFx(settings, reverbEnabled) {
    if (settings) currentSettings = settings;
    var shared = ensureBus(); if (!shared) return;
    var active = currentSettings || {};
    var mix = mixPercent(active.ttsReverbMix, REVERB_MIX_DEFAULT, REVERB_MIX_MAX);
    var on = reverbEnabled == null ? mix > 0 : Boolean(reverbEnabled) && mix > 0;
    var now = shared.context.currentTime;
    shared.wet.gain.cancelScheduledValues(now);
    shared.wet.gain.setTargetAtTime(on ? (mix / REVERB_MIX_MAX) * WET_MAX : 0, now, 0.12);
  }

  function decodeAudio(blob) {
    return blob.arrayBuffer().then(function (bytes) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        function done(value) { if (!settled) { settled = true; resolve(value); } }
        function fail(error) { if (!settled) { settled = true; reject(error || new Error("音频解码失败")); } }
        try {
          var result = audioContext.decodeAudioData(bytes.slice(0), done, fail);
          if (result && typeof result.then === "function") result.then(done, fail);
        } catch (error) { fail(error); }
      });
    });
  }

  function headers(profile) {
    var result = { "Content-Type": "application/json" };
    var eleven = profile.protocol === "elevenlabs" || profile.type === "elevenlabs";
    var doubao = profile.protocol === "doubao-speech-v3" || profile.type === "doubao";
    if (profile.apiKey) {
      if (eleven) result["xi-api-key"] = profile.apiKey;
      else if (doubao) result["X-Api-Key"] = profile.apiKey;
      else result.Authorization = "Bearer " + profile.apiKey;
    }
    if (doubao) {
      result.Accept = "text/event-stream";
      result["X-Api-Resource-Id"] = profile.model || "seed-tts-2.0";
      result["X-Api-Request-Id"] = requestId();
    }
    if (profile.protocol === "qwen-tts") result["X-DashScope-SSE"] = "enable";
    if (profile.protocol === "azure-speech") {
      result["Content-Type"] = "application/ssml+xml";
      result["X-Microsoft-OutputFormat"] = "raw-24khz-16bit-mono-pcm";
      if (profile.apiKey) result["Ocp-Apim-Subscription-Key"] = profile.apiKey;
      delete result.Authorization;
    }
    Object.assign(result, app.utils.parseHeaders(profile.customHeaders));
    return result;
  }

  function requestId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (letter) {
      var value = Math.floor(Math.random() * 16); return (letter === "x" ? value : value & 3 | 8).toString(16);
    });
  }

  function cleanText(text) { return String(text || "").replace(/```[\s\S]*?```/g, "").trim(); }
  function xml(value) { return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  async function profileFor(role) {
    var settings = await app.data.store.get("meta", "settings");
    // 音效设置跟着每次取配置一起刷新: 用户改完设置回来接着朗读就该生效, 不必再找别处接线。
    currentSettings = settings;
    var service = await app.data.store.get("tts-profiles", role && role.ttsProfileId || settings.defaultTtsProfileId || "system-tts");
    if (!service || service.enabled === false) throw new Error("朗读服务不存在或已停用，请在模型页选择可用服务");
    return { settings: settings, profile: app.services.modelServices.resolveTts(service, role || {}, settings), service: service };
  }

  function requestBody(profile, text, formatOverride) {
    var canonical = app.services.middleware.canonicalSpeech(profile, text);
    text = canonical.input;
    if (profile.protocol === "elevenlabs" || profile.type === "elevenlabs") {
      var elevenBody = { text: text, model_id: profile.model || "eleven_multilingual_v2" };
      return elevenBody;
    }
    if (profile.protocol === "doubao-speech-v3" || profile.type === "doubao") return {
      user: { uid: "chataxi" },
      req_params: {
        text: text,
        speaker: profile.voice,
        sample_rate: Number(profile.sampleRate || 24000),
        audio_params: {
          format: formatOverride || profile.format || "mp3",
          speech_rate: Math.max(-50, Math.min(100, Number(profile.speechRate || 0))),
          loudness_rate: Math.max(-50, Math.min(100, Number(profile.loudnessRate || 0))),
          bit_rate: 64000
        },
        additions: JSON.stringify({ post_process: { pitch: Math.max(-12, Math.min(12, Number(profile.pitchRate || 0))) }, disable_markdown_filter: true, enable_latex_tn: false })
      }
    };
    if (profile.protocol === "xai-tts") return {
      text: text, voice_id: profile.voice, language: profile.language || "auto",
      output_format: { codec: formatOverride === "pcm" ? "pcm_s16le" : formatOverride || profile.format || "mp3", sample_rate: Number(profile.sampleRate || 24000) },
      speed: Number(profile.rate || 1)
    };
    if (profile.protocol === "qwen-tts") return {
      model: profile.model,
      input: { text: text, voice: profile.voice, language_type: profile.language || "Auto" },
      parameters: { format: formatOverride || profile.format || "pcm", sample_rate: Number(profile.sampleRate || 24000) }
    };
    if (profile.protocol === "minimax-tts") return {
      model: profile.model, text: text, stream: formatOverride === "pcm",
      voice_setting: { voice_id: profile.voice, speed: Number(profile.rate || 1), vol: Math.max(0.1, 1 + Number(profile.loudnessRate || 0) / 100), pitch: Number(profile.pitchRate || 0) },
      audio_setting: { sample_rate: Number(profile.sampleRate || 24000), bitrate: 128000, format: formatOverride || profile.format || "mp3", channel: 1 }
    };
    if (profile.protocol === "gemini-tts") return {
      model: profile.model, input: text, stream: formatOverride === "pcm",
      response_format: { type: "audio" },
      generation_config: { speech_config: { voice_config: { prebuilt_voice_config: { voice_name: profile.voice } } } }
    };
    if (profile.protocol === "aws-polly") return {
      Engine: profile.model || "neural", LanguageCode: profile.language || undefined,
      OutputFormat: formatOverride || profile.format || "pcm", SampleRate: String(Number(profile.sampleRate || 24000)),
      Text: text, TextType: "text", VoiceId: profile.voice
    };
    if (profile.protocol === "fish-tts") return { text: text, reference_id: profile.voice || undefined, format: formatOverride || profile.format || "pcm", streaming: true };
    var body = { model: profile.model, input: text, voice: canonical.voiceId, response_format: formatOverride || canonical.responseFormat || "mp3" };
    if (profile.protocol === "vllm-omni") body.stream = true;
    if (profile.family === "siliconflow-tts") body.stream = true;
    if (canonical.instructions) body.instructions = canonical.instructions;
    return body;
  }

  function endpoint(profile, stream) {
    var value = String(stream ? profile.streamEndpoint || profile.endpoint : profile.endpoint || "");
    return value.replace(/\{voice\}/g, encodeURIComponent(profile.voice || ""));
  }

  function pcmStreamProfile(profile) {
    var eleven = profile.protocol === "elevenlabs" || profile.type === "elevenlabs";
    var doubao = profile.protocol === "doubao-speech-v3" || profile.type === "doubao";
    var openai = profile.protocol === "openai-speech" || profile.type === "openai";
    if (eleven) return { kind: "raw", format: "pcm_24000", sampleRate: 24000 };
    if (doubao) return { kind: "sse", format: "pcm", sampleRate: Number(profile.sampleRate || 24000) };
    if (openai) return { kind: "raw", format: "pcm", sampleRate: 24000 };
    if (profile.protocol === "xai-tts" || profile.protocol === "azure-speech" || profile.protocol === "aws-polly" || profile.protocol === "vllm-omni" || profile.protocol === "fish-tts") return { kind: "raw", format: "pcm", sampleRate: Number(profile.sampleRate || 24000) };
    if (profile.protocol === "qwen-tts" || profile.protocol === "minimax-tts" || profile.protocol === "gemini-tts") return { kind: "sse", format: "pcm", sampleRate: Number(profile.sampleRate || 24000) };
    return null;
  }

  function pcmStreamUrl(profile, config) {
    var value = endpoint(profile, true);
    if (profile.protocol === "elevenlabs" || profile.type === "elevenlabs") value += (value.indexOf("?") >= 0 ? "&" : "?") + "output_format=" + encodeURIComponent(config.format);
    return value;
  }

  function signedHeaders(profile, requestHeaders, method, url, bodyText, contentType) {
    if (profile.protocol !== "aws-polly") return requestHeaders;
    return Object.assign({}, requestHeaders, app.services.awsSigV4.sign({
      method: method, url: url, body: bodyText, contentType: contentType,
      region: profile.region, service: "polly", accessKeyId: profile.accessKeyId,
      secretAccessKey: profile.apiKey, sessionToken: profile.sessionToken || ""
    }));
  }

  function audioPayload(data, protocol) {
    if (!data || typeof data !== "object") return null;
    if (data.error || data.base_resp && Number(data.base_resp.status_code || 0) !== 0) {
      var detail = data.error && (data.error.message || data.error) || data.base_resp && (data.base_resp.status_msg || data.base_resp.status_code) || "语音服务返回业务错误";
      throw new Error(app.utils.cleanError(String(detail)));
    }
    if (protocol === "minimax-tts") return data.data && data.data.audio || data.audio || null;
    if (protocol === "qwen-tts") return data.output && data.output.audio && (data.output.audio.data || data.output.audio.audio) || data.audio && data.audio.data || null;
    if (protocol === "gemini-tts") {
      var parts = data.content && data.content.parts || data.outputs && data.outputs[0] && data.outputs[0].content || data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts || [];
      for (var i = 0; i < parts.length; i += 1) { var inline = parts[i].inlineData || parts[i].inline_data || parts[i].audio; if (inline && inline.data && /^audio\//i.test(inline.mimeType || inline.mime_type || "audio/pcm")) return inline.data; }
      return data.audio && (data.audio.data || data.audio) || null;
    }
    return data.data || data.audio || null;
  }

  async function readByteStream(options) {
    if (app.platform.network && app.platform.network.requestByteStream) return app.platform.network.requestByteStream(options);
    if (typeof fetch !== "function") throw streamUnavailable("当前环境没有可用的流式网络接口");
    var controller = typeof AbortController === "function" ? new AbortController() : null; if (options.task) options.task.controller = controller;
    var response = await fetch(options.url, { method: options.method, headers: options.headers, body: options.bodyText, signal: controller && controller.signal });
    if (response.status < 200 || response.status >= 300) throw responseError(response.status, await response.text());
    var reader = response.body && response.body.getReader && response.body.getReader(); if (!reader) throw streamUnavailable("当前 WebView 只能读取完整音频响应");
    while (true) { var part = await reader.read(); if (part.done) break; if (part.value && part.value.length) await options.onChunk(part.value); }
    return { status: response.status };
  }

  function streamUnavailable(message, cause) {
    var error = new Error(message); error.streamUnavailable = true; error.cause = cause; return error;
  }

  function base64Bytes(value) {
    var binary = atob(String(value || "").replace(/\s/g, "")), bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function streamPcm(text, profile, task, onAudio) {
    var config = pcmStreamProfile(profile);
    if (!config) throw streamUnavailable("当前环境没有可用的流式音频通道");
    var url = pcmStreamUrl(profile, config), body = requestBody(profile, text, config.format);
    var bodyText = profile.protocol === "azure-speech" ? '<speak version="1.0" xml:lang="' + xml(profile.language || "zh-CN") + '"><voice name="' + xml(profile.voice) + '">' + xml(text) + '</voice></speak>' : JSON.stringify(body);
    var contentType = profile.protocol === "azure-speech" ? "application/ssml+xml" : "application/json";
    var requestHeaders = signedHeaders(profile, headers(profile), "POST", url, bodyText, contentType), received = false;
    var decoder = config.kind === "sse" ? new TextDecoder("utf-8") : null, buffer = "";
    async function consume(line) {
      if (line.indexOf("data:") !== 0 && line.charAt(0) !== "{") return;
      var raw = line.indexOf("data:") === 0 ? line.slice(5).trim() : line.trim(); if (!raw || raw === "[DONE]") return;
      var event = app.utils.safeJsonParse(raw, null); if (!event) return;
      if (profile.protocol === "doubao-speech-v3") {
        var code = Number(event.code || 0);
        if (code !== 0 && code !== 20000000) throw new Error("豆包语音返回错误（" + code + "）" + (event.message ? "：" + app.utils.cleanError(event.message) : ""));
      }
      var payload = audioPayload(event, profile.protocol), bytes = null;
      if (payload) bytes = profile.protocol === "minimax-tts" ? hexBytes(payload) : base64Bytes(payload);
      if (bytes && bytes.length) { received = true; onAudio(bytes, config.sampleRate); }
    }
    try {
      await readByteStream({
        url: url, method: "POST", headers: requestHeaders, bodyText: bodyText, contentType: contentType, timeoutMs: 120000, task: task,
        onChunk: async function (bytes) {
          if (config.kind === "raw") { if (bytes.length) { received = true; onAudio(bytes, config.sampleRate); } return; }
          buffer += decoder.decode(bytes, { stream: true }); var lines = buffer.split(/\r?\n/); buffer = lines.pop() || "";
          for (var lineIndex = 0; lineIndex < lines.length; lineIndex += 1) await consume(lines[lineIndex]);
        }
      });
      if (decoder) { buffer += decoder.decode(); if (buffer) await consume(buffer); }
    } catch (error) {
      if (task && task.cancelled) { error.cancelled = true; throw error; }
      if (error.streamUnavailable) throw error;
      throw error;
    }
    if (!received) throw new Error("朗读服务没有返回流式音频数据");
    return true;
  }

  function hexBytes(value) {
    var text = String(value || "").replace(/\s/g, ""); if (!/^[0-9a-f]*$/i.test(text) || text.length % 2) throw new Error("语音服务返回了无效的十六进制音频");
    var bytes = new Uint8Array(text.length / 2); for (var i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16); return bytes;
  }

  async function disposeClip(clip) {
    if (!clip) return;
    if (clip.url) { URL.revokeObjectURL(clip.url); clip.url = ""; }
    // cacheOwned 的 clip 属于朗读缓存（见 tts-cache.js）: 那个宿主文件是缓存条目的本体, 播完
    // 不能删, 删了缓存记录第二天就指向一个不存在的文件。它的生命周期由 LRU 淘汰负责。
    if (clip.logicalFileId && !clip.cacheOwned && app.platform.haminn.available()) await app.platform.haminn.api().files.delete({ logicalFileId: clip.logicalFileId }).catch(function () {});
    clip.logicalFileId = ""; clip.blob = null;
  }

  async function disposeReady(item) {
    if (!item) return;
    if (item.clip) await disposeClip(item.clip);
    item.pcmChunks = [];
  }

  async function pruneReady() {
    var ids = Object.keys(ready).sort(function (left, right) { return ready[left].createdAt - ready[right].createdAt; });
    var bytes = ids.reduce(function (sum, id) { return sum + Number(ready[id].pcmBytes || 0); }, 0);
    while (ids.length > MAX_READY_ITEMS || bytes > MAX_READY_PCM_BYTES) {
      var oldest = ids.shift(), item = ready[oldest];
      bytes -= Number(item && item.pcmBytes || 0); delete ready[oldest]; await disposeReady(item);
    }
  }

  async function rememberPcm(owner) {
    if (!owner || !owner.messageId || owner.cacheOverflow || !owner.pcmCache || !owner.pcmCache.length) return false;
    var previous = ready[owner.messageId];
    ready[owner.messageId] = {
      pcmChunks: owner.pcmCache,
      pcmBytes: owner.pcmCacheBytes,
      sampleRate: owner.pcmSampleRate || 24000,
      roleId: owner.role && owner.role.id || "",
      createdAt: Date.now()
    };
    if (previous) await disposeReady(previous);
    owner.pcmCache = [];
    await pruneReady();
    emit({ speaking: false, ready: true, messageId: owner.messageId });
    return true;
  }

  async function invalidate(messageId) {
    var item = ready[messageId]; if (!item) return false;
    delete ready[messageId]; await disposeReady(item); return true;
  }

  async function invalidateMany(messageIds) {
    var ids = Array.isArray(messageIds) ? messageIds : [];
    for (var index = 0; index < ids.length; index += 1) await invalidate(ids[index]);
  }

  async function invalidateRole(roleId) {
    var ids = Object.keys(ready).filter(function (id) { return ready[id].roleId === roleId; });
    await invalidateMany(ids);
  }

  async function invalidateAll() { await invalidateMany(Object.keys(ready)); }

  // 整段合成那一份请求的材料（地址 / 请求体 / 头）。抽出来是为了让**缓存查键**与**真正发出去的
  // 请求**用的是同一份东西 —— 两处各拼一遍迟早会漂移, 那时候缓存要么永远不命中（白占额度）,
  // 要么命中错的一条（播的是另一句的音频）, 而这两种错都不会报错。
  function nonStreamRequest(profile, text, stream) {
    var url = endpoint(profile, stream), body = requestBody(profile, text);
    var contentType = profile.protocol === "azure-speech" ? "application/ssml+xml" : "application/json";
    var bodyText = profile.protocol === "azure-speech" ? '<speak version="1.0" xml:lang="' + xml(profile.language || "zh-CN") + '"><voice name="' + xml(profile.voice) + '">' + xml(text) + '</voice></speak>' : JSON.stringify(body);
    return { url: url, bodyText: bodyText, contentType: contentType, headers: signedHeaders(profile, headers(profile), "POST", url, bodyText, contentType) };
  }

  // 朗读缓存查键用的材料, 与 synthesize 真正会发出去的那份完全一致（同一函数产出）。
  async function cacheKeyFor(profile, text) { return app.services.ttsCache.keyFor(nonStreamRequest(profile, text, false)); }

  // 逐段 PCM 封成 WAV。流式那条路只拿得到裸 PCM, 想进"整段音频"缓存就得自己套容器。
  // 选 WAV 而不是 mp3: 它不需要编码器（44 字节头 + 采样字节），而 decodeAudioData 原生就吃 WAV ——
  // 于是流式音频被缓存之后, 命中时走的还是 playClip 那条**既有的**解码播放路径, 不必为它另开一条播放链。
  function wavFromPcm(chunks, sampleRate, bytes) {
    var total = Number(bytes || 0);
    if (!chunks || !chunks.length || total <= 0) return null;
    var rate = Math.max(8000, Number(sampleRate || 24000));
    var buffer = new ArrayBuffer(44 + total), view = new DataView(buffer);
    function ascii(at, text) { for (var index = 0; index < text.length; index += 1) view.setUint8(at + index, text.charCodeAt(index)); }
    ascii(0, "RIFF"); view.setUint32(4, 36 + total, true); ascii(8, "WAVE");
    ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    ascii(36, "data"); view.setUint32(40, total, true);
    var target = new Uint8Array(buffer, 44), offset = 0;
    for (var index = 0; index < chunks.length; index += 1) {
      var chunk = chunks[index]; if (offset + chunk.length > total) break;
      target.set(chunk, offset); offset += chunk.length;
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  // 把刚播完的流式 PCM 收进朗读缓存。
  //
  // 这一步是补一个**洞**, 不是优化: 缓存原来只挂在整段合成那条路上（synthesize 查 + 存）, 而 speak()
  // 一旦判定这条服务支持流式（capabilities.audioStreaming && pcmStreamProfile）就走流式分支 ——
  // 那条路既不查也不写缓存。于是"反复点同一条消息的朗读按钮"永远打接口、永远重新生成, 一次都不会命中
  // （用户 2026-09-26 报的就是这个: "缓存好像没有生效, 反复点同一个朗读按钮应该立即播放"）。
  // 逐段 PCM 本来就攒在 owner.pcmCache 里（rememberPcm 用的就是同一份），直接封成 WAV 存进去。
  //
  // 键用的是**整段请求**那个键（cacheKey）, 与 synthesize / playReady 同源。这是有意的:
  // 流式与非流式只是容器不同（pcm 对 mp3）, 说的却是同一句话、同一个音色, 而用户的判据就是
  // "内容 + 模型 + 音色"。分成两个键会让同一句话占掉两条额度, 命中率还减半。
  async function cacheStreamedClip(owner, cacheKey, profile, text) {
    try {
      // 中途被停掉的朗读绝不能进缓存: 存半句进去, 以后每次命中都只播这半句, 而且看不出是缓存造成的。
      if (!cacheKey || !owner || owner.cancelled || !owner.finished || owner.cacheOverflow) return false;
      var chunks = (owner.pcmCache || []).slice(), bytes = Number(owner.pcmCacheBytes || 0);
      // 凑不成整采样的那个尾字节留在 pcmRemainder 里, 补上它总长才是偶数。
      if (owner.pcmRemainder != null) { chunks.push(new Uint8Array([owner.pcmRemainder])); bytes += 1; }
      var rate = Number(owner.pcmSampleRate || 24000);
      var blob = wavFromPcm(chunks, rate, bytes);
      if (!blob) return false;
      return await app.services.ttsCache.store(cacheKey, { blob: blob, mime: "audio/wav", seconds: bytes / 2 / rate }, { chars: text.length, profileId: profile.id });
    } catch (_) { return false; }
  }

  // 非 SSE 的音频响应（各家 mp3 / opus 整段合成）走**原生字节流**取回页面, 而不是 network.request。
  //
  // 为什么必须换通道: 宿主对"没有 Content-Length 的响应"（chunked —— ElevenLabs / OpenAI 这类 TTS
  // 一律如此）会把它落成一个宿主文件, 只回一个 logicalFileId（NativeHttpClient.request:
  // declaredLength < 0 直接进 file 分支）。那种音频只有宿主播放器（api.audio.play）能放, 而宿主播放器
  // 在 WebView 之外出声 ⇒ 音频不进 AudioContext ⇒ 混响器与环境声都挂不上去, 那条路上**永远**没有混响。
  // 页面自己按同源 url 去取也不行: 宿主发给 happ 的 CSP 是 connect-src 'none'（见
  // LocalContentGateway.headers）, fetch 会被直接拦掉。
  // openStream / readStream 是走原生 socket 的字节通道, 响应体原样以 base64 分片回来 ⇒ 自己拼成 Blob
  // ⇒ 回到 decodeAudioData → 音频总线那条带混响的路。流式朗读一直用的就是这条通道。
  //
  // 返回 null 只表示"这条通道不在"（旧宿主 / 降级环境）, 由调用方退回 network.request 的老流程;
  // 其它错误照原样抛, 只把错误措辞换回朗读服务那一套（设置页连测会把它显示给人看）。
  async function streamAudioBody(request, task) {
    var network = app.platform.network;
    if (!network || typeof network.requestByteStream !== "function") return null;
    var chunks = [], total = 0;
    try {
      var result = await network.requestByteStream({
        url: request.url, method: "POST", headers: request.headers, bodyText: request.bodyText,
        contentType: request.contentType, timeoutMs: 90000, chunkBytes: 32 * 1024, task: task,
        onChunk: function (bytes) { chunks.push(bytes); total += bytes.length; }
      });
      var merged = new Uint8Array(total), offset = 0;
      for (var index = 0; index < chunks.length; index += 1) { merged.set(chunks[index], offset); offset += chunks[index].length; }
      var raw = result.contentType || (result.headers && (result.headers["content-type"] || result.headers["Content-Type"])) || "audio/mpeg";
      return { bytes: merged, mime: String(raw).split(";")[0].trim() || "audio/mpeg" };
    } catch (error) {
      // 与流式朗读同一条回退策略: 通道不存在, 或者一次可重试的连接中断, 就退回老的 network.request 流程
      // —— 多打一次接口好过直接失败（那条路没有混响, 属于兜底）。其它错误照原样抛。
      if (error && (error.streamUnavailable || error.code === "E_NETWORK" && error.retryable === true)) return null;
      if (error && error.status) {
        var payload = error.payload;
        var detail = payload && typeof payload === "object" ? (payload.error || payload.detail || payload.message || payload) : payload;
        throw responseError(error.status, detail == null ? "" : (typeof detail === "string" ? detail : JSON.stringify(detail)));
      }
      throw error;
    }
  }

  async function audioClipFromBytes(streamed, cacheKey, text, profile) {
    if (!streamed.bytes || !streamed.bytes.length) throw new Error("语音服务没有返回可播放音频");
    var clip = { blob: new Blob([streamed.bytes], { type: streamed.mime }), mime: streamed.mime, seconds: estimateSeconds(text) };
    await app.services.ttsCache.store(cacheKey, clip, { chars: text.length, profileId: profile.id }).catch(function () {});
    return clip;
  }

  async function synthesize(text, profile, task, stream) {
    var request = nonStreamRequest(profile, text, stream);
    // 先查缓存, 再决定要不要打接口（用户 2026-09-26: "每次要进行朗读的任务前, 都检查一下 hash 是否存在"）。
    // 键与 playReady / prepare / testService 走的同一条整段合成请求 ⇒ 这四处互相之间也共享缓存。
    var cacheKey = await app.services.ttsCache.keyFor(request);
    var cached = await app.services.ttsCache.take(cacheKey);
    if (cached) { if (task) task.cacheHit = true; return cached; }
    var sseProtocol = ["doubao-speech-v3", "qwen-tts", "minimax-tts", "gemini-tts"].indexOf(profile.protocol) >= 0;
    // SSE 那几家必须走 network.request + readText（响应是文本帧, 而且 readText 已经会处理"宿主落成
    // 文件"的情况）。二进制音频走字节流, 理由见 streamAudioBody。
    if (!sseProtocol) {
      var streamed = await streamAudioBody(request, task);
      if (streamed) return await audioClipFromBytes(streamed, cacheKey, text, profile);
    }
    var response = await app.platform.network.request({ url: request.url, method: "POST", headers: request.headers, bodyText: request.bodyText, contentType: request.contentType, timeoutMs: 90000, task: task });
    if (task.cancelled) { if (response.file && response.file.logicalFileId && app.platform.haminn.available()) await app.platform.haminn.api().files.delete({ logicalFileId: response.file.logicalFileId }).catch(function () {}); return null; }
    if (sseProtocol) {
      var sseText = await app.platform.network.readText(response);
      if (response.status < 200 || response.status >= 300) throw responseError(response.status, sseText);
      var audio = parseSpeechPayload(sseText, profile, profile.format || "mp3");
      if (!audio || !audio.size) throw new Error("朗读服务没有返回可播放音频");
      var sseClip = { blob: audio, mime: audio.type, seconds: estimateSeconds(text) };
      await app.services.ttsCache.store(cacheKey, sseClip, { chars: text.length, profileId: profile.id }).catch(function () {});
      return sseClip;
    }
    if (response.status < 200 || response.status >= 300) { var failedText = await app.platform.network.readText(response); throw responseError(response.status, failedText); }
    if (response.file && response.file.logicalFileId) {
      // 只有"宿主没有字节流能力"的旧 APK 才会走到这里。这条路拿不到字节回流, 只能把句柄记进缓存
      // —— 那就必须由缓存拥有这个文件（cacheOwned）, 否则播完 disposeClip 一删, 缓存记录就指向一个
      // 不存在的文件。注意它没有混响（宿主播放器在总线之外）, 这是旧宿主的固有代价。
      var fileClip = { logicalFileId: response.file.logicalFileId, mime: response.file.mime || "audio/mpeg", seconds: estimateSeconds(text) };
      if (await app.services.ttsCache.store(cacheKey, fileClip, { chars: text.length, profileId: profile.id })) fileClip.cacheOwned = true;
      return fileClip;
    }
    if (!response.bodyBase64) throw new Error("语音服务没有返回可播放音频");
    var mime = response.headers && (response.headers["content-type"] || response.headers["Content-Type"]) || "audio/mpeg";
    var clip = { blob: app.utils.base64ToBlob(response.bodyBase64, mime), mime: mime, seconds: estimateSeconds(text) };
    await app.services.ttsCache.store(cacheKey, clip, { chars: text.length, profileId: profile.id }).catch(function () {});
    return clip;
  }

  function responseError(status, bodyText) {
    var payload = app.utils.safeJsonParse(bodyText, null), detail = payload && (payload.error || payload.detail || payload.message || payload);
    var message = detail && typeof detail === "object" ? detail.message || detail.status || detail.code : detail;
    var category = status === 401 ? "朗读服务认证失败" : status === 403 ? "朗读服务权限不足" : status === 429 ? "朗读服务额度或频率限制" : "朗读服务请求失败";
    return new Error(category + "（" + status + "）" + (message ? "：" + app.utils.cleanError(String(message)) : ""));
  }

  function parseDoubaoSse(text, format) {
    var chunks = [], lines = String(text || "").split(/\r?\n/);
    lines.forEach(function (line) {
      if (line.indexOf("data:") !== 0) return;
      var event = app.utils.safeJsonParse(line.slice(5).trim(), null); if (!event) return;
      var code = Number(event.code || 0);
      if (code !== 0 && code !== 20000000) throw new Error("豆包语音返回错误（" + code + "）" + (event.message ? "：" + app.utils.cleanError(event.message) : ""));
      if (!event.data) return;
      chunks.push(base64Bytes(event.data));
    });
    return chunks.length ? new Blob(chunks, { type: format === "ogg_opus" ? "audio/ogg" : format === "pcm" ? "audio/pcm" : "audio/mpeg" }) : null;
  }

  function parseSpeechPayload(text, profile, format) {
    if (profile.protocol === "doubao-speech-v3") return parseDoubaoSse(text, format);
    var chunks = [], lines = String(text || "").split(/\r?\n/), protocol = profile.protocol;
    lines.forEach(function (line) {
      var raw = line.indexOf("data:") === 0 ? line.slice(5).trim() : line.trim(); if (!raw || raw === "[DONE]") return;
      var event = app.utils.safeJsonParse(raw, null); if (!event) return;
      var payload = audioPayload(event, protocol); if (!payload) return;
      chunks.push(protocol === "minimax-tts" ? hexBytes(payload) : base64Bytes(payload));
    });
    return chunks.length ? new Blob(chunks, { type: format === "wav" ? "audio/wav" : format === "pcm" ? "audio/pcm" : format.indexOf("ogg") >= 0 ? "audio/ogg" : "audio/mpeg" }) : null;
  }

  function estimateSeconds(text) {
    var value = String(text || ""), cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
    var other = value.replace(/[\u3400-\u9fff\s.,!?;:'"，。！？；：、“”‘’（）()\[\]{}<>《》—…-]/g, "").length;
    return Math.max(0.6, cjk / 4.2 + other / 12);
  }

  function attachPcmPlayer(owner, token, options) {
    owner.pcmQueue = []; owner.pcmSources = []; owner.pcmRemainder = null; owner.bufferedSeconds = 0; owner.started = false; owner.starved = false; owner.finished = false; owner.pcmActive = 0; owner.pcmNextTime = 0;
    owner.pcmCache = []; owner.pcmCacheBytes = 0; owner.pcmSampleRate = 0; owner.cacheOverflow = false;
    var resolveDone, rejectDone;
    owner.pcmDone = new Promise(function (resolve, reject) { resolveDone = resolve; rejectDone = reject; });
    owner.pcmDone.catch(function () {});
    owner.pcmResolve = resolveDone; owner.pcmReject = rejectDone;
    if (!audioContext || !playbackUnlocked) throw streamUnavailable("请先触摸页面以启用流式音频播放");
    owner.audioGain = audioContext.createGain(); owner.audioGain.gain.value = muted ? 0 : 1; owner.audioGain.connect(outputTarget());

    function settle(error) {
      if (!owner.pcmResolve && !owner.pcmReject) return;
      var resolve = owner.pcmResolve, reject = owner.pcmReject; owner.pcmResolve = null; owner.pcmReject = null;
      error ? reject(error) : resolve();
    }
    function maybeDone() {
      if (owner.cancelled) { settle(); return; }
      if (owner.finished && owner.pcmActive === 0 && !owner.pcmQueue.length) { owner.starved = false; settle(); return; }
      if (owner.started && !owner.finished && owner.pcmActive === 0 && !owner.pcmQueue.length) { owner.starved = true; emit({ speaking: false, paused: true, messageId: owner.messageId }); }
    }
    function schedule(entry) {
      var samples = entry.samples, buffer = audioContext.createBuffer(1, samples.length, entry.sampleRate), channel = buffer.getChannelData(0);
      channel.set(samples);
      var source = audioContext.createBufferSource(); source.buffer = buffer; source.connect(owner.audioGain);
      var when = Math.max(owner.pcmNextTime || 0, audioContext.currentTime + 0.035); owner.pcmNextTime = when + samples.length / entry.sampleRate; owner.pcmActive += 1; owner.pcmSources.push(source);
      source.onended = function () { owner.pcmSources = owner.pcmSources.filter(function (item) { return item !== source; }); owner.pcmActive = Math.max(0, owner.pcmActive - 1); maybeDone(); };
      source.start(when);
    }
    function startQueue() {
      if (backgrounded || owner.cancelled || token !== generation || owner.started && !owner.starved) return;
      owner.started = true; owner.starved = false; emit({ speaking: true, messageId: owner.messageId });
      while (owner.pcmQueue.length) schedule(owner.pcmQueue.shift());
    }
    function push(bytes, sampleRate) {
      if (owner.cancelled || token !== generation || !bytes || !bytes.length) return;
      var input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), merged;
      if (owner.pcmRemainder != null) { merged = new Uint8Array(input.length + 1); merged[0] = owner.pcmRemainder; merged.set(input, 1); input = merged; owner.pcmRemainder = null; }
      if (input.length % 2) { owner.pcmRemainder = input[input.length - 1]; input = input.slice(0, -1); }
      if (!input.length) return;
      if (options.cache !== false && !owner.cacheOverflow) {
        if (owner.pcmCacheBytes + input.byteLength <= MAX_READY_PCM_BYTES) {
          owner.pcmCache.push(input.slice()); owner.pcmCacheBytes += input.byteLength; owner.pcmSampleRate = sampleRate;
        } else { owner.pcmCache = []; owner.pcmCacheBytes = 0; owner.cacheOverflow = true; }
      }
      var view = new DataView(input.buffer, input.byteOffset, input.byteLength), samples = new Float32Array(input.byteLength / 2);
      for (var index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
      var entry = { samples: samples, sampleRate: sampleRate }, seconds = samples.length / sampleRate; owner.bufferedSeconds += seconds;
      if (owner.started && !owner.starved) schedule(entry); else owner.pcmQueue.push(entry);
      emit({ speaking: owner.started && !owner.starved, buffering: !owner.started, paused: owner.starved, messageId: owner.messageId, bufferedSeconds: owner.bufferedSeconds });
      if (options.autoPlay !== false && !owner.started && owner.bufferedSeconds >= Number(options.minBufferSeconds == null ? 3 : options.minBufferSeconds)) startQueue();
    }
    function finish() { owner.finished = true; owner.pcmRemainder = null; if (options.autoPlay !== false && !owner.started) startQueue(); maybeDone(); return owner.pcmDone; }
    function resumePcm() { if (!owner.starved || !owner.pcmQueue.length) return false; startQueue(); return true; }
    owner.pushPcm = push; owner.finishPcm = finish; owner.resume = resumePcm; owner.startPcm = startQueue; owner.failPcm = function (error) { settle(error); };
    return owner;
  }

  function playClip(clip, owner, token) {
    return new Promise(async function (resolve, reject) {
      function releaseClip() { return owner.preserveActiveClip ? Promise.resolve() : disposeClip(clip); }
      if (token !== generation || owner.cancelled) { await releaseClip(); resolve(); return; }
      owner.activeClip = clip; owner.playbackResolve = resolve;
      if (clip.logicalFileId && app.platform.haminn.available()) {
        var finished = false, offs = [];
        function done(error) { if (finished) return; finished = true; offs.splice(0).forEach(function (off) { off(); }); owner.playbackId = null; owner.activeClip = null; owner.playbackResolve = null; releaseClip().then(function () { error ? reject(error) : resolve(); }); }
        offs.push(app.platform.haminn.on("audio.playback.done", function (data) { if (!owner.playbackId || data.playbackId === owner.playbackId) done(); }));
        offs.push(app.platform.haminn.on("audio.playback.error", function (data) { if (!owner.playbackId || data.playbackId === owner.playbackId) done(new Error("音频播放失败")); }));
        try { var playback = await app.platform.haminn.api().audio.play({ logicalFileId: clip.logicalFileId, volume: muted ? 0 : 1 }); if (owner.cancelled || token !== generation) { await app.platform.haminn.api().audio.stopPlayback({ playbackId: playback.playbackId }).catch(function () {}); done(); return; } owner.playbackId = playback.playbackId; }
        catch (error) { done(error); }
        return;
      }
      if (clip.blob && playbackUnlocked && audioContext) {
        try {
          if (audioContext.state !== "running" && typeof audioContext.resume === "function") await audioContext.resume();
          var decoded = await decodeAudio(clip.blob);
          if (token !== generation || owner.cancelled) { await releaseClip(); resolve(); return; }
          var source = audioContext.createBufferSource(), gain = audioContext.createGain();
          source.buffer = decoded; gain.gain.value = muted ? 0 : 1; source.connect(gain); gain.connect(outputTarget());
          owner.audioSource = source; owner.audioGain = gain;
          source.onended = function () { owner.audioSource = null; owner.audioGain = null; owner.activeClip = null; owner.playbackResolve = null; releaseClip().then(resolve); };
          source.start(0); return;
        } catch (_) { owner.audioSource = null; owner.audioGain = null; }
      }
      if (!clip.url && clip.blob) clip.url = URL.createObjectURL(clip.blob);
      if (!clip.url || typeof Audio !== "function") { await disposeClip(clip); reject(new Error("当前环境不能播放语音")); return; }
      var audio = new Audio(clip.url); audio.muted = muted; owner.audio = audio;
      audio.onended = function () { owner.audio = null; owner.activeClip = null; owner.playbackResolve = null; releaseClip().then(resolve); };
      audio.onerror = function () { owner.audio = null; owner.activeClip = null; owner.playbackResolve = null; releaseClip().then(function () { reject(new Error("音频无法播放，请检查服务输出格式")); }); };
      try {
        await audio.play();
        if (token !== generation || owner.cancelled) { audio.pause(); owner.audio = null; await releaseClip(); resolve(); }
      } catch (error) { owner.audio = null; await releaseClip(); reject(/gesture|notallowed/i.test(String(error && (error.message || error))) ? new Error("当前 WebView 阻止了网页音频播放，请触摸页面后重试") : error); }
    });
  }

  async function stopOwner(owner) {
    if (!owner) return;
    owner.cancelled = true;
    if (owner.task) { owner.task.cancelled = true; if (owner.task.controller) owner.task.controller.abort(); }
    (owner.offs || []).forEach(function (off) { off(); }); owner.offs = [];
    if (owner.audio) { owner.audio.onended = null; owner.audio.onerror = null; owner.audio.pause(); owner.audio = null; }
    if (owner.audioSource) { owner.audioSource.onended = null; try { owner.audioSource.stop(0); } catch (_) {} owner.audioSource = null; }
    while (owner.pcmSources && owner.pcmSources.length) { var source = owner.pcmSources.shift(); source.onended = null; try { source.stop(0); } catch (_) {} }
    owner.pcmQueue = []; owner.pcmActive = 0; if (owner.pcmResolve) { owner.pcmResolve(); owner.pcmResolve = null; owner.pcmReject = null; }
    if (owner.socketTimer) { clearTimeout(owner.socketTimer); owner.socketTimer = null; }
    if (owner.socketSession) { await owner.socketSession.close("Cancelled").catch(function () {}); owner.socketSession = null; }
    if (owner.socket) { owner.socket.onopen = null; owner.socket.onmessage = null; owner.socket.onerror = null; owner.socket.onclose = null; try { owner.socket.close(); } catch (_) {} owner.socket = null; }
    if (owner.audioGain && typeof owner.audioGain.disconnect === "function") { try { owner.audioGain.disconnect(); } catch (_) {} }
    owner.audioGain = null;
    if (owner.playbackId && app.platform.haminn.available()) await app.platform.haminn.api().audio.stopPlayback({ playbackId: owner.playbackId }).catch(function () {});
    owner.playbackId = null;
    if (owner.activeClip && !owner.preserveActiveClip) await disposeClip(owner.activeClip); owner.activeClip = null;
    if (owner.playbackResolve) owner.playbackResolve(); owner.playbackResolve = null;
    while (owner.clips && owner.clips.length) await disposeClip(owner.clips.shift());
    if (owner.utteranceId && app.platform.haminn.available()) await app.platform.haminn.api().tts.stop().catch(function () {});
  }

  async function stop(options) {
    options = options || {};
    generation += 1;
    var owner = current; current = null;
    if (!options.background) { pausedPlayback = null; backgroundResume = null; }
    await stopOwner(owner);
    stopAmbience();
    emit({ speaking: false });
  }

  async function speakSystem(text, profile, settings, owner, token) {
    if (!(await app.platform.haminn.awaitReady(1000))) throw new Error("系统朗读需要在 HaminnApp 中使用");
    var api = app.platform.haminn.api(), catalog = await api.tts.voices();
    if (token !== generation) return;
    owner.offs = ["tts.done", "tts.error"].map(function (event) { return app.platform.haminn.on(event, function (data) {
      if (token !== generation || owner.utteranceId && data.utteranceId !== owner.utteranceId) return;
      if (event === "tts.error") app.events.emit("tts:error", { message: "系统朗读失败，请检查系统语音服务" });
      stop();
    }); });
    var languages = Array.isArray(catalog.languages) ? catalog.languages : [], voices = Array.isArray(catalog.voices) ? catalog.voices : [];
    var language = languages.indexOf(profile.language) >= 0 ? profile.language : undefined;
    var voiceId = voices.some(function (voice) { return voice.id === profile.voice; }) ? profile.voice : undefined;
    var result = await api.tts.speak({ text: text, language: language, voiceId: voiceId, rate: Number(profile.rate || 1), pitch: Number(profile.pitch || 1) });
    if (token !== generation) { await api.tts.stop(); return; }
    owner.utteranceId = result.utteranceId;
  }

  async function speak(text, role) {
    var clean = cleanText(text); if (!clean) return;
    if (backgrounded) {
      await stop(); backgroundResume = { kind: "speak", text: clean, role: role };
      emit({ speaking: false, suspended: true }); return;
    }
    await stop();
    var token = ++generation, owner = { cancelled: false, task: { cancelled: false }, clips: [], resumeRequest: { kind: "speak", text: clean, role: role } }; current = owner;
    var resolved = await profileFor(role);
    if (token !== generation) return;
    emit({ speaking: true });
    // 拿到配置之后、真正出声之前就把音效就位: 混响是常驻总线上的一个参数, 环境声则提前
    // 淡入 —— 听感上"房间一直都在", 而不是每句话重新开一次。
    //
    // Android 系统朗读（profile.type === "system"）由 App 直接发声, 音频流不进 WebView, 混响挂不上。
    // 既然挂不上, 环境声也必须一起撤: 只留环境声会变成"人声是干的、背景声却一直在响", 比两者都关
    // 更难听, 也和设置页那句"混响和环境声对 Android 系统朗读无效"对不上。
    // 角色编辑页与模型页的试听走的都是这个 speak(), 所以这条判断对它们同样成立。
    var systemVoice = resolved.profile.type === "system";
    applyAudioFx(resolved.settings, !systemVoice);
    if (systemVoice) stopAmbience(); else startAmbience();
    try {
      if (resolved.profile.type === "system") { await speakSystem(clean, resolved.profile, resolved.settings, owner, token); return; }
      // 整段音频缓存（用户 2026-09-26）。读同一条消息的第二次、群聊里反复出现的同一句台词,
      // 都不必再打一次 TTS 接口。查在**流式之前** —— 流式那条路是"边生成边播", 而已合成好的整段
      // 音频直接放更快也更省。键在这里算一次并往下传: 流式分支播完也要往同一个键里写（见
      // cacheStreamedClip）—— 只查不写的话, 走流式的服务永远是"每点一次重新生成一次"。
      var cacheKey = await cacheKeyFor(resolved.profile, clean);
      var cachedClip = await app.services.ttsCache.take(cacheKey);
      if (cachedClip) {
        if (token !== generation) return;
        await playClip(cachedClip, owner, token);
        if (token === generation) await stop();
        return;
      }
      var capabilities = app.services.modelServices.ttsCapabilities(resolved.service, resolved.profile.model);
      if (capabilities.audioStreaming && pcmStreamProfile(resolved.profile) && playbackUnlocked && audioContext) {
        try {
          owner.messageId = ""; attachPcmPlayer(owner, token, { autoPlay: true, minBufferSeconds: 3 });
          await streamPcm(clean, resolved.profile, owner.task, function (bytes, sampleRate) { owner.streamReceived = true; owner.pushPcm(bytes, sampleRate); });
          await owner.finishPcm();
          await cacheStreamedClip(owner, cacheKey, resolved.profile, clean);
          if (token === generation) await stop(); return;
        } catch (streamError) {
          var recoverable = streamError.streamUnavailable || streamError.code === "E_NETWORK" && streamError.retryable === true;
          if (!recoverable || owner.started) throw streamError;
          await stopOwner(owner); token = ++generation; owner = { cancelled: false, task: { cancelled: false }, clips: [], resumeRequest: { kind: "speak", text: clean, role: role } }; current = owner; emit({ speaking: true });
        }
      }
      var clip = await synthesize(clean, resolved.profile, owner.task, false); if (!clip || token !== generation) return;
      await playClip(clip, owner, token); if (token === generation) await stop();
    } catch (error) { if (token === generation) { await stop(); throw error; } }
  }

  async function prepare(text, role, messageId) {
    var clean = cleanText(text); if (!clean || !messageId) return false;
    var resolved = await profileFor(role);
    if (resolved.profile.type === "system") return false;
    await stop(); var token = ++generation, owner = { cancelled: false, task: { cancelled: false }, clips: [], messageId: messageId }; current = owner;
    emit({ speaking: false, preparing: true, messageId: messageId });
    var clip;
    try { clip = await synthesize(clean, resolved.profile, owner.task, false); }
    catch (error) { if (current === owner) current = null; emit({ speaking: false, messageId: messageId }); throw error; }
    if (!clip || owner.cancelled || token !== generation) { await disposeClip(clip); return false; }
    if (ready[messageId]) await disposeReady(ready[messageId]);
    ready[messageId] = { clip: clip, role: role, createdAt: Date.now() };
    await pruneReady();
    current = null;
    emit({ speaking: false, ready: true, messageId: messageId }); return true;
  }

  async function testService(service) {
    var settings = await app.data.store.get("meta", "settings");
    var candidates = app.services.modelServices.models("tts", service), selected = candidates.find(function (item) { return item.id === service.defaultModelId; }) || candidates[0];
    var model = selected && selected.id || service.defaultModelId || service.model || "";
    var availableVoices = app.services.modelServices.voices(service, model);
    var voice = (availableVoices.find(function (item) { return item.id === service.defaultVoiceId; }) || availableVoices[0] || {}).id || service.defaultVoiceId || service.voice || "";
    var profile = app.services.modelServices.resolveTts(service, { ttsModel: model, ttsVoice: voice }, settings);
    if (!profile.model || profile.type !== "system" && !profile.voice && profile.protocol !== "fish-tts") throw new Error("服务缺少可测试的模型或音色");
    var task = { cancelled: false }, clip = await synthesize(app.i18n.pick("你好", "Hello"), profile, task, false); await disposeClip(clip); return { modelId: model, voiceId: voice };
  }

  async function playReady(messageId) {
    var item = ready[messageId]; if (!item) return false;
    if (backgrounded) { backgroundResume = { kind: "ready", messageId: messageId }; emit({ speaking: false, suspended: true, messageId: messageId }); return true; }
    if (item.clip) delete ready[messageId];
    await stop();
    var token = ++generation, owner = { cancelled: false, task: { cancelled: false }, clips: [], messageId: messageId, resumeRequest: { kind: "ready", messageId: messageId, item: item } }; current = owner; emit({ speaking: true, messageId: messageId });
    applyAudioFx(await app.data.store.get("meta", "settings"));
    startAmbience();
    try {
      if (item.pcmChunks && item.pcmChunks.length) {
        owner.messageId = messageId; attachPcmPlayer(owner, token, { autoPlay: true, minBufferSeconds: 0, cache: false });
        item.pcmChunks.forEach(function (chunk) { owner.pushPcm(chunk, item.sampleRate || 24000); });
        owner.finished = true; await owner.finishPcm();
      } else await playClip(item.clip, owner, token);
      if (token === generation) await stop(); return true;
    }
    catch (error) { if (token === generation) await stop(); throw error; }
  }

  function takeSpeechSegments(owner, flush) {
    var limit = Math.min(240, Math.max(80, Number(owner.maxCharacters || 240))), output = [];
    while (owner.textBuffer) {
      var paragraph = owner.textBuffer.search(/\n/), length = paragraph >= 0 ? paragraph + 1 : 0, match;
      if (!length) {
        var stops = /[。！？!?；;]/g;
        while ((match = stops.exec(owner.textBuffer))) { if (match.index + 1 >= 40) { length = match.index + 1; break; } }
      }
      if (!length && owner.textBuffer.length >= limit) {
        var windowText = owner.textBuffer.slice(0, limit), punctuation = Math.max(windowText.lastIndexOf("。"), windowText.lastIndexOf("！"), windowText.lastIndexOf("？"), windowText.lastIndexOf("!"), windowText.lastIndexOf("?"), windowText.lastIndexOf("；"), windowText.lastIndexOf(";"));
        length = punctuation >= Math.floor(limit * 0.55) ? punctuation + 1 : limit;
      }
      if (!length && flush) length = owner.textBuffer.length;
      if (!length) break;
      if (length < owner.textBuffer.length && /[\uD800-\uDBFF]/.test(owner.textBuffer.charAt(length - 1))) length -= 1;
      if (!length) break;
      var part = cleanText(owner.textBuffer.slice(0, length)); owner.textBuffer = owner.textBuffer.slice(length);
      if (part) output.push(part);
    }
    return output;
  }

  function createPcmTextOwner(profile, role, messageId, options, token) {
    var owner = attachPcmPlayer({ cancelled: false, task: { cancelled: false }, clips: [], textBuffer: "", receivedText: "", chain: Promise.resolve(), profile: profile, role: role, messageId: messageId, maxCharacters: app.services.modelServices.modelDefinition("tts", profile, profile.model).maxCharacters || 240 }, token, options);
    async function enqueue(text) {
      if (owner.cancelled || owner.failure || token !== generation) return;
      await streamPcm(text, profile, owner.task, function (bytes, sampleRate) { owner.streamReceived = true; owner.pushPcm(bytes, sampleRate); });
    }
    function append(delta) {
      if (owner.cancelled || !delta) return;
      owner.receivedText += delta; owner.textBuffer += delta;
      takeSpeechSegments(owner, false).forEach(function (part) { owner.chain = owner.chain.then(function () { return enqueue(part); }).catch(function (error) { owner.failure = owner.failure || error; }); });
    }
    async function finish(finalText) {
      if (owner.cancelled) return;
      var finalClean = cleanText(finalText);
      if (finalClean && finalClean.indexOf(owner.receivedText) === 0) append(finalClean.slice(owner.receivedText.length));
      takeSpeechSegments(owner, true).forEach(function (part) { owner.chain = owner.chain.then(function () { return enqueue(part); }).catch(function (error) { owner.failure = owner.failure || error; }); });
      await owner.chain;
      if (owner.failure) { owner.failure.streamReceived = Boolean(owner.streamReceived); owner.failPcm(owner.failure); var failure = owner.failure; await stop(); throw failure; }
      owner.finished = true; await owner.finishPcm(); await rememberPcm(owner);
      if (current === owner) { current = null; emit({ speaking: false, messageId: messageId }); }
    }
    owner.append = append; owner.finish = finish; return owner;
  }

  async function createElevenSocketOwner(profile, role, messageId, options, token) {
    var owner = attachPcmPlayer({ cancelled: false, task: { cancelled: false }, clips: [], textBuffer: "", receivedText: "", chain: Promise.resolve(), profile: profile, role: role, messageId: messageId, maxCharacters: app.services.modelServices.modelDefinition("tts", profile, profile.model).maxCharacters || 240 }, token, options);
    var v3 = /^eleven_v3(?:_|$)/.test(profile.model || ""), base;
    try { var parsed = new URL(profile.endpoint || "https://api.elevenlabs.io"); base = (parsed.protocol === "http:" ? "ws:" : "wss:") + "//" + parsed.host; } catch (_) { base = "wss://api.elevenlabs.io"; }
    var path = v3 ? "/v1/text-to-dialogue/stream-input" : "/v1/text-to-speech/" + encodeURIComponent(profile.voice || "") + "/stream-input";
    var socket = await app.platform.network.openWebSocket({ url: base + path + "?model_id=" + encodeURIComponent(profile.model || "") + "&output_format=pcm_24000" + (v3 ? "" : "&auto_mode=true"), timeoutMs: 60000, task: owner.task }); owner.socketSession = socket;
    var readyResolve, readyReject, doneResolve, doneReject, socketFinished = false, socketReady = false;
    var ready = new Promise(function (resolve, reject) { readyResolve = resolve; readyReject = reject; });
    var done = new Promise(function (resolve, reject) { doneResolve = resolve; doneReject = reject; });
    var timer = setTimeout(function () { var error = new Error("ElevenLabs 流式连接超时"); if (!socketReady) readyReject(error); if (!socketFinished) { socketFinished = true; owner.socketTimer = null; doneReject(error); socket.close("Timeout").catch(function () {}); } }, 90000); owner.socketTimer = timer;
    ready.catch(function () {}); done.catch(function () {});
    function finishSocket(error) { if (socketFinished) return; socketFinished = true; clearTimeout(timer); owner.socketTimer = null; error ? doneReject(error) : doneResolve(); }
    try {
      await socket.sendText(JSON.stringify(v3 ? { voices: [profile.voice], xi_api_key: profile.apiKey } : { text: " ", xi_api_key: profile.apiKey, generation_config: { chunk_length_schedule: [80, 120, 180, 240] } }));
      socketReady = true; readyResolve();
    } catch (error) { readyReject(error); finishSocket(error); }
    (async function readLoop() {
      while (!socketFinished && !owner.cancelled) {
        var event = await socket.next(30000);
        if (!event || event.type === "timeout") continue;
        if (event.type === "error") { finishSocket(streamUnavailable(event.text || "ElevenLabs 流式连接失败")); break; }
        if (event.type === "closed" || event.type === "closing") { var closed = owner.streamReceived ? null : streamUnavailable("ElevenLabs 流式连接在音频返回前关闭"); if (!socketReady) readyReject(closed || streamUnavailable("ElevenLabs 流式连接未建立")); finishSocket(closed); break; }
        if (event.type !== "text") continue;
        var data = app.utils.safeJsonParse(event.text, null); if (!data) continue;
        if (data.error || data.type === "error") { var detail = data.error && (data.error.message || data.error) || data.message || "ElevenLabs 流式合成失败"; finishSocket(new Error(app.utils.cleanError(String(detail)))); break; }
        if (data.audio) { var bytes = base64Bytes(data.audio); if (bytes.length) { owner.streamReceived = true; owner.pushPcm(bytes, 24000); } }
        if (data.isFinal || data.is_final || data.type === "final") { finishSocket(); break; }
      }
    })().catch(function (error) { if (!socketReady) readyReject(error); finishSocket(error); });
    async function sendPart(text) {
      await ready; if (owner.cancelled || token !== generation) return;
      await socket.sendText(JSON.stringify(v3 ? { inputs: [{ text: text, voice_id: profile.voice }] } : { text: text + " ", try_trigger_generation: true }));
    }
    function append(delta) {
      if (owner.cancelled || !delta) return;
      owner.receivedText += delta; owner.textBuffer += delta;
      takeSpeechSegments(owner, false).forEach(function (part) { owner.chain = owner.chain.then(function () { return sendPart(part); }).catch(function (error) { owner.failure = owner.failure || error; }); });
    }
    async function finish(finalText) {
      if (owner.cancelled) return;
      var finalClean = cleanText(finalText); if (finalClean && finalClean.indexOf(owner.receivedText) === 0) append(finalClean.slice(owner.receivedText.length));
      takeSpeechSegments(owner, true).forEach(function (part) { owner.chain = owner.chain.then(function () { return sendPart(part); }).catch(function (error) { owner.failure = owner.failure || error; }); });
      try {
        await owner.chain; if (owner.failure) throw owner.failure; await ready;
        if (v3) await socket.sendText(JSON.stringify({ close_socket: true }));
        else await socket.sendText(JSON.stringify({ text: "", flush: true }));
        await done; owner.finished = true; await owner.finishPcm(); await rememberPcm(owner);
        if (owner.socketSession) { await owner.socketSession.close("Completed").catch(function () {}); owner.socketSession = null; }
        if (current === owner) { current = null; emit({ speaking: false, messageId: messageId }); }
      } catch (error) {
        error.streamReceived = Boolean(owner.streamReceived); await stopOwner(owner); throw error;
      }
    }
    owner.append = append; owner.finish = finish; return owner;
  }

  async function createXaiSocketOwner(profile, role, messageId, options, token) {
    var owner = attachPcmPlayer({ cancelled: false, task: { cancelled: false }, clips: [], textBuffer: "", receivedText: "", chain: Promise.resolve(), profile: profile, role: role, messageId: messageId, maxCharacters: 15000 }, token, options);
    var parsed = new URL(profile.endpoint || "https://api.x.ai/v1/tts"); parsed.protocol = parsed.protocol === "http:" ? "ws:" : "wss:";
    parsed.searchParams.set("voice", profile.voice || "eve"); parsed.searchParams.set("language", profile.language || "auto"); parsed.searchParams.set("codec", "pcm"); parsed.searchParams.set("sample_rate", String(Number(profile.sampleRate || 24000))); parsed.searchParams.set("speed", String(Number(profile.rate || 1))); parsed.searchParams.set("optimize_streaming_latency", "1");
    var socketHeaders = Object.assign({}, app.utils.parseHeaders(profile.customHeaders)); if (profile.apiKey) socketHeaders.Authorization = "Bearer " + profile.apiKey;
    var socket = await app.platform.network.openWebSocket({ url: parsed.toString(), headers: socketHeaders, timeoutMs: 60000, task: owner.task }); owner.socketSession = socket;
    var doneResolve, doneReject, finished = false, done = new Promise(function (resolve, reject) { doneResolve = resolve; doneReject = reject; }); done.catch(function () {});
    var timer = setTimeout(function () { if (!finished) { finished = true; doneReject(new Error("xAI TTS 流式连接超时")); socket.close("Timeout").catch(function () {}); } }, 90000); owner.socketTimer = timer;
    function settle(error) { if (finished) return; finished = true; clearTimeout(timer); owner.socketTimer = null; error ? doneReject(error) : doneResolve(); }
    (async function readLoop() {
      while (!finished && !owner.cancelled) {
        var event = await socket.next(30000); if (!event || event.type === "timeout") continue;
        if (event.type === "error") { settle(streamUnavailable(event.text || "xAI TTS 流式连接失败")); break; }
        if (event.type === "closed" || event.type === "closing") { settle(owner.streamReceived ? null : streamUnavailable("xAI TTS 在音频返回前关闭")); break; }
        if (event.type !== "text") continue;
        var data = app.utils.safeJsonParse(event.text, null); if (!data) continue;
        if (data.type === "error" || data.error) { var detail = data.error && (data.error.message || data.error) || data.message || "xAI TTS 合成失败"; settle(new Error(app.utils.cleanError(String(detail)))); break; }
        if (data.type === "audio.delta" && data.delta) { var bytes = base64Bytes(data.delta); if (bytes.length) { owner.streamReceived = true; owner.pushPcm(bytes, Number(profile.sampleRate || 24000)); } }
        if (data.type === "audio.done") { settle(); break; }
      }
    })().catch(settle);
    async function sendPart(text) { if (!owner.cancelled && token === generation) await socket.sendText(JSON.stringify({ type: "text.delta", delta: text })); }
    function append(delta) { if (owner.cancelled || !delta) return; owner.receivedText += delta; owner.textBuffer += delta; takeSpeechSegments(owner, false).forEach(function (part) { owner.chain = owner.chain.then(function () { return sendPart(part); }).catch(function (error) { owner.failure = owner.failure || error; }); }); }
    async function finish(finalText) {
      if (owner.cancelled) return;
      var finalClean = cleanText(finalText); if (finalClean && finalClean.indexOf(owner.receivedText) === 0) append(finalClean.slice(owner.receivedText.length));
      takeSpeechSegments(owner, true).forEach(function (part) { owner.chain = owner.chain.then(function () { return sendPart(part); }).catch(function (error) { owner.failure = owner.failure || error; }); });
      try {
        await owner.chain; if (owner.failure) throw owner.failure; await socket.sendText(JSON.stringify({ type: "text.done" })); await done;
        owner.finished = true; await owner.finishPcm(); await rememberPcm(owner); await socket.close("Completed").catch(function () {}); owner.socketSession = null;
        if (current === owner) { current = null; emit({ speaking: false, messageId: messageId }); }
      } catch (error) { error.streamReceived = Boolean(owner.streamReceived); await stopOwner(owner); throw error; }
    }
    owner.append = append; owner.finish = finish; return owner;
  }

  async function createQwenSocketOwner(profile, role, messageId, options, token) {
    var owner = attachPcmPlayer({ cancelled: false, task: { cancelled: false }, clips: [], textBuffer: "", receivedText: "", chain: Promise.resolve(), profile: profile, role: role, messageId: messageId, maxCharacters: 240 }, token, options);
    var parsed = new URL(profile.endpoint || "https://dashscope.aliyuncs.com"); parsed.protocol = parsed.protocol === "http:" ? "ws:" : "wss:"; parsed.pathname = "/api-ws/v1/realtime"; parsed.search = ""; parsed.searchParams.set("model", profile.model);
    var socketHeaders = Object.assign({}, app.utils.parseHeaders(profile.customHeaders)); if (profile.apiKey) socketHeaders.Authorization = "Bearer " + profile.apiKey;
    var socket = await app.platform.network.openWebSocket({ url: parsed.toString(), headers: socketHeaders, timeoutMs: 60000, task: owner.task }); owner.socketSession = socket;
    var responseWaiters = [], sessionResolve, sessionReject, sessionDone = new Promise(function (resolve, reject) { sessionResolve = resolve; sessionReject = reject; }); sessionDone.catch(function () {});
    var socketFinished = false, timer = setTimeout(function () { if (!socketFinished) { socketFinished = true; sessionReject(new Error("Qwen TTS 流式连接超时")); while (responseWaiters.length) responseWaiters.shift().reject(new Error("Qwen TTS 流式连接超时")); socket.close("Timeout").catch(function () {}); } }, 120000); owner.socketTimer = timer;
    function fail(error) { if (socketFinished) return; socketFinished = true; clearTimeout(timer); owner.socketTimer = null; while (responseWaiters.length) responseWaiters.shift().reject(error); sessionReject(error); }
    function event(type, extra) { return Object.assign({ event_id: "event_" + Date.now() + "_" + Math.floor(Math.random() * 10000), type: type }, extra || {}); }
    (async function readLoop() {
      while (!socketFinished && !owner.cancelled) {
        var incoming = await socket.next(30000); if (!incoming || incoming.type === "timeout") continue;
        if (incoming.type === "error") { fail(streamUnavailable(incoming.text || "Qwen TTS 流式连接失败")); break; }
        if (incoming.type === "closed" || incoming.type === "closing") { if (!socketFinished) fail(owner.streamReceived ? new Error("Qwen TTS 会话未明确完成") : streamUnavailable("Qwen TTS 在音频返回前关闭")); break; }
        if (incoming.type !== "text") continue;
        var data = app.utils.safeJsonParse(incoming.text, null); if (!data) continue;
        if (data.type === "error") { var detail = data.error && (data.error.message || data.error) || data.message || "Qwen TTS 合成失败"; fail(new Error(app.utils.cleanError(String(detail)))); break; }
        if (data.type === "response.audio.delta" && data.delta) { var bytes = base64Bytes(data.delta); if (bytes.length) { owner.streamReceived = true; owner.pushPcm(bytes, 24000); } }
        if (data.type === "response.done" && responseWaiters.length) responseWaiters.shift().resolve();
        if (data.type === "session.finished") { socketFinished = true; clearTimeout(timer); owner.socketTimer = null; sessionResolve(); break; }
      }
    })().catch(fail);
    await socket.sendText(JSON.stringify(event("session.update", { session: { voice: profile.voice, language_type: profile.language || "Auto", response_format: "pcm", sample_rate: 24000, mode: "commit" } })));
    async function sendPart(text) {
      if (owner.cancelled || token !== generation) return;
      var waiter = {}, completed = new Promise(function (resolve, reject) { waiter.resolve = resolve; waiter.reject = reject; }); responseWaiters.push(waiter);
      await socket.sendText(JSON.stringify(event("input_text_buffer.append", { text: text })));
      await socket.sendText(JSON.stringify(event("input_text_buffer.commit")));
      await completed;
    }
    function append(delta) { if (owner.cancelled || !delta) return; owner.receivedText += delta; owner.textBuffer += delta; takeSpeechSegments(owner, false).forEach(function (part) { owner.chain = owner.chain.then(function () { return sendPart(part); }).catch(function (error) { owner.failure = owner.failure || error; }); }); }
    async function finish(finalText) {
      if (owner.cancelled) return;
      var finalClean = cleanText(finalText); if (finalClean && finalClean.indexOf(owner.receivedText) === 0) append(finalClean.slice(owner.receivedText.length));
      takeSpeechSegments(owner, true).forEach(function (part) { owner.chain = owner.chain.then(function () { return sendPart(part); }).catch(function (error) { owner.failure = owner.failure || error; }); });
      try {
        await owner.chain; if (owner.failure) throw owner.failure; await socket.sendText(JSON.stringify(event("session.finish"))); await sessionDone;
        owner.finished = true; await owner.finishPcm(); await rememberPcm(owner); await socket.close("Completed").catch(function () {}); owner.socketSession = null;
        if (current === owner) { current = null; emit({ speaking: false, messageId: messageId }); }
      } catch (error) { error.streamReceived = Boolean(owner.streamReceived); await stopOwner(owner); throw error; }
    }
    owner.append = append; owner.finish = finish; return owner;
  }

  async function createStream(role, messageId, options) {
    await stop();
    var resolved = await profileFor(role), capabilities = app.services.modelServices.ttsCapabilities(resolved.service, resolved.profile.model);
    if (resolved.profile.type === "system" || !capabilities.audioStreaming || !pcmStreamProfile(resolved.profile) || !playbackUnlocked || !audioContext) return null;
    var token = ++generation, owner;
    if ((resolved.profile.protocol === "elevenlabs" || resolved.profile.type === "elevenlabs") && capabilities.textStreaming) {
      try { owner = await createElevenSocketOwner(resolved.profile, role, messageId, options || {}, token); }
      catch (error) { if (!error.streamUnavailable) throw error; owner = createPcmTextOwner(resolved.profile, role, messageId, options || {}, token); }
    } else if (resolved.profile.protocol === "xai-tts" && capabilities.textStreaming) {
      try { owner = await createXaiSocketOwner(resolved.profile, role, messageId, options || {}, token); }
      catch (error) { if (!error.streamUnavailable) throw error; owner = createPcmTextOwner(resolved.profile, role, messageId, options || {}, token); }
    } else if (resolved.profile.protocol === "qwen-tts" && /-realtime(?:$|-)/.test(resolved.profile.model || "") && capabilities.textStreaming) {
      try { owner = await createQwenSocketOwner(resolved.profile, role, messageId, options || {}, token); }
      catch (error) { if (!error.streamUnavailable) throw error; owner = createPcmTextOwner(resolved.profile, role, messageId, options || {}, token); }
    } else owner = createPcmTextOwner(resolved.profile, role, messageId, options || {}, token);
    current = owner;
    emit({ speaking: false, buffering: true, messageId: messageId, bufferedSeconds: 0 }); return owner;
  }

  async function resume(messageId) {
    if (!current || current.messageId !== messageId || !current.starved || !(current.clips && current.clips.length || current.pcmQueue && current.pcmQueue.length)) return false;
    await current.resume(); return true;
  }

  function hasReady(messageId) { return Boolean(ready[messageId]); }
  function canResume(messageId) { return Boolean(current && current.messageId === messageId && current.starved && (current.clips && current.clips.length || current.pcmQueue && current.pcmQueue.length)); }

  async function pauseForBackground() {
    backgrounded = true;
    if (muted || pausedPlayback || backgroundResume) return false;
    var owner = current; if (!owner) return false;
    if (owner.audio) {
      owner.audio.pause(); pausedPlayback = { owner: owner, kind: "audio" };
      emit({ speaking: false, suspended: true, messageId: owner.messageId }); return true;
    }
    if (owner.audioGain && audioContext && typeof audioContext.suspend === "function") {
      await audioContext.suspend();
      if (current !== owner) return false;
      pausedPlayback = { owner: owner, kind: "context" };
      emit({ speaking: false, suspended: true, messageId: owner.messageId }); return true;
    }
    if (!owner.resumeRequest) return false;
    var request = owner.resumeRequest;
    if (request.kind === "ready" && request.item && request.item.clip && owner.activeClip === request.item.clip) owner.preserveActiveClip = true;
    await stop({ background: true });
    if (request.kind === "ready" && request.item) ready[request.messageId] = request.item;
    backgroundResume = request;
    emit({ speaking: false, suspended: true, messageId: request.messageId }); return true;
  }

  async function resumeAfterBackground() {
    backgrounded = false;
    var paused = pausedPlayback; pausedPlayback = null;
    if (paused && current === paused.owner) {
      if (paused.kind === "audio") await paused.owner.audio.play();
      else if (audioContext && typeof audioContext.resume === "function") await audioContext.resume();
      if (!paused.owner.started && paused.owner.startPcm && paused.owner.pcmQueue && paused.owner.pcmQueue.length) paused.owner.startPcm();
      if (paused.owner.audio || paused.owner.audioSource || paused.owner.started && !paused.owner.starved) emit({ speaking: true, messageId: paused.owner.messageId });
      startAmbience();
      return true;
    }
    if (audioContext && playbackUnlocked && audioContext.state === "suspended" && typeof audioContext.resume === "function") await audioContext.resume();
    var request = backgroundResume; backgroundResume = null;
    if (!request || muted) return false;
    var restarted = request.kind === "ready" ? playReady(request.messageId) : speak(request.text, request.role);
    restarted.catch(function (error) { app.events.emit("tts:error", { message: "继续朗读失败：" + app.utils.cleanError(error) }); });
    return true;
  }

  function queueLifecycle(hidden) {
    lifecycleQueue = lifecycleQueue.catch(function () {}).then(function () { return hidden ? pauseForBackground() : resumeAfterBackground(); }).catch(function (error) {
      app.events.emit("tts:error", { message: "朗读前后台切换失败：" + app.utils.cleanError(error) });
    });
  }

  if (typeof window.addEventListener === "function") {
    window.addEventListener("pointerdown", unlockPlayback, true);
    window.addEventListener("touchstart", unlockPlayback, true);
    window.addEventListener("keydown", unlockPlayback, true);
    window.addEventListener("pagehide", function () { queueLifecycle(true); });
    window.addEventListener("pageshow", function () { queueLifecycle(false); });
  }
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") document.addEventListener("visibilitychange", function () { queueLifecycle(Boolean(document.hidden)); });

  app.services.tts = { speak: speak, stop: stop, headers: headers, requestBody: requestBody, parseDoubaoSse: parseDoubaoSse, prepare: prepare, testService: testService, playReady: playReady, hasReady: hasReady, invalidate: invalidate, invalidateMany: invalidateMany, invalidateRole: invalidateRole, invalidateAll: invalidateAll, createStream: createStream, resume: resume, canResume: canResume, unlockPlayback: unlockPlayback, setMuted: setMuted, applyAudioFx: applyAudioFx, isMuted: function () { return muted; }, isPlaying: function () { return Boolean(lastState.speaking); }, pauseForBackground: pauseForBackground, resumeAfterBackground: resumeAfterBackground };
})(window.chataxi);
