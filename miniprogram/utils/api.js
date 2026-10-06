const { apiBase, templateId } = require("../config");
let loginTask;
function raw(path, method, data, token) {
  return new Promise((resolve, reject) =>
    wx.request({
      url: apiBase + "/" + path,
      method,
      data,
      header: {
        "content-type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      timeout: 20000,
      success: (r) =>
        r.statusCode >= 200 && r.statusCode < 300
          ? resolve(r.data)
          : reject({
              status: r.statusCode,
              message:
                (r.data && r.data.error && r.data.error.message) ||
                "请求失败，请重试",
            }),
      fail: () => reject({ message: "网络连接失败，请稍后重试" }),
    }),
  );
}
function login() {
  if (!loginTask)
    loginTask = new Promise((resolve, reject) =>
      wx.login({ success: resolve, fail: reject }),
    )
      .then((r) => raw("login", "POST", { code: r.code }))
      .then((r) => {
        wx.setStorageSync("miniToken", r.token);
        return r.token;
      })
      .finally(() => {
        loginTask = null;
      });
  return loginTask;
}
async function request(path, method = "GET", data) {
  let token = wx.getStorageSync("miniToken");
  if (!token) throw { status: 401, message: "请先到“我的”页面微信登录" };
  try {
    return await raw(path, method, data, token);
  } catch (e) {
    if (e.status !== 401) throw e;
    if (wx.getStorageSync("miniToken") === token)
      wx.removeStorageSync("miniToken");
    token = wx.getStorageSync("miniToken") || (await login());
    return raw(path, method, data, token);
  }
}
function notice(e) {
  wx.showToast({ title: e.message || "操作失败，请重试", icon: "none" });
}
// Must be called directly from a user tap, never automatically on page load.
function authorize() {
  return new Promise((resolve, reject) =>
    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: resolve,
      fail: reject,
    }),
  ).then((r) =>
    request("notification-consent", "POST", {
      accepted: r[templateId] === "accept",
    }).then(() => r[templateId] === "accept"),
  );
}
// Start the native authorization in the tap call stack, before any HTTP request.
async function subscribeBrand(brand) {
  const accepted = await authorize();
  if (!accepted) {
    wx.showModal({
      title: "需开启消息提醒",
      content:
        "允许微信新商机提醒后，才能订阅品牌。若之前拒绝并记住了选择，请前往设置开启，再点击订阅。",
      confirmText: "去设置",
      cancelText: "暂不开启",
      success: (r) => {
        if (r.confirm) wx.openSetting({});
      },
    });
    return false;
  }
  await request("brand-subscriptions", "POST", {
    brand_id: brand,
    subscribed: true,
  });
  return true;
}
module.exports = { request, notice, authorize, login, subscribeBrand };
