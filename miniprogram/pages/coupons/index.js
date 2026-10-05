const { request, notice } = require("../../utils/api");
const categoryOptions = {
  food: [
    "全部分类",
    "茶饮果饮",
    "咖啡",
    "烘焙甜品",
    "西式快餐",
    "中式快餐小吃",
    "火锅烧烤",
    "中餐及本地特色",
    "其他餐饮",
  ],
  leisure: [
    "全部分类",
    "亲子乐园",
    "主题乐园",
    "动物海洋馆",
    "展馆观光",
    "户外景区",
    "运动玩乐",
  ],
};
const money = (n) => (n == null ? "—" : (n / 100).toFixed(2));
Page({
  data: {
    views: [
      { id: "recommended", name: "优先券" },
      { id: "all", name: "全部券" },
      { id: "new", name: "新上" },
      { id: "accelerating", name: "增长加快" },
      { id: "price_drop", name: "降价" },
      { id: "value_rising", name: "降价且升温" },
    ],
    categoryIndex: 0,
    categories: categoryOptions.food,
    view: "recommended",
    channel: "food",
    order: "priority",
    sortIndex: 0,
    sorts: ["优先分", "热度增速", "增长加快", "最新采集"],
    search: "",
    brand_id: "",
    items: [],
    total: 0,
    loading: false,
    error: "",
    detail: null,
    loggedIn: false,
  },
  onLoad(q) {
    if (q.brand_id) this.setData({ brand_id: q.brand_id, view: "all" });
  },
  onShow() {
    this.setData({ loggedIn: !!wx.getStorageSync("miniToken") });
    if (this.data.loggedIn) this.load(true);
    else this.setData({ items: [], total: 0, error: "" });
  },
  goLogin() {
    wx.switchTab({ url: "/pages/mine/index" });
  },
  onUnload() {
    clearTimeout(this.searchTimer);
    this.version = (this.version || 0) + 1;
  },
  onPullDownRefresh() {
    this.load(true).finally(() => wx.stopPullDownRefresh());
  },
  onReachBottom() {
    if (!this.data.loading && this.data.items.length < this.data.total)
      this.load(false);
  },
  async load(reset) {
    if (!wx.getStorageSync("miniToken")) return;
    const version = (this.version = (this.version || 0) + 1);
    const offset = reset ? 0 : this.data.items.length;
    this.setData({ loading: true, error: "", ...(reset ? { items: [] } : {}) });
    try {
      const q = {
        view: this.data.view,
        channel: this.data.brand_id ? "all" : this.data.channel,
        order: this.data.order,
        search: this.data.search,
        offset,
        limit: 20,
      };
      if (this.data.brand_id) q.brand_id = this.data.brand_id;
      if (this.data.categoryIndex)
        q.category = this.data.categories[this.data.categoryIndex];
      const r = await request(
        "coupon-picks?" +
          Object.keys(q)
            .map((k) => k + "=" + encodeURIComponent(q[k]))
            .join("&"),
      );
      if (version !== this.version) return;
      this.setData({
        items: (reset ? [] : this.data.items).concat(
          r.items.map((x) => ({
            ...x,
            key: x.brand_id + ":" + x.product_id,
            price: money(x.price_fen),
            origin: money(x.origin_price_fen),
            score: Number(x.priority_score).toFixed(1),
          })),
        ),
        total: r.total,
      });
    } catch (e) {
      if (version === this.version) this.setData({ error: e.message });
    } finally {
      if (version === this.version) this.setData({ loading: false });
    }
  },
  view(e) {
    this.setData({ view: e.currentTarget.dataset.id });
    this.load(true);
  },
  channel(e) {
    this.setData({
      channel: e.currentTarget.dataset.id,
      brand_id: "",
      categoryIndex: 0,
      categories: categoryOptions[e.currentTarget.dataset.id],
    });
    this.load(true);
  },
  category(e) {
    this.setData({ categoryIndex: Number(e.detail.value) });
    this.load(true);
  },
  search(e) {
    this.setData({ search: e.detail.value });
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.load(true), 350);
  },
  sort(e) {
    const i = Number(e.detail.value);
    this.setData({
      sortIndex: i,
      order: ["priority", "speed", "acceleration", "newest"][i],
    });
    this.load(true);
  },
  clearBrand() {
    this.setData({ brand_id: "" });
    this.load(true);
  },
  retry() {
    this.load(true);
  },
  async detail(e) {
    const p = this.data.items[e.currentTarget.dataset.index];
    this.setData({ detail: { ...p, rules: [], shop: null, loading: true } });
    try {
      const q = "?brand_id=" + p.brand_id;
      const [rules, stores] = await Promise.all([
        request("coupons/" + p.product_id + "/rules" + q),
        request("coupons/" + p.product_id + "/stores" + q),
      ]);
      if (this.data.detail && this.data.detail.key === p.key)
        this.setData({
          detail: {
            ...p,
            rules: rules.rules,
            shop: stores.source_shop,
            loading: false,
          },
        });
    } catch (e) {
      notice(e);
      if (this.data.detail)
        this.setData({
          "detail.loading": false,
          "detail.error": "使用信息暂时无法加载，请关闭后重试",
        });
    }
  },
  close() {
    this.setData({ detail: null });
  },
  noop() {},
  async subscribe(e) {
    try {
      await request("brand-subscriptions", "POST", {
        brand_id: e.currentTarget.dataset.brand,
        subscribed: true,
      });
      wx.showToast({ title: "已订阅品牌" });
    } catch (e) {
      notice(e);
    }
  },
  block(e) {
    const id = e.currentTarget.dataset.brand;
    wx.showModal({
      title: "加入品牌黑名单",
      content: "该品牌将不再出现在你的优先券中。",
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await request("brand-blacklist", "POST", {
            brand_id: id,
            blocked: true,
          });
          this.close();
          this.load(true);
        } catch (e) {
          notice(e);
        }
      },
    });
  },
});
