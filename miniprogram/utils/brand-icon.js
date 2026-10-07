const { request } = require("./api");
const pending = new Map();
let session = "";
function brandIcon(id) {
  const token = wx.getStorageSync("miniToken");
  if (!token || !/^[a-f0-9-]{36}$/i.test(id)) return Promise.resolve("");
  if (session !== token) {
    pending.clear();
    session = token;
  }
  if (!pending.has(id)) {
    const task = request("brand-icons/" + id + "?format=json")
      .then(
        (image) =>
          new Promise((resolve) => {
            const ext = {
              "image/png": "png",
              "image/jpeg": "jpg",
              "image/webp": "webp",
            }[image.mime];
            if (!ext) return resolve("");
            const path = wx.env.USER_DATA_PATH + "/brand-" + id + "." + ext;
            wx.getFileSystemManager().writeFile({
              filePath: path,
              data: image.content,
              encoding: "base64",
              success: () => resolve(path),
              fail: () => resolve(""),
            });
          }),
      )
      .catch(() => {
        pending.delete(id);
        return "";
      });
    pending.set(id, task);
  }
  return pending.get(id);
}
module.exports = { brandIcon };
