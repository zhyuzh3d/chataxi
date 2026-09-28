# chataxi v0.4.11 ElevenLabs 模型、音色与播放修订

本次修订纠正 ElevenLabs 模型与音色兼容推断，并修复第三方 TTS 在 Android WebView 中不能自动播放的问题。

ElevenLabs 的标准 Create Speech 与 Stream Speech 接口都通过 `model_id` 选择模型，普通 `eleven_v3` 可用于这两个接口。账户音色接口返回的 `high_quality_base_model_ids`、`verified_languages` 与 `fine_tuning.state` 描述质量、语言验证和训练状态，并不是模型可用性白名单。官方同时说明 Professional Voice Clone 可以用于 v3，但 v3 对 PVC 尚未完全优化，相似度可能低于早期模型。因此，chataxi 对 ElevenLabs 账户音色不做模型白名单过滤，也不会根据 `professional` 类别推导请求参数。

`use_pvc_as_ivc` 已被 ElevenLabs 标记为弃用，并且真实 v3 请求会明确拒绝该参数。本版完全停止生成和发送它。Jane、Jessica、Lulu 等名称只用于显示，合成始终使用账户接口返回的 `voice_id` 与角色实际选择的 `model_id`，不再根据名称猜测模型关系。

静态兜底模型目录只包含当前 Text to Speech HTTP 集成确认支持的 `eleven_multilingual_v2`、`eleven_flash_v2_5` 和 `eleven_v3`。`eleven_v3_conversational` 的实时合同主要属于 Agents 与 Text to Dialogue；只有 `/v1/models` 对当前账户真实返回并声明 `can_do_text_to_speech` 时，chataxi 才把额外模型加入可选列表。

自动朗读现在有一致语义：开启后总会播放最后一位角色的回复。关闭流式播放时，完整回复和整段音频生成完毕后自动播放；开启时，语言模型增量按句送往 TTS 并在累计约三秒后提前播放。Android WebView 要求网页媒体播放由用户手势启动，因此本版在首次触摸或按键时解锁一个 Web Audio 上下文，后续异步取得的内联 MP3 通过该上下文解码播放。Haminn 返回持久文件时仍优先走原生 `audio.play`。

参考的供应商合同：

- [ElevenLabs Create Speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)
- [ElevenLabs Stream Speech](https://elevenlabs.io/docs/api-reference/text-to-speech/stream)
- [ElevenLabs Models](https://elevenlabs.io/docs/overview/models)
- [ElevenLabs Get Voice](https://elevenlabs.io/docs/api-reference/voices/get)
- [ElevenLabs v3 best practices](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices)

版本号为 0.4.11，版本代码为 26。数据结构不变。本轮自动检查不使用用户真实 API Key，也不构成真实账户、真机或收费合成验收。
