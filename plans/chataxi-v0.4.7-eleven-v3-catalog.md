# chataxi 0.4.7 Eleven v3 模型目录修订

> 本记录描述 0.4.7 当时的静态目录；v3 Conversational 的协议边界已由 [0.4.11 修订](chataxi-v0.4.11-elevenlabs-tts-playback.md)收紧，当前静态 Text to Speech HTTP 兜底目录不再包含它。

> 0.4.9 曾纠正本版本将 `professional` 类别直接排除在 v3 之外的过严规则；当前协议与参数行为以 0.4.11 为准。

## 根因

ElevenLabs 的模型接口需要 `models_read` 权限。权限受限的密钥仍可读取账户音色并合成，因此 chataxi 会改用内置 TTS 目录；该目录只包含 Multilingual v2 和 Flash v2.5，遗漏了已经开放 API 的 Eleven v3 和后续的 Eleven v3 Conversational。

音色发现还有第二个问题：`high_quality_base_model_ids` 表示高质量音色的基础模型信息，并不是完整的兼容白名单。把它当作硬过滤条件会让 v3 选择后错误地没有音色可用。

## 修复

- 继续优先采用账户 `/v1/models` 返回且声明 `can_do_text_to_speech` 的模型。
- 受限权限回退目录增加 `eleven_v3` 和 `eleven_v3_conversational`，保留 v2 与 Flash v2.5。
- v3 不再被旧的高质量基础模型列表误过滤；根据 ElevenLabs 当前限制排除 Professional Voice Clone，普通克隆、设计和预置音色继续可选。
- v3 标明表现力和 70+ 语言特征，Conversational 标明实时对话用途；实际账户接口一旦可读，仍以接口返回能力为准。

## 验收

自动测试覆盖模型目录权限不足时的四个 TTS 回退模型，以及 v3 对普通音色可见、Professional Voice Clone 不可见的规则。
