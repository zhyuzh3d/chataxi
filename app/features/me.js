(function (app) {
  "use strict";
  var u = app.utils, ui = app.components, store = app.data.store;

  async function render() {
    var profile = await store.get("meta", "user-profile") || { name: "我", introduction: "", avatarMediaId: "" };
    if (app.state.route !== "me") return;
    ui.pageHeader("我的", "个人设定");
    var main = document.getElementById("mainContent"); main.className = "main";
    main.innerHTML = '<section class="page my-page"><form id="userProfileForm" class="settings-stack"><section class="form-grid my-panel"><h2 class="section-title">个人设定</h2><div class="avatar-editor"><button class="avatar-picker round" type="button" data-choose-user-avatar aria-label="从图库选择头像"><span id="userAvatarPreview">' + ui.avatar(profile.name, "", "large user-profile-avatar", "", profile.avatarMediaId) + '</span><span class="avatar-edit-badge" aria-hidden="true">' + ui.icon("camera") + '</span></button><div class="avatar-copy"><strong>头像</strong><small>点击头像从图库选择并拖动裁切</small><div class="avatar-actions">' + (profile.avatarMediaId ? '<button class="button ghost" type="button" data-remove-user-avatar>移除头像</button>' : '') + '</div></div></div><label class="field"><span>名称</span><input name="name" required maxlength="40" value="' + u.escapeHtml(profile.name || "我") + '" placeholder="AI 应该如何称呼你？"></label><label class="field"><span>自我介绍</span><textarea class="prompt-editor" name="introduction" maxlength="8000" placeholder="例如你的身份、长期目标、偏好、边界和希望角色了解的背景。">' + u.escapeHtml(profile.introduction || "") + '</textarea><small>名称和介绍会加入模型上下文；每个对话都可按字段设置自己的个人设定。</small></label></section><button class="button primary full" type="submit">保存个人设定</button><p class="save-status" id="userProfileSaveStatus" role="status"></p></form></section>';
    var form = document.getElementById("userProfileForm"), stagedBlob = null, stagedDataUrl = "", removeAvatar = false;
    ui.hydrateAvatars(form);
    function preview() { var target = form.querySelector("#userAvatarPreview"); if (stagedDataUrl) target.innerHTML = '<span class="avatar large user-profile-avatar" aria-hidden="true"><img src="' + u.escapeHtml(stagedDataUrl) + '" alt=""></span>'; else { target.innerHTML = ui.avatar(u.formValue(form, "name") || "我", "", "large user-profile-avatar", "", removeAvatar ? "" : profile.avatarMediaId); ui.hydrateAvatars(target); } }
    function markDirty() { form.querySelector("#userProfileSaveStatus").textContent = "有未保存的更改"; }
    function bindRemove(button) { button.addEventListener("click", function () { stagedBlob = null; stagedDataUrl = ""; removeAvatar = true; button.remove(); preview(); markDirty(); }); }
    var remove = form.querySelector("[data-remove-user-avatar]"); if (remove) bindRemove(remove);
    form.querySelector("[data-choose-user-avatar]").addEventListener("click", ui.action(async function () {
      var picked = await ui.pickLocalImage(); if (!picked) return;
      await ui.cropAvatar(picked, async function (output) { stagedBlob = output; stagedDataUrl = await u.blobToDataUrl(output); removeAvatar = false; preview(); var actions = form.querySelector(".avatar-actions"); if (!actions.querySelector("[data-remove-user-avatar]")) { var button = document.createElement("button"); button.type = "button"; button.className = "button ghost"; button.dataset.removeUserAvatar = ""; button.textContent = "移除头像"; actions.appendChild(button); bindRemove(button); } markDirty(); });
    }));
    form.elements.namedItem("name").addEventListener("input", function () { preview(); markDirty(); });
    form.elements.namedItem("introduction").addEventListener("input", markDirty);
    form.addEventListener("submit", ui.action(async function (event) {
      event.preventDefault(); var button = form.querySelector('[type="submit"]'); button.disabled = true; var created = null;
      try {
        var name = u.formValue(form, "name"); if (!name) throw new Error("请填写你的名称");
        var avatarMediaId = removeAvatar ? "" : profile.avatarMediaId || "";
        if (stagedBlob) { created = await app.data.media.put(stagedBlob, { name: "user-avatar.jpg", mime: "image/jpeg" }); avatarMediaId = created.id; }
        var next = { name: name, introduction: u.formValue(form, "introduction"), avatarMediaId: avatarMediaId, createdAt: profile.createdAt || Date.now(), updatedAt: Date.now() };
        await store.put("meta", "user-profile", next);
        if (profile.avatarMediaId && profile.avatarMediaId !== avatarMediaId) await store.releaseMedia([profile.avatarMediaId]).catch(function () {});
        profile = next; stagedBlob = null; stagedDataUrl = ""; removeAvatar = false; created = null; preview();
        form.querySelector("#userProfileSaveStatus").textContent = "个人设定已保存"; ui.toast("个人设定已保存");
      } catch (error) { if (created) await app.data.media.remove(created.id).catch(function () {}); throw error; }
      finally { button.disabled = false; }
    }));
  }

  app.features = app.features || {};
  app.features.me = { render: render };
})(window.chataxi);
