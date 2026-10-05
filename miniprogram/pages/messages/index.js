const { request, notice, authorize } = require("../../utils/api");
Page({
  data: { items: [], unread: 0, error: "", loading: false },
  onShow() {
    this.load();
    this.timer = setInterval(() => this.load(), 60000);
  },
  onHide() {
    clearInterval(this.timer);
  },
  onUnload() {
    clearInterval(this.timer);
  },
  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },
  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: "" });
    try {
      const r = await request("brand-subscriptions/messages");
      this.setData({ items: r.items, unread: r.unread });
      if (r.unread)
        wx.setTabBarBadge({
          index: 1,
          text: r.unread > 99 ? "99+" : String(r.unread),
        });
      else wx.removeTabBarBadge({ index: 1 });
    } catch (e) {
      this.setData({ error: e.message });
    } finally {
      this.setData({ loading: false });
    }
  },
  async readAll() {
    try {
      await request("brand-subscriptions/read", "POST", {
        ids: this.data.items.filter((m) => !m.read_at).map((m) => m.id),
      });
      this.load();
    } catch (e) {
      notice(e);
    }
  },
  async open(e) {
    const m = this.data.items[e.currentTarget.dataset.index];
    try {
      await request("brand-subscriptions/read", "POST", { ids: [m.id] });
    } catch (e) {
      notice(e);
    }
    wx.reLaunch({ url: "/pages/coupons/index?brand_id=" + m.brand_id });
  },
  enable() {
    authorize()
      .then((ok) =>
        wx.showToast({
          title: ok ? "已开启本次提醒" : "未开启微信提醒",
          icon: "none",
        }),
      )
      .catch(notice);
  },
  retry() {
    this.load();
  },
});
