# chataxi v0.4.9 ElevenLabs 音色与模型兼容修订

> 本记录描述 0.4.9 当时的实现，关于 `use_pvc_as_ivc` 的判断已被 [0.4.11 修订](chataxi-v0.4.11-elevenlabs-tts-playback.md)纠正，不再是当前产品合同。

## 根因

ElevenLabs `/v2/voices` 返回的 `high_quality_base_model_ids` 表示音色具有高质量表现的基础模型，`verified_languages[].model_id` 表示语言验证所用模型；两者都不是完整的模型兼容白名单。此前把这些字段合并成 `compatibleModelIds`，会错误隐藏不在列表中的模型音色。

另一个过严规则是把所有 `professional` 音色从 Eleven v3 中排除。ElevenLabs 当前说明 v3 不能直接使用 PVC 微调版本，但文字转语音请求仍公开提供 `use_pvc_as_ivc` 兼容参数。因此 Professional 音色不应从选择器消失，而应在 v3 下明确切换到 IVC 表示。

## 修复

- ElevenLabs 返回到当前账户的全部音色都保留在每个可用 TTS 模型的选择器中，不再根据高质量模型或已验证语言列表硬过滤。
- 分开保存 `highQualityModelIds`、`verifiedModelIds` 和 `fineTuningStates`，避免把质量元数据伪装成兼容能力。
- Professional 音色选择 `eleven_v3` 或 `eleven_v3_conversational` 且没有对应的完成微调状态时，自动发送 `use_pvc_as_ivc: true`。
- 角色编辑页即时说明 Professional 音色在 v3 下使用 IVC 兼容模式，避免把它描述成原生 PVC v3 微调。

## 验收

自动测试使用 Jane Professional 音色夹具验证：v3、v3 Conversational 和未出现在质量列表中的模型均不会隐藏 Jane；v3 请求包含兼容参数，Multilingual v2 继续使用原生微调版本。

版本号为 0.4.9，版本代码为 24。已有 ElevenLabs 服务重新连接后会取得分离后的音色元数据；旧数据即使仍带 `compatibleModelIds`，也不会再被 ElevenLabs 选择器当作白名单。
