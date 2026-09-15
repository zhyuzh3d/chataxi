(function (app) {
  "use strict";
  var store = app.data.store;

  function roleStatus(role, profiles) {
    if (role.enabled === false) return "已下线";
    var profile = profiles.find(function (item) { return item.id === role.llmProfileId; });
    if (!profile) return "需要绑定对话模型";
    var status = app.services.modelServices.serviceStatus("llm", profile);
    if (status) return "对话模型" + status;
    if (!role.model && !profile.model && !app.services.modelServices.models("llm", profile).length) return "需要选择具体模型";
    return "";
  }

  function userForConversation(conversation, globalProfile) {
    conversation = conversation || {};
    globalProfile = globalProfile || {};
    var conversationName = String(conversation.userName || "").trim();
    var conversationIntroduction = String(conversation.userIntroduction || "").trim();
    return {
      name: conversationName || String(globalProfile.name || "").trim() || "我",
      introduction: conversationIntroduction || String(globalProfile.introduction || "").trim(),
      avatarMediaId: String(conversation.userAvatarMediaId || "").trim() || String(globalProfile.avatarMediaId || "").trim()
    };
  }

  async function availableRoles() {
    var profiles = await store.list("llm-profiles");
    return (await store.list("roles")).filter(function (role) { return !roleStatus(role, profiles); });
  }

  async function remove(kind, id) {
    var collection = kind + "-profiles";
    var profile = await store.get(collection, id);
    if (!profile) return;
    if (profile.type === "system") throw new Error("系统配置不能删除");
    var roles = await store.list("roles");
    if (kind === "llm") {
      var refs = roles.filter(function (role) { return role.llmProfileId === id; });
      if (refs.length) throw new Error("仍被“" + refs.map(function (role) { return role.name; }).join("、") + "”使用，请先更换角色的对话模型");
    } else {
      var settings = await store.get("meta", "settings");
      var field = kind === "tts" ? "defaultTtsProfileId" : "defaultAsrProfileId";
      if (settings[field] === id) { settings[field] = "system-" + kind; await store.put("meta", "settings", settings); }
      if (kind === "tts") {
        for (var i = 0; i < roles.length; i += 1) {
          if (roles[i].ttsProfileId === id) { roles[i].ttsProfileId = ""; roles[i].ttsModel = ""; roles[i].ttsVoice = ""; roles[i].voicePrompt = ""; await store.put("roles", roles[i].id, roles[i]); }
        }
      } else {
        var conversations = await store.list("conversations");
        for (var conversationIndex = 0; conversationIndex < conversations.length; conversationIndex += 1) {
          if (conversations[conversationIndex].asrProfileId === id) {
            conversations[conversationIndex].asrProfileId = "";
            conversations[conversationIndex].asrModel = "";
            await store.put("conversations", conversations[conversationIndex].id, conversations[conversationIndex]);
          }
        }
      }
    }
    await store.remove(collection, id);
  }

  async function validateEnabled(kind, profile) {
    if (profile.type === "system" && profile.enabled === false) throw new Error("系统配置始终保留可选；可在通用设置关闭自动朗读或更换默认服务");
    if (profile.enabled !== false) return;
    if (kind === "llm") {
      var llmRoles = (await store.list("roles")).filter(function (role) { return role.llmProfileId === profile.id; });
      if (llmRoles.length) throw new Error("请先更换“" + llmRoles.map(function (role) { return role.name; }).join("、") + "”的对话模型，再停用此模型");
      return;
    }
    var settings = await store.get("meta", "settings");
    if (settings[kind === "tts" ? "defaultTtsProfileId" : "defaultAsrProfileId"] === profile.id) throw new Error("请先更换默认配置，再停用此服务");
    if (kind === "tts") {
      var roles = await store.list("roles");
      if (roles.some(function (role) { return role.ttsProfileId === profile.id; })) throw new Error("请先更换角色的朗读配置，再停用此服务");
    } else {
      var conversations = await store.list("conversations");
      if (conversations.some(function (conversation) { return conversation.asrProfileId === profile.id; })) throw new Error("请先更换对话的语音输入服务，再停用此服务");
    }
  }

  app.services.profiles = { roleStatus: roleStatus, userForConversation: userForConversation, availableRoles: availableRoles, remove: remove, validateEnabled: validateEnabled };
})(window.chataxi);
