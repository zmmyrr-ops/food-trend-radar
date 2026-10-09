const telemetry = require("./utils/telemetry");
App({
  globalData: {},
  onShow() {
    telemetry.start();
  },
  onHide() {
    telemetry.stop();
  },
});
