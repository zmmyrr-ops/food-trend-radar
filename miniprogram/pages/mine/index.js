const { request, notice, login } = require("../../utils/api");
Page({
  data: {
    loggedIn: false,
    nicknameSaving: false,
    busy: false,
    nickname: "",
    avatar: "",
    subscriptions: 0,
    blacklist: 0,
    unread: 0,
    error: "",
    errorDetail: "",
  },
  onShow() {
    this.refresh();
  },
  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },
  async refresh() {
    const loggedIn = !!wx.getStorageSync("miniToken");
    this.setData({ loggedIn, error: "" });
    if (!loggedIn) {
      this.setData({
        nickname: "",
        avatar: "",
        subscriptions: 0,
        blacklist: 0,
        unread: 0,
      });
      return;
    }
    try {
      const [p, s, b, m] = await Promise.all([
        request("profile"),
        request("brand-subscriptions"),
        request("brand-blacklist"),
        request("brand-subscriptions/messages"),
      ]);
      this.setData({
        nickname: p.profile.nickname,
        avatar: p.profile.avatar_data,
        subscriptions: s.items.length,
        blacklist: b.items.length,
        unread: m.unread,
      });
      if (m.unread)
        wx.setTabBarBadge({
          index: 1,
          text: m.unread > 99 ? "99+" : String(m.unread),
        });
      else wx.removeTabBarBadge({ index: 1 });
    } catch (e) {
      this.setData({ error: e.message });
    }
  },
  async login() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: "", errorDetail: "" });
    try {
      await login();
      await this.refresh();
    } catch (e) {
      notice(e);
      this.setData({
        error: e.message || "登录失败，请重试",
        errorDetail: e.detail
          ? e.detail + (e.code ? " [" + e.code + "]" : "")
          : "",
      });
    } finally {
      this.setData({ busy: false });
    }
  },
  nicknameChanged(e) {
    this.nicknameDraft = String(e.detail.value || "").trim();
  },
  nicknameReviewed(e) {
    if (!e.detail.pass || e.detail.timeout) {
      notice({
        message: e.detail.timeout
          ? "昵称校验超时，请重新选择"
          : "请选择其他微信昵称",
      });
      return;
    }
    this.createSelectorQuery()
      .select("#wechat-nickname")
      .fields({ properties: ["value"] }, (field) => {
        const nickname = String(
          field?.value ?? this.nicknameDraft ?? "",
        ).trim();
        this.saveNickname(nickname);
      })
      .exec();
  },
  async saveNickname(nickname) {
    if (
      !nickname ||
      this.data.nickname ||
      this.data.nicknameSaving ||
      !this.data.loggedIn
    )
      return;
    this.setData({ nicknameSaving: true });
    try {
      await request("profile", "POST", { nickname });
      this.setData({ nickname });
      wx.showToast({ title: "昵称已更新" });
    } catch (e) {
      notice(e);
    } finally {
      this.setData({ nicknameSaving: false });
    }
  },
  async avatar(e) {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      const r = await new Promise((resolve, reject) =>
        wx.compressImage({
          src: e.detail.avatarUrl,
          quality: 60,
          compressedWidth: 160,
          compressedHeight: 160,
          success: resolve,
          fail: reject,
        }),
      );
      const data = await new Promise((resolve, reject) =>
        wx.getFileSystemManager().readFile({
          filePath: r.tempFilePath,
          encoding: "base64",
          success: (x) => resolve(x.data),
          fail: reject,
        }),
      );
      const mime = data.startsWith("iVBOR") ? "png" : "jpeg";
      const avatar_data = "data:image/" + mime + ";base64," + data;
      await request("profile", "POST", { avatar_data });
      this.setData({ avatar: avatar_data });
    } catch (e) {
      notice(e);
    } finally {
      this.setData({ busy: false });
    }
  },
  open(e) {
    if (!this.data.loggedIn) return notice({ message: "请先微信登录" });
    wx.navigateTo({ url: e.currentTarget.dataset.url });
  },
  logout() {
    wx.showModal({
      title: "退出登录",
      content: "退出后，订阅和黑名单会继续保留。",
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await request("logout", "POST", {});
        } catch (e) {
          notice(e);
          return;
        }
        wx.removeStorageSync("miniToken");
        wx.removeTabBarBadge({ index: 1 });
        this.refresh();
      },
    });
  },
  retry() {
    if (!this.data.loggedIn) return this.login();
    this.refresh();
  },
});
