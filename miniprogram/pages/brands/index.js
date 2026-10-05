const { request, notice, authorize } = require("../../utils/api");
Page({
  data: {
    mode: "subscriptions",
    search: "",
    results: [],
    items: [],
    loading: false,
    busy: false,
    error: "",
    searching: false,
  },
  onLoad(q) {
    if (q.mode === "blacklist") this.setData({ mode: "blacklist" });
  },
  onShow() {
    this.load();
  },
  onUnload() {
    clearTimeout(this.timer);
    this.searchVersion = (this.searchVersion || 0) + 1;
  },
  endpoint() {
    return this.data.mode === "subscriptions"
      ? "brand-subscriptions"
      : "brand-blacklist";
  },
  async load() {
    const mode = this.data.mode;
    this.setData({ loading: true, error: "" });
    try {
      const r = await request(this.endpoint());
      if (mode === this.data.mode) this.setData({ items: r.items });
    } catch (e) {
      this.setData({ error: e.message });
    } finally {
      if (mode === this.data.mode) this.setData({ loading: false });
    }
  },
  switchMode(e) {
    clearTimeout(this.timer);
    this.searchVersion = (this.searchVersion || 0) + 1;
    this.setData({
      mode: e.currentTarget.dataset.id,
      search: "",
      results: [],
      items: [],
      searching: false,
    });
    this.load();
  },
  search(e) {
    const q = e.detail.value;
    this.setData({ search: q, results: [], searching: !!q.trim() });
    clearTimeout(this.timer);
    const version = (this.searchVersion = (this.searchVersion || 0) + 1);
    if (!q.trim()) return;
    this.timer = setTimeout(async () => {
      try {
        const r = await request(
          this.endpoint() + "/search?q=" + encodeURIComponent(q.trim()),
        );
        if (version === this.searchVersion)
          this.setData({
            results: r.items.map((b) => ({
              ...b,
              added: this.data.items.some((i) => i.brand_id === b.id),
            })),
          });
      } catch (e) {
        notice(e);
      } finally {
        if (version === this.searchVersion) this.setData({ searching: false });
      }
    }, 300);
  },
  async change(e) {
    if (this.data.busy) return;
    this.setData({ busy: true });
    const brand = e.currentTarget.dataset.brand;
    const value = e.currentTarget.dataset.add === "yes";
    try {
      await request(this.endpoint(), "POST", {
        brand_id: brand,
        [this.data.mode === "subscriptions" ? "subscribed" : "blocked"]: value,
      });
      await this.load();
      this.setData({
        results: this.data.results.map((b) => ({
          ...b,
          added: this.data.items.some((i) => i.brand_id === b.id),
        })),
      });
    } catch (e) {
      notice(e);
    } finally {
      this.setData({ busy: false });
    }
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
