const { apiBase } = require("../config");
let queue = [],
  busy = false,
  timer;
function track(page) {
  if (!wx.getStorageSync("miniToken")) return;
  if (queue.length < 100)
    queue.push({
      id: "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 3) | 8).toString(16);
      }),
      name: "page_view",
      page,
      channel: "mini",
    });
}
function flush() {
  const token = wx.getStorageSync("miniToken");
  if (busy || !token || !queue.length) return;
  busy = true;
  const events = queue.splice(0, 30);
  wx.request({
    url: apiBase + "/analytics/events",
    method: "POST",
    data: { events },
    header: {
      "content-type": "application/json",
      Authorization: "Bearer " + token,
      "x-client-channel": "mini",
    },
    timeout: 5000,
    success: (r) => {
      if (r.statusCode >= 500) queue = events.concat(queue).slice(0, 100);
    },
    fail: () => {
      queue = events.concat(queue).slice(0, 100);
    },
    complete: () => {
      busy = false;
    },
  });
}
module.exports = {
  track,
  flush,
  start() {
    if (!timer) timer = setInterval(flush, 15000);
  },
  stop() {
    clearInterval(timer);
    timer = null;
    flush();
  },
};
