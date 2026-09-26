(function (app) {
  "use strict";
  var backend = "local";
  var prefix = "chataxi.v1.";
  var collections = ["meta", "credentials", "llm-profiles", "tts-profiles", "asr-profiles", "roles", "conversations", "messages", "drafts", "message-text", "summaries", "remote-media", "model-catalog", "model-directory"];
  var secretFields = ["apiKey", "accessKeyId", "sessionToken", "customHeaders"];

  function localKey(collection, key) { return prefix + collection + "." + key; }

  var localBackend = {
    get: async function (collection, key) {
      var raw = localStorage.getItem(localKey(collection, key));
      return raw == null ? null : { collection: collection, key: key, value: app.utils.safeJsonParse(raw, null), revision: "local" };
    },
    put: async function (collection, key, value) {
      localStorage.setItem(localKey(collection, key), JSON.stringify(value));
      return { collection: collection, key: key, revision: "local" };
    },
    delete: async function (collection, key) {
      var existed = localStorage.getItem(localKey(collection, key)) != null;
      localStorage.removeItem(localKey(collection, key));
      return { deleted: existed };
    },
    scan: async function (collection, keyPrefix) {
      var items = [];
      var start = localKey(collection, keyPrefix || "");
      for (var index = 0; index < localStorage.length; index += 1) {
        var key = localStorage.key(index);
        if (key && key.indexOf(start) === 0) {
          var entityKey = key.slice(localKey(collection, "").length);
          items.push({ collection: collection, key: entityKey, value: app.utils.safeJsonParse(localStorage.getItem(key), null), revision: "local" });
        }
      }
      items.sort(function (left, right) { return left.key.localeCompare(right.key); });
      return { items: items, nextAfterKey: null };
    }
  };

  var hermitBackend = {
    get: async function (collection, key) { return app.platform.hermit.api().data.get({ collection: collection, key: key }); },
    put: async function (collection, key, value) { return app.platform.hermit.api().data.put({ collection: collection, key: key, value: value }); },
    delete: async function (collection, key) { return app.platform.hermit.api().data.delete({ collection: collection, key: key }); },
    scan: async function (collection, keyPrefix) {
      var all = [];
      var afterKey = null;
      do {
        var page = await app.platform.hermit.api().data.scan({ collection: collection, prefix: keyPrefix || "", afterKey: afterKey || undefined, limit: 100 });
        all = all.concat(page.items || []);
        afterKey = page.nextAfterKey;
      } while (afterKey);
      return { items: all, nextAfterKey: null };
    }
  };

  function api() { return backend === "hermit" ? hermitBackend : localBackend; }

  function stableSuffix(value) {
    var hash = 2166136261, text = String(value || "");
    for (var index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(36);
  }

  async function migrateSingleModelProfiles() {
    var maps = { llm: {}, tts: {}, asr: {} }, kinds = ["llm", "tts", "asr"];
    for (var kindIndex = 0; kindIndex < kinds.length; kindIndex += 1) {
      var kind = kinds[kindIndex], profiles = await list(kind + "-profiles");
      for (var profileIndex = 0; profileIndex < profiles.length; profileIndex += 1) {
        var profile = profiles[profileIndex];
        if (profile.singleModelVersion === 1) {
          maps[kind][profile.id + "\n" + (profile.externalModelId || profile.model || profile.defaultModelId || "")] = profile.id;
          continue;
        }
        var candidates = app.services.modelServices.allModels(kind, profile), enabledIds = Array.isArray(profile.enabledModelIds) && profile.enabledModelIds.length ? profile.enabledModelIds.slice() : candidates.map(function (item) { return item.id; });
        var selected = candidates.filter(function (item) { return enabledIds.indexOf(item.id) >= 0; });
        if (!selected.length && (profile.model || profile.defaultModelId)) selected = [{ id: profile.model || profile.defaultModelId, name: profile.model || profile.defaultModelId, capabilitySource: "legacy" }];
        if (!selected.length) continue;
        var preferred = profile.defaultModelId || profile.model || selected[0].id;
        selected.sort(function (left, right) { return left.id === preferred ? -1 : right.id === preferred ? 1 : 0; });
        for (var modelIndex = 0; modelIndex < selected.length; modelIndex += 1) {
          var model = selected[modelIndex], next = app.services.modelServices.toSingleProfile(kind, Object.assign({}, profile, { singleModelVersion: 0 }), model.id), keepId = modelIndex === 0;
          next.id = keepId ? profile.id : profile.id + "--" + stableSuffix(model.id);
          next.sourceProfileId = profile.id;
          next.name = selected.length > 1 ? (profile.name || app.services.modelServices.family(kind, profile.family || profile.type).name) + " · " + (model.name || model.id) : profile.name || model.name || model.id;
          if (!keepId) { next.validationState = "catalog-only"; next.validatedAt = 0; next.validationBaseline = null; }
          next.createdAt = profile.createdAt || Date.now(); next.updatedAt = Date.now();
          await put(kind + "-profiles", next.id, next);
          maps[kind][profile.id + "\n" + model.id] = next.id;
        }
      }
    }
    return maps;
  }

  async function init() {
    backend = (await app.platform.hermit.awaitReady(3500)) ? "hermit" : "local";
    if (backend === "local" && window.hermit) throw new Error("Hermit 尚未就绪，请重新加载；不会把宿主数据写入浏览器预览区");
    await seed();
    return backend;
  }

  // 首次安装时按界面语言写入这两段默认内容；之后切换语言不会改写已经保存的值。
  function defaultCompressionPrompt() {
    return app.i18n.pick("请把更早的对话压缩成可供后续继续交流的上下文。保留已经确认的事实、用户偏好、重要结论、未完成事项、约束和角色之间的关键分歧；删除寒暄、重复内容和已被否定的方案。不要补充原对话没有的信息，使用清晰紧凑的中文。", "Compress the earlier part of the conversation into context that can carry the chat forward. Keep confirmed facts, user preferences, important conclusions, open items, constraints and the key disagreements between roles; drop small talk, repetition and options that have already been rejected. Do not add anything that was not in the original conversation. Write in clear, compact English.");
  }
  function defaultUserName() { return app.i18n.pick("我", "Me"); }
  // 缺省、非数字或落在滑竿范围外的历史值统一收进范围；范围内的用户选择原样保留。
  function compressionBound(value, min, max, fallback) {
    var number = Number(value);
    if (!isFinite(number) || number <= 0) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  async function seed() {
    var settings = await get("meta", "settings");
    if (!settings) {
      settings = {
        autoSpeak: true,
        defaultTtsProfileId: "system-tts",
        defaultAsrProfileId: "system-asr",
        uiLanguage: "system",
        language: "zh-CN",
        imageDetail: "auto",
        autoCompress: true,
        compressionThresholdChars: 10000,
        compressionRetainChars: 4000,
        compressionTargetChars: 1000,
        compressionPrompt: defaultCompressionPrompt(),
        theme: "system"
      };
    } else {
      if (settings.autoCompress == null) settings.autoCompress = true;
      // 触发字数 4000~32000（默认 10000）、压缩保留字数 2000~10000（默认 4000）、
      // 压缩目标 500~2000（默认 1000）是设置页滑竿的界限。
      // 老版本存下的值可能落在范围外（滑竿显示不出来），这里就地收进范围，保证界面与实际一致。
      settings.compressionThresholdChars = compressionBound(settings.compressionThresholdChars, 4000, 32000, 10000);
      settings.compressionRetainChars = compressionBound(settings.compressionRetainChars, 2000, 10000, 4000);
      settings.compressionTargetChars = compressionBound(settings.compressionTargetChars, 500, 2000, 1000);
      if (["system", "zh-CN", "en"].indexOf(settings.uiLanguage) < 0) settings.uiLanguage = "system";
      delete settings.recentFullMessages;
      delete settings.historyLimit;
      // 「按 Enter 发送」也不再提供：Enter 始终换行，Ctrl / ⌘ + Enter 始终发送。
      delete settings.enterToSend;
      // 语音语言（settings.language）照旧保留给朗读/识别做兜底，界面语言是另一个字段。
      if (!settings.compressionPrompt) settings.compressionPrompt = defaultCompressionPrompt();
    }
    await put("meta", "settings", settings);
    var userProfile = await get("meta", "user-profile") || { name: defaultUserName(), introduction: "", avatarMediaId: "", createdAt: Date.now() };
    if (!String(userProfile.name || "").trim()) userProfile.name = defaultUserName();
    if (userProfile.introduction == null) userProfile.introduction = userProfile.bio || "";
    delete userProfile.bio;
    userProfile.updatedAt = Number(userProfile.updatedAt || Date.now());
    await put("meta", "user-profile", userProfile);
    var systemTts = await get("tts-profiles", "system-tts") || { id: "system-tts", name: "Android 系统朗读", rate: 1, pitch: 1 };
    await put("tts-profiles", "system-tts", Object.assign(systemTts, { family: "system", type: "system", enabled: true, models: ["system"], defaultModelId: "system", voices: systemTts.voices || [] }));
    var systemAsr = await get("asr-profiles", "system-asr") || { id: "system-asr", name: "Android 系统语音识别", language: "", onDevice: false };
    await put("asr-profiles", "system-asr", Object.assign(systemAsr, { family: "system", type: "system", enabled: true, models: ["system"], defaultModelId: "system" }));
    var profileKinds = ["llm", "tts", "asr"];
    for (var profileKindIndex = 0; profileKindIndex < profileKinds.length; profileKindIndex += 1) {
      var profileKind = profileKinds[profileKindIndex], profiles = await list(profileKind + "-profiles");
      for (var profileIndex = 0; profileIndex < profiles.length; profileIndex += 1) {
        var profile = profiles[profileIndex], profileChanged = false;
        var enabledModels = app.services.modelServices.models(profileKind, profile);
        if (!enabledModels.some(function (item) { return item.id === profile.defaultModelId; })) {
          profile.defaultModelId = (enabledModels.find(function (item) { return item.id === profile.model; }) || enabledModels[0] || {}).id || "";
          profileChanged = true;
        }
        if (profileKind === "tts") {
          var availableVoices = app.services.modelServices.voices(profile, profile.defaultModelId);
          if (!availableVoices.some(function (item) { return item.id === profile.defaultVoiceId; })) {
            profile.defaultVoiceId = (availableVoices.find(function (item) { return item.id === profile.voice; }) || availableVoices[0] || {}).id || "";
            profileChanged = true;
          }
        }
        if (profileChanged) await put(profileKind + "-profiles", profile.id, profile);
      }
    }
    var singleProfileMaps = await migrateSingleModelProfiles();
    var roles = await list("roles");
    for (var roleIndex = 0; roleIndex < roles.length; roleIndex += 1) {
      var role = roles[roleIndex], changed = false;
      if (Object.prototype.hasOwnProperty.call(role, "avatarIcon")) { delete role.avatarIcon; changed = true; }
      if (Object.prototype.hasOwnProperty.call(role, "avatarColor")) { delete role.avatarColor; changed = true; }
      if (!role.model && role.llmProfileId) { var llm = await get("llm-profiles", role.llmProfileId); if (llm && llm.model) { role.model = llm.model; changed = true; } }
      var llmProfileKey = role.llmProfileId + "\n" + (role.model || "");
      if (singleProfileMaps.llm[llmProfileKey] && role.llmProfileId !== singleProfileMaps.llm[llmProfileKey]) { role.llmProfileId = singleProfileMaps.llm[llmProfileKey]; changed = true; }
      var ttsProfileKey = role.ttsProfileId + "\n" + (role.ttsModel || "");
      if (singleProfileMaps.tts[ttsProfileKey] && role.ttsProfileId !== singleProfileMaps.tts[ttsProfileKey]) { role.ttsProfileId = singleProfileMaps.tts[ttsProfileKey]; changed = true; }
      if (role.temperatureOverride == null) { role.temperatureOverride = role.temperature != null; changed = true; }
      if (role.maxOutputOverride == null) { role.maxOutputOverride = role.maxOutputTokens != null; changed = true; }
      if (changed) await put("roles", role.id, role);
    }
    var conversations = await list("conversations");
    for (var conversationIndex = 0; conversationIndex < conversations.length; conversationIndex += 1) {
      var conversationChanged = false;
      if (conversations[conversationIndex].userName == null) { conversations[conversationIndex].userName = ""; conversationChanged = true; }
      if (conversations[conversationIndex].userIntroduction == null) { conversations[conversationIndex].userIntroduction = ""; conversationChanged = true; }
      if (conversations[conversationIndex].userAvatarMediaId == null) { conversations[conversationIndex].userAvatarMediaId = ""; conversationChanged = true; }
      var inferredKind = (conversations[conversationIndex].roleIds || []).length > 1 ? "group" : "single";
      if (conversations[conversationIndex].kind !== inferredKind) { conversations[conversationIndex].kind = inferredKind; conversationChanged = true; }
      // 「固定携带最近消息」已取消：保留多少条改由「压缩保留字数」按字数推导，
      // 逐对话存下的条数不再有任何作用，留着只会让人误以为还能配置。
      if (conversations[conversationIndex].recentFullMessages != null) { delete conversations[conversationIndex].recentFullMessages; conversationChanged = true; }
      var participantIds = conversations[conversationIndex].roleIds || [];
      var moderatorRoleId = conversations[conversationIndex].moderatorRoleId && participantIds.indexOf(conversations[conversationIndex].moderatorRoleId) >= 0 ? conversations[conversationIndex].moderatorRoleId : participantIds[0] || "";
      var orderedParticipantIds = moderatorRoleId ? [moderatorRoleId].concat(participantIds.filter(function (roleId) { return roleId !== moderatorRoleId; })) : participantIds.slice();
      if (JSON.stringify(participantIds) !== JSON.stringify(orderedParticipantIds)) { conversations[conversationIndex].roleIds = orderedParticipantIds; participantIds = orderedParticipantIds; conversationChanged = true; }
      if (conversations[conversationIndex].moderatorRoleId !== moderatorRoleId) { conversations[conversationIndex].moderatorRoleId = moderatorRoleId; conversationChanged = true; }
      if (conversations[conversationIndex].autoSelectRole == null) { conversations[conversationIndex].autoSelectRole = false; conversationChanged = true; }
      var asrProfileKey = conversations[conversationIndex].asrProfileId + "\n" + (conversations[conversationIndex].asrModel || "");
      if (singleProfileMaps.asr[asrProfileKey] && conversations[conversationIndex].asrProfileId !== singleProfileMaps.asr[asrProfileKey]) { conversations[conversationIndex].asrProfileId = singleProfileMaps.asr[asrProfileKey]; conversationChanged = true; }
      var rememberedRoleId = (conversations[conversationIndex].activeRoleIds || []).find(function (roleId) { return participantIds.indexOf(roleId) >= 0; }) || participantIds[0];
      var activeRoleIds = rememberedRoleId ? [rememberedRoleId] : [];
      if (JSON.stringify(conversations[conversationIndex].activeRoleIds || []) !== JSON.stringify(activeRoleIds)) { conversations[conversationIndex].activeRoleIds = activeRoleIds; conversationChanged = true; }
      if (conversationChanged) await put("conversations", conversations[conversationIndex].id, conversations[conversationIndex]);
    }
    // 14：压缩设置由「触发字数 + 目标字数」扩为「触发 / 保留 / 目标」三项，并删除对话上的 recentFullMessages。
    await put("meta", "schema", { version: 14, modelProfileMigrationVersion: 1, updatedAt: Date.now() });
  }

  function profileCollection(collection) { return collection === "llm-profiles" || collection === "tts-profiles" || collection === "asr-profiles"; }
  function catalogPrefix(serviceId, revision) { return serviceId + ":catalog:" + (revision ? revision + ":" : ""); }

  function credentialValues(value) {
    var result = {};
    secretFields.forEach(function (name) { if (value && Object.prototype.hasOwnProperty.call(value, name)) result[name] = value[name] == null ? "" : value[name]; });
    return result;
  }

  async function persistCredential(value) {
    if (!value) return "";
    var secrets = credentialValues(value), names = Object.keys(secrets), reference = value.credentialRef || "";
    if (!names.length) return reference;
    if (!reference) reference = app.utils.id("credential");
    var previous = await api().get("credentials", reference);
    await api().put("credentials", reference, Object.assign({}, previous && previous.value || {}, secrets, { id: reference, updatedAt: Date.now() }));
    value.credentialRef = reference;
    return reference;
  }

  function withoutSecrets(value) {
    var result = app.utils.clone(value);
    secretFields.forEach(function (name) { delete result[name]; });
    return result;
  }

  async function hydrateProfile(collection, value) {
    if (!value || !profileCollection(collection)) return value;
    if (value.modelsExternal && value.modelCatalogRevision) {
      var result = await api().scan("model-catalog", catalogPrefix(value.id, value.modelCatalogRevision));
      var records = (result.items || []).map(function (item) { return item.value; }).filter(Boolean);
      records.sort(function (left, right) { return left.index - right.index; });
      value.models = records.map(function (item) { return item.model; });
    }
    if (value.credentialRef) {
      var credential = await api().get("credentials", value.credentialRef);
      if (credential && credential.value) secretFields.forEach(function (name) {
        if (Object.prototype.hasOwnProperty.call(credential.value, name)) value[name] = credential.value[name];
      });
    }
    return value;
  }

  async function removeCatalog(serviceId, keepRevision) {
    var result = await api().scan("model-catalog", catalogPrefix(serviceId));
    var keepPrefix = keepRevision ? catalogPrefix(serviceId, keepRevision) : "";
    for (var index = 0; index < (result.items || []).length; index += 1) {
      if (!keepPrefix || result.items[index].key.indexOf(keepPrefix) !== 0) await api().delete("model-catalog", result.items[index].key);
    }
  }

  async function removeModelDirectory(profileId) {
    var result = await api().scan("model-directory", profileId + ":");
    for (var index = 0; index < (result.items || []).length; index += 1) await api().delete("model-directory", result.items[index].key);
  }

  async function saveModelDirectory(kind, profileId, models, voices) {
    await removeModelDirectory(profileId);
    var groups = [{ name: "model", items: models || [] }, { name: "voice", items: voices || [] }];
    for (var groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      for (var itemIndex = 0; itemIndex < groups[groupIndex].items.length; itemIndex += 1) {
        await api().put("model-directory", profileId + ":" + groups[groupIndex].name + ":" + String(itemIndex).padStart(5, "0"), {
          kind: kind, type: groups[groupIndex].name, index: itemIndex, value: groups[groupIndex].items[itemIndex], updatedAt: Date.now()
        });
      }
    }
    return { models: models || [], voices: voices || [] };
  }

  async function modelDirectory(profileId) {
    var result = await api().scan("model-directory", profileId + ":"), models = [], voices = [];
    (result.items || []).map(function (item) { return item.value; }).filter(Boolean).sort(function (left, right) { return left.index - right.index; }).forEach(function (item) {
      if (item.type === "model") models.push(item.value); else if (item.type === "voice") voices.push(item.value);
    });
    return { models: models, voices: voices };
  }

  async function removeCredentialIfUnused(reference) {
    if (!reference) return;
    var profileCollections = ["llm-profiles", "tts-profiles", "asr-profiles"];
    for (var index = 0; index < profileCollections.length; index += 1) {
      var result = await api().scan(profileCollections[index], "");
      if ((result.items || []).some(function (item) { return item.value && item.value.credentialRef === reference; })) return;
    }
    await api().delete("credentials", reference);
  }

  async function get(collection, key) {
    var result = await api().get(collection, key);
    return result ? hydrateProfile(collection, result.value) : null;
  }

  async function put(collection, key, value) {
    if (collections.indexOf(collection) < 0) throw new Error("未知数据集合：" + collection);
    var payload = value, revision = "", written = [];
    if (profileCollection(collection) && value) {
      await persistCredential(value);
      payload = withoutSecrets(value);
    }
    if (profileCollection(collection) && value && Array.isArray(value.models)) {
      var size = new TextEncoder().encode(JSON.stringify(payload)).length;
      if (value.models.length > 80 || size > 40 * 1024) {
        revision = app.utils.id("catalog");
        payload.models = []; payload.modelsExternal = true;
        payload.modelCatalogRevision = revision; payload.catalogRevision = revision; payload.modelCount = value.models.length;
        try {
          for (var modelIndex = 0; modelIndex < value.models.length; modelIndex += 1) {
            var modelKey = catalogPrefix(key, revision) + String(modelIndex).padStart(5, "0");
            await api().put("model-catalog", modelKey, { serviceId: key, revision: revision, index: modelIndex, model: value.models[modelIndex] });
            written.push(modelKey);
          }
        } catch (error) {
          for (var writtenIndex = 0; writtenIndex < written.length; writtenIndex += 1) await api().delete("model-catalog", written[writtenIndex]).catch(function () {});
          throw error;
        }
      } else if (value.modelsExternal) {
        delete payload.modelsExternal; delete payload.modelCatalogRevision; delete payload.modelCount;
      }
    }
    if (new TextEncoder().encode(JSON.stringify(payload)).length > 63 * 1024) throw new Error("内容过长，尚未保存；请缩短后重试");
    try { await api().put(collection, key, payload); }
    catch (error) { for (var cleanup = 0; cleanup < written.length; cleanup += 1) await api().delete("model-catalog", written[cleanup]).catch(function () {}); throw error; }
    if (profileCollection(collection)) await removeCatalog(key, revision).catch(function () {});
    app.events.emit("data:changed", { collection: collection, key: key });
    return value;
  }

  async function remove(collection, key) {
    var existing = profileCollection(collection) ? await api().get(collection, key) : null;
    var result = await api().delete(collection, key);
    if (profileCollection(collection)) {
      await removeCatalog(key).catch(function () {}); await removeModelDirectory(key).catch(function () {});
      await removeCredentialIfUnused(existing && existing.value && existing.value.credentialRef).catch(function () {});
    }
    app.events.emit("data:changed", { collection: collection, key: key });
    return result.deleted;
  }

  async function list(collection, keyPrefix) {
    var result = await api().scan(collection, keyPrefix || "");
    var values = (result.items || []).map(function (item) { return item.value; }).filter(Boolean);
    if (profileCollection(collection)) values = await Promise.all(values.map(function (value) { return hydrateProfile(collection, value); }));
    return values;
  }

  function messageKey(message) {
    return message.conversationId + ":" + String(message.createdAt).padStart(15, "0") + ":" + message.id;
  }

  function sortMessages(items) {
    items.sort(function (a, b) { return a.createdAt - b.createdAt || a.id.localeCompare(b.id); });
    return items;
  }

  async function messages(conversationId) {
    var items = sortMessages((await list("messages", conversationId + ":")).filter(function (item) { return item.kind !== "routing"; }));
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].textStorageId) {
        var chunks = await list("message-text", items[i].textStorageId + ":");
        chunks.sort(function (a, b) { return a.index - b.index; });
        if (chunks.length !== items[i].textChunkCount) throw new Error("消息正文不完整，请保留数据并重试");
        items[i].text = chunks.map(function (item) { return item.text; }).join("");
      }
    }
    return items;
  }

  async function routingRecords(conversationId) {
    return sortMessages((await list("messages", conversationId + ":")).filter(function (item) { return item.kind === "routing"; }));
  }

  function openingSceneId(conversationId) { return "opening-scene:" + conversationId; }

  async function openingScene(conversationId, history) {
    var items = history || await messages(conversationId);
    return items.find(function (item) { return item.kind === "system" && item.systemType === "scene"; }) || null;
  }

  async function prepareOpeningScene(conversationId) {
    var conversation = await get("conversations", conversationId);
    if (!conversation) throw new Error("对话不存在");
    var history = await messages(conversationId);
    var existing = await openingScene(conversationId, history);
    if (existing) {
      if (Object.prototype.hasOwnProperty.call(conversation, "openingSceneDraft")) {
        delete conversation.openingSceneDraft;
        await put("conversations", conversation.id, conversation);
      }
      return { conversation: conversation, message: existing, history: history, created: false };
    }
    var text = String(conversation.openingSceneDraft || "").trim();
    if (!text) return { conversation: conversation, message: null, history: history, created: false };
    if (history.length) {
      delete conversation.openingSceneDraft;
      await put("conversations", conversation.id, conversation);
      return { conversation: conversation, message: null, history: history, created: false };
    }
    var message = {
      id: openingSceneId(conversationId),
      conversationId: conversationId,
      kind: "system",
      systemType: "scene",
      text: text,
      media: [],
      status: "done",
      createdAt: Number(conversation.createdAt || Date.now())
    };
    await putMessage(message);
    delete conversation.openingSceneDraft;
    conversation.updatedAt = Date.now();
    await put("conversations", conversation.id, conversation);
    return { conversation: conversation, message: message, history: [message], created: true };
  }

  async function removeText(storageId) {
    if (!storageId) return;
    var records = await api().scan("message-text", storageId + ":");
    for (var i = 0; i < records.items.length; i += 1) await api().delete("message-text", records.items[i].key);
  }

  async function putMessage(message) {
    var key = messageKey(message);
    var old = await get("messages", key);
    var record = app.utils.clone(message);
    delete record.textStorageId; delete record.textChunkCount;
    if (new TextEncoder().encode(JSON.stringify(record)).length > 60 * 1024) {
      record.textStorageId = app.utils.id("text");
      var value = record.text || "";
      record.text = "";
      record.textChunkCount = Math.ceil(value.length / 8000);
      try {
        for (var i = 0; i < record.textChunkCount; i += 1) {
          await put("message-text", record.textStorageId + ":" + String(i).padStart(5, "0"), { index: i, text: value.slice(i * 8000, (i + 1) * 8000) });
        }
        await put("messages", key, record);
      } catch (error) { await removeText(record.textStorageId).catch(function () {}); throw error; }
    } else await put("messages", key, record);
    if (old && old.textStorageId) await removeText(old.textStorageId).catch(function () {});
    return message;
  }

  async function removeMessage(message) {
    var key = messageKey(message);
    var record = await get("messages", key);
    if (!record) return false;
    await api().delete("messages", key);
    await removeText(record.textStorageId);
    await releaseMedia(record.media || []);
    app.events.emit("data:changed", { collection: "messages", key: key });
    return true;
  }

  async function deleteMessagesAfter(conversationId, createdAt, includeBoundary) {
    var records = await api().scan("messages", conversationId + ":");
    var media = [];
    var removed = [];
    for (var i = 0; i < records.items.length; i += 1) {
      var value = records.items[i].value;
      if (value.createdAt > createdAt || (includeBoundary && value.createdAt === createdAt)) {
        media = media.concat(value.media || []);
        removed.push(value);
        await api().delete("messages", records.items[i].key);
        await removeText(value.textStorageId);
      }
    }
    await releaseMedia(media);
    app.events.emit("data:changed", { collection: "messages", key: conversationId });
    return removed;
  }

  async function releaseMedia(candidates) {
    if (!candidates.length) return;
    var references = (await list("messages")).concat(await list("drafts"));
    var used = {}, usedLogical = {};
    references.forEach(function (item) { (item.media || []).forEach(function (media) { if (media.mediaId) used[media.mediaId] = true; if (media.logicalFileId) usedLogical[media.logicalFileId] = true; }); });
    (await list("roles")).forEach(function (role) { if (role.avatarMediaId) used[role.avatarMediaId] = true; });
    (await list("conversations")).forEach(function (conversation) { if (conversation.userAvatarMediaId) used[conversation.userAvatarMediaId] = true; if (conversation.background && conversation.background.mediaId) used[conversation.background.mediaId] = true; });
    var userProfile = await get("meta", "user-profile"); if (userProfile && userProfile.avatarMediaId) used[userProfile.avatarMediaId] = true;
    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = typeof candidates[i] === "string" ? { mediaId: candidates[i] } : candidates[i] || {};
      if (candidate.mediaId && !used[candidate.mediaId]) await app.data.media.remove(candidate.mediaId);
      if (candidate.logicalFileId && !usedLogical[candidate.logicalFileId] && app.platform.hermit.available()) {
        await app.platform.hermit.api().files.delete({ logicalFileId: candidate.logicalFileId }).catch(function () {});
      }
    }
  }

  async function deleteConversation(conversationId) {
    var records = await api().scan("messages", conversationId + ":");
    var draft = await get("drafts", conversationId);
    var conversation = await get("conversations", conversationId);
    var media = (draft && draft.media || []).slice();
    if (conversation && conversation.userAvatarMediaId) media.push({ mediaId: conversation.userAvatarMediaId });
    if (conversation && conversation.background && conversation.background.mediaId) media.push({ mediaId: conversation.background.mediaId });
    for (var i = 0; i < records.items.length; i += 1) {
      var value = records.items[i].value;
      media = media.concat(value.media || []);
      await api().delete("messages", records.items[i].key);
      await removeText(value.textStorageId);
    }
    await remove("drafts", conversationId);
    await remove("summaries", conversationId);
    var summaries = await api().scan("summaries", conversationId + ":");
    for (var summaryIndex = 0; summaryIndex < summaries.items.length; summaryIndex += 1) await api().delete("summaries", summaries.items[summaryIndex].key);
    await remove("conversations", conversationId);
    await releaseMedia(media);
  }

  app.data = app.data || {};
  app.data.store = {
    init: init,
    backend: function () { return backend; },
    get: get,
    put: put,
    remove: remove,
    list: list,
    messages: messages,
    routingRecords: routingRecords,
    openingScene: openingScene,
    prepareOpeningScene: prepareOpeningScene,
    putMessage: putMessage,
    removeMessage: removeMessage,
    deleteMessagesAfter: deleteMessagesAfter,
    releaseMedia: releaseMedia,
    deleteConversation: deleteConversation,
    saveModelDirectory: saveModelDirectory,
    modelDirectory: modelDirectory
  };
})(window.chataxi);
