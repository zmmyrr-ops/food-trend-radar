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
  let token = wx.getStorageSync("miniToken") || (await login());
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
module.exports = { request, notice, authorize };
